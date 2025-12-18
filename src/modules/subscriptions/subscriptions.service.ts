import {
  Injectable,
  NotFoundException,
  ConflictException,
  Logger,
  BadRequestException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, QueryRunner } from 'typeorm';
import {
  Subscription,
  SubscriptionPlan,
  SubscriptionStatus,
  BillingPeriod,
} from './entities/subscription.entity';
import {
  CreateSubscriptionDto,
  UpgradeSubscriptionDto,
} from './dto/create-subscription.dto';

@Injectable()
export class SubscriptionsService {
  private readonly logger = new Logger(SubscriptionsService.name);
  
  // Plan pricing configuration
  private readonly planPricing = {
    [SubscriptionPlan.FREE]: { monthly: 0, yearly: 0 },
    [SubscriptionPlan.STARTER]: { monthly: 49, yearly: 490 },
    [SubscriptionPlan.PROFESSIONAL]: { monthly: 149, yearly: 1490 },
    [SubscriptionPlan.ENTERPRISE]: { monthly: 499, yearly: 4990 },
  };

  // Plan limits configuration
  private readonly planLimits = {
    [SubscriptionPlan.FREE]: {
      devices: 5,
      users: 1,
      apiCalls: 1000,
      dataRetention: 7,
      storage: 1,
    },
    [SubscriptionPlan.STARTER]: {
      devices: 50,
      users: 5,
      apiCalls: 50000,
      dataRetention: 30,
      storage: 10,
    },
    [SubscriptionPlan.PROFESSIONAL]: {
      devices: 500,
      users: 25,
      apiCalls: 500000,
      dataRetention: 90,
      storage: 100,
    },
    [SubscriptionPlan.ENTERPRISE]: {
      devices: -1, // unlimited
      users: -1,
      apiCalls: -1,
      dataRetention: 365,
      storage: 1000,
    },
  };

  // Plan hierarchy for validation
  private readonly planOrder = [
    SubscriptionPlan.FREE,
    SubscriptionPlan.STARTER,
    SubscriptionPlan.PROFESSIONAL,
    SubscriptionPlan.ENTERPRISE,
  ];

  constructor(
    @InjectRepository(Subscription)
    private readonly subscriptionRepository: Repository<Subscription>,
  ) {}

  /**
   * Create subscription - now handles both manual and automatic creation
   */
  async create(
    userId: string,
    createSubscriptionDto: CreateSubscriptionDto,
  ): Promise<Subscription> {
    // Check if user already has a subscription
    const existing = await this.subscriptionRepository.findOne({
      where: { userId },
    });

    if (existing) {
      throw new ConflictException('User already has a subscription');
    }

    const { plan, billingPeriod = BillingPeriod.MONTHLY } =
      createSubscriptionDto;
    const price = this.planPricing[plan][billingPeriod];
    const limits = this.planLimits[plan];

    const subscription = this.subscriptionRepository.create({
      plan,
      billingPeriod,
      price,
      limits,
      usage: {
        devices: 0,
        users: 1,
        apiCalls: 0,
        storage: 0,
      },
      features: this.getPlanFeatures(plan),
      userId,
      createdBy: userId,
      status:
        plan === SubscriptionPlan.FREE
          ? SubscriptionStatus.ACTIVE
          : SubscriptionStatus.TRIAL,
      nextBillingDate: this.calculateNextBillingDate(billingPeriod),
      trialEndsAt:
        plan !== SubscriptionPlan.FREE ? this.calculateTrialEnd() : undefined,
    });

    return await this.subscriptionRepository.save(subscription);
  }

  /**
   * Get or create subscription - ensures user always has one
   * Call this on user registration or first login
   */
  async getOrCreateFreeSubscription(userId: string): Promise<Subscription> {
    try {
      return await this.findCurrent(userId);
    } catch (error) {
      if (error instanceof NotFoundException) {
        this.logger.log(`Creating free subscription for new user: ${userId}`);
        return await this.create(userId, {
          plan: SubscriptionPlan.FREE,
          billingPeriod: BillingPeriod.MONTHLY,
        });
      }
      throw error;
    }
  }

  async findCurrent(userId: string): Promise<Subscription> {
    const subscription = await this.subscriptionRepository.findOne({
      where: { userId },
    });

    if (!subscription) {
      throw new NotFoundException('No active subscription found');
    }

    return subscription;
  }

  async getPlans() {
    return [
      {
        plan: SubscriptionPlan.FREE,
        name: 'Free',
        monthlyPrice: this.planPricing[SubscriptionPlan.FREE].monthly,
        yearlyPrice: this.planPricing[SubscriptionPlan.FREE].yearly,
        limits: this.planLimits[SubscriptionPlan.FREE],
        features: this.getPlanFeatures(SubscriptionPlan.FREE),
      },
      {
        plan: SubscriptionPlan.STARTER,
        name: 'Starter',
        monthlyPrice: this.planPricing[SubscriptionPlan.STARTER].monthly,
        yearlyPrice: this.planPricing[SubscriptionPlan.STARTER].yearly,
        limits: this.planLimits[SubscriptionPlan.STARTER],
        features: this.getPlanFeatures(SubscriptionPlan.STARTER),
      },
      {
        plan: SubscriptionPlan.PROFESSIONAL,
        name: 'Professional',
        monthlyPrice: this.planPricing[SubscriptionPlan.PROFESSIONAL].monthly,
        yearlyPrice: this.planPricing[SubscriptionPlan.PROFESSIONAL].yearly,
        limits: this.planLimits[SubscriptionPlan.PROFESSIONAL],
        features: this.getPlanFeatures(SubscriptionPlan.PROFESSIONAL),
      },
      {
        plan: SubscriptionPlan.ENTERPRISE,
        name: 'Enterprise',
        monthlyPrice: this.planPricing[SubscriptionPlan.ENTERPRISE].monthly,
        yearlyPrice: this.planPricing[SubscriptionPlan.ENTERPRISE].yearly,
        limits: this.planLimits[SubscriptionPlan.ENTERPRISE],
        features: this.getPlanFeatures(SubscriptionPlan.ENTERPRISE),
      },
    ];
  }

  async getUsage(userId: string) {
    const subscription = await this.findCurrent(userId);

    return {
      current: subscription.usage,
      limits: subscription.limits,
      percentage: {
        devices:
          subscription.limits.devices > 0
            ? (subscription.usage.devices / subscription.limits.devices) * 100
            : 0,
        users:
          subscription.limits.users > 0
            ? (subscription.usage.users / subscription.limits.users) * 100
            : 0,
        apiCalls:
          subscription.limits.apiCalls > 0
            ? (subscription.usage.apiCalls / subscription.limits.apiCalls) * 100
            : 0,
        storage:
          subscription.limits.storage > 0
            ? (subscription.usage.storage / subscription.limits.storage) * 100
            : 0,
      },
    };
  }

  /**
   * Validate if upgrade is allowed (prevents downgrades)
   */
  validateUpgrade(currentPlan: SubscriptionPlan, targetPlan: SubscriptionPlan): void {
    const currentPlanIndex = this.planOrder.indexOf(currentPlan);
    const targetPlanIndex = this.planOrder.indexOf(targetPlan);
    
    if (targetPlanIndex <= currentPlanIndex) {
      throw new BadRequestException(
        `Cannot downgrade from ${currentPlan} to ${targetPlan}. Current plan is equal or higher.`
      );
    }
  }

  /**
   * Check if plan change is an upgrade
   */
  isUpgrade(currentPlan: SubscriptionPlan, targetPlan: SubscriptionPlan): boolean {
    const currentPlanIndex = this.planOrder.indexOf(currentPlan);
    const targetPlanIndex = this.planOrder.indexOf(targetPlan);
    return targetPlanIndex > currentPlanIndex;
  }

  /**
   * Check if plan change is a renewal (same plan)
   */
  isRenewal(currentPlan: SubscriptionPlan, targetPlan: SubscriptionPlan): boolean {
    return currentPlan === targetPlan;
  }

  /**
   * Upgrade subscription - ONLY called after payment verification
   * This is now a PRIVATE method called by payment service
   */
  async upgradeAfterPayment(
    userId: string,
    plan: SubscriptionPlan,
    billingPeriod: BillingPeriod,
    paymentAmount: number,
    queryRunner?: QueryRunner,
  ): Promise<Subscription> {
    const useTransaction = !!queryRunner;
    const repository = useTransaction 
      ? queryRunner.manager.getRepository(Subscription)
      : this.subscriptionRepository;

    // Get current subscription with lock to prevent race conditions
    const subscription = await repository.findOne({
      where: { userId },
      lock: useTransaction ? { mode: 'pessimistic_write' } : undefined,
    });

    if (!subscription) {
      throw new NotFoundException('No subscription found for user');
    }

    // Validate this is actually an upgrade
    this.validateUpgrade(subscription.plan, plan);

    // Validate payment amount matches plan pricing
    const expectedAmount = this.planPricing[plan][billingPeriod];
    if (Math.abs(paymentAmount - expectedAmount) > 0.01) {
      throw new BadRequestException(
        `Payment amount ${paymentAmount} does not match plan price ${expectedAmount}`
      );
    }

    // Update subscription
    subscription.plan = plan;
    subscription.billingPeriod = billingPeriod;
    subscription.price = this.planPricing[plan][billingPeriod];
    subscription.limits = this.planLimits[plan];
    subscription.features = this.getPlanFeatures(plan);
    subscription.status = SubscriptionStatus.ACTIVE;
    subscription.nextBillingDate = this.calculateNextBillingDate(billingPeriod);
    subscription.trialEndsAt = undefined; // Clear trial when upgrading
    subscription.cancelledAt = undefined; // Clear cancellation
    subscription.updatedBy = userId;

    // Clear any scheduled downgrades
    if (subscription.metadata?.scheduledDowngrade) {
      subscription.metadata = {
        ...subscription.metadata,
        scheduledDowngrade: undefined,
      };
    }

    const updated = await repository.save(subscription);
    
    this.logger.log(
      `✅ Subscription upgraded for user ${userId}: ${subscription.plan} → ${plan}`
    );

    return updated;
  }

  /**
   * Renew subscription - ONLY called after payment verification
   * Called when a user pays for their current plan again
   */
  async renewAfterPayment(
    userId: string,
    billingPeriod: BillingPeriod,
    paymentAmount: number,
    queryRunner?: QueryRunner,
  ): Promise<Subscription> {
    const useTransaction = !!queryRunner;
    const repository = useTransaction 
      ? queryRunner.manager.getRepository(Subscription)
      : this.subscriptionRepository;

    const subscription = await repository.findOne({
      where: { userId },
      lock: useTransaction ? { mode: 'pessimistic_write' } : undefined,
    });

    if (!subscription) {
      throw new NotFoundException('No subscription found for user');
    }

    // Validate payment amount matches current plan pricing
    const expectedAmount = this.planPricing[subscription.plan][billingPeriod];
    if (Math.abs(paymentAmount - expectedAmount) > 0.01) {
      throw new BadRequestException(
        `Payment amount ${paymentAmount} does not match plan price ${expectedAmount}`
      );
    }

    // Calculate the new next billing date
    const currentNextBilling = subscription.nextBillingDate || new Date();
    const today = new Date();
    
    // If next billing date is in the past, start from today
    const baseDate = currentNextBilling > today ? currentNextBilling : today;
    
    let newNextBillingDate: Date;
    
    if (billingPeriod === BillingPeriod.MONTHLY) {
      newNextBillingDate = new Date(baseDate);
      newNextBillingDate.setMonth(newNextBillingDate.getMonth() + 1);
    } else if (billingPeriod === BillingPeriod.YEARLY) {
      newNextBillingDate = new Date(baseDate);
      newNextBillingDate.setFullYear(newNextBillingDate.getFullYear() + 1);
    } else {
      newNextBillingDate = new Date(baseDate);
      newNextBillingDate.setMonth(newNextBillingDate.getMonth() + 1);
    }

    // Update subscription
    subscription.nextBillingDate = newNextBillingDate;
    subscription.billingPeriod = billingPeriod;
    subscription.status = SubscriptionStatus.ACTIVE;
    subscription.cancelledAt = undefined;
    subscription.trialEndsAt = undefined;
    subscription.updatedBy = userId;

    await repository.save(subscription);

    this.logger.log(
      `✅ Subscription renewed for user ${userId}. Next billing: ${newNextBillingDate.toISOString()}`
    );

    return subscription;
  }

  /**
   * Process subscription change after successful payment
   * This is the main entry point called by PaymentsService
   */
  async processSubscriptionAfterPayment(
    userId: string,
    targetPlan: SubscriptionPlan,
    billingPeriod: BillingPeriod,
    paymentAmount: number,
    queryRunner?: QueryRunner,
  ): Promise<Subscription> {
    const subscription = await this.findCurrent(userId);

    // Determine action type
    if (this.isUpgrade(subscription.plan, targetPlan)) {
      return await this.upgradeAfterPayment(
        userId,
        targetPlan,
        billingPeriod,
        paymentAmount,
        queryRunner,
      );
    } else if (this.isRenewal(subscription.plan, targetPlan)) {
      return await this.renewAfterPayment(
        userId,
        billingPeriod,
        paymentAmount,
        queryRunner,
      );
    } else {
      // This is a downgrade attempt - should never happen if payment validation is correct
      throw new BadRequestException(
        `Cannot process downgrade from ${subscription.plan} to ${targetPlan} via payment`
      );
    }
  }

  /**
   * OLD UPGRADE ENDPOINT - Now deprecated, redirect to payment flow
   * Keep for backward compatibility but should not process upgrades directly
   */
  async upgrade(
    userId: string,
    upgradeDto: UpgradeSubscriptionDto,
  ): Promise<{ requiresPayment: true; message: string; plan: SubscriptionPlan; billingPeriod: BillingPeriod }> {
    const subscription = await this.findCurrent(userId);
    const { plan, billingPeriod = subscription.billingPeriod } = upgradeDto;

    // Validate upgrade
    this.validateUpgrade(subscription.plan, plan);

    // Return payment requirement instead of processing directly
    return {
      requiresPayment: true,
      message: 'Please complete payment to upgrade your subscription',
      plan,
      billingPeriod,
    };
  }

  /**
   * Schedule downgrade for end of billing period
   */
  async scheduleDowngrade(
    userId: string,
    targetPlan: SubscriptionPlan,
  ): Promise<Subscription> {
    const subscription = await this.findCurrent(userId);

    const currentPlanIndex = this.planOrder.indexOf(subscription.plan);
    const newPlanIndex = this.planOrder.indexOf(targetPlan);
    
    if (newPlanIndex >= currentPlanIndex) {
      throw new ConflictException(
        'Target plan must be lower than current plan for downgrade',
      );
    }

    // Schedule downgrade for next billing date
    subscription.metadata = {
      ...subscription.metadata,
      scheduledDowngrade: {
        plan: targetPlan,
        effectiveDate: subscription.nextBillingDate,
      },
    };
    subscription.updatedBy = userId;

    await this.subscriptionRepository.save(subscription);

    this.logger.log(
      `Downgrade scheduled for user ${userId}: ${subscription.plan} → ${targetPlan} on ${subscription.nextBillingDate}`
    );

    return subscription;
  }

  /**
   * Execute scheduled downgrade (called by cron job)
   */
  async executeScheduledDowngrade(userId: string): Promise<Subscription | null> {
    const subscription = await this.findCurrent(userId);

    if (!subscription.metadata?.scheduledDowngrade) {
      return null;
    }

    const { plan: targetPlan, effectiveDate } = subscription.metadata.scheduledDowngrade;
    const now = new Date();

    if (effectiveDate && new Date(effectiveDate) <= now) {
      subscription.plan = targetPlan;
      subscription.price = this.planPricing[targetPlan][subscription.billingPeriod];
      subscription.limits = this.planLimits[targetPlan];
      subscription.features = this.getPlanFeatures(targetPlan);
      
      // Clear scheduled downgrade
      subscription.metadata = {
        ...subscription.metadata,
        scheduledDowngrade: undefined,
      };

      await this.subscriptionRepository.save(subscription);

      this.logger.log(
        `✅ Executed scheduled downgrade for user ${userId} to ${targetPlan}`
      );

      return subscription;
    }

    return null;
  }

  async cancel(userId: string): Promise<Subscription> {
    const subscription = await this.findCurrent(userId);

    if (subscription.status === SubscriptionStatus.CANCELLED) {
      throw new ConflictException('Subscription is already cancelled');
    }

    subscription.status = SubscriptionStatus.CANCELLED;
    subscription.cancelledAt = new Date();
    subscription.updatedBy = userId;

    return await this.subscriptionRepository.save(subscription);
  }

  async getInvoices(userId: string) {
    // TODO: Implement actual invoice retrieval from billing system
    return {
      invoices: [],
      total: 0,
    };
  }

  private getPlanFeatures(plan: SubscriptionPlan) {
    const features = {
      [SubscriptionPlan.FREE]: {
        analytics: false,
        automation: false,
        integrations: false,
        support: 'community',
        whiteLabel: false,
      },
      [SubscriptionPlan.STARTER]: {
        analytics: true,
        automation: true,
        integrations: false,
        support: 'email',
        whiteLabel: false,
      },
      [SubscriptionPlan.PROFESSIONAL]: {
        analytics: true,
        automation: true,
        integrations: true,
        support: 'priority',
        whiteLabel: true,
      },
      [SubscriptionPlan.ENTERPRISE]: {
        analytics: true,
        automation: true,
        integrations: true,
        support: '24/7',
        whiteLabel: true,
      },
    };

    return features[plan];
  }

  private calculateNextBillingDate(billingPeriod: BillingPeriod): Date {
    const now = new Date();
    if (billingPeriod === BillingPeriod.MONTHLY) {
      return new Date(now.setMonth(now.getMonth() + 1));
    } else {
      return new Date(now.setFullYear(now.getFullYear() + 1));
    }
  }

  private calculateTrialEnd(): Date {
    const now = new Date();
    return new Date(now.setDate(now.getDate() + 14)); // 14-day trial
  }

  /**
   * Increment usage for a specific resource
   */
  async incrementUsage(
    userId: string,
    resource: 'devices' | 'users' | 'apiCalls' | 'storage',
    amount: number = 1,
  ): Promise<void> {
    const subscription = await this.findCurrent(userId);

    subscription.usage[resource] = (subscription.usage[resource] || 0) + amount;

    await this.subscriptionRepository.save(subscription);
  }

  /**
   * Decrement usage for a specific resource
   */
  async decrementUsage(
    userId: string,
    resource: 'devices' | 'users' | 'apiCalls' | 'storage',
    amount: number = 1,
  ): Promise<void> {
    const subscription = await this.findCurrent(userId);

    subscription.usage[resource] = Math.max(
      0,
      (subscription.usage[resource] || 0) - amount,
    );

    await this.subscriptionRepository.save(subscription);
  }

  /**
   * Check if user can perform action based on limits
   */
  async canPerformAction(
    userId: string,
    resource: 'devices' | 'users' | 'apiCalls' | 'storage',
  ): Promise<boolean> {
    const subscription = await this.findCurrent(userId);

    const currentUsage = subscription.usage[resource] || 0;
    const limit = subscription.limits[resource];

    // -1 means unlimited
    if (limit === -1) {
      return true;
    }

    return currentUsage < limit;
  }

  /**
   * Check if feature is available for user
   */
  async hasFeature(userId: string, feature: string): Promise<boolean> {
    const subscription = await this.findCurrent(userId);

    return subscription.features?.[feature] === true;
  }

  /**
   * Get pricing for a plan
   */
  getPlanPricing(plan: SubscriptionPlan, billingPeriod: BillingPeriod): number {
    return this.planPricing[plan][billingPeriod];
  }
}