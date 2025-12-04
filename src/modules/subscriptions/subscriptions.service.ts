import {
  Injectable,
  NotFoundException,
  ConflictException,
  Logger,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
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

  constructor(
    @InjectRepository(Subscription)
    private readonly subscriptionRepository: Repository<Subscription>,
  ) {}

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

  async upgrade(
    userId: string,
    upgradeDto: UpgradeSubscriptionDto,
  ): Promise<Subscription> {
    const subscription = await this.findCurrent(userId);

    const { plan, billingPeriod = subscription.billingPeriod } = upgradeDto;

    // Validate upgrade (can't downgrade using this endpoint)
    const planOrder = [
      SubscriptionPlan.FREE,
      SubscriptionPlan.STARTER,
      SubscriptionPlan.PROFESSIONAL,
      SubscriptionPlan.ENTERPRISE,
    ];
    if (planOrder.indexOf(plan) <= planOrder.indexOf(subscription.plan)) {
      throw new ConflictException(
        'Cannot downgrade or switch to same plan using upgrade endpoint',
      );
    }

    subscription.plan = plan;
    subscription.billingPeriod = billingPeriod;
    subscription.price = this.planPricing[plan][billingPeriod];
    subscription.limits = this.planLimits[plan];
    subscription.features = this.getPlanFeatures(plan);
    subscription.status = SubscriptionStatus.ACTIVE;
    subscription.nextBillingDate = this.calculateNextBillingDate(billingPeriod);
    subscription.updatedBy = userId;

    return await this.subscriptionRepository.save(subscription);
  }

  /**
   * Renew subscription - extend the billing period for the same plan
   * Called when a user pays for their current plan again
   */
  async renew(
    userId: string,
    billingPeriod: BillingPeriod,
  ): Promise<Subscription> {
    const subscription = await this.findCurrent(userId);

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
      // Fallback to monthly if unknown billing period
      newNextBillingDate = new Date(baseDate);
      newNextBillingDate.setMonth(newNextBillingDate.getMonth() + 1);
    }

    // Update subscription
    subscription.nextBillingDate = newNextBillingDate;
    subscription.billingPeriod = billingPeriod;
    subscription.status = SubscriptionStatus.ACTIVE;
    subscription.cancelledAt = undefined; // Clear any cancellation
    subscription.updatedBy = userId;

    await this.subscriptionRepository.save(subscription);

    this.logger.log(
      `Subscription renewed for user ${userId}. Next billing: ${newNextBillingDate.toISOString()}`
    );

    return subscription;
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
    // For now, return mock data
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
}