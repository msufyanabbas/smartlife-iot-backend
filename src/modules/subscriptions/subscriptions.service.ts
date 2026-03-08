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
import { SubscriptionPlan, SubscriptionStatus, BillingPeriod, SupportLevel } from '@common/enums/index.enum';
import { SubscriptionFeatures, SubscriptionLimits, SubscriptionUsage, EMPTY_USAGE } from '@common/interfaces/index.interface';
import { Subscription, Customer, Device, Tenant, User, Payment } from '@modules/index.entities';
import {
  CreateSubscriptionDto,
  UpgradeSubscriptionDto,
} from './dto/create-subscription.dto';
import { UsersService } from '@modules/index.service';

// ─────────────────────────────────────────────────────────────────────────────
// Plan Configuration
//
// SYNC RULE: when you add a field to SubscriptionLimits or SubscriptionFeatures
// in subscription.entity.ts, add it to EVERY plan config below.
// TypeScript will error here if you miss one (the Record type enforces it).
// ─────────────────────────────────────────────────────────────────────────────

const PLAN_PRICING: Record<SubscriptionPlan, Record<BillingPeriod, number>> = {
  [SubscriptionPlan.FREE]: { [BillingPeriod.MONTHLY]: 0, [BillingPeriod.YEARLY]: 0 },
  [SubscriptionPlan.STARTER]: { [BillingPeriod.MONTHLY]: 199, [BillingPeriod.YEARLY]: 1990 },
  [SubscriptionPlan.PROFESSIONAL]: { [BillingPeriod.MONTHLY]: 499, [BillingPeriod.YEARLY]: 4990 },
  [SubscriptionPlan.ENTERPRISE]: { [BillingPeriod.MONTHLY]: 0, [BillingPeriod.YEARLY]: 0 },
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
    users: 2,
    customers: 1,
    apiCallsPerMonth: 10_000,
    storageGB: 1,
    smsNotificationsPerMonth: 0,
  },
  [SubscriptionPlan.STARTER]: {
    devices: 50,
    dashboards: 5,
    assets: 100,
    floorPlans: 5,
    automations: 10,
    users: 5,
    customers: 5,
    apiCallsPerMonth: 100_000,
    storageGB: 10,
    smsNotificationsPerMonth: 100,
  },
  [SubscriptionPlan.PROFESSIONAL]: {
    devices: 200,
    dashboards: 20,
    assets: 500,
    floorPlans: 20,
    automations: -1,  // unlimited
    users: 20,
    customers: 20,
    apiCallsPerMonth: 500_000,
    storageGB: 50,
    smsNotificationsPerMonth: 500,
  },
  [SubscriptionPlan.ENTERPRISE]: {
    devices: -1,
    dashboards: -1,
    assets: -1,
    floorPlans: -1,
    automations: -1,
    users: -1,
    customers: -1,
    apiCallsPerMonth: -1,
    storageGB: 500,
    smsNotificationsPerMonth: -1,
  },
};

// These must match SubscriptionFeatures exactly — TypeScript enforces it
const PLAN_FEATURES: Record<SubscriptionPlan, SubscriptionFeatures> = {
  [SubscriptionPlan.FREE]: {
    devices: true,
    dashboards: true,
    assets: true,
    floorPlans: false,
    automations: false,
    apiAccess: true,
    smsNotifications: false,
    whiteLabel: false,
    auditLogs: false,
  },
  [SubscriptionPlan.STARTER]: {
    devices: true,
    dashboards: true,
    assets: true,
    floorPlans: true,
    automations: true,
    apiAccess: true,
    smsNotifications: true,
    whiteLabel: false,
    auditLogs: true,
  },
  [SubscriptionPlan.PROFESSIONAL]: {
    devices: true,
    dashboards: true,
    assets: true,
    floorPlans: true,
    automations: true,
    apiAccess: true,
    smsNotifications: true,
    whiteLabel: true,
    auditLogs: true,
  },
  [SubscriptionPlan.ENTERPRISE]: {
    devices: true,
    dashboards: true,
    assets: true,
    floorPlans: true,
    automations: true,
    apiAccess: true,
    smsNotifications: true,
    whiteLabel: true,
    auditLogs: true,
  },
};

const PLAN_ORDER: SubscriptionPlan[] = [
  SubscriptionPlan.FREE,
  SubscriptionPlan.STARTER,
  SubscriptionPlan.PROFESSIONAL,
  SubscriptionPlan.ENTERPRISE,
];

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

  constructor(
    @InjectRepository(Subscription)
    private readonly subscriptionRepository: Repository<Subscription>,
    @InjectRepository(Tenant)
    private readonly tenantRepository: Repository<Tenant>,
    @InjectRepository(Payment)
private readonly paymentRepository: Repository<Payment>,
    private readonly dataSource: DataSource
  ) { }

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
    tenantId: string,
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
    const existing = await this.subscriptionRepository.findOne({
      where: { tenantId },
    });

    if (existing) {
      throw new ConflictException('Tenant already has a subscription');
    }

    const { plan, billingPeriod = BillingPeriod.MONTHLY } = createSubscriptionDto;
    const trialDays = PLAN_TRIAL_DAYS[plan];
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
      trialEndsAt:
        plan !== SubscriptionPlan.FREE && trialDays > 0
          ? this.calculateTrialEnd(trialDays)
          : undefined,
      metadata: {
        lastUsageReset: new Date(),
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
   */
  async findByTenantId(tenantId: string): Promise<Subscription> {
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

    // Super admin has no tenant and no subscription
    if (!user.tenantId) {
      throw new NotFoundException('No subscription associated with this account');
    }

    return this.findByTenantId(user.tenantId);
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
      percentage: this.calculateUsagePercentages(subscription.usage, subscription.limits),
      warnings: this.generateUsageWarnings(subscription.usage, subscription.limits),
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
      if (limit === -1) return 0;  // unlimited — show 0%
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
      smsNotifications: pct(usage.smsNotifications, limits.smsNotificationsPerMonth),
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
        warnings.push(`${label} usage at ${Math.round(pct)}% (${used}/${limit})`);
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
    check('SMS Notifications', usage.smsNotifications, limits.smsNotificationsPerMonth);

    return warnings;
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // PRIVATE HELPERS
  // ═══════════════════════════════════════════════════════════════════════════
  validateUpgrade(currentPlan: SubscriptionPlan, targetPlan: SubscriptionPlan): void {
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
  isUpgrade(currentPlan: SubscriptionPlan, targetPlan: SubscriptionPlan): boolean {
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
  ): Promise<Subscription> {
    const useTransaction = !!queryRunner;
    const repository = useTransaction
      ? queryRunner.manager.getRepository(Subscription)
      : this.subscriptionRepository;

    const subscription = await repository.findOne({
      where: { tenantId },
      lock: { mode: 'pessimistic_write' }
    });

    if (!subscription) {
      throw new NotFoundException('No subscription found');
    }

    this.validateUpgrade(subscription.plan, plan);

    if (Math.abs(paymentAmount - PLAN_PRICING[plan][billingPeriod]) > 0.01) {
      throw new BadRequestException(
        `Payment amount ${paymentAmount} does not match plan price ${PLAN_PRICING[plan][billingPeriod]}`,
      );
    }

    subscription.plan = plan;
    subscription.billingPeriod = billingPeriod;
    subscription.price = PLAN_PRICING[plan][billingPeriod];
    subscription.limits = PLAN_LIMITS[plan];
    subscription.features = PLAN_FEATURES[plan];
    subscription.status = SubscriptionStatus.ACTIVE;
    subscription.nextBillingDate = this.calculateNextBillingDate(billingPeriod);
    subscription.trialEndsAt = undefined;
    subscription.cancelledAt = undefined;
    subscription.updatedBy = tenantId;

    if (subscription.metadata?.scheduledDowngrade) {
      subscription.metadata = {
        ...subscription.metadata,
        scheduledDowngrade: undefined,
      };
    }

    const updated = await repository.save(subscription);

    this.logger.log(
      `✅ Subscription upgraded: ${subscription.plan} → ${plan} (User: ${tenantId})`,
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
  ): Promise<Subscription> {
    const useTransaction = !!queryRunner;
    const repository = useTransaction
      ? queryRunner.manager.getRepository(Subscription)
      : this.subscriptionRepository;

    const subscription = await repository.findOne({
      where: { tenantId },
      lock: { mode: 'pessimistic_write' }
    });

    if (!subscription) {
      throw new NotFoundException('No subscription found');
    }

    this.validatePaymentAmount(paymentAmount, subscription.plan, billingPeriod)

    const expectedAmount = PLAN_PRICING[subscription.plan][billingPeriod];
    if (Math.abs(paymentAmount - expectedAmount) > 0.01) {
      throw new BadRequestException(
        `Payment amount ${paymentAmount} does not match plan price ${expectedAmount}`,
      );
    }
    // Extend from the current next billing date if in the future, otherwise from now
    const baseDate = subscription.nextBillingDate && subscription.nextBillingDate > new Date()
      ? new Date(subscription.nextBillingDate)
      : new Date();

    subscription.nextBillingDate = billingPeriod === BillingPeriod.MONTHLY
      ? new Date(baseDate.setMonth(baseDate.getMonth() + 1))
      : new Date(baseDate.setFullYear(baseDate.getFullYear() + 1));

    subscription.billingPeriod = billingPeriod;
    subscription.status = SubscriptionStatus.ACTIVE;
    subscription.cancelledAt = undefined;
    subscription.trialEndsAt = undefined;
    subscription.updatedBy = tenantId;

    await repository.save(subscription);

    this.logger.log(
      `✅ Subscription renewed (User: ${tenantId}, Next billing: ${subscription.nextBillingDate})`,
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
  ): Promise<Subscription> {
    const subscription = await this.findByTenantId(tenantId);

    if (this.isUpgrade(subscription.plan, targetPlan)) {
      return await this.upgradeAfterPayment(
        tenantId,
        targetPlan,
        billingPeriod,
        paymentAmount,
        queryRunner,
      );
    }

    if (this.isRenewal(subscription.plan, targetPlan)) {
      return this.renewAfterPayment(
        tenantId,
        billingPeriod,
        paymentAmount,
        queryRunner,
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
    const subscription = await this.findCurrent(userId);
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
    const subscription = await this.findCurrent(userId);

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
    const subscription = await this.findCurrent(userId);

    if (!subscription.metadata?.scheduledDowngrade) {
      throw new NotFoundException('No scheduled downgrade found');
    }

    subscription.metadata = { ...subscription.metadata, scheduledDowngrade: undefined };
    return this.subscriptionRepository.save(subscription);
  }

  /**
   * Execute scheduled downgrade (cron job)
   */
  async executeScheduledDowngrade(
    userId: string,
  ): Promise<Subscription | null> {
    const subscription = await this.findCurrent(userId);

    if (!subscription.metadata?.scheduledDowngrade) {
      return null;
    }

    const { plan: targetPlan, effectiveDate } =
      subscription.metadata.scheduledDowngrade;
    const now = new Date();

    if (effectiveDate && new Date(effectiveDate) <= now) {
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
  async cancel(userId: string): Promise<Subscription> {
    const subscription = await this.findCurrent(userId);

    if (subscription.status === SubscriptionStatus.CANCELLED) {
      throw new ConflictException('Subscription already cancelled');
    }

    subscription.status = SubscriptionStatus.CANCELLED;
    subscription.cancelledAt = new Date();
    subscription.updatedBy = userId;

    return await this.subscriptionRepository.save(subscription);
  }

  /**
   * @deprecated — use incrementTenantUsage() instead.
   * Kept for backward compatibility with any existing callers.
   */
  async incrementUsage(
    userId: string,
    resource: keyof SubscriptionUsage,
    amount = 1,
  ): Promise<void> {
    const subscription = await this.findCurrent(userId);
    await this.incrementTenantUsage(subscription.tenantId, resource, amount);
  }

  /**
   * @deprecated — use decrementTenantUsage() instead.
   */
  async decrementUsage(
    userId: string,
    resource: keyof SubscriptionUsage,
    amount = 1,
  ): Promise<void> {
    const subscription = await this.findCurrent(userId);
    await this.decrementTenantUsage(subscription.tenantId, resource, amount);
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

  /**
   * Returns true if a feature is enabled in the tenant's current plan.
   */
  async hasFeature(userId: string, feature: keyof SubscriptionFeatures): Promise<boolean> {
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
        subscription.price = PLAN_PRICING[targetPlan][subscription.billingPeriod];
        subscription.limits = PLAN_LIMITS[targetPlan];
        subscription.features = PLAN_FEATURES[targetPlan];
        subscription.metadata = { ...subscription.metadata, scheduledDowngrade: undefined };

        await this.subscriptionRepository.save(subscription);
        processed++;

        this.logger.log(`Executed downgrade to ${targetPlan} for tenant ${subscription.tenantId}`);
      } catch (err) {
        this.logger.error(`Failed to execute downgrade for tenant ${subscription.tenantId}`, err);
      }
    }

    this.logger.log(`Processed ${processed} scheduled downgrades`);
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // INVOICES
  // ═══════════════════════════════════════════════════════════════════════════

async getInvoices(tenantId: string | undefined): Promise<{ invoices: any[]; total: number }> {
  // First get the subscription to find its id
  const subscription = await this.subscriptionRepository.findOne({
    where: { tenantId },
    select: ['id'],
  });

  if (!subscription) {
    return { invoices: [], total: 0 };
  }

  const payments = await this.paymentRepository.find({
    where: { subscriptionId: subscription.id },
    order: { createdAt: 'DESC' },
  });

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

  return { invoices, total: invoices.length };
}

  /**
   * Check if plan change is a renewal (same plan)
   */
  isRenewal(currentPlan: SubscriptionPlan, targetPlan: SubscriptionPlan): boolean {
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
}