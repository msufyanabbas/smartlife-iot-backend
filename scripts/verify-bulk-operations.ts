/**
 * Verifies the bulk delete / bulk update routes against a real PostgreSQL
 * database.
 *
 *   createdb bulkcheck && npx ts-node -r tsconfig-paths/register \
 *     scripts/verify-bulk-operations.ts bulkcheck
 *
 * Why this and not an HTTP e2e script: booting the application needs a
 * reachable Kafka broker (CLAUDE.md §11), so the services are wired by hand
 * here. Everything below the controller is the real thing — real TypeORM
 * repositories, real SQL, real per-item transactions, the real
 * SubscriptionsService maintaining the real `subscriptions.usage` jsonb, and
 * the real global ValidationPipe configuration from main.ts for the cap.
 *
 * What it proves, in order:
 *   1. Schema initialises with the new DTOs/entities in play.
 *   2. DEVICES — a mixed batch returns one outcome per id with the right
 *      successes (deletable), not_found (another tenant's id, unknown id) and
 *      blocked (open alarm).
 *   3. DEVICES — the other tenant's device is STILL THERE and not soft-deleted.
 *   4. DEVICES — the delete was SOFT: the rows are still in `devices` with
 *      `deleted_at` set.
 *   5. DEVICES — cascades: credentials hard-gone, floor-plan placement
 *      soft-gone, customer/user assignment rows gone, and the counters they
 *      feed (customers.usageCounters.devices, customer_user_limits) moved by
 *      exactly the right amount.
 *   6. DEVICES — subscriptions.usage.devices moved by exactly -2 for the
 *      acting tenant and NOT AT ALL for the other tenant.
 *   7. DEVICES — the batch cap is a 400 from the real ValidationPipe.
 *   8. DEVICES — bulk update: per-id outcomes, `skipped` for a no-op, a
 *      foreign id untouched, and a foreign customerId rejected for the whole
 *      request.
 *   9. USERS — a mixed batch: successes, another tenant's id rejected and not
 *      deleted, self blocked, the last tenant admin blocked.
 *  10. USERS — soft delete confirmed in the rows, and
 *      subscriptions.usage.users moved by exactly -2 / 0.
 *  11. USERS — the cap is a 400, and `role` / `password` / `email` in a bulk
 *      update body are a 400 (forbidNonWhitelisted), which is what keeps the
 *      allowed field set narrow.
 */
import { DataSource, Repository } from 'typeorm';
import { randomUUID } from 'crypto';
import { ValidationPipe, BadRequestException } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import * as entities from '../src/modules/index.entities';
import { Device } from '../src/modules/devices/entities/device.entity';
import { User } from '../src/modules/users/entities/user.entity';
import { Customer } from '../src/modules/customers/entities/customers.entity';
import { Subscription } from '../src/modules/subscriptions/entities/subscription.entity';
import { Tenant } from '../src/modules/tenants/entities/tenant.entity';
import { Asset } from '../src/modules/assets/entities/asset.entity';
import { DeviceProfile } from '../src/modules/profiles/entities/device-profile.entity';
import { Dashboard } from '../src/modules/dashboards/entities/dashboard.entity';
import { RuleChain } from '../src/modules/rules/entities/rule-chain.entity';
import { FloorPlan } from '../src/modules/floor-plans/entities/floor-plan.entity';
import { Automation } from '../src/modules/automation/entities/automation.entity';
import { Payment } from '../src/modules/payments/entities/payment.entity';
import { Role } from '../src/modules/roles/entities/roles.entity';
import { Permission } from '../src/modules/permissions/entities/permissions.entity';
import { DevicesService } from '../src/modules/devices/devices.service';
import { UsersService } from '../src/modules/users/users.service';
import { CustomersService } from '../src/modules/customers/customers.service';
import { NotificationsService } from '../src/modules/notifications/notifications.service';
import { Notification } from '../src/modules/notifications/entities/notification.entity';
import { SubscriptionsService } from '../src/modules/subscriptions/subscriptions.service';
import { BulkDeleteDevicesDto, BulkUpdateDevicesDto } from '../src/modules/devices/dto/bulk-device.dto';
import { BulkDeleteUsersByIdDto, BulkUpdateUsersDto } from '../src/modules/users/dto/bulk-user.dto';
import { BulkOutcome, BULK_MAX_IDS } from '../src/common/dto/bulk-operation.dto';
import {
  AlarmSeverity,
  AlarmStatus,
  CustomerStatus,
  DeviceStatus,
  DeviceType,
  UserRole,
  UserStatus,
} from '../src/common/enums/index.enum';
import { inMemoryRedis } from './support/in-memory-redis';
import { SubscriptionCacheService } from '../src/lib/redis/subscription-cache.service';
import { PermissionCacheService } from '../src/lib/redis/permission-cache.service';

const database = process.argv[2] ?? 'bulkcheck';

let failures = 0;
const check = (label: string, condition: boolean, detail?: unknown) => {
  if (condition) {
    console.log(`  ✓ ${label}`);
  } else {
    failures++;
    console.error(`  ✗ ${label}`, detail === undefined ? '' : detail);
  }
};
const section = (title: string) => console.log(`\n── ${title} ─────────────`);

/** Mirrors main.ts exactly — this is the pipe that turns the cap into a 400. */
const globalPipe = new ValidationPipe({
  whitelist: true,
  transform: true,
  forbidNonWhitelisted: true,
  transformOptions: { enableImplicitConversion: true },
});

async function expect400(
  label: string,
  dtoType: any,
  body: unknown,
): Promise<void> {
  try {
    await globalPipe.transform(body as any, {
      type: 'body',
      metatype: dtoType,
    });
    check(label, false, 'validation accepted the body');
  } catch (err) {
    const is400 =
      err instanceof BadRequestException && err.getStatus() === 400;
    check(label, is400, err);
  }
}

const TENANT_A = randomUUID();
const TENANT_B = randomUUID();

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

  section('1. Schema');
  await dataSource.initialize();
  check('DataSource initialises', true);

  const q = (sql: string, params?: unknown[]) => dataSource.query(sql, params);

  // ── Clean slate for repeated runs ─────────────────────────────────────────
  for (const table of [
    'notifications',
    'user_devices',
    'customer_devices',
    'customer_user_limits',
    'floor_plan_devices',
    'floor_plans',
    'alarms',
    'device_credentials',
    'devices',
    'assets',
    'customers',
    'subscriptions',
    'users',
    'tenants',
  ]) {
    await q(`TRUNCATE TABLE ${table} CASCADE`);
  }

  // ── Fixtures ──────────────────────────────────────────────────────────────
  // Raw INSERTs so the User entity's @BeforeInsert password hook and the
  // services' own side effects stay out of the fixture setup.
  for (const [index, id] of [TENANT_A, TENANT_B].entries()) {
    await q(`INSERT INTO tenants (id, name, email) VALUES ($1, $2, $3)`, [
      id,
      `Bulk fixture tenant ${index + 1}`,
      `bulk-t${index}-${id.slice(0, 8)}@example.invalid`,
    ]);
  }

  const DEVICE_LIMITS = {
    devices: 1000,
    dashboards: 100,
    assets: 100,
    users: 100,
    ruleChains: 100,
    floorPlans: 100,
    automations: 100,
    customers: 100,
  };
  const START_USAGE = { devices: 10, users: 10, customers: 5 };

  for (const tenantId of [TENANT_A, TENANT_B]) {
    await q(
      `INSERT INTO subscriptions (id, "tenantId", plan, status, limits, usage, features)
       VALUES ($1, $2, 'professional', 'active', $3, $4, '{}')`,
      [
        randomUUID(),
        tenantId,
        JSON.stringify(DEVICE_LIMITS),
        JSON.stringify(START_USAGE),
      ],
    );
  }

  const mkUser = async (
    tenantId: string,
    role: UserRole,
    label: string,
    customerId?: string,
  ): Promise<string> => {
    const id = randomUUID();
    await q(
      `INSERT INTO users (id, email, password, name, role, status, "tenantId", "customerId")
       VALUES ($1, $2, 'not-a-real-hash', $3, $4, $5, $6, $7)`,
      [
        id,
        `${label}-${id.slice(0, 8)}@example.invalid`,
        label,
        role,
        UserStatus.ACTIVE,
        tenantId,
        customerId ?? null,
      ],
    );
    return id;
  };

  const adminA = await mkUser(TENANT_A, UserRole.TENANT_ADMIN, 'admin-a');
  const adminA2 = await mkUser(TENANT_A, UserRole.TENANT_ADMIN, 'admin-a2');
  const adminB = await mkUser(TENANT_B, UserRole.TENANT_ADMIN, 'admin-b');

  const actorA = {
    id: adminA,
    role: UserRole.TENANT_ADMIN,
    tenantId: TENANT_A,
    email: 'admin-a@example.invalid',
  } as User;

  const mkCustomer = async (
    tenantId: string,
    devicesCounter: number,
  ): Promise<string> => {
    const id = randomUUID();
    await q(
      `INSERT INTO customers (id, name, email, "tenantId", status, "allocatedLimits", "usageCounters")
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [
        id,
        `Customer ${id.slice(0, 8)}`,
        `cust-${id.slice(0, 8)}@example.invalid`,
        tenantId,
        CustomerStatus.ACTIVE,
        JSON.stringify({ devices: 50 }),
        JSON.stringify({
          devices: devicesCounter,
          dashboards: 0,
          assets: 0,
          floorPlans: 0,
          automations: 0,
          users: 0,
        }),
      ],
    );
    return id;
  };

  const customerA = await mkCustomer(TENANT_A, 3);
  const customerB = await mkCustomer(TENANT_B, 0);

  const mkDevice = async (
    tenantId: string,
    ownerId: string,
    label: string,
    customerId?: string,
  ): Promise<string> => {
    const id = randomUUID();
    await q(
      `INSERT INTO devices (id, "tenantId", "deviceKey", name, type, status, "userId", "customerId")
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [
        id,
        tenantId,
        `dev_${id.slice(0, 12)}`,
        label,
        DeviceType.SENSOR,
        DeviceStatus.INACTIVE,
        ownerId,
        customerId ?? null,
      ],
    );
    await q(
      `INSERT INTO device_credentials (id, "deviceId", "credentialsType", "credentialsId", "credentialsValue")
       VALUES ($1, $2, 'ACCESS_TOKEN', $3, 'secret')`,
      [randomUUID(), id, `cred_${id.slice(0, 12)}`],
    );
    return id;
  };

  const devA1 = await mkDevice(TENANT_A, adminA, 'A device 1', customerA);
  const devA2 = await mkDevice(TENANT_A, adminA, 'A device 2');
  const devAAlarmed = await mkDevice(TENANT_A, adminA, 'A device alarmed');
  const devB1 = await mkDevice(TENANT_B, adminB, 'B device 1');
  const UNKNOWN_DEVICE = randomUUID();

  // An ACTIVE alarm on devAAlarmed — the documented block rule.
  await q(
    `INSERT INTO alarms (id, "tenantId", name, severity, status, rule, "deviceId")
     VALUES ($1, $2, 'High temperature', $3, $4, $5, $6)`,
    [
      randomUUID(),
      TENANT_A,
      AlarmSeverity.CRITICAL,
      AlarmStatus.ACTIVE,
      JSON.stringify({ telemetryKey: 'temperature', condition: 'GREATER_THAN', threshold: 40 }),
      devAAlarmed,
    ],
  );

  // devA1 carries every kind of reference a device can carry: a floor-plan
  // placement, a customer assignment and a user assignment, each with its own
  // denormalised counter.
  const assetA = randomUUID();
  await q(
    `INSERT INTO assets (id, "tenantId", name, type) VALUES ($1, $2, 'HQ', 'building')`,
    [assetA, TENANT_A],
  );
  const floorPlanA = randomUUID();
  await q(
    `INSERT INTO floor_plans (id, "tenantId", "assetId", "userId", name, building, floor, dimensions)
     VALUES ($1, $2, $3, $4, 'Floor 1', 'HQ', '1', $5)`,
    [
      floorPlanA,
      TENANT_A,
      assetA,
      adminA,
      JSON.stringify({ width: 10, height: 10 }),
    ],
  );
  await q(
    `INSERT INTO floor_plan_devices (id, "tenantId", "floorPlanId", "deviceId") VALUES ($1, $2, $3, $4)`,
    [randomUUID(), TENANT_A, floorPlanA, devA1],
  );
  await q(
    `INSERT INTO customer_devices (id, "customerId", "tenantId", "deviceId") VALUES ($1, $2, $3, $4)`,
    [randomUUID(), customerA, TENANT_A, devA1],
  );
  const customerUserA = await mkUser(
    TENANT_A,
    UserRole.CUSTOMER_USER,
    'cu-a',
    customerA,
  );
  await q(
    `INSERT INTO user_devices (id, "userId", "customerId", "tenantId", "deviceId") VALUES ($1, $2, $3, $4, $5)`,
    [randomUUID(), customerUserA, customerA, TENANT_A, devA1],
  );
  await q(
    `INSERT INTO customer_user_limits (id, "userId", "customerId", "tenantId", limits, "usageCounters")
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [
      randomUUID(),
      customerUserA,
      customerA,
      TENANT_A,
      JSON.stringify({ devices: 10 }),
      JSON.stringify({
        devices: 2,
        dashboards: 0,
        assets: 0,
        floorPlans: 0,
        automations: 0,
      }),
    ],
  );

  // ── Services, wired by hand ───────────────────────────────────────────────
  const repo = (e: any): any => dataSource.getRepository(e);
  const stub: any = new Proxy(
    {},
    { get: () => async () => undefined },
  );

  // The REAL SubscriptionsService, so the counter assertions below exercise
  // the production jsonb_set statements rather than a copy of them.
  const subscriptionsService = new SubscriptionsService(
    repo(Subscription),
    repo(Tenant),
    repo(Payment),
    repo(Device),
    repo(Dashboard),
    repo(Asset),
    repo(User),
    repo(RuleChain),
    repo(FloorPlan),
    repo(Automation),
    dataSource,
    // SubscriptionCacheService — a real in-memory cache rather than a
    // stub, so the invalidation path is exercised instead of skipped.
    new SubscriptionCacheService(inMemoryRedis()),
  );

  const devicesService = new DevicesService(
    repo(Device),
    repo(Asset),
    repo(DeviceProfile),
    stub, // ConfigService — unused by the bulk paths
    stub, // UsersService
    new EventEmitter2(),
    stub, // DeviceCredentialsService — the bulk path deletes credentials itself
    stub, // CodecRegistryService
    subscriptionsService,
    stub, // ProfileAlarmService
    dataSource,
  );

  const usersService = new UsersService(
    repo(User),
    new EventEmitter2(),
    stub, // MailService
    repo(Role),
    repo(Permission),
    stub, // NotificationsService
    subscriptionsService,
    stub, // ConfigService
    dataSource,
    // PermissionCacheService — UsersService bumps the cache epoch when a
    // role or grant changes. Real, so those bumps actually happen.
    new PermissionCacheService(inMemoryRedis()),
  );

  const notificationsService = new NotificationsService(
    repo(Notification),
    stub, // NotificationsRepository — unused by the bulk paths
    new EventEmitter2(),
    stub, // EmailChannel
    stub, // UsersService
    stub, // SmsChannel
    stub, // PushChannel
    stub, // PushSubscriptionsService — resolves a user's registered devices
    stub, // WhatsappChannel
    dataSource,
  );

  const customersService = new CustomersService(
    repo(Customer),
    repo(User),
    // The Permission repository, added when customers gained grantable
    // permissions. Real rather than a stub: the grant methods validate ids
    // against it, and a stub that answered undefined would let an invalid
    // grant look like a successful one.
    repo(Permission),
    stub, // TenantsService
    new EventEmitter2(),
    stub, // MailService
    stub, // UsersService
    subscriptionsService,
    dataSource,
    // PermissionCacheService. Real rather than `stub`, even though the bulk
    // paths do not change grants: `stub` is a Proxy answering undefined, so a
    // future bulk path that did invalidate would call `undefined()` and throw
    // inside the operation it was meant to make correct.
    new PermissionCacheService(inMemoryRedis()),
  );

  const usage = async (tenantId: string, key: string): Promise<number> => {
    const rows = await q(
      `SELECT (usage->>$2)::int AS v FROM subscriptions WHERE "tenantId" = $1`,
      [tenantId, key],
    );
    return Number(rows[0]?.v ?? 0);
  };
  const outcomeOf = (result: any, id: string) =>
    result.outcomes.find((o: any) => o.id === id);

  // ═══════════════════════════════════════════════════════════════════════════
  section('2. Devices — mixed batch returns per-id outcomes');

  const devicesUsageBeforeA = await usage(TENANT_A, 'devices');
  const devicesUsageBeforeB = await usage(TENANT_B, 'devices');

  const deleteResult = await devicesService.bulkDelete(
    {
      ids: [devA1, devA2, devAAlarmed, devB1, UNKNOWN_DEVICE],
    } as BulkDeleteDevicesDto,
    actorA,
  );

  check('requested counts all 5 ids', deleteResult.requested === 5, deleteResult);
  check('2 succeeded', deleteResult.succeeded === 2, deleteResult.succeeded);
  check('3 failed', deleteResult.failed === 3, deleteResult.failed);
  check(
    'own-tenant device A1 → success',
    outcomeOf(deleteResult, devA1)?.outcome === BulkOutcome.SUCCESS,
    outcomeOf(deleteResult, devA1),
  );
  check(
    'own-tenant device A2 → success',
    outcomeOf(deleteResult, devA2)?.outcome === BulkOutcome.SUCCESS,
    outcomeOf(deleteResult, devA2),
  );
  check(
    'device with an ACTIVE alarm → blocked, with a reason',
    outcomeOf(deleteResult, devAAlarmed)?.outcome === BulkOutcome.BLOCKED &&
      /alarm/i.test(outcomeOf(deleteResult, devAAlarmed)?.reason ?? ''),
    outcomeOf(deleteResult, devAAlarmed),
  );
  check(
    "OTHER TENANT's device → not_found (not 'forbidden' — the row's existence is not disclosed)",
    outcomeOf(deleteResult, devB1)?.outcome === BulkOutcome.NOT_FOUND,
    outcomeOf(deleteResult, devB1),
  );
  check(
    'unknown uuid → not_found',
    outcomeOf(deleteResult, UNKNOWN_DEVICE)?.outcome === BulkOutcome.NOT_FOUND,
    outcomeOf(deleteResult, UNKNOWN_DEVICE),
  );

  // ═══════════════════════════════════════════════════════════════════════════
  section('3. Devices — the other tenant\'s row was NOT touched');

  const [bRow] = await q(
    `SELECT deleted_at FROM devices WHERE id = $1`,
    [devB1],
  );
  check('tenant B device still present', bRow !== undefined);
  check('tenant B device NOT soft-deleted', bRow?.deleted_at === null, bRow);

  const [alarmedRow] = await q(
    `SELECT deleted_at FROM devices WHERE id = $1`,
    [devAAlarmed],
  );
  check('blocked device NOT soft-deleted', alarmedRow?.deleted_at === null, alarmedRow);

  // ═══════════════════════════════════════════════════════════════════════════
  section('4. Devices — the delete was SOFT, not a row removal');

  const softRows = await q(
    `SELECT id, deleted_at FROM devices WHERE id = ANY($1)`,
    [[devA1, devA2]],
  );
  check('both deleted devices are still rows in `devices`', softRows.length === 2, softRows);
  check(
    'both have deleted_at set',
    softRows.every((r: any) => r.deleted_at !== null),
    softRows,
  );
  const visible: Device[] = await repo(Device).find({
    where: { tenantId: TENANT_A },
  });
  check(
    'and are invisible to a normal (non-withDeleted) read',
    !visible.some((d) => d.id === devA1 || d.id === devA2),
    visible.map((d) => d.id),
  );

  // ═══════════════════════════════════════════════════════════════════════════
  section('5. Devices — documented cascades and their counters');

  const creds = await q(
    `SELECT id FROM device_credentials WHERE "deviceId" = ANY($1)`,
    [[devA1, devA2]],
  );
  check('credentials HARD deleted (they could still authenticate MQTT)', creds.length === 0, creds);

  const [placement] = await q(
    `SELECT deleted_at FROM floor_plan_devices WHERE "deviceId" = $1`,
    [devA1],
  );
  check('floor-plan placement soft-removed', placement?.deleted_at !== null, placement);

  const custAssign = await q(
    `SELECT id FROM customer_devices WHERE "deviceId" = $1`,
    [devA1],
  );
  check('customer_devices assignment removed', custAssign.length === 0, custAssign);

  const userAssign = await q(
    `SELECT id FROM user_devices WHERE "deviceId" = $1`,
    [devA1],
  );
  check('user_devices assignment removed', userAssign.length === 0, userAssign);

  const [custCounter] = await q(
    `SELECT ("usageCounters"->>'devices')::int AS v FROM customers WHERE id = $1`,
    [customerA],
  );
  check(
    'customers.usageCounters.devices 3 → 2 (the one assignment that existed)',
    Number(custCounter?.v) === 2,
    custCounter,
  );

  const [limitCounter] = await q(
    `SELECT ("usageCounters"->>'devices')::int AS v FROM customer_user_limits WHERE "userId" = $1`,
    [customerUserA],
  );
  check(
    'customer_user_limits.usageCounters.devices 2 → 1',
    Number(limitCounter?.v) === 1,
    limitCounter,
  );

  // ═══════════════════════════════════════════════════════════════════════════
  section('6. Devices — subscription quota moved by exactly the right amount');

  const devicesUsageAfterA = await usage(TENANT_A, 'devices');
  const devicesUsageAfterB = await usage(TENANT_B, 'devices');
  check(
    `tenant A devices usage ${devicesUsageBeforeA} → ${devicesUsageAfterA} (−2)`,
    devicesUsageAfterA === devicesUsageBeforeA - 2,
  );
  check(
    `tenant B devices usage unchanged at ${devicesUsageBeforeB}`,
    devicesUsageAfterB === devicesUsageBeforeB,
  );

  // ═══════════════════════════════════════════════════════════════════════════
  section('7. Devices — the batch cap is enforced as a 400');

  await expect400(
    `${BULK_MAX_IDS + 1} ids → 400 before any row is read`,
    BulkDeleteDevicesDto,
    { ids: Array.from({ length: BULK_MAX_IDS + 1 }, () => randomUUID()) },
  );
  const atCap = await globalPipe.transform(
    { ids: Array.from({ length: BULK_MAX_IDS }, () => randomUUID()) } as any,
    { type: 'body', metatype: BulkDeleteDevicesDto },
  );
  check(`exactly ${BULK_MAX_IDS} ids is accepted`, (atCap as any).ids.length === BULK_MAX_IDS);
  await expect400('empty ids → 400', BulkDeleteDevicesDto, { ids: [] });
  await expect400('a non-uuid id → 400', BulkDeleteDevicesDto, {
    ids: ['not-a-uuid'],
  });

  // ═══════════════════════════════════════════════════════════════════════════
  section('8. Devices — bulk update');

  const devA4 = await mkDevice(TENANT_A, adminA, 'A device 4');
  await q(`UPDATE devices SET status = $2 WHERE id = $1`, [
    devA4,
    DeviceStatus.MAINTENANCE,
  ]);

  const updateResult = await devicesService.bulkUpdate(
    {
      ids: [devAAlarmed, devA4, devB1],
      status: DeviceStatus.MAINTENANCE,
    } as BulkUpdateDevicesDto,
    actorA,
  );
  check(
    'in-tenant device → success',
    outcomeOf(updateResult, devAAlarmed)?.outcome === BulkOutcome.SUCCESS,
    outcomeOf(updateResult, devAAlarmed),
  );
  check(
    'device already in the requested state → skipped (counts as a success)',
    outcomeOf(updateResult, devA4)?.outcome === BulkOutcome.SKIPPED,
    outcomeOf(updateResult, devA4),
  );
  check(
    "OTHER TENANT's device → not_found",
    outcomeOf(updateResult, devB1)?.outcome === BulkOutcome.NOT_FOUND,
    outcomeOf(updateResult, devB1),
  );
  const [bAfterUpdate] = await q(`SELECT status FROM devices WHERE id = $1`, [
    devB1,
  ]);
  check(
    "OTHER TENANT's device status unchanged",
    bAfterUpdate?.status === DeviceStatus.INACTIVE,
    bAfterUpdate,
  );
  check('succeeded = 2 (1 success + 1 skipped)', updateResult.succeeded === 2, updateResult);

  // A shared target that belongs to another tenant must fail the whole
  // request, not quietly re-parent devices into tenant B's customer.
  let foreignCustomerRejected = false;
  try {
    await devicesService.bulkUpdate(
      { ids: [devAAlarmed], customerId: customerB } as BulkUpdateDevicesDto,
      actorA,
    );
  } catch {
    foreignCustomerRejected = true;
  }
  check(
    "a customerId from ANOTHER TENANT is rejected for the whole request",
    foreignCustomerRejected,
  );
  const [stillUnassigned] = await q(
    `SELECT "customerId" FROM devices WHERE id = $1`,
    [devAAlarmed],
  );
  check(
    'and no device was re-parented',
    stillUnassigned?.customerId === null,
    stillUnassigned,
  );

  // Unassigning with an explicit null actually writes NULL (save() would have
  // treated `undefined` as "unchanged" and silently done nothing).
  await devicesService.bulkUpdate(
    { ids: [devAAlarmed], customerId: customerA } as BulkUpdateDevicesDto,
    actorA,
  );
  await devicesService.bulkUpdate(
    { ids: [devAAlarmed], customerId: null } as BulkUpdateDevicesDto,
    actorA,
  );
  const [unassigned] = await q(
    `SELECT "customerId" FROM devices WHERE id = $1`,
    [devAAlarmed],
  );
  check('customerId: null really clears the column', unassigned?.customerId === null, unassigned);

  await expect400(
    'bulk update with no updatable field → 400',
    BulkUpdateDevicesDto,
    { ids: [randomUUID()], deviceKey: 'dev_hijack' },
  );

  // ═══════════════════════════════════════════════════════════════════════════
  section('9. Users — mixed batch returns per-id outcomes');

  const userA1 = await mkUser(TENANT_A, UserRole.USER, 'plain-a1');
  const userA2 = await mkUser(TENANT_A, UserRole.USER, 'plain-a2');
  const userB1 = await mkUser(TENANT_B, UserRole.USER, 'plain-b1');
  const UNKNOWN_USER = randomUUID();

  // Leave tenant A with a single admin so the last-admin block can fire.
  await q(`UPDATE users SET deleted_at = now() WHERE id = $1`, [adminA2]);

  const usersUsageBeforeA = await usage(TENANT_A, 'users');
  const usersUsageBeforeB = await usage(TENANT_B, 'users');

  const userDelete = await usersService.bulkDelete(
    {
      ids: [userA1, userA2, userB1, adminA, UNKNOWN_USER],
    } as BulkDeleteUsersByIdDto,
    actorA,
  );

  check('requested counts all 5 ids', userDelete.requested === 5, userDelete);
  check('2 succeeded', userDelete.succeeded === 2, userDelete.succeeded);
  check('3 failed', userDelete.failed === 3, userDelete.failed);
  check(
    'in-tenant user A1 → success',
    outcomeOf(userDelete, userA1)?.outcome === BulkOutcome.SUCCESS,
    outcomeOf(userDelete, userA1),
  );
  check(
    'in-tenant user A2 → success',
    outcomeOf(userDelete, userA2)?.outcome === BulkOutcome.SUCCESS,
    outcomeOf(userDelete, userA2),
  );
  check(
    "OTHER TENANT's user → not_found",
    outcomeOf(userDelete, userB1)?.outcome === BulkOutcome.NOT_FOUND,
    outcomeOf(userDelete, userB1),
  );
  check(
    'the caller / last tenant admin → blocked',
    outcomeOf(userDelete, adminA)?.outcome === BulkOutcome.BLOCKED,
    outcomeOf(userDelete, adminA),
  );
  check(
    'unknown uuid → not_found',
    outcomeOf(userDelete, UNKNOWN_USER)?.outcome === BulkOutcome.NOT_FOUND,
    outcomeOf(userDelete, UNKNOWN_USER),
  );

  // ═══════════════════════════════════════════════════════════════════════════
  section('10. Users — soft delete, foreign row intact, quota moved');

  const [bUserRow] = await q(`SELECT deleted_at FROM users WHERE id = $1`, [
    userB1,
  ]);
  check('tenant B user still present', bUserRow !== undefined);
  check('tenant B user NOT soft-deleted', bUserRow?.deleted_at === null, bUserRow);

  const [adminRow] = await q(`SELECT deleted_at FROM users WHERE id = $1`, [
    adminA,
  ]);
  check('the blocked admin NOT soft-deleted', adminRow?.deleted_at === null, adminRow);

  const deletedUserRows = await q(
    `SELECT id, deleted_at FROM users WHERE id = ANY($1)`,
    [[userA1, userA2]],
  );
  check(
    'both deleted users are still rows in `users`',
    deletedUserRows.length === 2,
    deletedUserRows,
  );
  check(
    'both have deleted_at set',
    deletedUserRows.every((r: any) => r.deleted_at !== null),
    deletedUserRows,
  );

  const usersUsageAfterA = await usage(TENANT_A, 'users');
  const usersUsageAfterB = await usage(TENANT_B, 'users');
  check(
    `tenant A users usage ${usersUsageBeforeA} → ${usersUsageAfterA} (−2)`,
    usersUsageAfterA === usersUsageBeforeA - 2,
  );
  check(
    `tenant B users usage unchanged at ${usersUsageBeforeB}`,
    usersUsageAfterB === usersUsageBeforeB,
  );

  // Last-admin block also applies to a bulk DEACTIVATION, which locks a
  // tenant out just as effectively as a delete.
  const statusResult = await usersService.bulkUpdate(
    { ids: [adminA], status: UserStatus.SUSPENDED } as BulkUpdateUsersDto,
    { ...actorA, id: randomUUID() } as User,
  );
  check(
    'suspending the last active tenant admin → blocked',
    outcomeOf(statusResult, adminA)?.outcome === BulkOutcome.BLOCKED,
    outcomeOf(statusResult, adminA),
  );

  // A foreign user's status must be untouched by a bulk update too.
  const foreignStatus = await usersService.bulkUpdate(
    { ids: [userB1], status: UserStatus.SUSPENDED } as BulkUpdateUsersDto,
    actorA,
  );
  check(
    "OTHER TENANT's user → not_found on bulk update",
    outcomeOf(foreignStatus, userB1)?.outcome === BulkOutcome.NOT_FOUND,
    outcomeOf(foreignStatus, userB1),
  );
  const [bStatus] = await q(`SELECT status FROM users WHERE id = $1`, [userB1]);
  check(
    "OTHER TENANT's user status unchanged",
    bStatus?.status === UserStatus.ACTIVE,
    bStatus,
  );

  // ═══════════════════════════════════════════════════════════════════════════
  section('11. Users — cap, and the narrow field set is enforced by validation');

  await expect400(
    `${BULK_MAX_IDS + 1} ids → 400`,
    BulkDeleteUsersByIdDto,
    { ids: Array.from({ length: BULK_MAX_IDS + 1 }, () => randomUUID()) },
  );
  for (const forbidden of [
    { field: 'role', body: { ids: [randomUUID()], role: UserRole.TENANT_ADMIN } },
    { field: 'password', body: { ids: [randomUUID()], password: 'Hijacked123!' } },
    { field: 'tenantId', body: { ids: [randomUUID()], tenantId: TENANT_B } },
    { field: 'email', body: { ids: [randomUUID()], email: 'x@example.invalid' } },
  ]) {
    await expect400(
      `bulk user update carrying \`${forbidden.field}\` → 400`,
      BulkUpdateUsersDto,
      forbidden.body,
    );
  }

  // ═══════════════════════════════════════════════════════════════════════════
  section('12. Customers — the block rule and the paired-account cascade');

  const custWithDevice = await mkCustomer(TENANT_A, 0);
  await mkDevice(TENANT_A, adminA, 'attached device', custWithDevice);
  const custEmpty = await mkCustomer(TENANT_A, 0);
  const pairedUser = await mkUser(
    TENANT_A,
    UserRole.CUSTOMER,
    'paired',
    custEmpty,
  );

  const customersUsageBefore = await usage(TENANT_A, 'customers');
  const usersUsageBefore2 = await usage(TENANT_A, 'users');

  const custResult = await customersService.bulkDelete(
    { ids: [custWithDevice, custEmpty, customerB] },
    actorA,
  );
  check(
    'customer with a device still assigned → blocked',
    outcomeOf(custResult, custWithDevice)?.outcome === BulkOutcome.BLOCKED,
    outcomeOf(custResult, custWithDevice),
  );
  check(
    'customer with nothing attached → success',
    outcomeOf(custResult, custEmpty)?.outcome === BulkOutcome.SUCCESS,
    outcomeOf(custResult, custEmpty),
  );
  check(
    "OTHER TENANT's customer → not_found",
    outcomeOf(custResult, customerB)?.outcome === BulkOutcome.NOT_FOUND,
    outcomeOf(custResult, customerB),
  );
  const [customerBRow] = await q(
    `SELECT deleted_at FROM customers WHERE id = $1`,
    [customerB],
  );
  check(
    "OTHER TENANT's customer NOT deleted",
    customerBRow?.deleted_at === null,
    customerBRow,
  );
  const [deletedCust] = await q(
    `SELECT deleted_at FROM customers WHERE id = $1`,
    [custEmpty],
  );
  check('deleted customer is soft-deleted', deletedCust?.deleted_at !== null, deletedCust);
  const [pairedRow] = await q(`SELECT deleted_at FROM users WHERE id = $1`, [
    pairedUser,
  ]);
  check(
    'the paired login account was soft-removed with it',
    pairedRow?.deleted_at !== null,
    pairedRow,
  );
  check(
    `customers usage ${customersUsageBefore} → ${await usage(TENANT_A, 'customers')} (−1)`,
    (await usage(TENANT_A, 'customers')) === customersUsageBefore - 1,
  );
  check(
    `users usage ${usersUsageBefore2} → ${await usage(TENANT_A, 'users')} (−1, the paired account)`,
    (await usage(TENANT_A, 'users')) === usersUsageBefore2 - 1,
  );

  // ═══════════════════════════════════════════════════════════════════════════
  section('13. Notifications — role-based scope on a bulk batch');

  const mkNotification = async (
    tenantId: string,
    userId: string,
    isRead: boolean,
  ): Promise<string> => {
    const id = randomUUID();
    await q(
      `INSERT INTO notifications (id, "tenantId", "userId", type, channel, priority, status, title, message, "isRead")
       VALUES ($1, $2, $3, 'system', 'in_app', 'normal', 'pending', 'Fixture', 'Fixture message', $4)`,
      [id, tenantId, userId, isRead],
    );
    return id;
  };

  const notifA = await mkNotification(TENANT_A, adminA, false);
  const notifARead = await mkNotification(TENANT_A, adminA, true);
  const notifB = await mkNotification(TENANT_B, adminB, false);

  const notifUpdate = await notificationsService.bulkUpdate(
    { ids: [notifA, notifARead, notifB], isRead: true },
    actorA,
  );
  check(
    'unread in-tenant notification → success',
    outcomeOf(notifUpdate, notifA)?.outcome === BulkOutcome.SUCCESS,
    outcomeOf(notifUpdate, notifA),
  );
  check(
    'already-read notification → skipped',
    outcomeOf(notifUpdate, notifARead)?.outcome === BulkOutcome.SKIPPED,
    outcomeOf(notifUpdate, notifARead),
  );
  check(
    "OTHER TENANT's notification → not_found",
    outcomeOf(notifUpdate, notifB)?.outcome === BulkOutcome.NOT_FOUND,
    outcomeOf(notifUpdate, notifB),
  );
  const [notifBRow] = await q(
    `SELECT "isRead" FROM notifications WHERE id = $1`,
    [notifB],
  );
  check(
    "OTHER TENANT's notification still unread",
    notifBRow?.isRead === false,
    notifBRow,
  );
  const [notifARow] = await q(
    `SELECT "isRead", "readAt" FROM notifications WHERE id = $1`,
    [notifA],
  );
  check('isRead: true also stamps readAt', notifARow?.readAt !== null, notifARow);

  const notifDelete = await notificationsService.bulkDelete(
    { ids: [notifA, notifB] },
    actorA,
  );
  check(
    'in-tenant notification deleted, foreign one not_found',
    outcomeOf(notifDelete, notifA)?.outcome === BulkOutcome.SUCCESS &&
      outcomeOf(notifDelete, notifB)?.outcome === BulkOutcome.NOT_FOUND,
    notifDelete.outcomes,
  );
  const [notifASoft] = await q(
    `SELECT deleted_at FROM notifications WHERE id = $1`,
    [notifA],
  );
  check('notification delete was soft', notifASoft?.deleted_at !== null, notifASoft);
  const [notifBAlive] = await q(
    `SELECT deleted_at FROM notifications WHERE id = $1`,
    [notifB],
  );
  check(
    "OTHER TENANT's notification NOT deleted",
    notifBAlive?.deleted_at === null,
    notifBAlive,
  );

  // A plain USER sees only their own rows, even inside their own tenant.
  const plainUser = await mkUser(TENANT_A, UserRole.USER, 'scoped');
  const notifOther = await mkNotification(TENANT_A, adminA, false);
  const notifMine = await mkNotification(TENANT_A, plainUser, false);
  const scopedResult = await notificationsService.bulkDelete(
    { ids: [notifMine, notifOther] },
    {
      id: plainUser,
      role: UserRole.USER,
      tenantId: TENANT_A,
      email: 'scoped@example.invalid',
    } as User,
  );
  check(
    "a plain USER can delete their own notification but not a colleague's",
    outcomeOf(scopedResult, notifMine)?.outcome === BulkOutcome.SUCCESS &&
      outcomeOf(scopedResult, notifOther)?.outcome === BulkOutcome.NOT_FOUND,
    scopedResult.outcomes,
  );

  await dataSource.destroy();

  console.log(
    failures === 0
      ? '\nAll bulk-operation checks passed.\n'
      : `\n${failures} check(s) FAILED.\n`,
  );
  process.exit(failures === 0 ? 0 : 1);
})().catch((err) => {
  console.error('\nFATAL', err);
  process.exit(1);
});
