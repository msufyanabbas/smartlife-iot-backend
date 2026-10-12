// src/modules/subscriptions/subscriptions.service.ts
import {
  Injectable,
  NotFoundException,
  ConflictException,
  Logger,
  BadRequestException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, QueryRunner, DataSource } from 'typeorm';
import { Cron, CronExpression } from '@nestjs/schedule';
import {
  SubscriptionPlan,
  SubscriptionStatus,
  BillingPeriod,
  SupportLevel,
  UserRole,
} from '@common/enums/index.enum';
import {
  SubscriptionFeatures,
  SubscriptionLimits,
  SubscriptionUsage,
  EMPTY_USAGE,
} from '@common/interfaces/index.interface';
import {
  Subscription,
  Customer,
  Device,
  Tenant,
  Dashboard,
  Asset,
  RuleChain,
  FloorPlan,
  Automation,
  User,
  Payment,
} from '@modules/index.entities';
import {
  PLAN_FEATURES as SHARED_PLAN_FEATURES,
  resolveFeatures,
} from './plan-features';
import {
  CreateSubscriptionDto,
  UpgradeSubscriptionDto,
} from './dto/create-subscription.dto';
import { UsersService } from '@modules/index.service';
import {
  PaginatedResponseDto,
  PaginationDto,
} from '@/common/dto/pagination.dto';

// ─────────────────────────────────────────────────────────────────────────────
// Plan Configuration
//
// SYNC RULE: when you add a field to SubscriptionLimits or SubscriptionFeatures
// in subscription.entity.ts, add it to EVERY plan config below.
// TypeScript will error here if you miss one (the Record type enforces it).
// ─────────────────────────────────────────────────────────────────────────────

const PLAN_PRICING: Record<SubscriptionPlan, Record<BillingPeriod, number>> = {
  [SubscriptionPlan.FREE]: {
    [BillingPeriod.MONTHLY]: 0,
    [BillingPeriod.YEARLY]: 0,
  },
  [SubscriptionPlan.STARTER]: {
    [BillingPeriod.MONTHLY]: 199,
    [BillingPeriod.YEARLY]: 1990,
  },
  [SubscriptionPlan.PROFESSIONAL]: {
    [BillingPeriod.MONTHLY]: 499,
    [BillingPeriod.YEARLY]: 4990,
  },
  [SubscriptionPlan.ENTERPRISE]: {
    [BillingPeriod.MONTHLY]: 0,
    [BillingPeriod.YEARLY]: 0,
  },
};

// Plan trial periods in days (0 = no trial)
const PLAN_TRIAL_DAYS: Record<SubscriptionPlan, number> = {
  [SubscriptionPlan.FREE]: 0,
  [SubscriptionPlan.STARTER]: 14,
  [SubscriptionPlan.PROFESSIONAL]: 14,
  [SubscriptionPlan.ENTERPRISE]: 30,
};

// These must match SubscriptionLimits exactly — TypeScript enforces it
const PLAN_LIMITS: Record<SubscriptionPlan, SubscriptionLimits> = {
  [SubscriptionPlan.FREE]: {
    devices: 5,
    dashboards: 1,
    assets: 10,
    floorPlans: 0,
    automations: 0,
    ruleChains: 0,
    users: 2,
    customers: 1,
    apiCallsPerMonth: 10_000,
    storageGB: 1,
    smsNotificationsPerMonth: 0,
    maxFloorPlans: 1,
    maxDevicesPerFloorPlan: 5,
  },
  [SubscriptionPlan.STARTER]: {
    devices: 50,
    dashboards: 5,
    assets: 100,
    floorPlans: 5,
    automations: 10,
    ruleChains: 5,
    users: 5,
    customers: 5,
    apiCallsPerMonth: 100_000,
    storageGB: 10,
    smsNotificationsPerMonth: 100,
    maxFloorPlans: 5,
    maxDevicesPerFloorPlan: 20,
  },
  [SubscriptionPlan.PROFESSIONAL]: {
    devices: 200,
    dashboards: 20,
    assets: 500,
    floorPlans: 20,
    automations: -1, // unlimited
    ruleChains: 25,
    users: 20,
    customers: 20,
    apiCallsPerMonth: 500_000,
    storageGB: 50,
    smsNotificationsPerMonth: 500,
    maxFloorPlans: 25,
    maxDevicesPerFloorPlan: 100,
  },
  [SubscriptionPlan.ENTERPRISE]: {
    devices: -1,
    dashboards: -1,
    assets: -1,
    floorPlans: -1,
    automations: -1,
    ruleChains: -1,
    users: -1,
    customers: -1,
    apiCallsPerMonth: -1,
    storageGB: 500,
    smsNotificationsPerMonth: -1,
    maxFloorPlans: -1,
    maxDevicesPerFloorPlan: -1,
  },
};

// PLAN_FEATURES, PLAN_LIMITS and the per-plan feature table used to be declared
// here AND, separately, inside subscription.seeder.ts — two hand-maintained
// copies that had already drifted. A tenant seeded by `npm run seed` got a
// different set of menus from a tenant created through this service: the
// seeder's copy never set devices/assets/floorPlans/automations/apiAccess at
// all, and its ENTERPRISE entry dropped the spread, so the top plan resolved to
// almost nothing. Both now read the one table in ./plan-features.
const PLAN_FEATURES = SHARED_PLAN_FEATURES;

const PLAN_ORDER: SubscriptionPlan[] = [
  SubscriptionPlan.FREE,
  SubscriptionPlan.STARTER,
  SubscriptionPlan.PROFESSIONAL,
  SubscriptionPlan.ENTERPRISE,
];

/**
 * Explicit NULL for a nullable timestamp column.
 *
 * TypeORM's `save()` IGNORES a property set to `undefined` — it reads as "not
 * provided" and the column keeps whatever it held. So `subscription.trialEndsAt
 * = undefined` does not clear the column; it does nothing at all, which is why
 * a trial's end date survived an upgrade and a cancellation date survived a
 * renewal. A null does clear it.
 *
 * The entity properties are declared `?: Date` rather than `Date | null`
 * because other modules read them, so the null needs a cast — CLEARED is that
 * cast, written once with the reason attached.
 */
const CLEARED = null as unknown as undefined;

const PLAN_DISPLAY_NAMES: Record<SubscriptionPlan, string> = {
  [SubscriptionPlan.FREE]: 'Free',
  [SubscriptionPlan.STARTER]: 'Starter',
  [SubscriptionPlan.PROFESSIONAL]: 'Professional',
  [SubscriptionPlan.ENTERPRISE]: 'Enterprise',
};

// ─────────────────────────────────────────────────────────────────────────────
// Service
// ─────────────────────────────────────────────────────────────────────────────

@Injectable()
export class SubscriptionsService {
  private readonly logger = new Logger(SubscriptionsService.name);

  /**
   * Days a paid plan survives a failed or missing renewal payment before the
   * sweep drops it to FREE. `SUBSCRIPTION_GRACE_PERIOD_DAYS`, default 3.
   *
   * Clamped to 0–30: a typo that reads as 3000 would keep an unpaid tenant on
   * a paid plan for eight years.
   */
  private readonly gracePeriodDays: number = Math.min(
    30,
    Math.max(0, Number(process.env.SUBSCRIPTION_GRACE_PERIOD_DAYS ?? 3) || 0),
  );

  constructor(
    @InjectRepository(Subscription)
    private readonly subscriptionRepository: Repository<Subscription>,
    @InjectRepository(Tenant)
    private readonly tenantRepository: Repository<Tenant>,
    @InjectRepository(Payment)
    private readonly paymentRepository: Repository<Payment>,
    // Read-only, for syncUsageFromDB(). Registered as bare repositories rather
    // than by importing each owning module — SubscriptionsModule is @Global and
    // half of these modules already depend on it, so module imports would cycle.
    @InjectRepository(Device)
    private readonly deviceRepository: Repository<Device>,
    @InjectRepository(Dashboard)
    private readonly dashboardRepository: Repository<Dashboard>,
    @InjectRepository(Asset)
    private readonly assetRepository: Repository<Asset>,
    @InjectRepository(User)
    private readonly userRepository: Repository<User>,
    @InjectRepository(RuleChain)
    private readonly ruleChainRepository: Repository<RuleChain>,
    @InjectRepository(FloorPlan)
    private readonly floorPlanRepository: Repository<FloorPlan>,
    @InjectRepository(Automation)
    private readonly automationRepository: Repository<Automation>,
    private readonly dataSource: DataSource,
  ) {}

  /**
   * Returns tenant-wide usage from the cached subscription counters.
   * Much cheaper than counting rows — O(1) not O(n).
   */
  async getTenantUsage(tenantId: string): Promise<SubscriptionUsage> {
    const subscription = await this.subscriptionRepository.findOne({
      where: { tenantId },
    });

    if (!subscription) {
      return { ...EMPTY_USAGE };
    }
    return subscription.usage;
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // LIMIT & FEATURE CHECKS
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Returns true if the tenant can still create/assign this resource type.
   * Reads from cached usage counters — no live COUNT queries.
   */
  async canTenantPerformAction(
    tenantId: string | undefined,
    resource: keyof SubscriptionUsage,
  ): Promise<boolean> {
    const subscription = await this.subscriptionRepository.findOne({
      where: { tenantId },
    });
    if (!subscription || !subscription.isActive()) return false;
    if (subscription.isTrialExpired()) return false;
    return !subscription.isLimitReached(resource);
  }

  /**
   * Create subscription
   */
  async create(
    tenantId: string | undefined,
    createSubscriptionDto: CreateSubscriptionDto,
  ): Promise<Subscription> {
    // Existence is checked WITHOUT a status filter. `subscriptions` is
    // @Unique(['tenantId']), so a tenant whose row was CANCELLED or EXPIRED
    // used to pass this check and then die on a unique-constraint violation
    // (a 500, where a 409 was intended) — and if it had succeeded it would
    // have been a fresh row with a fresh TRIAL, i.e. a free trial farm: cancel,
    // re-create, trial again.
    const existing = await this.subscriptionRepository.findOne({
      where: { tenantId },
    });

    if (existing) {
      throw new ConflictException('Tenant already has a subscription');
    }

    const { plan, billingPeriod = BillingPeriod.MONTHLY } =
      createSubscriptionDto;
    const trialDays = PLAN_TRIAL_DAYS[plan];
    const startsTrial = plan !== SubscriptionPlan.FREE && trialDays > 0;
    const trialEndsAt = startsTrial
      ? this.calculateTrialEnd(trialDays)
      : undefined;
    const subscription = this.subscriptionRepository.create({
      plan,
      billingPeriod,
      price: PLAN_PRICING[plan][billingPeriod],
      limits: PLAN_LIMITS[plan],
      features: PLAN_FEATURES[plan],
      usage: {
        ...EMPTY_USAGE,
        users: 1,
        // devices: 0,
        // users: 1, // Creator counts as 1 user
        // customers: 0,
        // apiCalls: 0,
        // storage: 0,
        // smsNotifications: 0,
      },
      tenantId,
      createdBy: tenantId,
      status:
        plan === SubscriptionPlan.FREE
          ? SubscriptionStatus.ACTIVE
          : trialDays > 0
            ? SubscriptionStatus.TRIAL
            : SubscriptionStatus.ACTIVE,
      nextBillingDate: this.calculateNextBillingDate(billingPeriod),
      trialEndsAt,
      metadata: {
        lastUsageReset: new Date(),
        // A trial started here burns the tenant's one trial, exactly as
        // startTrial() does — otherwise registering straight onto a paid plan
        // would leave `trial.usedAt` unset and POST /subscriptions/trial would
        // hand out a second one.
        ...(startsTrial
          ? {
              trial: {
                usedAt: new Date().toISOString(),
                plan,
                endsAt: trialEndsAt!.toISOString(),
                fromPlan: SubscriptionPlan.FREE,
              },
            }
          : {}),
      },
    });

    return await this.subscriptionRepository.save(subscription);
  }

  /**
   * Get or create free subscription
   */
  async getOrCreateFreeSubscription(tenantId: string): Promise<Subscription> {
    try {
      return await this.findByTenantId(tenantId);
    } catch (error) {
      if (error instanceof NotFoundException) {
        this.logger.log(`Creating free subscription for tenant: ${tenantId}`);
        return await this.create(tenantId, {
          plan: SubscriptionPlan.FREE,
          billingPeriod: BillingPeriod.MONTHLY,
        });
      }
      throw error;
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // READ
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Primary lookup — by tenantId.
   * Used internally and by guards.
   *
   * Deliberately NOT filtered by `status = 'active'` any more. `subscriptions`
   * is `@Unique(['tenantId'])`, so there is exactly one row per tenant and the
   * filter could only ever hide it. What it actually did was make every
   * non-ACTIVE state indistinguishable from "no subscription":
   *
   *   - a tenant on a TRIAL had no subscription at all as far as
   *     `SubscriptionGuard` was concerned, so it answered every request with
   *     "No subscription found for this tenant. Please contact support." —
   *     trials were unusable, and so were the quota checks in
   *     CustomersService and SolutionTemplateService.
   *   - an EXPIRED / SUSPENDED / CANCELLED tenant got that same support
   *     message instead of the "not active, please renew" the guard is written
   *     to produce three lines further down.
   *
   * Status is still enforced — by `isActive()` / `isTrialExpired()` in
   * SubscriptionGuard, which is where that decision belongs.
   */
  async findByTenantId(tenantId: string | undefined): Promise<Subscription> {
    const subscription = await this.subscriptionRepository.findOne({
      where: { tenantId },
    });
    if (!subscription) {
      throw new NotFoundException('No subscription found for this tenant');
    }
    return subscription;
  }

  /**
   * Find current subscription
   */
  async findCurrent(userId: string | undefined): Promise<Subscription> {
    // userId from the controller — look up the user to get their tenantId
    const user = await this.dataSource
      .getRepository('users')
      .findOne({ where: { id: userId }, select: ['id', 'tenantId', 'role'] });

    if (!user) throw new NotFoundException('User not found');

    // ── Super admin: no tenant, therefore no subscription row ────────────────
    //
    // This used to throw 404, which had a consequence nobody had traced: the
    // frontend only writes its feature-flag store inside
    // `if (query.data?.features)`, so on a 404 the store stays null — and the
    // sidebar hides any item whose flag is not strictly `true`. A platform
    // super admin therefore saw almost NO navigation at all, and every
    // feature-gated route rendered the Unauthorized page. The account with the
    // most access had the least.
    //
    // A super admin is not subject to plan limits (every guard bypasses them for
    // SUPER_ADMIN), so the honest answer is "everything enabled", not an error.
    // Returned as an unsaved entity instance: nothing is persisted, and no
    // subscription row is created for an account that should not have one.
    if (!user.tenantId) {
      if (user.role !== UserRole.SUPER_ADMIN) {
        throw new NotFoundException(
          'No subscription associated with this account',
        );
      }

      const platformSubscription = this.subscriptionRepository.create({
        plan: SubscriptionPlan.ENTERPRISE,
        status: SubscriptionStatus.ACTIVE,
        billingPeriod: BillingPeriod.MONTHLY,
        limits: PLAN_LIMITS[SubscriptionPlan.ENTERPRISE],
        usage: { ...EMPTY_USAGE },
        features: resolveFeatures(SubscriptionPlan.ENTERPRISE, null),
      });
      return platformSubscription;
    }

    const subscription = await this.findByTenantId(user.tenantId);

    // Fill any flag the stored `features` jsonb does not mention from the plan
    // baseline before handing it to the client.
    //
    // This endpoint is what populates the frontend sidebar, and the two sides
    // read a missing key in OPPOSITE directions: the backend guards treat
    // absent as allowed, the sidebar treats absent as hidden
    // (`features[key] !== true` → filtered out). So every flag that existed in
    // the interface but never got written to a row — and every flag added after
    // a row was created — silently removed a menu for that tenant.
    //
    // Resolving on read also means new navigation flags need no backfill
    // migration: rows keep whatever an admin explicitly set, and only the
    // unmentioned keys come from the plan.
    //
    // Deliberately NOT applied in findByTenantId(): the guards call that one,
    // and filling in a baseline `false` where a key was previously absent would
    // turn a fail-open check into a denial. Widening enforcement is a separate
    // decision from showing the right menus.
    subscription.features = resolveFeatures(
      subscription.plan,
      subscription.features,
    );

    return subscription;
  }

  /**
   * findCurrent() for the methods that are going to WRITE.
   *
   * findCurrent() can legitimately return an unsaved, in-memory entity: a
   * SUPER_ADMIN has no tenant and therefore no subscription row, and answering
   * that request with "ENTERPRISE, everything enabled" is what keeps the sidebar
   * populated for the platform admin.
   *
   * That phantom has no `id` and no `tenantId`, so any `save()` on it is an
   * INSERT into a table whose `tenantId` is NOT NULL and UNIQUE — a 500 from a
   * not-null violation, where the old behaviour was a clean 404. Billing
   * operations are meaningless for an account with no subscription anyway, so
   * they get an explicit refusal instead.
   *
   * Read-only callers (getUsage, hasFeature) deliberately keep using
   * findCurrent() — the phantom answers those correctly.
   */
  private async findCurrentForMutation(
    userId: string | undefined,
  ): Promise<Subscription> {
    const subscription = await this.findCurrent(userId);

    if (!subscription.id) {
      throw new BadRequestException(
        'This account has no subscription to modify. Billing operations apply to a tenant, and platform administrators are not billed.',
      );
    }

    return subscription;
  }

  /**
   * Get all available plans — used by GET /subscriptions/plans
   */
  async getPlans() {
    return PLAN_ORDER.map((plan) => ({
      plan,
      name: PLAN_DISPLAY_NAMES[plan],
      monthlyPrice: PLAN_PRICING[plan][BillingPeriod.MONTHLY],
      yearlyPrice: PLAN_PRICING[plan][BillingPeriod.YEARLY],
      limits: PLAN_LIMITS[plan],
      features: PLAN_FEATURES[plan],
      trialPeriodDays: PLAN_TRIAL_DAYS[plan],
      popular: plan === SubscriptionPlan.PROFESSIONAL,
    }));
  }

  /**
   * Get usage statistics vs limits — used by GET /subscriptions/usage
   * Reads from cached usage counters — no COUNT(*) queries.
   */
  async getUsage(userId: string) {
    const subscription = await this.findCurrent(userId);

    return {
      current: subscription.usage,
      limits: subscription.limits,
      percentage: this.calculateUsagePercentages(
        subscription.usage,
        subscription.limits,
      ),
      warnings: this.generateUsageWarnings(
        subscription.usage,
        subscription.limits,
      ),
    };
  }

  /**
   * Calculate usage percentages
   */
  private calculateUsagePercentages(
    usage: SubscriptionUsage,
    limits: SubscriptionLimits,
  ): Record<string, number> {
    const pct = (used: number, limit: number | undefined): number => {
      if (limit === -1) return 0; // unlimited — show 0%
      if (limit === 0) return 100;
      return Math.min(100, Math.round((used / (limit ? limit : 0)) * 100));
    };

    return {
      devices: pct(usage.devices, limits.devices),
      dashboards: pct(usage.dashboards, limits.dashboards),
      assets: pct(usage.assets, limits.assets),
      floorPlans: pct(usage.floorPlans, limits.floorPlans),
      automations: pct(usage.automations, limits.automations),
      users: pct(usage.users, limits.users),
      customers: pct(usage.customers, limits.customers),
      apiCalls: pct(usage.apiCalls, limits.apiCallsPerMonth),
      storageGB: pct(usage.storageGB, limits.storageGB),
      smsNotifications: pct(
        usage.smsNotifications,
        limits.smsNotificationsPerMonth,
      ),
    };
  }

  /**
   * Generate usage warnings
   */
  private generateUsageWarnings(
    usage: SubscriptionUsage,
    limits: SubscriptionLimits,
  ): string[] {
    const warnings: string[] = [];
    const WARN_THRESHOLD = 80;

    const check = (label: string, used: number, limit: number | undefined) => {
      if (limit === -1 || limit === 0) return;
      const pct = (used / (limit ? limit : 1)) * 100;
      if (pct >= 100) {
        warnings.push(`${label} limit reached (${used}/${limit})`);
      } else if (pct >= WARN_THRESHOLD) {
        warnings.push(
          `${label} usage at ${Math.round(pct)}% (${used}/${limit})`,
        );
      }
    };

    check('Devices', usage.devices, limits.devices);
    check('Dashboards', usage.dashboards, limits.dashboards);
    check('Assets', usage.assets, limits.assets);
    check('Floor Plans', usage.floorPlans, limits.floorPlans);
    check('Automations', usage.automations, limits.automations);
    check('Users', usage.users, limits.users);
    check('Customers', usage.customers, limits.customers);
    check('API Calls', usage.apiCalls, limits.apiCallsPerMonth);
    check('Storage', usage.storageGB, limits.storageGB);
    check(
      'SMS Notifications',
      usage.smsNotifications,
      limits.smsNotificationsPerMonth,
    );

    return warnings;
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // PRIVATE HELPERS
  // ═══════════════════════════════════════════════════════════════════════════
  validateUpgrade(
    currentPlan: SubscriptionPlan,
    targetPlan: SubscriptionPlan,
  ): void {
    const currentIndex = PLAN_ORDER.indexOf(currentPlan);
    const targetIndex = PLAN_ORDER.indexOf(targetPlan);
    if (targetIndex <= currentIndex) {
      throw new BadRequestException(
        `Cannot upgrade from ${currentPlan} to ${targetPlan}. Use schedule downgrade instead.`,
      );
    }
  }

  /**
   * Check if plan change is an upgrade
   */
  isUpgrade(
    currentPlan: SubscriptionPlan,
    targetPlan: SubscriptionPlan,
  ): boolean {
    return PLAN_ORDER.indexOf(targetPlan) > PLAN_ORDER.indexOf(currentPlan);
  }

  /**
   * Upgrade subscription - called after payment
   */
  async upgradeAfterPayment(
    tenantId: string,
    plan: SubscriptionPlan,
    billingPeriod: BillingPeriod,
    paymentAmount: number,
    queryRunner?: QueryRunner,
    /**
     * Payment id. Written into `metadata.appliedPayments` so the same payment
     * cannot be applied twice (webhook retries), and onto `previousPlan` so a
     * refund of THIS payment knows what to reverse to.
     */
    paymentId?: string,
  ): Promise<Subscription> {
    const useTransaction = !!queryRunner;
    const repository = useTransaction
      ? queryRunner.manager.getRepository(Subscription)
      : this.subscriptionRepository;

    const subscription = await repository.findOne({
      where: { tenantId },
      lock: { mode: 'pessimistic_write' },
    });

    if (!subscription) {
      throw new NotFoundException('No subscription found');
    }

    // Idempotency, before validateUpgrade(): a second delivery of the same
    // payment finds the tenant already ON the target plan, and validateUpgrade
    // would then reject it as a downgrade — a 400 back to Moyasar for a payment
    // that was processed perfectly well, which is indistinguishable from a real
    // failure in the logs.
    const alreadyApplied = paymentId
      ? subscription.metadata?.appliedPayments?.[paymentId]
      : undefined;
    if (alreadyApplied) {
      this.logger.warn(
        `Upgrade for payment ${paymentId} already applied at ${alreadyApplied.at} — ignoring duplicate delivery (tenant ${tenantId})`,
      );
      return subscription;
    }

    this.validateUpgrade(subscription.plan, plan);

    if (Math.abs(paymentAmount - PLAN_PRICING[plan][billingPeriod]) > 0.01) {
      throw new BadRequestException(
        `Payment amount ${paymentAmount} does not match plan price ${PLAN_PRICING[plan][billingPeriod]}`,
      );
    }

    const previousPlan = subscription.plan;
    const previousBillingPeriod = subscription.billingPeriod;
    const previousNextBillingDate = subscription.nextBillingDate
      ? new Date(subscription.nextBillingDate).toISOString()
      : null;

    subscription.plan = plan;
    subscription.billingPeriod = billingPeriod;
    subscription.price = PLAN_PRICING[plan][billingPeriod];
    subscription.limits = PLAN_LIMITS[plan];
    subscription.features = PLAN_FEATURES[plan];
    subscription.status = SubscriptionStatus.ACTIVE;
    subscription.nextBillingDate = this.calculateNextBillingDate(billingPeriod);
    subscription.trialEndsAt = CLEARED;
    subscription.cancelledAt = CLEARED;
    subscription.updatedBy = tenantId;

    const nextBillingDate = subscription.nextBillingDate
      ? new Date(subscription.nextBillingDate).toISOString()
      : null;

    subscription.metadata = {
      ...subscription.metadata,
      scheduledDowngrade: undefined,
      // Paying clears a past-due grace period: money arrived.
      pastDue: undefined,
      cancellation: undefined,
      // What a refund of this payment reverses to. Nothing recorded this
      // before, which is why the refund path had nowhere to go but FREE.
      previousPlan: {
        plan: previousPlan,
        billingPeriod: previousBillingPeriod,
        nextBillingDate: previousNextBillingDate,
        at: new Date().toISOString(),
        paymentId,
      },
      ...(paymentId
        ? {
            appliedPayments: {
              ...(subscription.metadata?.appliedPayments ?? {}),
              [paymentId]: {
                kind: 'upgrade' as const,
                at: new Date().toISOString(),
                periodEnd: nextBillingDate,
              },
            },
          }
        : {}),
    };

    const updated = await repository.save(subscription);

    this.logger.log(
      `✅ Subscription upgraded: ${previousPlan} → ${plan} (Tenant: ${tenantId}, payment: ${paymentId ?? 'n/a'})`,
    );

    return updated;
  }

  /**
   * Executes plan renewal after successful payment confirmation.
   * Called by PaymentsService — never directly by the controller.
   */
  async renewAfterPayment(
    tenantId: string,
    billingPeriod: BillingPeriod,
    paymentAmount: number,
    queryRunner?: QueryRunner,
    /**
     * Payment id — the renewal idempotency key.
     *
     * Moyasar retries a webhook it did not get a clean answer to, so the same
     * `invoice_paid` arrives twice as a matter of course. `verifyPayment()`
     * short-circuits on `status === SUCCEEDED && paidAt`, but that is a
     * read-then-write with no lock: two concurrent deliveries both see PENDING,
     * both reach here, and the pessimistic lock only makes them take turns —
     * it does not stop the second one adding another month. The ledger does.
     */
    paymentId?: string,
  ): Promise<Subscription> {
    const useTransaction = !!queryRunner;
    const repository = useTransaction
      ? queryRunner.manager.getRepository(Subscription)
      : this.subscriptionRepository;

    const subscription = await repository.findOne({
      where: { tenantId },
      lock: { mode: 'pessimistic_write' },
    });

    if (!subscription) {
      throw new NotFoundException('No subscription found');
    }

    const alreadyApplied = paymentId
      ? subscription.metadata?.appliedPayments?.[paymentId]
      : undefined;
    if (alreadyApplied) {
      this.logger.warn(
        `Renewal for payment ${paymentId} already applied at ${alreadyApplied.at} ` +
          `(period end ${alreadyApplied.periodEnd}) — ignoring duplicate delivery (tenant ${tenantId})`,
      );
      return subscription;
    }

    if (!paymentId) {
      // Not fatal — a caller with no payment id is either a legacy path or an
      // admin action — but it means this renewal is NOT protected against a
      // repeat, so it is worth a line in the log.
      this.logger.warn(
        `Renewal applied for tenant ${tenantId} with no payment id — not idempotency-protected`,
      );
    }

    this.validatePaymentAmount(paymentAmount, subscription.plan, billingPeriod);

    const expectedAmount = PLAN_PRICING[subscription.plan][billingPeriod];
    if (Math.abs(paymentAmount - expectedAmount) > 0.01) {
      throw new BadRequestException(
        `Payment amount ${paymentAmount} does not match plan price ${expectedAmount}`,
      );
    }
    // Extend from the current next billing date if in the future, otherwise from now
    const baseDate =
      subscription.nextBillingDate && subscription.nextBillingDate > new Date()
        ? new Date(subscription.nextBillingDate)
        : new Date();

    subscription.nextBillingDate =
      billingPeriod === BillingPeriod.MONTHLY
        ? new Date(baseDate.setMonth(baseDate.getMonth() + 1))
        : new Date(baseDate.setFullYear(baseDate.getFullYear() + 1));

    subscription.billingPeriod = billingPeriod;
    subscription.status = SubscriptionStatus.ACTIVE;
    subscription.cancelledAt = CLEARED;
    // The trial is over once money has changed hands — but `metadata.trial`
    // (and with it `trial.usedAt`) is deliberately kept, so clearing this
    // column cannot give the tenant a second trial.
    subscription.trialEndsAt = CLEARED;
    subscription.updatedBy = tenantId;

    subscription.metadata = {
      ...subscription.metadata,
      pastDue: undefined,
      cancellation: undefined,
      ...(paymentId
        ? {
            appliedPayments: {
              ...(subscription.metadata?.appliedPayments ?? {}),
              [paymentId]: {
                kind: 'renewal' as const,
                at: new Date().toISOString(),
                periodEnd: subscription.nextBillingDate
                  ? new Date(subscription.nextBillingDate).toISOString()
                  : null,
              },
            },
          }
        : {}),
    };

    // A renewal does NOT silently re-enable auto-renew. If the tenant turned it
    // off and then paid for one more period by hand, turning it back on would
    // charge them again next month without being asked.

    await repository.save(subscription);

    this.logger.log(
      `✅ Subscription renewed (Tenant: ${tenantId}, payment: ${paymentId ?? 'n/a'}, next billing: ${subscription.nextBillingDate})`,
    );

    return subscription;
  }

  /**
   * Routes payment webhook to upgrade or renewal based on the plan change.
   * Called by PaymentsService after payment confirmation.
   */
  async processSubscriptionAfterPayment(
    tenantId: string,
    targetPlan: SubscriptionPlan,
    billingPeriod: BillingPeriod,
    paymentAmount: number,
    queryRunner?: QueryRunner,
    /** Payment id — idempotency key, see renewAfterPayment(). */
    paymentId?: string,
  ): Promise<Subscription> {
    const subscription = await this.findByTenantId(tenantId);

    // Replay of a payment that has already been applied. Checked here as well
    // as inside the two appliers so that the duplicate never reaches the
    // downgrade rejection below: once an upgrade has landed, the tenant's
    // current plan EQUALS the target, which reads as a renewal, and a replayed
    // upgrade would otherwise be applied a second time as a free month.
    const applied = paymentId
      ? subscription.metadata?.appliedPayments?.[paymentId]
      : undefined;
    if (applied) {
      this.logger.warn(
        `Payment ${paymentId} already applied to tenant ${tenantId} as ${applied.kind} at ${applied.at} — ignoring duplicate delivery`,
      );
      return subscription;
    }

    if (this.isUpgrade(subscription.plan, targetPlan)) {
      return await this.upgradeAfterPayment(
        tenantId,
        targetPlan,
        billingPeriod,
        paymentAmount,
        queryRunner,
        paymentId,
      );
    }

    if (this.isRenewal(subscription.plan, targetPlan)) {
      return this.renewAfterPayment(
        tenantId,
        billingPeriod,
        paymentAmount,
        queryRunner,
        paymentId,
      );
    } else {
      throw new BadRequestException(
        `Cannot process downgrade from ${subscription.plan} to ${targetPlan} via payment`,
      );
    }
  }

  /**
   * Upgrade endpoint - returns payment requirement
   */
  async upgrade(
    userId: string,
    upgradeDto: UpgradeSubscriptionDto,
  ): Promise<{
    requiresPayment: true;
    message: string;
    plan: SubscriptionPlan;
    billingPeriod: BillingPeriod;
    amount: number;
  }> {
    const subscription = await this.findCurrentForMutation(userId);
    const { plan, billingPeriod = subscription.billingPeriod } = upgradeDto;

    this.validateUpgrade(subscription.plan, plan);

    return {
      requiresPayment: true,
      message: 'Please complete payment to upgrade your subscription',
      plan,
      billingPeriod,
      amount: PLAN_PRICING[plan][billingPeriod],
    };
  }

  /**
   * Schedules a downgrade at end of current billing period.
   * Used by POST /subscriptions/downgrade/schedule
   */
  async scheduleDowngrade(
    userId: string,
    targetPlan: SubscriptionPlan,
  ): Promise<Subscription> {
    const subscription = await this.findCurrentForMutation(userId);

    const currentPlanIndex = PLAN_ORDER.indexOf(subscription.plan);
    const targetIndex = PLAN_ORDER.indexOf(targetPlan);

    if (targetIndex >= currentPlanIndex) {
      throw new ConflictException(
        'Target plan must be lower than current plan',
      );
    }

    subscription.metadata = {
      ...subscription.metadata,
      scheduledDowngrade: {
        plan: targetPlan,
        effectiveDate: subscription.nextBillingDate!,
      },
    };
    subscription.updatedBy = userId;

    await this.subscriptionRepository.save(subscription);

    this.logger.log(
      `Downgrade scheduled: ${subscription.plan} → ${targetPlan} on ${subscription.nextBillingDate}`,
    );

    return subscription;
  }

  /**
   * Cancels a scheduled downgrade.
   * Used by POST /subscriptions/downgrade/cancel
   */
  async cancelScheduledDowngrade(userId: string): Promise<Subscription> {
    const subscription = await this.findCurrentForMutation(userId);

    if (!subscription.metadata?.scheduledDowngrade) {
      throw new NotFoundException('No scheduled downgrade found');
    }

    subscription.metadata = {
      ...subscription.metadata,
      scheduledDowngrade: undefined,
    };
    return this.subscriptionRepository.save(subscription);
  }

  /**
   * Execute scheduled downgrade (cron job)
   */
  async executeScheduledDowngrade(
    userId: string,
  ): Promise<Subscription | null> {
    const subscription = await this.findCurrentForMutation(userId);

    if (!subscription.metadata?.scheduledDowngrade) {
      return null;
    }

    const { plan: targetPlan, effectiveDate } =
      subscription.metadata.scheduledDowngrade;
    const now = new Date();

    if (effectiveDate && new Date(effectiveDate) <= now) {
      subscription.plan = targetPlan;
      subscription.price = PLAN_PRICING[targetPlan][subscription.billingPeriod];
      subscription.limits = PLAN_LIMITS[targetPlan];
      subscription.features = PLAN_FEATURES[targetPlan];

      subscription.metadata = {
        ...subscription.metadata,
        scheduledDowngrade: undefined,
      };

      await this.subscriptionRepository.save(subscription);

      this.logger.log(
        `✅ Executed scheduled downgrade to ${targetPlan} (User: ${userId})`,
      );

      return subscription;
    }

    return null;
  }

  /**
   * Cancels the subscription immediately.
   * Used by POST /subscriptions/cancel
   */
  /**
   * Cancels the subscription. Paid access continues to the end of the period
   * already paid for; the sweep (`sweepExpiredSubscriptions`) drops the tenant
   * to FREE when that date passes.
   *
   * It used to ALSO call `create(tenantId, {plan: FREE})` to make a second row.
   * That could not work and never did: `subscriptions` is `@Unique(['tenantId'])`,
   * and `create()` saw the still-ACTIVE row in the database (the CANCELLED
   * status was only set on the in-memory copy at that point) and threw
   * `ConflictException` — so **every** call to POST /subscriptions/cancel
   * answered 409 and nothing was ever cancelled. Had the conflict check not
   * fired, the INSERT would have hit the unique constraint instead.
   */
  async cancel(userId: string): Promise<Subscription> {
    const subscription = await this.findCurrentForMutation(userId);

    if (subscription.status === SubscriptionStatus.CANCELLED) {
      throw new ConflictException('Subscription already cancelled');
    }

    const now = new Date();

    subscription.status = SubscriptionStatus.CANCELLED;
    subscription.cancelledAt = now;
    subscription.updatedBy = userId;
    subscription.metadata = {
      ...subscription.metadata,
      // Cancelling means "do not charge me again". Leaving auto-renew on would
      // let the renewal path re-activate a cancelled subscription from a
      // webhook.
      autoRenew: false,
      scheduledDowngrade: undefined,
      cancellation: { cancelledAt: now.toISOString() },
    };

    const saved = await this.subscriptionRepository.save(subscription);

    this.logger.log(
      `Subscription cancelled for tenant ${saved.tenantId}: ${saved.plan} access until ${saved.getAccessEndsAt()?.toISOString() ?? 'immediately'}`,
    );

    return saved;
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // LIFECYCLE — trial, renewal, auto-renew, expiry, refund reversal
  //
  // Two rules govern everything in this section:
  //
  //   1. When a transition is ambiguous, take the branch that does NOT grant
  //      paid capability, and log loudly.
  //   2. A loss of plan NEVER deletes a tenant's data and never locks them out
  //      of reading it. A tenant who drops from PROFESSIONAL (200 devices) to
  //      FREE (5) with 40 devices keeps all 40: they can read them, operate
  //      them and delete them, and `SubscriptionLimitGuard.isLimitReached()`
  //      refuses only the creation of the 41st. That is why a downgrade lands
  //      on `status = ACTIVE` with the FREE plan rather than on EXPIRED or
  //      SUSPENDED — both of those fail `isActive()`, which makes
  //      `SubscriptionGuard` reject EVERY request including plain reads.
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Start the plan's free trial.
   *
   * Refused if this tenant has ever had one. The record lives in
   * `metadata.trial.usedAt`, which survives cancellation, expiry and renewal —
   * `trialEndsAt` does not (renewAfterPayment clears it), and a brand-new row
   * is no longer reachable either (`create()` now refuses when any row exists),
   * so cancel-and-resubscribe cannot farm trials.
   */
  async startTrial(
    userId: string,
    targetPlan: SubscriptionPlan,
    billingPeriod?: BillingPeriod,
  ): Promise<Subscription> {
    const subscription = await this.findCurrentForMutation(userId);

    const trialDays = PLAN_TRIAL_DAYS[targetPlan];
    if (!trialDays || targetPlan === SubscriptionPlan.FREE) {
      throw new BadRequestException(
        `The ${PLAN_DISPLAY_NAMES[targetPlan]} plan has no trial period.`,
      );
    }

    if (subscription.hasUsedTrial()) {
      this.logger.warn(
        `Tenant ${subscription.tenantId} attempted a second trial (first used at ${subscription.metadata?.trial?.usedAt})`,
      );
      throw new ConflictException(
        'This account has already used its free trial. Please choose a paid plan.',
      );
    }

    if (subscription.plan !== SubscriptionPlan.FREE) {
      throw new ConflictException(
        `A trial can only be started from the Free plan — this account is on ${PLAN_DISPLAY_NAMES[subscription.plan]}.`,
      );
    }

    if (subscription.status === SubscriptionStatus.SUSPENDED) {
      throw new ConflictException(
        'This subscription is suspended. Please settle the outstanding balance first.',
      );
    }

    const period = billingPeriod ?? subscription.billingPeriod;
    const endsAt = this.calculateTrialEnd(trialDays);

    subscription.plan = targetPlan;
    subscription.billingPeriod = period;
    // Price is what the tenant will owe when the trial converts. The trial
    // itself is not charged — `status = TRIAL` is what says so.
    subscription.price = PLAN_PRICING[targetPlan][period];
    subscription.limits = PLAN_LIMITS[targetPlan];
    subscription.features = PLAN_FEATURES[targetPlan];
    subscription.status = SubscriptionStatus.TRIAL;
    subscription.trialEndsAt = endsAt;
    // The trial period IS the billing period: nothing is owed until it ends.
    subscription.nextBillingDate = endsAt;
    subscription.cancelledAt = CLEARED;
    subscription.updatedBy = userId;
    subscription.metadata = {
      ...subscription.metadata,
      // A trial must never auto-charge. Converting is an explicit payment.
      autoRenew: false,
      pastDue: undefined,
      cancellation: undefined,
      trial: {
        usedAt: new Date().toISOString(),
        plan: targetPlan,
        endsAt: endsAt.toISOString(),
        fromPlan: SubscriptionPlan.FREE,
      },
    };

    const saved = await this.subscriptionRepository.save(subscription);

    this.logger.log(
      `Trial started for tenant ${saved.tenantId}: ${targetPlan} for ${trialDays} days, ends ${endsAt.toISOString()}`,
    );

    return saved;
  }

  /**
   * Tenant-initiated renewal. Like `upgrade()`, this does NOT change the
   * subscription — it validates and hands back the amount to pay. The period is
   * only extended by `renewAfterPayment()`, from a confirmed payment.
   */
  async requestRenewal(
    userId: string,
    billingPeriod?: BillingPeriod,
  ): Promise<{
    requiresPayment: true;
    message: string;
    plan: SubscriptionPlan;
    billingPeriod: BillingPeriod;
    amount: number;
    currentPeriodEnd: Date | null;
  }> {
    const subscription = await this.findCurrentForMutation(userId);
    const period = billingPeriod ?? subscription.billingPeriod;

    if (subscription.plan === SubscriptionPlan.FREE) {
      throw new BadRequestException(
        'The Free plan does not expire and cannot be renewed. Upgrade to a paid plan instead.',
      );
    }

    const amount = PLAN_PRICING[subscription.plan][period];
    if (amount <= 0) {
      // ENTERPRISE is quoted, not priced in PLAN_PRICING. Taking 0 SAR for it
      // here would extend the most expensive plan for free.
      throw new BadRequestException(
        `${PLAN_DISPLAY_NAMES[subscription.plan]} renewals are handled by your account manager — please contact sales.`,
      );
    }

    return {
      requiresPayment: true,
      message:
        'Please complete payment to extend your subscription for another period',
      plan: subscription.plan,
      billingPeriod: period,
      amount,
      currentPeriodEnd: subscription.nextBillingDate
        ? new Date(subscription.nextBillingDate)
        : null,
    };
  }

  /**
   * Turn auto-renew on or off.
   *
   * Off is not a cancellation: the plan runs to the end of the period already
   * paid for and then the sweep drops it to FREE. The response carries the date
   * to show as "your plan ends on X".
   */
  async setAutoRenew(
    userId: string,
    enabled: boolean,
  ): Promise<ReturnType<SubscriptionsService['describeLifecycle']>> {
    const subscription = await this.findCurrentForMutation(userId);

    if (enabled && subscription.plan === SubscriptionPlan.FREE) {
      throw new BadRequestException(
        'There is nothing to renew on the Free plan.',
      );
    }

    if (enabled && subscription.status === SubscriptionStatus.CANCELLED) {
      throw new ConflictException(
        'This subscription has been cancelled. Renew it to restart billing.',
      );
    }

    subscription.metadata = {
      ...subscription.metadata,
      autoRenew: enabled,
    };
    subscription.updatedBy = userId;

    const saved = await this.subscriptionRepository.save(subscription);

    this.logger.log(
      `Auto-renew ${enabled ? 'enabled' : 'disabled'} for tenant ${saved.tenantId} ` +
        `(${saved.plan}, access ends ${saved.getAccessEndsAt()?.toISOString() ?? 'n/a'})`,
    );

    return this.describeLifecycle(saved);
  }

  /**
   * Everything the billing screen needs to say what happens next, in one call.
   */
  async getLifecycle(userId: string) {
    return this.describeLifecycle(await this.findCurrent(userId));
  }

  private describeLifecycle(subscription: Subscription) {
    const accessEndsAt = subscription.getAccessEndsAt();
    const overQuota = subscription.getOverQuotaResources();
    const trialDays = PLAN_TRIAL_DAYS[subscription.plan] ?? 0;

    return {
      plan: subscription.plan,
      planName: PLAN_DISPLAY_NAMES[subscription.plan],
      status: subscription.status,
      billingPeriod: subscription.billingPeriod,
      price: Number(subscription.price),
      autoRenew: subscription.isAutoRenewEnabled(),
      currentPeriodEnd: subscription.nextBillingDate ?? null,
      /** Null while the plan keeps renewing; a date once it does not. */
      accessEndsAt,
      willRenew:
        subscription.isAutoRenewEnabled() &&
        subscription.plan !== SubscriptionPlan.FREE &&
        subscription.status !== SubscriptionStatus.CANCELLED,
      /** Rendered verbatim by the frontend — one sentence, already resolved. */
      message: this.lifecycleMessage(subscription, accessEndsAt),
      trial: {
        used: subscription.hasUsedTrial(),
        active: subscription.status === SubscriptionStatus.TRIAL,
        endsAt: subscription.trialEndsAt ?? null,
        expired: subscription.isTrialExpired(),
        /** Days the CURRENT plan's trial runs for, 0 if it has none. */
        eligiblePlanTrialDays: trialDays,
      },
      pastDue: subscription.metadata?.pastDue ?? null,
      scheduledDowngrade: subscription.metadata?.scheduledDowngrade ?? null,
      cancelledAt: subscription.cancelledAt ?? null,
      /**
       * Usage keys currently above the plan ceiling — the tenant keeps these
       * resources and can keep using them, but cannot create more.
       */
      overQuota,
      canCreateResources: overQuota.length === 0,
    };
  }

  private lifecycleMessage(
    subscription: Subscription,
    accessEndsAt: Date | null,
  ): string {
    const on = (date: Date) => date.toISOString().slice(0, 10);
    const name = PLAN_DISPLAY_NAMES[subscription.plan];

    if (subscription.status === SubscriptionStatus.SUSPENDED) {
      return `Your subscription is suspended. Settle the outstanding balance to restore ${name} access.`;
    }
    if (subscription.status === SubscriptionStatus.TRIAL) {
      return subscription.trialEndsAt
        ? `Your ${name} trial ends on ${on(new Date(subscription.trialEndsAt))}. Pay before then to keep ${name} features.`
        : `Your ${name} trial is active.`;
    }
    if (subscription.metadata?.pastDue) {
      return `Payment for your ${name} plan has not been received. ${name} features remain available until ${on(new Date(subscription.metadata.pastDue.graceEndsAt))}, then the account moves to Free.`;
    }
    if (subscription.status === SubscriptionStatus.CANCELLED) {
      return accessEndsAt
        ? `Your ${name} plan is cancelled and ends on ${on(accessEndsAt)}. You keep ${name} features until then.`
        : `Your ${name} plan is cancelled.`;
    }
    if (subscription.plan === SubscriptionPlan.FREE) {
      return 'You are on the Free plan. It does not expire.';
    }
    if (!subscription.isAutoRenewEnabled()) {
      return accessEndsAt
        ? `Auto-renew is off — your ${name} plan ends on ${on(accessEndsAt)} and the account moves to Free.`
        : `Auto-renew is off for your ${name} plan.`;
    }
    return subscription.nextBillingDate
      ? `Your ${name} plan renews on ${on(new Date(subscription.nextBillingDate))}.`
      : `Your ${name} plan is active.`;
  }

  /**
   * Called by PaymentsService when a payment that was meant to RENEW the
   * current plan fails or is cancelled.
   *
   * The plan is kept for a grace window rather than cut off immediately: a
   * failed card on a renewal is overwhelmingly an expired card, not a tenant
   * trying to get free service, and killing a live IoT deployment's quota the
   * minute a charge bounces is a worse failure than a few days of grace. When
   * the window closes `sweepExpiredSubscriptions()` drops the tenant to FREE.
   */
  async markRenewalPaymentFailed(
    tenantId: string,
    reason: string,
  ): Promise<Subscription | null> {
    const subscription = await this.subscriptionRepository.findOne({
      where: { tenantId },
    });
    if (!subscription) return null;

    if (subscription.plan === SubscriptionPlan.FREE) return subscription;

    const existing = subscription.metadata?.pastDue;
    const now = new Date();

    subscription.metadata = {
      ...subscription.metadata,
      pastDue: {
        // The grace window starts at the FIRST failure, so retrying a failing
        // card cannot extend it indefinitely.
        since: existing?.since ?? now.toISOString(),
        graceEndsAt:
          existing?.graceEndsAt ??
          new Date(
            now.getTime() + this.gracePeriodDays * 24 * 60 * 60 * 1000,
          ).toISOString(),
        reason,
        attempts: (existing?.attempts ?? 0) + 1,
      },
    };

    const saved = await this.subscriptionRepository.save(subscription);

    this.logger.warn(
      `⚠️ Renewal payment failed for tenant ${tenantId} (${reason}). ` +
        `${saved.plan} kept until ${saved.metadata!.pastDue!.graceEndsAt}, attempt ${saved.metadata!.pastDue!.attempts}`,
    );

    return saved;
  }

  /**
   * Reverses the plan change a payment bought, because the money went back.
   *
   * Reached from every refund path — the direct `POST /payments/refund`, a
   * Moyasar `payment_refunded` / `payment_voided` webhook, and a chargeback —
   * because all three funnel through `PaymentsService.reverseForPayment()`.
   *
   * ### What it reverses TO
   *
   * The plan recorded on the payment (`payment.metadata.originalPlan`, written
   * when the invoice was created) and, failing that, the plan recorded on the
   * subscription when the upgrade landed (`metadata.previousPlan`). If neither
   * exists — a payment from before either was recorded — the target is FREE,
   * logged as an error, because the alternative is leaving the tenant on a tier
   * they no longer paid for.
   *
   * Then: **never a plan above the one the tenant is on now.** If they upgraded
   * again after this payment, reversing an old payment must not promote them
   * from the result of a later one; the lower of the two ranks wins.
   *
   * ### Why a paid target can still end up FREE
   *
   * Reverting STARTER→PROFESSIONAL leaves the tenant on STARTER — but only for
   * the period STARTER was already paid for. That date comes from
   * `previousPlan.nextBillingDate`. If it is missing or already past, there is
   * no evidence of paid time remaining, so the target becomes FREE: granting a
   * fresh paid period for money that was handed back is the one outcome that
   * costs real money.
   *
   * Resources are never touched. See the section header.
   */
  async reverseAfterRefund(
    tenantId: string,
    options: {
      paymentId: string;
      kind: 'refund' | 'chargeback' | 'void';
      /** `payment.metadata.originalPlan`, if the payment recorded one. */
      originalPlan?: SubscriptionPlan | null;
      reason?: string;
    },
    queryRunner?: QueryRunner,
  ): Promise<Subscription> {
    const repository = queryRunner
      ? queryRunner.manager.getRepository(Subscription)
      : this.subscriptionRepository;

    const subscription = await repository.findOne({
      where: { tenantId },
      lock: queryRunner ? { mode: 'pessimistic_write' } : undefined,
    });

    if (!subscription) {
      throw new NotFoundException('No subscription found');
    }

    // Idempotent: a refund webhook is retried like any other.
    if (
      subscription.metadata?.reversedPayments?.includes(options.paymentId)
    ) {
      this.logger.warn(
        `Payment ${options.paymentId} already reversed for tenant ${tenantId} — ignoring duplicate`,
      );
      return subscription;
    }

    const recordedPrevious =
      subscription.metadata?.previousPlan?.paymentId === options.paymentId
        ? subscription.metadata.previousPlan
        : undefined;

    let target =
      options.originalPlan ??
      recordedPrevious?.plan ??
      subscription.metadata?.previousPlan?.plan;

    if (!target) {
      this.logger.error(
        `🚨 Payment ${options.paymentId} reversed for tenant ${tenantId} but no previous plan was recorded ` +
          `(neither payment.metadata.originalPlan nor subscription.metadata.previousPlan). ` +
          `Falling back to FREE — a tenant must not keep a tier whose payment was returned.`,
      );
      target = SubscriptionPlan.FREE;
    }

    // Never reverse UP.
    if (PLAN_ORDER.indexOf(target) > PLAN_ORDER.indexOf(subscription.plan)) {
      this.logger.warn(
        `Reversal target ${target} is above the tenant's current plan ${subscription.plan} ` +
          `(tenant ${tenantId}) — a later upgrade must have landed. Keeping ${subscription.plan}.`,
      );
      target = subscription.plan;
    }

    // Paid target: it is only honoured for period the tenant had already paid
    // for independently of the refunded payment.
    let restoredPeriodEnd: Date | null = null;
    if (target !== SubscriptionPlan.FREE) {
      const recorded =
        recordedPrevious?.nextBillingDate ??
        subscription.metadata?.previousPlan?.nextBillingDate ??
        null;
      const candidate = recorded ? new Date(recorded) : null;
      if (candidate && candidate.getTime() > Date.now()) {
        restoredPeriodEnd = candidate;
      } else {
        this.logger.warn(
          `No remaining paid period recorded for ${target} (tenant ${tenantId}, payment ${options.paymentId}) — ` +
            `reversing to FREE instead of granting an unpaid ${target} period.`,
        );
        target = SubscriptionPlan.FREE;
      }
    }

    const fromPlan = subscription.plan;
    const billingPeriod =
      target === SubscriptionPlan.FREE
        ? subscription.billingPeriod
        : (recordedPrevious?.billingPeriod ??
          subscription.metadata?.previousPlan?.billingPeriod ??
          subscription.billingPeriod);

    subscription.plan = target;
    subscription.billingPeriod = billingPeriod;
    subscription.price = PLAN_PRICING[target][billingPeriod];
    subscription.limits = PLAN_LIMITS[target];
    subscription.features = PLAN_FEATURES[target];
    // ACTIVE, not EXPIRED/SUSPENDED: the tenant keeps reading and operating
    // what they already have (see the section header). The FREE ceilings are
    // what stops them creating more.
    subscription.status = SubscriptionStatus.ACTIVE;
    subscription.nextBillingDate = restoredPeriodEnd ?? CLEARED;
    subscription.trialEndsAt = CLEARED;
    subscription.cancelledAt = CLEARED;

    const overQuota = subscription.getOverQuotaResources();

    subscription.metadata = {
      ...subscription.metadata,
      // Nothing is scheduled to renew a plan that was just refunded.
      autoRenew: false,
      pastDue: undefined,
      scheduledDowngrade: undefined,
      previousPlan: undefined,
      reversedPayments: [
        ...(subscription.metadata?.reversedPayments ?? []),
        options.paymentId,
      ],
      reversals: [
        ...(subscription.metadata?.reversals ?? []),
        {
          paymentId: options.paymentId,
          kind: options.kind,
          at: new Date().toISOString(),
          fromPlan,
          toPlan: target,
          reason: options.reason,
          overQuota: overQuota as string[],
        },
      ],
    };

    const saved = await repository.save(subscription);

    this.logger.warn(
      `💸 Plan reversed after ${options.kind} of payment ${options.paymentId}: ` +
        `${fromPlan} → ${target} (tenant ${tenantId}${
          restoredPeriodEnd
            ? `, paid period restored to ${restoredPeriodEnd.toISOString()}`
            : ''
        })`,
    );

    if (overQuota.length) {
      this.logger.warn(
        `⚠️ Tenant ${tenantId} is over the ${target} ceiling after reversal on: ` +
          overQuota
            .map(
              (key) =>
                `${key} ${saved.usage[key]}/${saved.getLimitValue(key)}`,
            )
            .join(', ') +
          '. Existing resources are KEPT and remain usable; creation of new ones is blocked until usage is under the limit.',
      );
    }

    return saved;
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // EXPIRY SWEEP
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Drives every time-based transition. Nothing else did: `trialEndsAt` and
   * `nextBillingDate` were written but never read by any scheduled job, so a
   * trial "expired" only in the sense that `SubscriptionGuard` started
   * answering 403 to every request — including reads — and stayed that way
   * forever, because no code path ever moved the row out of TRIAL.
   *
   * Hourly rather than daily: the window between a trial ending and the sweep
   * noticing is a window in which the tenant is locked out of their own data by
   * `isTrialExpired()`.
   *
   * Follows `IntegrationEventsService.prune()` / `DevicesService.checkOfflineDevices()`:
   * one narrow query, a per-row try/catch so one bad row cannot abort the
   * sweep, and a single summary log line.
   */
  @Cron(CronExpression.EVERY_HOUR)
  async sweepExpiredSubscriptions(): Promise<{
    trialsExpired: number;
    cancellationsCompleted: number;
    gracePeriodsStarted: number;
    downgradedAfterGrace: number;
  }> {
    const summary = {
      trialsExpired: 0,
      cancellationsCompleted: 0,
      gracePeriodsStarted: 0,
      downgradedAfterGrace: 0,
    };

    const candidates = await this.subscriptionRepository
      .createQueryBuilder('s')
      .where('s.status IN (:...statuses)', {
        statuses: [
          SubscriptionStatus.ACTIVE,
          SubscriptionStatus.TRIAL,
          SubscriptionStatus.CANCELLED,
        ],
      })
      .andWhere('s.plan != :free', { free: SubscriptionPlan.FREE })
      .andWhere(
        `(
          (s.status = :trial AND s."trialEndsAt" IS NOT NULL AND s."trialEndsAt" <= NOW())
          OR (s."nextBillingDate" IS NOT NULL AND s."nextBillingDate" <= NOW())
          OR ((s.metadata->'pastDue'->>'graceEndsAt')::timestamptz <= NOW())
        )`,
        { trial: SubscriptionStatus.TRIAL },
      )
      .getMany();

    if (candidates.length === 0) return summary;

    // Sequential, like syncAllTenantsUsage(): this is an hourly job with no
    // deadline, and every branch below writes.
    for (const subscription of candidates) {
      try {
        const outcome = await this.applyExpiry(subscription);
        if (outcome) summary[outcome]++;
      } catch (err) {
        this.logger.error(
          `Expiry sweep failed for tenant ${subscription.tenantId}: ${(err as Error).message}`,
        );
      }
    }

    this.logger.log(
      `Subscription expiry sweep: ${candidates.length} candidate(s) — ` +
        `trials expired ${summary.trialsExpired}, cancellations completed ${summary.cancellationsCompleted}, ` +
        `grace periods started ${summary.gracePeriodsStarted}, downgraded after grace ${summary.downgradedAfterGrace}`,
    );

    return summary;
  }

  /**
   * The state machine for one expired row. Exported via the sweep only.
   *
   * Order matters: a past grace period is settled before a new one would be
   * opened, and the trial branch runs before the billing-date branch because a
   * trial's `nextBillingDate` IS its `trialEndsAt`.
   */
  private async applyExpiry(
    subscription: Subscription,
  ): Promise<
    | 'trialsExpired'
    | 'cancellationsCompleted'
    | 'gracePeriodsStarted'
    | 'downgradedAfterGrace'
    | null
  > {
    const now = Date.now();
    const pastDue = subscription.metadata?.pastDue;

    // ── 1. A grace period that has run out ──────────────────────────────────
    if (pastDue && new Date(pastDue.graceEndsAt).getTime() <= now) {
      await this.downgradeToFree(subscription, {
        reason: `grace period expired (${pastDue.reason})`,
        clearPastDue: true,
      });
      this.logger.warn(
        `⚠️ Tenant ${subscription.tenantId} downgraded to FREE: grace period ended (${pastDue.reason})`,
      );
      return 'downgradedAfterGrace';
    }
    if (pastDue) return null; // still inside the window

    // ── 2. Trial expiry ─────────────────────────────────────────────────────
    if (
      subscription.status === SubscriptionStatus.TRIAL &&
      subscription.trialEndsAt &&
      new Date(subscription.trialEndsAt).getTime() <= now
    ) {
      // To FREE, not EXPIRED. The trial converting is a payment, and no payment
      // arrived; but the tenant's devices and dashboards are still theirs to
      // read. `trialEndsAt` is cleared so `isTrialExpired()` stops locking the
      // guard out, while `metadata.trial.usedAt` stays — no second trial.
      await this.downgradeToFree(subscription, {
        reason: 'trial expired without payment',
        clearTrialEndsAt: true,
        trialExpired: true,
      });
      this.logger.log(
        `Trial expired for tenant ${subscription.tenantId} (${subscription.metadata?.trial?.plan}) → FREE`,
      );
      return 'trialsExpired';
    }

    const periodEnded =
      !!subscription.nextBillingDate &&
      new Date(subscription.nextBillingDate).getTime() <= now;

    if (!periodEnded) return null;

    // ── 3. A cancelled subscription whose paid period ran out ───────────────
    if (subscription.status === SubscriptionStatus.CANCELLED) {
      await this.downgradeToFree(subscription, {
        reason: 'cancelled subscription reached the end of its paid period',
        completeCancellation: true,
      });
      this.logger.log(
        `Cancellation completed for tenant ${subscription.tenantId} → FREE`,
      );
      return 'cancellationsCompleted';
    }

    // ── 4. Auto-renew off: the tenant already said do not charge again ──────
    if (!subscription.isAutoRenewEnabled()) {
      await this.downgradeToFree(subscription, {
        reason: 'period ended with auto-renew off',
      });
      this.logger.log(
        `Period ended with auto-renew off for tenant ${subscription.tenantId} → FREE`,
      );
      return 'cancellationsCompleted';
    }

    // ── 5. ENTERPRISE is invoiced out of band ───────────────────────────────
    // PLAN_PRICING puts ENTERPRISE at 0 because it is quoted by sales, so no
    // Moyasar payment is ever going to arrive for it and "no payment received"
    // means nothing here. Downgrading a contracted enterprise tenant on that
    // basis would be the most expensive possible wrong answer, so the sweep
    // rolls the period forward and says so loudly instead.
    if (subscription.plan === SubscriptionPlan.ENTERPRISE) {
      subscription.nextBillingDate = this.calculateNextBillingDate(
        subscription.billingPeriod,
      );
      await this.subscriptionRepository.save(subscription);
      this.logger.warn(
        `⚠️ ENTERPRISE period ended for tenant ${subscription.tenantId} with no renewal payment. ` +
          `Plan KEPT (enterprise is invoiced outside Moyasar) and the period rolled to ` +
          `${subscription.nextBillingDate.toISOString()} — verify the contract manually.`,
      );
      return null;
    }

    // ── 6. Auto-renew on, period over, no payment: open the grace window ────
    await this.markRenewalPaymentFailed(
      subscription.tenantId,
      'renewal payment not received by the end of the billing period',
    );
    return 'gracePeriodsStarted';
  }

  /**
   * The one place a subscription loses its plan.
   *
   * Lands on FREE + ACTIVE deliberately — see the LIFECYCLE section header for
   * why EXPIRED and SUSPENDED are the wrong answer. `usage` is never touched:
   * a tenant over the FREE ceiling keeps every resource and simply cannot
   * create more.
   */
  private async downgradeToFree(
    subscription: Subscription,
    options: {
      reason: string;
      clearPastDue?: boolean;
      clearTrialEndsAt?: boolean;
      trialExpired?: boolean;
      completeCancellation?: boolean;
    },
  ): Promise<Subscription> {
    const fromPlan = subscription.plan;

    subscription.plan = SubscriptionPlan.FREE;
    subscription.price = PLAN_PRICING[SubscriptionPlan.FREE][
      subscription.billingPeriod
    ];
    subscription.limits = PLAN_LIMITS[SubscriptionPlan.FREE];
    subscription.features = PLAN_FEATURES[SubscriptionPlan.FREE];
    subscription.status = SubscriptionStatus.ACTIVE;
    subscription.nextBillingDate = CLEARED;
    if (options.clearTrialEndsAt) subscription.trialEndsAt = CLEARED;

    subscription.metadata = {
      ...subscription.metadata,
      autoRenew: false,
      pastDue: options.clearPastDue ? undefined : subscription.metadata?.pastDue,
      scheduledDowngrade: undefined,
      previousPlan: undefined,
      ...(options.trialExpired
        ? {
            trial: {
              ...(subscription.metadata?.trial ?? {}),
              expiredAt: new Date().toISOString(),
            },
          }
        : {}),
      ...(options.completeCancellation
        ? {
            cancellation: {
              cancelledAt:
                subscription.metadata?.cancellation?.cancelledAt ??
                subscription.cancelledAt?.toISOString() ??
                new Date().toISOString(),
              completedAt: new Date().toISOString(),
            },
          }
        : {}),
      lastDowngrade: {
        at: new Date().toISOString(),
        fromPlan,
        reason: options.reason,
      },
    };

    const saved = await this.subscriptionRepository.save(subscription);
    const overQuota = saved.getOverQuotaResources();

    if (overQuota.length) {
      this.logger.warn(
        `⚠️ Tenant ${saved.tenantId} is over the Free ceiling after downgrade from ${fromPlan} (${options.reason}) on: ` +
          overQuota
            .map((key) => `${key} ${saved.usage[key]}/${saved.getLimitValue(key)}`)
            .join(', ') +
          '. Existing resources KEPT; creation blocked until usage is under the limit.',
      );
    }

    return saved;
  }

  /**
   * Check if user can perform action
   */
  // async canPerformAction(
  //   userId: string,
  //   resource: 'devices' | 'users' | 'customers' | 'apiCalls' | 'storage' | 'smsNotifications',
  // ): Promise<boolean> {
  //   const subscription = await this.findCurrent(userId);
  //   const user = await this.userRepository.findOne({ where: { id: userId } });

  //   if (!user || !user.tenantId) {
  //     return false;
  //   }

  //   // Get limit based on resource
  //   let limit: number | undefined;
  //   switch (resource) {
  //     case 'devices':
  //       limit = subscription.limits.devices;
  //       break;
  //     case 'users':
  //       limit = subscription.limits.users;
  //       break;
  //     case 'customers':
  //       limit = subscription.limits.customers;
  //       break;
  //     case 'apiCalls':
  //       limit = subscription.limits.apiCallsPerMonth;
  //       break;
  //     case 'storage':
  //       limit = subscription.limits.storageGB;
  //       break;
  //     case 'smsNotifications':
  //       limit = subscription.limits.smsNotificationsPerMonth;
  //       break;
  //     default:
  //       return false;
  //   }

  //   if (limit === -1) return true; // unlimited

  //   const tenantUsage = await this.getTenantUsage(user.tenantId);
  //   const currentUsage = tenantUsage[resource] || 0;

  //   this.logger.debug(
  //     `Checking ${resource} for tenant ${user.tenantId}: ${currentUsage}/${limit}`,
  //   );

  //   return currentUsage < (limit ? limit : 0);
  // }

  /**
   * Increment tenant usage
   */
  async incrementTenantUsage(
    tenantId: string | undefined,
    resource: keyof SubscriptionUsage,
    amount: number = 1,
  ): Promise<void> {
    await this.dataSource.query(
      `UPDATE subscriptions
       SET usage = jsonb_set(
         usage,
         '{${resource}}',
         (COALESCE(usage->>'${resource}', '0')::int + $1)::text::jsonb
       )
       WHERE "tenantId" = $2`,
      [amount, tenantId],
    );
  }

  /**
   * Decrement tenant usage
   */
  async decrementTenantUsage(
    tenantId: string,
    resource: keyof SubscriptionUsage,
    amount: number = 1,
  ): Promise<void> {
    await this.dataSource.query(
      `UPDATE subscriptions
       SET usage = jsonb_set(
         usage,
         '{${resource}}',
         GREATEST(0, (COALESCE(usage->>'${resource}', '0')::int - $1))::text::jsonb
       )
       WHERE "tenantId" = $2`,
      [amount, tenantId],
    );
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // USAGE RECONCILIATION
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Recomputes the denormalised usage counters from live row counts.
   *
   * The counters are maintained incrementally by each resource service, which
   * is O(1) at read time but drifts whenever an increment is missed (a crash
   * between the INSERT and the counter update, a resource created by a path
   * that predates the counter, a direct DB edit). This is the repair.
   *
   * Only the six countable resources are recomputed. `apiCalls`,
   * `smsNotifications`, `storageGB` and `customers` are deliberately PRESERVED:
   *   - apiCalls / smsNotifications are monthly rate counters with no row to
   *     count against (api_logs is pruned, and the monthly cron resets them),
   *     so recomputing them from tables would silently reset a tenant's
   *     metered usage to zero mid-period.
   *   - storageGB has no authoritative source yet (no size column on
   *     floor_plans — see the audit notes).
   *   - customers is already maintained reliably by CustomerListener.
   *
   * This is why the write below MERGES over the existing jsonb rather than
   * replacing it — a wholesale replace would zero the metered counters.
   */
  async syncUsageFromDB(tenantId: string): Promise<SubscriptionUsage> {
    const [devices, dashboards, assets, users, ruleChains, floorPlans, automations] =
      await Promise.all([
        this.deviceRepository.count({ where: { tenantId } }),
        this.dashboardRepository.count({ where: { tenantId } }),
        this.assetRepository.count({ where: { tenantId } }),
        this.userRepository.count({ where: { tenantId } }),
        this.ruleChainRepository.count({ where: { tenantId } }),
        this.floorPlanRepository.count({ where: { tenantId } }),
        this.automationRepository.count({ where: { tenantId } }),
      ]);
    // TypeORM's count() already excludes soft-deleted rows (deleted_at IS NULL)
    // for entities with a @DeleteDateColumn, so no explicit predicate is needed.

    const recomputed = {
      devices,
      dashboards,
      assets,
      users,
      ruleChains,
      floorPlans,
      automations,
    };

    const result = await this.subscriptionRepository
      .createQueryBuilder()
      .update(Subscription)
      .set({
        // `usage || :recomputed` — jsonb concat, right side wins per key.
        // Merges rather than replaces, so metered counters survive.
        usage: () => `COALESCE(usage, '{}'::jsonb) || :recomputed::jsonb`,
      })
      .where('"tenantId" = :tenantId', { tenantId })
      .setParameter('recomputed', JSON.stringify(recomputed))
      .returning('usage')
      .execute();

    const updated: SubscriptionUsage =
      result.raw?.[0]?.usage ?? { ...EMPTY_USAGE, ...recomputed };

    this.logger.log(
      `Usage synced for tenant ${tenantId}: ` +
        Object.entries(recomputed)
          .map(([k, v]) => `${k}=${v}`)
          .join(' '),
    );

    return updated;
  }

  /**
   * Nightly drift repair for every subscription.
   *
   * Sequential, not Promise.all: this touches every tenant and there is no
   * deadline on a 2 AM job — a burst of parallel COUNTs across seven tables
   * per tenant is a worse trade than taking a few extra seconds.
   */
  @Cron('0 2 * * *')
  async syncAllTenantsUsage(): Promise<void> {
    this.logger.log('Running daily usage sync for all tenants...');

    const subscriptions = await this.subscriptionRepository.find({
      select: ['id', 'tenantId'],
    });

    let synced = 0;
    for (const sub of subscriptions) {
      try {
        await this.syncUsageFromDB(sub.tenantId);
        synced++;
      } catch (err) {
        this.logger.error(
          `Failed to sync usage for tenant ${sub.tenantId}: ${(err as Error).message}`,
        );
      }
    }

    this.logger.log(
      `Daily usage sync completed: ${synced}/${subscriptions.length} subscriptions`,
    );
  }

  /**
   * Returns true if a feature is enabled in the tenant's current plan.
   */
  async hasFeature(
    userId: string,
    feature: keyof SubscriptionFeatures,
  ): Promise<boolean> {
    const subscription = await this.findCurrent(userId);
    return subscription.hasFeature(feature);
  }

  /**
   * Pricing helper used by PaymentsService.
   */
  getPlanPricing(plan: SubscriptionPlan, billingPeriod: BillingPeriod): number {
    return PLAN_PRICING[plan][billingPeriod];
  }

  /**
   * Helper: Get device count for tenant
   */
  private async getDeviceCountForTenant(tenantId: string): Promise<number> {
    return this.dataSource
      .getRepository(Device)
      .createQueryBuilder('device')
      .where('device.tenantId = :tenantId', { tenantId })
      .andWhere('device.deletedAt IS NULL')
      .getCount();
  }

  /**
   * Helper: Calculate next billing date
   */
  private calculateNextBillingDate(billingPeriod: BillingPeriod): Date {
    const now = new Date();
    return billingPeriod === BillingPeriod.MONTHLY
      ? new Date(now.setMonth(now.getMonth() + 1))
      : new Date(now.setFullYear(now.getFullYear() + 1));
  }

  /**
   * Helper: Calculate trial end date
   */
  private calculateTrialEnd(days: number): Date {
    const now = new Date();
    return new Date(now.setDate(now.getDate() + days));
  }

  /**
   * Helper: Get trial period for plan
   */
  private getTrialPeriod(plan: SubscriptionPlan): number {
    const trialPeriods = {
      [SubscriptionPlan.FREE]: 30,
      [SubscriptionPlan.STARTER]: 0,
      [SubscriptionPlan.PROFESSIONAL]: 0,
      [SubscriptionPlan.ENTERPRISE]: 0,
    };
    return trialPeriods[plan];
  }

  /**
   * Helper: Get plan display name
   */
  private getPlanDisplayName(plan: SubscriptionPlan): string {
    const names = {
      [SubscriptionPlan.FREE]: 'Free',
      [SubscriptionPlan.STARTER]: 'Starter',
      [SubscriptionPlan.PROFESSIONAL]: 'Professional',
      [SubscriptionPlan.ENTERPRISE]: 'Enterprise',
    };
    return names[plan];
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // CRON JOBS
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Reset monthly usage counters for all active subscriptions.
   * Runs at midnight on the 1st of every month.
   * Uses a single bulk SQL UPDATE instead of loading + looping in JS.
   */
  @Cron(CronExpression.EVERY_1ST_DAY_OF_MONTH_AT_MIDNIGHT)
  async resetMonthlyUsage(): Promise<void> {
    this.logger.log('🔄 Starting monthly usage reset...');

    const result = await this.dataSource.query(
      `UPDATE subscriptions
       SET
         usage = jsonb_set(jsonb_set(
           usage,
           '{apiCalls}', '0'::jsonb
         ), '{smsNotifications}', '0'::jsonb),
         metadata = jsonb_set(
           COALESCE(metadata, '{}'),
           '{lastUsageReset}',
           to_jsonb(now()::text)
         )
       WHERE status IN ('active', 'trial')`,
    );

    this.logger.log(
      `✅ Monthly usage reset complete for ${result.rowCount} subscriptions`,
    );
  }

  /**
   * Execute scheduled downgrades when their effective date has passed.
   * Runs every day at midnight.
   */
  @Cron(CronExpression.EVERY_DAY_AT_MIDNIGHT)
  async processScheduledDowngrades(): Promise<void> {
    this.logger.log('Processing scheduled downgrades...');

    // Find subscriptions with a pending downgrade whose date has passed
    const subscriptions = await this.subscriptionRepository
      .createQueryBuilder('s')
      .where(`s.metadata->>'scheduledDowngrade' IS NOT NULL`)
      .andWhere(
        `(s.metadata->'scheduledDowngrade'->>'effectiveDate')::timestamptz <= NOW()`,
      )
      .getMany();

    let processed = 0;
    for (const subscription of subscriptions) {
      try {
        const { plan: targetPlan } = subscription.metadata!.scheduledDowngrade!;

        subscription.plan = targetPlan;
        subscription.price =
          PLAN_PRICING[targetPlan][subscription.billingPeriod];
        subscription.limits = PLAN_LIMITS[targetPlan];
        subscription.features = PLAN_FEATURES[targetPlan];
        subscription.metadata = {
          ...subscription.metadata,
          scheduledDowngrade: undefined,
        };

        await this.subscriptionRepository.save(subscription);
        processed++;

        this.logger.log(
          `Executed downgrade to ${targetPlan} for tenant ${subscription.tenantId}`,
        );
      } catch (err) {
        this.logger.error(
          `Failed to execute downgrade for tenant ${subscription.tenantId}`,
          err,
        );
      }
    }

    this.logger.log(`Processed ${processed} scheduled downgrades`);
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // INVOICES
  // ═══════════════════════════════════════════════════════════════════════════

  async getInvoices(
    tenantId: string | undefined,
    paginationDto: PaginationDto,
  ): Promise<PaginatedResponseDto<any>> {
    const { page, limit, search, sortBy, sortOrder } = paginationDto;

    const subscription = await this.subscriptionRepository.findOne({
      where: { tenantId },
      select: ['id'],
    });

    if (!subscription) {
      return PaginatedResponseDto.create([], page, limit, 0);
    }

    const qb = this.paymentRepository
      .createQueryBuilder('payment')
      .where('payment.subscriptionId = :subscriptionId', {
        subscriptionId: subscription.id,
      });

    if (search) {
      qb.andWhere(
        `(payment.metadata->>'plan' ILIKE :search OR payment.description ILIKE :search)`,
        { search: `%${search}%` },
      );
    }

    const allowedSortFields: Record<string, string> = {
      date: 'payment.paidAt',
      amount: 'payment.amount',
      status: 'payment.status',
      createdAt: 'payment.createdAt',
    };
    const sortField = allowedSortFields[sortBy ?? ''] ?? 'payment.createdAt';
    qb.orderBy(sortField, sortOrder ?? 'DESC');

    qb.skip(paginationDto.skip).take(paginationDto.take);

    const [payments, total] = await qb.getManyAndCount();

    const invoices = payments.map((p) => ({
      id: p.id,
      invoiceNumber: `INV-${p.createdAt.getFullYear()}-${p.id.slice(0, 8).toUpperCase()}`,
      date: p.paidAt ?? p.createdAt,
      amount: Number(p.amount),
      currency: p.currency,
      status: p.status,
      plan: p.metadata?.plan ?? null,
      billingPeriod: p.metadata?.billingPeriod ?? null,
      method: p.method,
      provider: p.provider,
      failureReason: p.failureReason ?? null,
      createdAt: p.createdAt,
    }));

    return PaginatedResponseDto.create(invoices, page, limit, total);
  }

  /**
   * Check if plan change is a renewal (same plan)
   */
  isRenewal(
    currentPlan: SubscriptionPlan,
    targetPlan: SubscriptionPlan,
  ): boolean {
    return currentPlan === targetPlan;
  }

  private validatePaymentAmount(
    paymentAmount: number,
    plan: SubscriptionPlan,
    billingPeriod: BillingPeriod,
  ): void {
    const expected = PLAN_PRICING[plan][billingPeriod];
    if (Math.abs(paymentAmount - expected) > 0.01) {
      throw new BadRequestException(
        `Payment amount ${paymentAmount} does not match plan price ${expected} SAR`,
      );
    }
  }

  async getInvoiceForPdf(
    tenantId: string | undefined,
    paymentId: string,
  ): Promise<{ payment: Payment; invoiceNumber: string }> {
    const subscription = await this.subscriptionRepository.findOne({
      where: { tenantId },
      select: ['id'],
    });

    if (!subscription) throw new NotFoundException('No subscription found');

    const payment = await this.paymentRepository.findOne({
      where: {
        id: paymentId,
        subscriptionId: subscription.id, // ensures tenant isolation
      },
    });

    if (!payment) throw new NotFoundException('Invoice not found');

    const invoiceNumber = `INV-${payment.createdAt.getFullYear()}-${payment.id.slice(0, 8).toUpperCase()}`;

    return { payment, invoiceNumber };
  }
}
