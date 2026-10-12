/**
 * Verifies the subscription lifecycle and the refund reversal against a real
 * PostgreSQL database.
 *
 *   createdb subcheck && npx ts-node -r tsconfig-paths/register \
 *     scripts/verify-subscription-lifecycle.ts subcheck
 *
 * Why this and not an HTTP e2e run: booting the application needs a reachable
 * Kafka broker (CLAUDE.md §11), so the services are wired by hand here.
 * Everything below the controller is the real thing — real TypeORM
 * repositories, real SQL, real transactions, the real guards.
 *
 * Only the Moyasar HTTP calls are stubbed (by replacing `axios.get`/`axios.post`
 * for the duration of the run); there is no sandbox invoice to pay, and the
 * point of the exercise is what the DATABASE ends up holding.
 *
 * What it proves, in order:
 *   1. The entity initialises and a FREE subscription is created.
 *   2. An upgrade paid through the real webhook path lands, and records the
 *      plan it came from.
 *   3. A FULL refund of that payment actually downgrades — the bug this work
 *      was for — and does not touch a single resource.
 *   4. An over-quota tenant can still read and still operate what it has, and
 *      cannot create more: asserted against the REAL SubscriptionGuard and
 *      SubscriptionLimitGuard, and against real device rows.
 *   5. A refund reverts to the PREVIOUS PAID plan when that plan still has paid
 *      period left, and to FREE when it does not.
 *   6. A PARTIAL refund does not downgrade; partials that add up to the whole
 *      charge do.
 *   7. A chargeback reverses like a full refund, with no provider call.
 *   8. The same renewal webhook delivered twice renews once — sequentially,
 *      concurrently, and even with the payment row forced back to PENDING.
 *   9. A second trial is refused, including via cancel-and-resubscribe.
 *  10. The cron sweeps every expired state into the right one.
 */
import { DataSource, Repository } from 'typeorm';
import { randomUUID } from 'crypto';
import axios from 'axios';
import { Reflector } from '@nestjs/core';
import { ForbiddenException, ConflictException } from '@nestjs/common';
import * as entities from '../src/modules/index.entities';
import { Subscription } from '../src/modules/subscriptions/entities/subscription.entity';
import { Payment } from '../src/modules/payments/entities/payment.entity';
import { Device } from '../src/modules/devices/entities/device.entity';
import { SubscriptionsService } from '../src/modules/subscriptions/subscriptions.service';
import { PaymentsService } from '../src/modules/payments/payments.service';
import { SubscriptionGuard } from '../src/common/guards/subscription.guard';
import { SubscriptionLimitGuard } from '../src/common/guards/subscription-limit.guard';
import { RequireSubscriptionLimit } from '../src/common/decorators/subscription.decorator';
import {
  SubscriptionPlan,
  SubscriptionStatus,
  BillingPeriod,
  PaymentStatus,
  PaymentProvider,
  UserRole,
} from '../src/common/enums/index.enum';

const database = process.argv[2] ?? 'subcheck';

let failures = 0;
const check = (label: string, condition: boolean, detail?: unknown) => {
  if (condition) {
    console.log(`  ✓ ${label}`);
  } else {
    failures++;
    console.error(`  ✗ ${label}`, detail === undefined ? '' : detail);
  }
};
const eq = (label: string, actual: unknown, expected: unknown) =>
  check(`${label} = ${String(expected)}`, actual === expected, `got ${String(actual)}`);
const section = (title: string) => console.log(`\n── ${title} ${'─'.repeat(Math.max(0, 60 - title.length))}`);

const MONTH_MS = 30 * 24 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

/** Fixture: one tenant + one tenant-admin user, with real rows (FKs are real). */
async function makeTenant(ds: DataSource, label: string) {
  const tenantId = randomUUID();
  const userId = randomUUID();
  await ds.query(`INSERT INTO tenants (id, name, email) VALUES ($1, $2, $3)`, [
    tenantId,
    `${label} ${tenantId.slice(0, 8)}`,
    `${label}-${tenantId.slice(0, 8)}@example.invalid`.toLowerCase(),
  ]);
  await ds.query(
    `INSERT INTO users (id, email, password, name, role, "tenantId")
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [
      userId,
      `u-${userId.slice(0, 8)}@example.invalid`,
      'not-a-real-hash',
      `${label} admin`,
      UserRole.TENANT_ADMIN,
      tenantId,
    ],
  );
  return { tenantId, userId };
}

/** A pending payment row, as createPaymentIntent() would have written it. */
async function makePayment(
  repo: Repository<Payment>,
  opts: {
    tenantId: string;
    userId: string;
    subscriptionId: string;
    invoiceId: string;
    amount: number;
    plan: SubscriptionPlan;
    originalPlan: SubscriptionPlan;
    intent: 'upgrade' | 'renewal';
    billingPeriod?: BillingPeriod;
  },
) {
  return repo.save(
    repo.create({
      tenantId: opts.tenantId,
      userId: opts.userId,
      subscriptionId: opts.subscriptionId,
      paymentIntentId: opts.invoiceId,
      provider: PaymentProvider.MOYASAR,
      amount: opts.amount,
      currency: 'SAR',
      status: PaymentStatus.PENDING,
      description: `${opts.plan} ${opts.intent}`,
      metadata: {
        plan: opts.plan,
        billingPeriod: opts.billingPeriod ?? BillingPeriod.MONTHLY,
        invoiceId: opts.invoiceId,
        originalPlan: opts.originalPlan,
        intent: opts.intent,
      },
    }),
  );
}

// ── Fake execution context, enough for the two guards under test ────────────
class QuotaProbe {
  @RequireSubscriptionLimit({ resource: 'devices' })
  createDevice() {}

  // No decorator: reading and operating existing resources.
  listDevices() {}
}

const contextFor = (handler: Function, request: any) =>
  ({
    getHandler: () => handler,
    getClass: () => QuotaProbe,
    switchToHttp: () => ({ getRequest: () => request }),
  }) as any;

(async () => {
  const dataSource = new DataSource({
    type: 'postgres',
    host: process.env.DB_HOST ?? 'localhost',
    port: Number(process.env.DB_PORT ?? 5432),
    username: process.env.DB_USERNAME ?? 'postgres',
    password: process.env.DB_PASSWORD ?? '123456',
    database,
    entities: Object.values(entities) as any[],
    synchronize: true,
    logging: false,
  });

  section('1. Schema and wiring');
  await dataSource.initialize();
  check('DataSource initialises', true);

  const subscriptionRepo = dataSource.getRepository(Subscription);
  const paymentRepo = dataSource.getRepository(Payment);
  const deviceRepo = dataSource.getRepository(Device);

  // Clean slate for repeated runs.
  await dataSource.query('DELETE FROM devices');
  await dataSource.query('DELETE FROM payments');
  await dataSource.query('DELETE FROM subscriptions');
  await dataSource.query("DELETE FROM users WHERE email LIKE '%@example.invalid'");
  await dataSource.query("DELETE FROM tenants WHERE email LIKE '%@example.invalid'");

  const subscriptions = new SubscriptionsService(
    subscriptionRepo,
    dataSource.getRepository(entities.Tenant),
    paymentRepo,
    deviceRepo,
    dataSource.getRepository(entities.Dashboard),
    dataSource.getRepository(entities.Asset),
    dataSource.getRepository(entities.User),
    dataSource.getRepository(entities.RuleChain),
    dataSource.getRepository(entities.FloorPlan),
    dataSource.getRepository(entities.Automation),
    dataSource,
  );

  const configStub: any = {
    get: (key: string) =>
      ({
        MOYASAR_API_KEY: 'sk_test_fixture',
        MOYASAR_WEBHOOK_SECRET: '',
        FRONTEND_URL: 'https://app.example.invalid',
        PAYMENT_CURRENCY: 'SAR',
      })[key],
  };

  const payments = new PaymentsService(
    paymentRepo,
    subscriptions,
    configStub,
    dataSource,
  );
  check('PaymentsService constructs', true);

  // ── Moyasar stubs ─────────────────────────────────────────────────────────
  // Only the HTTP boundary is faked. Every assertion below reads real rows.
  const paidInvoices = new Set<string>();
  const refundCalls: Array<{ url: string; amount: number }> = [];
  (axios as any).get = async (url: string) => {
    const id = url.split('/').pop()!;
    return {
      data: paidInvoices.has(id)
        ? {
            id,
            status: 'paid',
            url: `https://pay.example.invalid/${id}`,
            paid_at: new Date().toISOString(),
            updated_at: new Date().toISOString(),
            payments: [{ id: `pay_${id}`, status: 'paid' }],
          }
        : { id, status: 'pending', url: `https://pay.example.invalid/${id}` },
    };
  };
  let createdInvoices = 0;
  const invoicePayloads: any[] = [];
  (axios as any).post = async (url: string, body: any) => {
    if (url.endsWith('/invoices')) {
      createdInvoices++;
      invoicePayloads.push(body);
      const id = `inv_created_${createdInvoices}`;
      return { data: { id, url: `https://pay.example.invalid/${id}` } };
    }
    refundCalls.push({ url, amount: body?.amount });
    return { data: { id: `ref_${refundCalls.length}` } };
  };

  // ═════════════════════════════════════════════════════════════════════════
  section('2. Upgrade through the real payment path');

  const a = await makeTenant(dataSource, 'refund-full');
  let subA = await subscriptions.create(a.tenantId, {
    plan: SubscriptionPlan.FREE,
    billingPeriod: BillingPeriod.MONTHLY,
  });
  eq('new subscription plan', subA.plan, SubscriptionPlan.FREE);
  eq('new subscription devices limit', subA.limits.devices, 5);

  const upgradePayment = await makePayment(paymentRepo, {
    tenantId: a.tenantId,
    userId: a.userId,
    subscriptionId: subA.id,
    invoiceId: 'inv_upgrade_a',
    amount: 499,
    plan: SubscriptionPlan.PROFESSIONAL,
    originalPlan: SubscriptionPlan.FREE,
    intent: 'upgrade',
  });
  paidInvoices.add('inv_upgrade_a');
  await payments.verifyPayment('inv_upgrade_a');

  subA = await subscriptions.findByTenantId(a.tenantId);
  eq('plan after paid upgrade', subA.plan, SubscriptionPlan.PROFESSIONAL);
  eq('status after paid upgrade', subA.status, SubscriptionStatus.ACTIVE);
  eq('devices limit after upgrade', subA.limits.devices, 200);
  eq(
    'previous plan recorded for reversal',
    subA.metadata?.previousPlan?.plan,
    SubscriptionPlan.FREE,
  );
  check(
    'payment recorded in the applied-payments ledger',
    !!subA.metadata?.appliedPayments?.[upgradePayment.id],
    subA.metadata?.appliedPayments,
  );
  check(
    'moyasar payment id captured off the invoice (needed to refund)',
    (await paymentRepo.findOneByOrFail({ id: upgradePayment.id })).metadata
      ?.moyasarPaymentId === 'pay_inv_upgrade_a',
  );

  // 40 real devices on a plan that allows 200.
  for (let i = 0; i < 40; i++) {
    await deviceRepo.save(
      deviceRepo.create({
        tenantId: a.tenantId,
        userId: a.userId,
        deviceKey: `dev_a_${i}_${a.tenantId.slice(0, 4)}`,
        name: `Sensor ${i}`,
      }),
    );
  }
  await subscriptions.syncUsageFromDB(a.tenantId);
  subA = await subscriptions.findByTenantId(a.tenantId);
  eq('usage.devices after sync', subA.usage.devices, 40);

  // ═════════════════════════════════════════════════════════════════════════
  section('3. THE BUG: a full refund must downgrade');

  const refundedPayment = await payments.refundPayment(a.userId, {
    paymentId: upgradePayment.id,
    reason: 'customer changed their mind',
  });

  eq('payment status after full refund', refundedPayment.status, PaymentStatus.REFUNDED);
  check('provider refund was called', refundCalls.length === 1, refundCalls);
  eq('refunded amount sent to provider (halalas)', refundCalls[0].amount, 49900);
  check(
    'refund called against the payment id, not the invoice id',
    refundCalls[0].url.endsWith('/payments/pay_inv_upgrade_a/refund'),
    refundCalls[0].url,
  );

  subA = await subscriptions.findByTenantId(a.tenantId);
  eq('plan after full refund', subA.plan, SubscriptionPlan.FREE);
  eq('devices limit after full refund', subA.limits.devices, 5);
  eq(
    'status after full refund (NOT expired/suspended — reads must keep working)',
    subA.status,
    SubscriptionStatus.ACTIVE,
  );
  eq('auto-renew off after refund', subA.isAutoRenewEnabled(), false);
  eq('reversal recorded', subA.metadata?.reversals?.length, 1);
  eq(
    'reversal target recorded',
    subA.metadata?.reversals?.[0].toPlan,
    SubscriptionPlan.FREE,
  );
  eq('reversal is idempotent-guarded', subA.metadata?.reversedPayments?.length, 1);

  eq('devices NOT deleted by the downgrade', await deviceRepo.count({ where: { tenantId: a.tenantId } }), 40);
  eq('usage counter NOT reset by the downgrade', subA.usage.devices, 40);
  check(
    'over-quota resources reported',
    subA.getOverQuotaResources().includes('devices'),
    subA.getOverQuotaResources(),
  );

  // A second refund attempt must not reverse a second time.
  let secondRefundRejected = false;
  try {
    await payments.refundPayment(a.userId, { paymentId: upgradePayment.id });
  } catch (err) {
    secondRefundRejected = err instanceof ConflictException;
  }
  check('refunding an already-refunded payment is refused', secondRefundRejected);

  // ═════════════════════════════════════════════════════════════════════════
  section('4. Over-quota tenant: reads and existing resources keep working');

  const reflector = new Reflector();
  const subscriptionGuard = new SubscriptionGuard(reflector, subscriptions as any);
  const limitGuard = new SubscriptionLimitGuard(reflector);
  const user = { id: a.userId, role: UserRole.TENANT_ADMIN, tenantId: a.tenantId };

  const readRequest: any = { user };
  const guardPassed = await subscriptionGuard.canActivate(
    contextFor(QuotaProbe.prototype.listDevices, readRequest),
  );
  check('SubscriptionGuard admits an over-quota tenant (reads work)', guardPassed === true);
  check('SubscriptionGuard cached the subscription', !!readRequest.subscription);

  const readAllowed = await limitGuard.canActivate(
    contextFor(QuotaProbe.prototype.listDevices, readRequest),
  );
  check('a route with no quota decorator is allowed', readAllowed === true);

  // Operating an existing resource: a real UPDATE on a real row.
  const existing = await deviceRepo.findOneByOrFail({
    deviceKey: `dev_a_0_${a.tenantId.slice(0, 4)}`,
  });
  existing.name = 'Renamed while over quota';
  await deviceRepo.save(existing);
  eq(
    'an existing device can still be updated',
    (await deviceRepo.findOneByOrFail({ id: existing.id })).name,
    'Renamed while over quota',
  );

  const createRequest: any = { user };
  await subscriptionGuard.canActivate(
    contextFor(QuotaProbe.prototype.createDevice, createRequest),
  );
  let blocked: unknown;
  try {
    await limitGuard.canActivate(
      contextFor(QuotaProbe.prototype.createDevice, createRequest),
    );
  } catch (err) {
    blocked = err;
  }
  check(
    'creating a new device is blocked with Forbidden, not a crash',
    blocked instanceof ForbiddenException,
    blocked,
  );
  check(
    'the refusal names the real numbers',
    blocked instanceof ForbiddenException &&
      /40\/5/.test((blocked as ForbiddenException).message),
    blocked instanceof Error ? blocked.message : blocked,
  );
  eq(
    'service-level quota check agrees',
    await subscriptions.canTenantPerformAction(a.tenantId, 'devices'),
    false,
  );

  const lifecycleA = await subscriptions.getLifecycle(a.userId);
  eq('lifecycle reports it cannot create', lifecycleA.canCreateResources, false);
  check(
    'lifecycle lists the over-quota resource',
    lifecycleA.overQuota.includes('devices'),
    lifecycleA.overQuota,
  );

  // Deleting back under the ceiling must restore creation.
  const surplus = await deviceRepo.find({ where: { tenantId: a.tenantId }, take: 36 });
  await deviceRepo.remove(surplus);
  await subscriptions.syncUsageFromDB(a.tenantId);
  eq(
    'back under the limit after deleting surplus devices',
    await subscriptions.canTenantPerformAction(a.tenantId, 'devices'),
    true,
  );

  // ═════════════════════════════════════════════════════════════════════════
  section('5. Refund reverts to the previous PAID plan when it has time left');

  const b = await makeTenant(dataSource, 'refund-to-paid');
  let subB = await subscriptions.create(b.tenantId, {
    plan: SubscriptionPlan.FREE,
    billingPeriod: BillingPeriod.MONTHLY,
  });

  // FREE → STARTER
  const starterPayment = await makePayment(paymentRepo, {
    tenantId: b.tenantId,
    userId: b.userId,
    subscriptionId: subB.id,
    invoiceId: 'inv_starter_b',
    amount: 199,
    plan: SubscriptionPlan.STARTER,
    originalPlan: SubscriptionPlan.FREE,
    intent: 'upgrade',
  });
  paidInvoices.add('inv_starter_b');
  await payments.verifyPayment('inv_starter_b');

  // STARTER → PROFESSIONAL, with STARTER's period still running.
  subB = await subscriptions.findByTenantId(b.tenantId);
  const starterPeriodEnd = subB.nextBillingDate!;
  const proPayment = await makePayment(paymentRepo, {
    tenantId: b.tenantId,
    userId: b.userId,
    subscriptionId: subB.id,
    invoiceId: 'inv_pro_b',
    amount: 499,
    plan: SubscriptionPlan.PROFESSIONAL,
    originalPlan: SubscriptionPlan.STARTER,
    intent: 'upgrade',
  });
  paidInvoices.add('inv_pro_b');
  await payments.verifyPayment('inv_pro_b');
  subB = await subscriptions.findByTenantId(b.tenantId);
  eq('upgraded to professional', subB.plan, SubscriptionPlan.PROFESSIONAL);

  await payments.refundPayment(b.userId, { paymentId: proPayment.id, reason: 'misclick' });
  subB = await subscriptions.findByTenantId(b.tenantId);
  eq('refund reverted to the previous PAID plan', subB.plan, SubscriptionPlan.STARTER);
  eq('starter limits restored', subB.limits.devices, 50);
  eq(
    "starter's own paid period restored",
    subB.nextBillingDate!.toISOString(),
    new Date(starterPeriodEnd).toISOString(),
  );

  // Now refund the STARTER payment too, but with no paid period left behind it.
  await subscriptionRepo.update(
    { tenantId: b.tenantId },
    {
      metadata: {
        ...subB.metadata,
        previousPlan: {
          plan: SubscriptionPlan.STARTER,
          billingPeriod: BillingPeriod.MONTHLY,
          nextBillingDate: new Date(Date.now() - DAY_MS).toISOString(),
          at: new Date().toISOString(),
          paymentId: starterPayment.id,
        },
      } as any,
    },
  );
  await payments.refundPayment(b.userId, { paymentId: starterPayment.id });
  subB = await subscriptions.findByTenantId(b.tenantId);
  eq(
    'a reversal with no paid period left falls back to FREE',
    subB.plan,
    SubscriptionPlan.FREE,
  );

  // ═════════════════════════════════════════════════════════════════════════
  section('6. Partial refund does NOT downgrade; partials that total up do');

  const c = await makeTenant(dataSource, 'partial');
  let subC = await subscriptions.create(c.tenantId, {
    plan: SubscriptionPlan.FREE,
    billingPeriod: BillingPeriod.MONTHLY,
  });
  const cPayment = await makePayment(paymentRepo, {
    tenantId: c.tenantId,
    userId: c.userId,
    subscriptionId: subC.id,
    invoiceId: 'inv_pro_c',
    amount: 499,
    plan: SubscriptionPlan.PROFESSIONAL,
    originalPlan: SubscriptionPlan.FREE,
    intent: 'upgrade',
  });
  paidInvoices.add('inv_pro_c');
  await payments.verifyPayment('inv_pro_c');

  const partial = await payments.refundPayment(c.userId, {
    paymentId: cPayment.id,
    amount: 100,
    reason: 'goodwill credit',
  });
  eq('payment stays SUCCEEDED after a partial refund', partial.status, PaymentStatus.SUCCEEDED);
  eq('partial flag set', partial.metadata?.partialRefund, true);
  eq('refunded total tracked', partial.metadata?.refundedTotal, 100);
  subC = await subscriptions.findByTenantId(c.tenantId);
  eq('plan UNCHANGED by a partial refund', subC.plan, SubscriptionPlan.PROFESSIONAL);
  eq('no reversal recorded', subC.metadata?.reversals, undefined);

  let overRefund = false;
  try {
    await payments.refundPayment(c.userId, { paymentId: cPayment.id, amount: 450 });
  } catch {
    overRefund = true;
  }
  check('a refund beyond the refundable balance is refused', overRefund);

  const completed = await payments.refundPayment(c.userId, {
    paymentId: cPayment.id,
    amount: 399,
  });
  eq('payment REFUNDED once partials total the charge', completed.status, PaymentStatus.REFUNDED);
  eq('refunded total is the full charge', completed.metadata?.refundedTotal, 499);
  subC = await subscriptions.findByTenantId(c.tenantId);
  eq('plan reversed when the partials complete', subC.plan, SubscriptionPlan.FREE);

  // ═════════════════════════════════════════════════════════════════════════
  section('7. Chargeback and the refund webhook reach the same reversal');

  const d = await makeTenant(dataSource, 'chargeback');
  let subD = await subscriptions.create(d.tenantId, {
    plan: SubscriptionPlan.FREE,
    billingPeriod: BillingPeriod.MONTHLY,
  });
  const dPayment = await makePayment(paymentRepo, {
    tenantId: d.tenantId,
    userId: d.userId,
    subscriptionId: subD.id,
    invoiceId: 'inv_pro_d',
    amount: 499,
    plan: SubscriptionPlan.PROFESSIONAL,
    originalPlan: SubscriptionPlan.FREE,
    intent: 'upgrade',
  });
  paidInvoices.add('inv_pro_d');
  await payments.verifyPayment('inv_pro_d');

  const callsBefore = refundCalls.length;
  await payments.handleWebhook({
    type: 'payment_chargeback',
    data: { invoice_id: 'inv_pro_d' },
  });
  subD = await subscriptions.findByTenantId(d.tenantId);
  eq('chargeback webhook reversed the plan', subD.plan, SubscriptionPlan.FREE);
  eq('chargeback kind recorded', subD.metadata?.reversals?.[0].kind, 'chargeback');
  eq('no provider call made for a chargeback', refundCalls.length, callsBefore);
  eq(
    'payment marked refunded by the chargeback',
    (await paymentRepo.findOneByOrFail({ id: dPayment.id })).status,
    PaymentStatus.REFUNDED,
  );

  // The same chargeback delivered twice.
  await payments.handleWebhook({
    type: 'payment_chargeback',
    data: { invoice_id: 'inv_pro_d' },
  });
  subD = await subscriptions.findByTenantId(d.tenantId);
  eq('duplicate chargeback does not reverse twice', subD.metadata?.reversals?.length, 1);

  // A dashboard-issued refund arriving only as a webhook.
  const e = await makeTenant(dataSource, 'webhook-refund');
  const subE0 = await subscriptions.create(e.tenantId, {
    plan: SubscriptionPlan.FREE,
    billingPeriod: BillingPeriod.MONTHLY,
  });
  await makePayment(paymentRepo, {
    tenantId: e.tenantId,
    userId: e.userId,
    subscriptionId: subE0.id,
    invoiceId: 'inv_pro_e',
    amount: 499,
    plan: SubscriptionPlan.PROFESSIONAL,
    originalPlan: SubscriptionPlan.FREE,
    intent: 'upgrade',
  });
  paidInvoices.add('inv_pro_e');
  await payments.verifyPayment('inv_pro_e');
  await payments.handleWebhook({
    type: 'payment_refunded',
    data: { invoice_id: 'inv_pro_e', refunded: 49900 },
  });
  eq(
    'payment_refunded webhook reversed the plan',
    (await subscriptions.findByTenantId(e.tenantId)).plan,
    SubscriptionPlan.FREE,
  );
  await payments.handleWebhook({
    type: 'payment_partially_refunded',
    data: { invoice_id: 'inv_pro_e', refunded: 1000 },
  });
  eq(
    'a partial-refund webhook on an already-reversed payment changes nothing further',
    (await subscriptions.findByTenantId(e.tenantId)).metadata?.reversals?.length,
    1,
  );

  // ═════════════════════════════════════════════════════════════════════════
  section('8. The same renewal webhook delivered twice renews ONCE');

  const f = await makeTenant(dataSource, 'renewal');
  const subF0 = await subscriptions.create(f.tenantId, {
    plan: SubscriptionPlan.FREE,
    billingPeriod: BillingPeriod.MONTHLY,
  });
  await makePayment(paymentRepo, {
    tenantId: f.tenantId,
    userId: f.userId,
    subscriptionId: subF0.id,
    invoiceId: 'inv_starter_f',
    amount: 199,
    plan: SubscriptionPlan.STARTER,
    originalPlan: SubscriptionPlan.FREE,
    intent: 'upgrade',
  });
  paidInvoices.add('inv_starter_f');
  await payments.verifyPayment('inv_starter_f');

  let subF = await subscriptions.findByTenantId(f.tenantId);
  const periodBefore = new Date(subF.nextBillingDate!).getTime();

  const renewal = await makePayment(paymentRepo, {
    tenantId: f.tenantId,
    userId: f.userId,
    subscriptionId: subF.id,
    invoiceId: 'inv_renew_f',
    amount: 199,
    plan: SubscriptionPlan.STARTER,
    originalPlan: SubscriptionPlan.STARTER,
    intent: 'renewal',
  });
  paidInvoices.add('inv_renew_f');

  const delivery = { type: 'invoice_paid', data: { invoice_id: 'inv_renew_f' } };
  await payments.handleWebhook(delivery);
  subF = await subscriptions.findByTenantId(f.tenantId);
  const afterFirst = new Date(subF.nextBillingDate!).getTime();
  check(
    'first delivery extended the period by ~1 month',
    afterFirst > periodBefore + 27 * DAY_MS && afterFirst < periodBefore + 32 * DAY_MS,
    { periodBefore: new Date(periodBefore), afterFirst: new Date(afterFirst) },
  );

  await payments.handleWebhook(delivery);
  subF = await subscriptions.findByTenantId(f.tenantId);
  eq(
    'second delivery did NOT extend again',
    new Date(subF.nextBillingDate!).getTime(),
    afterFirst,
  );

  // Force the payment row back to PENDING: this defeats verifyPayment()'s
  // status short-circuit, so only the applied-payments ledger can stop the
  // second month being given away.
  await paymentRepo.update(renewal.id, {
    status: PaymentStatus.PENDING,
    paidAt: undefined,
  });
  await payments.handleWebhook(delivery);
  subF = await subscriptions.findByTenantId(f.tenantId);
  eq(
    'ledger alone refuses a replay (payment forced back to PENDING)',
    new Date(subF.nextBillingDate!).getTime(),
    afterFirst,
  );
  eq(
    'one ledger entry for the renewal payment',
    Object.keys(subF.metadata?.appliedPayments ?? {}).filter((k) => k === renewal.id)
      .length,
    1,
  );

  // Concurrent delivery of a fresh renewal.
  const renewal2 = await makePayment(paymentRepo, {
    tenantId: f.tenantId,
    userId: f.userId,
    subscriptionId: subF.id,
    invoiceId: 'inv_renew_f2',
    amount: 199,
    plan: SubscriptionPlan.STARTER,
    originalPlan: SubscriptionPlan.STARTER,
    intent: 'renewal',
  });
  paidInvoices.add('inv_renew_f2');
  const before2 = new Date(subF.nextBillingDate!).getTime();
  const concurrent = { type: 'invoice_paid', data: { invoice_id: 'inv_renew_f2' } };
  await Promise.all([
    payments.handleWebhook(concurrent),
    payments.handleWebhook(concurrent),
  ]);
  subF = await subscriptions.findByTenantId(f.tenantId);
  const after2 = new Date(subF.nextBillingDate!).getTime();
  check(
    'two CONCURRENT deliveries extended the period exactly once',
    after2 > before2 + 27 * DAY_MS && after2 < before2 + 32 * DAY_MS,
    {
      before: new Date(before2),
      after: new Date(after2),
      ledger: subF.metadata?.appliedPayments?.[renewal2.id],
    },
  );

  // A renewal that fails payment opens a grace window rather than cutting off.
  const failing = await makePayment(paymentRepo, {
    tenantId: f.tenantId,
    userId: f.userId,
    subscriptionId: subF.id,
    invoiceId: 'inv_renew_f3',
    amount: 199,
    plan: SubscriptionPlan.STARTER,
    originalPlan: SubscriptionPlan.STARTER,
    intent: 'renewal',
  });
  await payments.handleWebhook({
    type: 'invoice_expired',
    data: { invoice_id: 'inv_renew_f3' },
  });
  subF = await subscriptions.findByTenantId(f.tenantId);
  eq(
    'failed renewal payment is recorded as cancelled',
    (await paymentRepo.findOneByOrFail({ id: failing.id })).status,
    PaymentStatus.CANCELLED,
  );
  eq('failed renewal keeps the plan for now', subF.plan, SubscriptionPlan.STARTER);
  check('failed renewal opened a grace window', subF.isPastDue(), subF.metadata?.pastDue);

  // ═════════════════════════════════════════════════════════════════════════
  section('9. Trial: one per tenant, ever');

  const g = await makeTenant(dataSource, 'trial');
  await subscriptions.create(g.tenantId, {
    plan: SubscriptionPlan.FREE,
    billingPeriod: BillingPeriod.MONTHLY,
  });

  let subG = await subscriptions.startTrial(g.userId, SubscriptionPlan.PROFESSIONAL);
  eq('trial status', subG.status, SubscriptionStatus.TRIAL);
  eq('trial plan', subG.plan, SubscriptionPlan.PROFESSIONAL);
  eq('trial gets the plan limits', subG.limits.devices, 200);
  check('trialEndsAt ~14 days out', (() => {
    const delta = new Date(subG.trialEndsAt!).getTime() - Date.now();
    return delta > 13 * DAY_MS && delta < 15 * DAY_MS;
  })(), subG.trialEndsAt);
  eq('a trial never auto-charges', subG.isAutoRenewEnabled(), false);
  eq('trial recorded as used', subG.hasUsedTrial(), true);

  // The guard must admit a TRIAL tenant. findByTenantId used to filter on
  // status = 'active', which made a trial look like no subscription at all.
  const trialRequest: any = {
    user: { id: g.userId, role: UserRole.TENANT_ADMIN, tenantId: g.tenantId },
  };
  let trialGuard: unknown;
  try {
    trialGuard = await subscriptionGuard.canActivate(
      contextFor(QuotaProbe.prototype.listDevices, trialRequest),
    );
  } catch (err) {
    trialGuard = err;
  }
  check('SubscriptionGuard admits a tenant on TRIAL', trialGuard === true, trialGuard);

  // Cancel must work (it always threw 409 before) and must not create a row.
  const cancelled = await subscriptions.cancel(g.userId);
  eq('cancel sets CANCELLED', cancelled.status, SubscriptionStatus.CANCELLED);
  eq('cancel did not create a second subscription row', await subscriptionRepo.count({ where: { tenantId: g.tenantId } }), 1);

  let recreate = false;
  try {
    await subscriptions.create(g.tenantId, { plan: SubscriptionPlan.STARTER });
  } catch (err) {
    recreate = err instanceof ConflictException;
  }
  check('re-subscribing after cancel is refused (no fresh trial row)', recreate);

  // Expire the trial through the cron, then try for a second one.
  await subscriptionRepo.update(
    { tenantId: g.tenantId },
    {
      status: SubscriptionStatus.TRIAL,
      trialEndsAt: new Date(Date.now() - DAY_MS),
      nextBillingDate: new Date(Date.now() - DAY_MS),
    },
  );
  await subscriptions.sweepExpiredSubscriptions();
  subG = await subscriptions.findByTenantId(g.tenantId);
  eq('expired trial lands on FREE', subG.plan, SubscriptionPlan.FREE);
  eq('expired trial is ACTIVE, not locked out', subG.status, SubscriptionStatus.ACTIVE);
  eq('trialEndsAt cleared so the guard stops 403ing', subG.trialEndsAt ?? null, null);
  eq('trial still recorded as used', subG.hasUsedTrial(), true);
  check('trial expiry timestamped', !!subG.metadata?.trial?.expiredAt);

  let secondTrial: unknown;
  try {
    await subscriptions.startTrial(g.userId, SubscriptionPlan.STARTER);
  } catch (err) {
    secondTrial = err;
  }
  check(
    'a second trial is refused with 409',
    secondTrial instanceof ConflictException,
    secondTrial,
  );

  // ═════════════════════════════════════════════════════════════════════════
  section('10. Auto-renew toggle and "your plan ends on X"');

  const h = await makeTenant(dataSource, 'autorenew');
  const subH0 = await subscriptions.create(h.tenantId, {
    plan: SubscriptionPlan.FREE,
    billingPeriod: BillingPeriod.MONTHLY,
  });
  await makePayment(paymentRepo, {
    tenantId: h.tenantId,
    userId: h.userId,
    subscriptionId: subH0.id,
    invoiceId: 'inv_starter_h',
    amount: 199,
    plan: SubscriptionPlan.STARTER,
    originalPlan: SubscriptionPlan.FREE,
    intent: 'upgrade',
  });
  paidInvoices.add('inv_starter_h');
  await payments.verifyPayment('inv_starter_h');

  let lifecycle = await subscriptions.getLifecycle(h.userId);
  eq('auto-renew defaults to ON for an upgraded plan', lifecycle.autoRenew, true);
  eq('willRenew true', lifecycle.willRenew, true);
  eq('accessEndsAt null while renewing', lifecycle.accessEndsAt, null);
  check('renewing message', /renews on \d{4}-\d{2}-\d{2}/.test(lifecycle.message), lifecycle.message);

  lifecycle = await subscriptions.setAutoRenew(h.userId, false);
  const subH = await subscriptions.findByTenantId(h.tenantId);
  eq('auto-renew off', lifecycle.autoRenew, false);
  eq('willRenew false', lifecycle.willRenew, false);
  eq(
    'accessEndsAt is the end of the paid period',
    lifecycle.accessEndsAt?.toISOString(),
    new Date(subH.nextBillingDate!).toISOString(),
  );
  check(
    '"ends on" message carries the date',
    /ends on \d{4}-\d{2}-\d{2}/.test(lifecycle.message),
    lifecycle.message,
  );

  // Period ends with auto-renew off → FREE, no grace (they already said stop).
  await subscriptionRepo.update(
    { tenantId: h.tenantId },
    { nextBillingDate: new Date(Date.now() - DAY_MS) },
  );
  await subscriptions.sweepExpiredSubscriptions();
  eq(
    'period end with auto-renew off drops straight to FREE',
    (await subscriptions.findByTenantId(h.tenantId)).plan,
    SubscriptionPlan.FREE,
  );

  // ═════════════════════════════════════════════════════════════════════════
  section('11. The sweep drives every remaining expiry');

  // (a) cancelled subscription whose paid period ran out
  const i = await makeTenant(dataSource, 'sweep-cancel');
  const subI0 = await subscriptions.create(i.tenantId, {
    plan: SubscriptionPlan.FREE,
    billingPeriod: BillingPeriod.MONTHLY,
  });
  await makePayment(paymentRepo, {
    tenantId: i.tenantId,
    userId: i.userId,
    subscriptionId: subI0.id,
    invoiceId: 'inv_pro_i',
    amount: 499,
    plan: SubscriptionPlan.PROFESSIONAL,
    originalPlan: SubscriptionPlan.FREE,
    intent: 'upgrade',
  });
  paidInvoices.add('inv_pro_i');
  await payments.verifyPayment('inv_pro_i');
  await subscriptions.cancel(i.userId);

  let subI = await subscriptions.findByTenantId(i.tenantId);
  eq('cancelled tenant keeps the plan until the period ends', subI.plan, SubscriptionPlan.PROFESSIONAL);
  check(
    'cancelled tenant is shown an end date',
    (await subscriptions.getLifecycle(i.userId)).message.includes('ends on'),
    (await subscriptions.getLifecycle(i.userId)).message,
  );
  await subscriptions.sweepExpiredSubscriptions();
  subI = await subscriptions.findByTenantId(i.tenantId);
  eq('a cancelled subscription inside its period is NOT swept', subI.plan, SubscriptionPlan.PROFESSIONAL);

  // Cancelling must not lock the tenant out of the period they paid for.
  const cancelledRequest: any = {
    user: { id: i.userId, role: UserRole.TENANT_ADMIN, tenantId: i.tenantId },
  };
  let cancelledGuard: unknown;
  try {
    cancelledGuard = await subscriptionGuard.canActivate(
      contextFor(QuotaProbe.prototype.listDevices, cancelledRequest),
    );
  } catch (err) {
    cancelledGuard = err;
  }
  check(
    'a cancelled tenant still has access inside the paid period',
    cancelledGuard === true,
    cancelledGuard,
  );
  eq(
    'and can still create resources it has quota for',
    await subscriptions.canTenantPerformAction(i.tenantId, 'devices'),
    true,
  );

  await subscriptionRepo.update(
    { tenantId: i.tenantId },
    { nextBillingDate: new Date(Date.now() - DAY_MS) },
  );
  let summary = await subscriptions.sweepExpiredSubscriptions();
  subI = await subscriptions.findByTenantId(i.tenantId);
  eq('cancellation completed → FREE', subI.plan, SubscriptionPlan.FREE);
  eq('cancellation completed → ACTIVE', subI.status, SubscriptionStatus.ACTIVE);
  check('completion timestamped', !!subI.metadata?.cancellation?.completedAt);
  check('sweep counted it', summary.cancellationsCompleted >= 1, summary);
  eq(
    'post-cancellation the tenant is on FREE quota',
    subI.limits.devices,
    5,
  );
  check(
    'a CANCELLED row whose period has passed is no longer "active"',
    !subscriptionRepo.create({
      status: SubscriptionStatus.CANCELLED,
      nextBillingDate: new Date(Date.now() - DAY_MS),
    }).isActive(),
  );

  // (b) auto-renew ON, period over, no payment → grace, then FREE
  const j = await makeTenant(dataSource, 'sweep-grace');
  const subJ0 = await subscriptions.create(j.tenantId, {
    plan: SubscriptionPlan.FREE,
    billingPeriod: BillingPeriod.MONTHLY,
  });
  await makePayment(paymentRepo, {
    tenantId: j.tenantId,
    userId: j.userId,
    subscriptionId: subJ0.id,
    invoiceId: 'inv_pro_j',
    amount: 499,
    plan: SubscriptionPlan.PROFESSIONAL,
    originalPlan: SubscriptionPlan.FREE,
    intent: 'upgrade',
  });
  paidInvoices.add('inv_pro_j');
  await payments.verifyPayment('inv_pro_j');
  await deviceRepo.save(
    deviceRepo.create({
      tenantId: j.tenantId,
      userId: j.userId,
      deviceKey: `dev_j_${j.tenantId.slice(0, 6)}`,
      name: 'Survivor',
    }),
  );
  await subscriptions.syncUsageFromDB(j.tenantId);

  await subscriptionRepo.update(
    { tenantId: j.tenantId },
    { nextBillingDate: new Date(Date.now() - DAY_MS) },
  );
  summary = await subscriptions.sweepExpiredSubscriptions();
  let subJ = await subscriptions.findByTenantId(j.tenantId);
  eq('missed renewal keeps the plan during grace', subJ.plan, SubscriptionPlan.PROFESSIONAL);
  check('grace window opened', subJ.isPastDue(), subJ.metadata?.pastDue);
  check('sweep counted the grace', summary.gracePeriodsStarted >= 1, summary);
  check(
    'the tenant is told what happens next',
    (await subscriptions.getLifecycle(j.userId)).message.includes('not been received'),
    (await subscriptions.getLifecycle(j.userId)).message,
  );

  // A second sweep inside the window must not re-open or extend it.
  const graceEnd = subJ.metadata!.pastDue!.graceEndsAt;
  await subscriptions.sweepExpiredSubscriptions();
  subJ = await subscriptions.findByTenantId(j.tenantId);
  eq('grace window is not extended by later sweeps', subJ.metadata?.pastDue?.graceEndsAt, graceEnd);

  await subscriptionRepo.update(
    { tenantId: j.tenantId },
    {
      metadata: {
        ...subJ.metadata,
        pastDue: {
          ...subJ.metadata!.pastDue!,
          graceEndsAt: new Date(Date.now() - DAY_MS).toISOString(),
        },
      } as any,
    },
  );
  summary = await subscriptions.sweepExpiredSubscriptions();
  subJ = await subscriptions.findByTenantId(j.tenantId);
  eq('grace expired → FREE', subJ.plan, SubscriptionPlan.FREE);
  eq('grace expired → still ACTIVE', subJ.status, SubscriptionStatus.ACTIVE);
  eq('pastDue cleared', subJ.metadata?.pastDue ?? null, null);
  check('sweep counted the downgrade', summary.downgradedAfterGrace >= 1, summary);
  eq(
    'the device created on the paid plan still exists',
    await deviceRepo.count({ where: { tenantId: j.tenantId } }),
    1,
  );

  // (c) ENTERPRISE is invoiced out of band — never swept off its plan
  const k = await makeTenant(dataSource, 'sweep-enterprise');
  await subscriptions.create(k.tenantId, {
    plan: SubscriptionPlan.FREE,
    billingPeriod: BillingPeriod.MONTHLY,
  });
  await subscriptionRepo.update(
    { tenantId: k.tenantId },
    {
      plan: SubscriptionPlan.ENTERPRISE,
      status: SubscriptionStatus.ACTIVE,
      nextBillingDate: new Date(Date.now() - DAY_MS),
      metadata: { autoRenew: true } as any,
    },
  );
  await subscriptions.sweepExpiredSubscriptions();
  const subK = await subscriptions.findByTenantId(k.tenantId);
  eq('enterprise keeps its plan past the period', subK.plan, SubscriptionPlan.ENTERPRISE);
  check(
    'enterprise period rolled forward',
    new Date(subK.nextBillingDate!).getTime() > Date.now(),
    subK.nextBillingDate,
  );

  // (d) a FREE subscription is never a sweep candidate
  const freeBefore = await subscriptions.findByTenantId(a.tenantId);
  await subscriptions.sweepExpiredSubscriptions();
  const freeAfter = await subscriptions.findByTenantId(a.tenantId);
  eq('FREE is untouched by the sweep', freeAfter.plan, freeBefore.plan);
  eq('FREE status untouched', freeAfter.status, freeBefore.status);

  // ═════════════════════════════════════════════════════════════════════════
  section('12. Renewal quote');

  const quote = await subscriptions.requestRenewal(i.userId).catch((e) => e);
  check(
    'renewing a FREE plan is refused',
    quote instanceof Error && /does not expire/.test(quote.message),
    quote,
  );

  const renewQuote = await subscriptions.requestRenewal(f.userId);
  eq('renewal quote plan', renewQuote.plan, SubscriptionPlan.STARTER);
  eq('renewal quote amount', renewQuote.amount, 199);
  eq('renewal requires payment', renewQuote.requiresPayment, true);
  const yearly = await subscriptions.requestRenewal(f.userId, BillingPeriod.YEARLY);
  eq('yearly renewal quote amount', yearly.amount, 1990);
  const entQuote = await subscriptions.requestRenewal(k.userId).catch((e) => e);
  check(
    'enterprise renewal is referred to sales, not priced at 0',
    entQuote instanceof Error && /sales/.test(entQuote.message),
    entQuote,
  );

  // ═════════════════════════════════════════════════════════════════════════
  section('13. createPaymentIntent writes what the lifecycle depends on');

  // A tenant with NO subscription row at all — the path that used to pass a
  // user id where a tenant id was wanted and die on the tenants(id) FK.
  const m = await makeTenant(dataSource, 'intent');
  const mUser: any = { id: m.userId, tenantId: m.tenantId };

  const intent = await payments.createPaymentIntent(mUser, {
    plan: SubscriptionPlan.STARTER,
    billingPeriod: BillingPeriod.MONTHLY,
  });
  eq('invoice amount quoted', intent.amount, 199);
  check('payment url returned', !!intent.paymentUrl, intent.paymentUrl);
  eq(
    'a FREE subscription was created for the TENANT',
    (await subscriptions.findByTenantId(m.tenantId)).tenantId,
    m.tenantId,
  );

  let mPayment = await paymentRepo.findOneByOrFail({
    paymentIntentId: intent.invoiceId,
  });
  eq('payment starts PENDING', mPayment.status, PaymentStatus.PENDING);
  eq('intent recorded as upgrade', mPayment.metadata?.intent, 'upgrade');
  eq('original plan recorded', mPayment.metadata?.originalPlan, SubscriptionPlan.FREE);

  // Asking again for the same thing reuses the open invoice rather than
  // creating a second one the tenant could also pay.
  const invoicesBefore = createdInvoices;
  const again = await payments.createPaymentIntent(mUser, {
    plan: SubscriptionPlan.STARTER,
    billingPeriod: BillingPeriod.MONTHLY,
  });
  eq('an open invoice is reused', again.invoiceId, intent.invoiceId);
  eq('no second invoice created', createdInvoices, invoicesBefore);

  paidInvoices.add(intent.invoiceId);
  await payments.verifyPayment(intent.invoiceId);
  eq(
    'paying the created invoice upgrades the plan',
    (await subscriptions.findByTenantId(m.tenantId)).plan,
    SubscriptionPlan.STARTER,
  );

  // Same plan again → RENEWAL, which is what makes a failed payment open a
  // grace period instead of being ignored.
  const renewIntent = await payments.createPaymentIntent(mUser, {
    plan: SubscriptionPlan.STARTER,
    billingPeriod: BillingPeriod.MONTHLY,
  });
  mPayment = await paymentRepo.findOneByOrFail({
    paymentIntentId: renewIntent.invoiceId,
  });
  eq('intent recorded as renewal', mPayment.metadata?.intent, 'renewal');

  // And a downgrade cannot be bought.
  const downgrade = await payments
    .createPaymentIntent(mUser, {
      plan: SubscriptionPlan.FREE,
      billingPeriod: BillingPeriod.MONTHLY,
    })
    .catch((e) => e);
  check(
    'a payment for the FREE plan is refused',
    downgrade instanceof Error,
    downgrade,
  );

  // ═════════════════════════════════════════════════════════════════════════
  await dataSource.destroy();

  console.log(
    failures === 0
      ? '\n✅ All subscription lifecycle checks passed\n'
      : `\n❌ ${failures} check(s) failed\n`,
  );
  process.exit(failures === 0 ? 0 : 1);
})().catch((err) => {
  console.error('\n💥 Verification crashed:', err);
  process.exit(1);
});
