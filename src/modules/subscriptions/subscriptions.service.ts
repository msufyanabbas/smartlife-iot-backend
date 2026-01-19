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
  Subscription,
  SubscriptionPlan,
  SubscriptionStatus,
  BillingPeriod,
  SubscriptionLimits,
  SubscriptionFeatures,
  SupportLevel,
} from './entities/subscription.entity';
import {
  CreateSubscriptionDto,
  UpgradeSubscriptionDto,
} from './dto/create-subscription.dto';
import { Customer, Device, Tenant, User } from '../index.entities';
import { UsersService } from '../users/users.service';

@Injectable()
export class SubscriptionsService {
  private readonly logger = new Logger(SubscriptionsService.name);

  // ✅ Plan pricing configuration (SAR)
  private readonly planPricing = {
    [SubscriptionPlan.FREE]: { monthly: 0, yearly: 0 },
    [SubscriptionPlan.STARTER]: { monthly: 199, yearly: 1990 },
    [SubscriptionPlan.PROFESSIONAL]: { monthly: 499, yearly: 4990 },
    [SubscriptionPlan.ENTERPRISE]: { monthly: 0, yearly: 0 }, // Custom pricing
  };

  // ✅ Plan limits configuration based on Smart Life Excel
  private readonly planLimits: Record<SubscriptionPlan, SubscriptionLimits> = {
    [SubscriptionPlan.FREE]: {
      devices: 5,
      users: 2,
      customers: 1,
      apiCallsPerMonth: 10000,
      dataRetentionDays: 7,
      storageGB: 1,
      dashboardTemplates: 3,
      customDashboards: 1,
      customIntegrations: 0,
      webhooks: 0,
      apiRateLimitPerMin: 100,
      concurrentConnections: 10,
      smsNotificationsPerMonth: 0,
      historicalDataQueryDays: 7,
      trainingSessions: 0,
    },
    [SubscriptionPlan.STARTER]: {
      devices: 50,
      users: 5,
      customers: 5,
      apiCallsPerMonth: 100000,
      dataRetentionDays: 30,
      storageGB: 10,
      dashboardTemplates: 10,
      customDashboards: 5,
      customIntegrations: 3,
      webhooks: 5,
      apiRateLimitPerMin: 500,
      concurrentConnections: 50,
      smsNotificationsPerMonth: 100,
      historicalDataQueryDays: 30,
      trainingSessions: 0,
    },
    [SubscriptionPlan.PROFESSIONAL]: {
      devices: 200,
      users: 20,
      customers: 20,
      apiCallsPerMonth: 500000,
      dataRetentionDays: 90,
      storageGB: 50,
      dashboardTemplates: -1, // unlimited
      customDashboards: 20,
      customIntegrations: -1, // unlimited
      webhooks: -1, // unlimited
      apiRateLimitPerMin: 1000,
      concurrentConnections: 200,
      smsNotificationsPerMonth: 500,
      historicalDataQueryDays: 90,
      trainingSessions: 1,
    },
    [SubscriptionPlan.ENTERPRISE]: {
      devices: -1, // unlimited
      users: -1, // unlimited
      customers: -1, // unlimited
      apiCallsPerMonth: -1, // unlimited
      dataRetentionDays: 365,
      storageGB: 500,
      dashboardTemplates: -1, // unlimited
      customDashboards: -1, // unlimited
      customIntegrations: -1, // unlimited
      webhooks: -1, // unlimited
      apiRateLimitPerMin: -1, // unlimited
      concurrentConnections: -1, // unlimited
      smsNotificationsPerMonth: -1, // unlimited
      historicalDataQueryDays: 365,
      trainingSessions: -1, // unlimited
    },
  };

  // ✅ Plan features configuration based on Smart Life Excel
  private readonly planFeatures: Record<SubscriptionPlan, SubscriptionFeatures> = {
    [SubscriptionPlan.FREE]: {
      realtimeAnalytics: false,
      advancedAutomation: false,
      ruleEngine: 'basic',
      restApiAccess: true,
      mqttAccess: true,
      customIntegrations: false,
      whiteLabelBranding: false,
      brandingLevel: 'none',
      emailNotifications: true,
      smsNotifications: false,
      mobileAppAccess: true,
      widgetLibrary: 'basic',
      alarmManagement: 'basic',
      advancedAlarms: false,
      dataExport: 'csv',
      scheduledReports: 'none',
      supportLevel: SupportLevel.COMMUNITY,
      slaGuarantee: false,
      slaPercentage: 0,
      onboardingSupport: 'none',
      floorMapping: 0,
      customDevelopment: false,
      multiTenancy: false,
      customerManagement: false,
      roleBasedAccess: false,
      auditLogs: false,
      backupRecovery: false,
      otaUpdates: 'manual',
      deviceGroups: true,
      assetManagement: 'none',
      geofencing: false,
      customAttributes: false,
      rpcCommands: false,
      dataAggregation: false,
    },
    [SubscriptionPlan.STARTER]: {
      realtimeAnalytics: true,
      advancedAutomation: true,
      ruleEngine: 'advanced',
      restApiAccess: true,
      mqttAccess: true,
      customIntegrations: true,
      whiteLabelBranding: false,
      brandingLevel: 'none',
      emailNotifications: true,
      smsNotifications: true,
      mobileAppAccess: true,
      widgetLibrary: 'standard',
      alarmManagement: 'advanced',
      advancedAlarms: false,
      dataExport: 'csv-json-excel',
      scheduledReports: 'monthly',
      supportLevel: SupportLevel.EMAIL,
      slaGuarantee: true,
      slaPercentage: 95,
      onboardingSupport: 'basic',
      floorMapping: 5,
      customDevelopment: false,
      multiTenancy: false,
      customerManagement: false,
      roleBasedAccess: true,
      auditLogs: true,
      backupRecovery: true,
      otaUpdates: 'automatic',
      deviceGroups: true,
      assetManagement: 'basic',
      geofencing: true,
      customAttributes: true,
      rpcCommands: true,
      dataAggregation: false,
    },
    [SubscriptionPlan.PROFESSIONAL]: {
      realtimeAnalytics: true,
      advancedAutomation: true,
      ruleEngine: 'advanced',
      restApiAccess: true,
      mqttAccess: true,
      customIntegrations: true,
      whiteLabelBranding: true,
      brandingLevel: 'partial',
      emailNotifications: true,
      smsNotifications: true,
      mobileAppAccess: true,
      widgetLibrary: 'advanced',
      alarmManagement: 'advanced',
      advancedAlarms: true,
      dataExport: 'all-formats',
      scheduledReports: 'weekly',
      supportLevel: SupportLevel.PRIORITY,
      slaGuarantee: true,
      slaPercentage: 99,
      onboardingSupport: 'standard',
      floorMapping: 20,
      customDevelopment: false,
      multiTenancy: true,
      customerManagement: true,
      roleBasedAccess: true,
      auditLogs: true,
      backupRecovery: true,
      otaUpdates: 'automatic',
      deviceGroups: true,
      assetManagement: 'advanced',
      geofencing: true,
      customAttributes: true,
      rpcCommands: true,
      dataAggregation: true,
    },
    [SubscriptionPlan.ENTERPRISE]: {
      realtimeAnalytics: true,
      advancedAutomation: true,
      ruleEngine: 'premium',
      restApiAccess: true,
      mqttAccess: true,
      customIntegrations: true,
      whiteLabelBranding: true,
      brandingLevel: 'full',
      emailNotifications: true,
      smsNotifications: true,
      mobileAppAccess: true,
      widgetLibrary: 'advanced',
      alarmManagement: 'advanced',
      advancedAlarms: true,
      dataExport: 'all-formats',
      scheduledReports: 'realtime',
      supportLevel: SupportLevel.DEDICATED,
      slaGuarantee: true,
      slaPercentage: 99.9,
      onboardingSupport: 'premium',
      floorMapping: -1, // unlimited
      customDevelopment: true,
      multiTenancy: true,
      customerManagement: true,
      roleBasedAccess: true,
      auditLogs: true,
      backupRecovery: true,
      otaUpdates: 'automatic',
      deviceGroups: true,
      assetManagement: 'advanced',
      geofencing: true,
      customAttributes: true,
      rpcCommands: true,
      dataAggregation: true,
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
    @InjectRepository(User)
    private readonly userRepository: Repository<User>,
    @InjectRepository(Tenant)
    private readonly tenantRepository: Repository<Tenant>,
    private readonly dataSource: DataSource,
    private usersService: UsersService,
  ) {}

  /**
   * ✅ Get tenant-wide usage statistics
   */
  async getTenantUsage(tenantId: string): Promise<{
    devices: number;
    users: number;
    customers: number;
    apiCalls: number;
    storage: number;
    smsNotifications: number;
  }> {
    // Count users in tenant
    const usersCount = await this.userRepository.count({
      where: { tenantId },
    });

    // Count customers in tenant
    const customersCount = await this.dataSource
      .getRepository(Customer)
      .count({
        where: { tenantId },
      });

    // Count devices in tenant
    const devicesCount = await this.getDeviceCountForTenant(tenantId);

    // Get API calls and storage from tenant admin's subscription
    const tenant = await this.tenantRepository.findOne({
      where: { id: tenantId },
    });

    if (!tenant || !tenant.tenantAdminId) {
      return {
        devices: devicesCount,
        users: usersCount,
        customers: customersCount,
        apiCalls: 0,
        storage: 0,
        smsNotifications: 0,
      };
    }

    const subscription = await this.subscriptionRepository.findOne({
      where: { userId: tenant.tenantAdminId },
    });

    return {
      devices: devicesCount,
      users: usersCount,
      customers: customersCount,
      apiCalls: subscription?.usage.apiCalls || 0,
      storage: subscription?.usage.storage || 0,
      smsNotifications: subscription?.usage.smsNotifications || 0,
    };
  }

  /**
   * ✅ Check if tenant can perform action based on limits
   */
  async canTenantPerformAction(
    tenantId: string,
    resource: 'devices' | 'users' | 'customers' | 'apiCalls' | 'storage' | 'smsNotifications',
  ): Promise<boolean> {
    const tenant = await this.tenantRepository.findOne({
      where: { id: tenantId },
    });

    if (!tenant || !tenant.tenantAdminId) {
      this.logger.warn(`Tenant ${tenantId} has no admin - denying access`);
      return false;
    }

    return this.canPerformAction(tenant.tenantAdminId, resource);
  }

  /**
   * Create subscription
   */
  async create(
    userId: string,
    createSubscriptionDto: CreateSubscriptionDto,
  ): Promise<Subscription> {
    const existing = await this.subscriptionRepository.findOne({
      where: { userId },
    });

    if (existing) {
      throw new ConflictException('User already has a subscription');
    }

    const { plan, billingPeriod = BillingPeriod.MONTHLY } = createSubscriptionDto;
    const price = this.planPricing[plan][billingPeriod];
    const limits = this.planLimits[plan];
    const features = this.planFeatures[plan];

    // Get trial period based on plan
    const trialDays = this.getTrialPeriod(plan);

    const subscription = this.subscriptionRepository.create({
      plan,
      billingPeriod,
      price,
      limits,
      features,
      usage: {
        devices: 0,
        users: 1, // Creator counts as 1 user
        customers: 0,
        apiCalls: 0,
        storage: 0,
        smsNotifications: 0,
      },
      userId,
      createdBy: userId,
      status:
        plan === SubscriptionPlan.FREE
          ? SubscriptionStatus.ACTIVE
          : SubscriptionStatus.TRIAL,
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

  /**
   * Find current subscription
   */
  async findCurrent(userId: string): Promise<Subscription> {
    
    const user: any = await this.usersService.findByTenant(userId);

    const subscription = await this.subscriptionRepository.findOne({
      where: { userId: user.id },
    });

    if (!subscription) {
      throw new NotFoundException('No active subscription found');
    }

    return subscription;
  }

  /**
   * Get all available plans with pricing and features
   */
  async getPlans() {
    return this.planOrder.map((plan) => ({
      plan,
      name: this.getPlanDisplayName(plan),
      monthlyPrice: this.planPricing[plan].monthly,
      yearlyPrice: this.planPricing[plan].yearly,
      limits: this.planLimits[plan],
      features: this.planFeatures[plan],
      trialPeriodDays: this.getTrialPeriod(plan),
      popular: plan === SubscriptionPlan.PROFESSIONAL,
    }));
  }

  /**
   * Get usage statistics
   */
  async getUsage(userId: string) {
    const subscription = await this.findCurrent(userId);
    const user = await this.userRepository.findOne({ where: { id: userId } });

    if (!user || !user.tenantId) {
      throw new BadRequestException('User has no tenant');
    }

    // Get actual tenant-wide usage
    const tenantUsage = await this.getTenantUsage(user.tenantId);

    return {
      current: tenantUsage,
      limits: subscription.limits,
      percentage: this.calculateUsagePercentages(tenantUsage, subscription.limits),
      warnings: this.generateUsageWarnings(tenantUsage, subscription.limits),
    };
  }

  /**
   * Calculate usage percentages
   */
  private calculateUsagePercentages(
    usage: any,
    limits: SubscriptionLimits,
  ): Record<string, number> {
    const calculatePercentage = (used: number, limit: number): number => {
      if (limit === -1) return 0; // unlimited
      if (limit === 0) return 100;
      return Math.round((used / limit) * 100);
    };

    return {
      devices: calculatePercentage(usage.devices, limits.devices),
      users: calculatePercentage(usage.users, limits.users),
      customers: calculatePercentage(usage.customers, limits.customers),
      apiCalls: calculatePercentage(usage.apiCalls, limits.apiCallsPerMonth),
      storage: calculatePercentage(usage.storage, limits.storageGB),
      smsNotifications: calculatePercentage(
        usage.smsNotifications,
        limits.smsNotificationsPerMonth,
      ),
    };
  }

  /**
   * Generate usage warnings
   */
  private generateUsageWarnings(
    usage: any,
    limits: SubscriptionLimits,
  ): string[] {
    const warnings: string[] = [];
    const threshold = 80; // Warn at 80%

    const checkLimit = (
      resource: string,
      used: number,
      limit: number,
      displayName: string,
    ) => {
      if (limit === -1) return; // unlimited
      const percentage = (used / limit) * 100;
      if (percentage >= 100) {
        warnings.push(`${displayName} limit reached (${used}/${limit})`);
      } else if (percentage >= threshold) {
        warnings.push(
          `${displayName} usage is at ${Math.round(percentage)}% (${used}/${limit})`,
        );
      }
    };

    checkLimit('devices', usage.devices, limits.devices, 'Device');
    checkLimit('users', usage.users, limits.users, 'User');
    checkLimit('customers', usage.customers, limits.customers, 'Customer');
    checkLimit(
      'apiCalls',
      usage.apiCalls,
      limits.apiCallsPerMonth,
      'API Calls',
    );
    checkLimit('storage', usage.storage, limits.storageGB, 'Storage');
    checkLimit(
      'smsNotifications',
      usage.smsNotifications,
      limits.smsNotificationsPerMonth,
      'SMS Notifications',
    );

    return warnings;
  }

  /**
   * Validate if upgrade is allowed
   */
  validateUpgrade(
    currentPlan: SubscriptionPlan,
    targetPlan: SubscriptionPlan,
  ): void {
    const currentPlanIndex = this.planOrder.indexOf(currentPlan);
    const targetPlanIndex = this.planOrder.indexOf(targetPlan);

    if (targetPlanIndex <= currentPlanIndex) {
      throw new BadRequestException(
        `Cannot downgrade from ${currentPlan} to ${targetPlan}. Use schedule downgrade instead.`,
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
    const currentPlanIndex = this.planOrder.indexOf(currentPlan);
    const targetPlanIndex = this.planOrder.indexOf(targetPlan);
    return targetPlanIndex > currentPlanIndex;
  }

  /**
   * Upgrade subscription - called after payment
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

    const subscription = await repository.findOne({
      where: { userId },
      lock: useTransaction ? { mode: 'pessimistic_write' } : undefined,
    });

    if (!subscription) {
      throw new NotFoundException('No subscription found');
    }

    this.validateUpgrade(subscription.plan, plan);

    const expectedAmount = this.planPricing[plan][billingPeriod];
    if (Math.abs(paymentAmount - expectedAmount) > 0.01) {
      throw new BadRequestException(
        `Payment amount ${paymentAmount} does not match plan price ${expectedAmount}`,
      );
    }

    subscription.plan = plan;
    subscription.billingPeriod = billingPeriod;
    subscription.price = expectedAmount;
    subscription.limits = this.planLimits[plan];
    subscription.features = this.planFeatures[plan];
    subscription.status = SubscriptionStatus.ACTIVE;
    subscription.nextBillingDate = this.calculateNextBillingDate(billingPeriod);
    subscription.trialEndsAt = undefined;
    subscription.cancelledAt = undefined;
    subscription.updatedBy = userId;

    if (subscription.metadata?.scheduledDowngrade) {
      subscription.metadata = {
        ...subscription.metadata,
        scheduledDowngrade: undefined,
      };
    }

    const updated = await repository.save(subscription);

    this.logger.log(
      `✅ Subscription upgraded: ${subscription.plan} → ${plan} (User: ${userId})`,
    );

    return updated;
  }

  /**
   * Renew subscription after payment
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
      throw new NotFoundException('No subscription found');
    }

    const expectedAmount = this.planPricing[subscription.plan][billingPeriod];
    if (Math.abs(paymentAmount - expectedAmount) > 0.01) {
      throw new BadRequestException(
        `Payment amount ${paymentAmount} does not match plan price ${expectedAmount}`,
      );
    }

    const currentNextBilling = subscription.nextBillingDate || new Date();
    const today = new Date();
    const baseDate = currentNextBilling > today ? currentNextBilling : today;

    subscription.nextBillingDate =
      billingPeriod === BillingPeriod.MONTHLY
        ? new Date(baseDate.setMonth(baseDate.getMonth() + 1))
        : new Date(baseDate.setFullYear(baseDate.getFullYear() + 1));
    subscription.billingPeriod = billingPeriod;
    subscription.status = SubscriptionStatus.ACTIVE;
    subscription.cancelledAt = undefined;
    subscription.trialEndsAt = undefined;
    subscription.updatedBy = userId;

    await repository.save(subscription);

    this.logger.log(
      `✅ Subscription renewed (User: ${userId}, Next billing: ${subscription.nextBillingDate})`,
    );

    return subscription;
  }

  /**
   * Process subscription change after payment
   */
  async processSubscriptionAfterPayment(
    userId: string,
    targetPlan: SubscriptionPlan,
    billingPeriod: BillingPeriod,
    paymentAmount: number,
    queryRunner?: QueryRunner,
  ): Promise<Subscription> {
    const subscription = await this.findCurrent(userId);

    if (this.isUpgrade(subscription.plan, targetPlan)) {
      return await this.upgradeAfterPayment(
        userId,
        targetPlan,
        billingPeriod,
        paymentAmount,
        queryRunner,
      );
    } else if (subscription.plan === targetPlan) {
      return await this.renewAfterPayment(
        userId,
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

    const amount = this.planPricing[plan][billingPeriod];

    return {
      requiresPayment: true,
      message: 'Please complete payment to upgrade your subscription',
      plan,
      billingPeriod,
      amount,
    };
  }

  /**
   * Schedule downgrade
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
        'Target plan must be lower than current plan',
      );
    }

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
      `Downgrade scheduled: ${subscription.plan} → ${targetPlan} on ${subscription.nextBillingDate}`,
    );

    return subscription;
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
        this.planPricing[targetPlan][subscription.billingPeriod];
      subscription.limits = this.planLimits[targetPlan];
      subscription.features = this.planFeatures[targetPlan];

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
   * Cancel subscription
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
   * Increment usage
   */
  async incrementUsage(
    userId: string,
    resource: 'devices' | 'users' | 'customers' | 'apiCalls' | 'storage' | 'smsNotifications',
    amount: number = 1,
  ): Promise<void> {
    const subscription = await this.findCurrent(userId);
    subscription.usage[resource] = (subscription.usage[resource] || 0) + amount;
    await this.subscriptionRepository.save(subscription);
  }

  /**
   * Decrement usage
   */
  async decrementUsage(
    userId: string,
    resource: 'devices' | 'users' | 'customers' | 'apiCalls' | 'storage' | 'smsNotifications',
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
   * Check if user can perform action
   */
  async canPerformAction(
    userId: string,
    resource: 'devices' | 'users' | 'customers' | 'apiCalls' | 'storage' | 'smsNotifications',
  ): Promise<boolean> {
    const subscription = await this.findCurrent(userId);
    const user = await this.userRepository.findOne({ where: { id: userId } });

    if (!user || !user.tenantId) {
      return false;
    }

    // Get limit based on resource
    let limit: number;
    switch (resource) {
      case 'devices':
        limit = subscription.limits.devices;
        break;
      case 'users':
        limit = subscription.limits.users;
        break;
      case 'customers':
        limit = subscription.limits.customers;
        break;
      case 'apiCalls':
        limit = subscription.limits.apiCallsPerMonth;
        break;
      case 'storage':
        limit = subscription.limits.storageGB;
        break;
      case 'smsNotifications':
        limit = subscription.limits.smsNotificationsPerMonth;
        break;
      default:
        return false;
    }

    if (limit === -1) return true; // unlimited

    const tenantUsage = await this.getTenantUsage(user.tenantId);
    const currentUsage = tenantUsage[resource] || 0;

    this.logger.debug(
      `Checking ${resource} for tenant ${user.tenantId}: ${currentUsage}/${limit}`,
    );

    return currentUsage < limit;
  }

  /**
   * Increment tenant usage
   */
  async incrementTenantUsage(
    tenantId: string,
    resource: 'devices' | 'users' | 'customers' | 'apiCalls' | 'storage' | 'smsNotifications',
    amount: number = 1,
  ): Promise<void> {
    const tenant = await this.tenantRepository.findOne({
      where: { id: tenantId },
    });

        if (!tenant || !tenant.id) {
      throw new NotFoundException('Tenant admin not found');
    }

    await this.incrementUsage(tenant.id, resource, amount);
  }

  /**
   * Decrement tenant usage
   */
  async decrementTenantUsage(
    tenantId: string,
    resource: 'devices' | 'users' | 'customers' | 'apiCalls' | 'storage' | 'smsNotifications',
    amount: number = 1,
  ): Promise<void> {
    const tenant = await this.tenantRepository.findOne({
      where: { id: tenantId },
    });

    if (!tenant || !tenant.tenantAdminId) {
      throw new NotFoundException('Tenant admin not found');
    }

    await this.decrementUsage(tenant.tenantAdminId, resource, amount);
  }

  /**
   * Check if feature is available
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

  /**
   * Cron: Reset monthly usage counters
   */
  @Cron(CronExpression.EVERY_1ST_DAY_OF_MONTH_AT_MIDNIGHT)
  async resetMonthlyUsage(): Promise<void> {
    this.logger.log('🔄 Starting monthly usage reset...');

    const subscriptions = await this.subscriptionRepository.find({
      where: { status: SubscriptionStatus.ACTIVE },
    });

    for (const subscription of subscriptions) {
      subscription.usage.apiCalls = 0;
      subscription.usage.smsNotifications = 0;
      subscription.metadata = {
        ...subscription.metadata,
        lastUsageReset: new Date(),
      };
      await this.subscriptionRepository.save(subscription);
    }

    this.logger.log(
      `✅ Monthly usage reset complete for ${subscriptions.length} subscriptions`,
    );
  }

  /**
   * Cron: Process scheduled downgrades
   */
  @Cron(CronExpression.EVERY_DAY_AT_MIDNIGHT)
  async processScheduledDowngrades(): Promise<void> {
    this.logger.log('🔄 Processing scheduled downgrades...');

    const subscriptions = await this.subscriptionRepository
      .createQueryBuilder('subscription')
      .where("subscription.metadata->>'scheduledDowngrade' IS NOT NULL")
      .getMany();

    let processed = 0;
    for (const subscription of subscriptions) {
      const result = await this.executeScheduledDowngrade(subscription.userId);
      if (result) processed++;
    }

    this.logger.log(`✅ Processed ${processed} scheduled downgrades`);
  }

  async getInvoices(userId: string) {
    // TODO: Implement invoice retrieval
    return { invoices: [], total: 0 };
  }

  /**
   * Check if plan change is a renewal (same plan)
   */
  isRenewal(currentPlan: SubscriptionPlan, targetPlan: SubscriptionPlan): boolean {
    return currentPlan === targetPlan;
  }
}