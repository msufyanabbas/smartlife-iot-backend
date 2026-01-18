import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import {
  SubscriptionPlan,
  SubscriptionStatus,
  BillingPeriod,
  SubscriptionLimits,
  SubscriptionFeatures,
  SupportLevel,
} from '@modules/subscriptions/entities/subscription.entity';
import { Subscription, User } from '@modules/index.entities';
import { ISeeder } from '../seeder.interface';

@Injectable()
export class SubscriptionSeeder implements ISeeder {
  constructor(
    @InjectRepository(Subscription)
    private readonly subscriptionRepository: Repository<Subscription>,
    @InjectRepository(User)
    private readonly userRepository: Repository<User>,
  ) {}

  /**
   * Helper: Get plan limits based on plan type
   */
  private getPlanLimits(plan: SubscriptionPlan): SubscriptionLimits {
    const limitsMap: Record<SubscriptionPlan, SubscriptionLimits> = {
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
        dashboardTemplates: -1,
        customDashboards: 20,
        customIntegrations: -1,
        webhooks: -1,
        apiRateLimitPerMin: 1000,
        concurrentConnections: 200,
        smsNotificationsPerMonth: 500,
        historicalDataQueryDays: 90,
        trainingSessions: 1,
      },
      [SubscriptionPlan.ENTERPRISE]: {
        devices: -1,
        users: -1,
        customers: -1,
        apiCallsPerMonth: -1,
        dataRetentionDays: 365,
        storageGB: 500,
        dashboardTemplates: -1,
        customDashboards: -1,
        customIntegrations: -1,
        webhooks: -1,
        apiRateLimitPerMin: -1,
        concurrentConnections: -1,
        smsNotificationsPerMonth: -1,
        historicalDataQueryDays: 365,
        trainingSessions: -1,
      },
    };

    return limitsMap[plan];
  }

  /**
   * Helper: Get plan features based on plan type
   */
  private getPlanFeatures(plan: SubscriptionPlan): SubscriptionFeatures {
    const featuresMap: Record<SubscriptionPlan, SubscriptionFeatures> = {
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
        floorMapping: -1,
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

    return featuresMap[plan];
  }

  /**
   * Helper: Get plan pricing
   */
  private getPlanPrice(
    plan: SubscriptionPlan,
    billingPeriod: BillingPeriod,
  ): number {
    const pricing = {
      [SubscriptionPlan.FREE]: { monthly: 0, yearly: 0 },
      [SubscriptionPlan.STARTER]: { monthly: 199, yearly: 1990 },
      [SubscriptionPlan.PROFESSIONAL]: { monthly: 499, yearly: 4990 },
      [SubscriptionPlan.ENTERPRISE]: { monthly: 0, yearly: 0 }, // Custom
    };

    return pricing[plan][billingPeriod];
  }

  /**
   * Helper: Generate next billing date
   */
  private generateNextBilling(period: BillingPeriod): Date {
    const date = new Date();
    if (period === BillingPeriod.MONTHLY) {
      date.setMonth(date.getMonth() + 1);
    } else {
      date.setFullYear(date.getFullYear() + 1);
    }
    return date;
  }

  /**
   * Helper: Generate trial end date
   */
  private generateTrialEnd(daysFromNow: number): Date {
    const date = new Date();
    date.setDate(date.getDate() + daysFromNow);
    return date;
  }

  /**
   * Helper: Get random item from array
   */
  private getRandomItem<T>(array: T[]): T {
    return array[Math.floor(Math.random() * array.length)];
  }

  /**
   * Main seeding method
   */
  async seed(): Promise<void> {
    console.log('🌱 Starting subscription seeding...');

    // Fetch all users first
    const users = await this.userRepository.find({ take: 10 });

    if (users.length === 0) {
      console.log('⚠️  No users found. Please seed users first.');
      return;
    }

    const subscriptionConfigs = [
      // 1. Free Plan - Active
      {
        plan: SubscriptionPlan.FREE,
        status: SubscriptionStatus.ACTIVE,
        billingPeriod: BillingPeriod.MONTHLY,
        usage: {
          devices: 3,
          users: 1,
          customers: 0,
          apiCalls: 2345,
          storage: 0.2,
          smsNotifications: 0,
        },
        trialEndsAt: undefined,
        nextBillingDate: undefined,
        cancelledAt: undefined,
        userId: users[0].id,
        tenantId: users[0].tenantId,
      },
      // 2. Starter Plan - Active (Monthly)
      {
        plan: SubscriptionPlan.STARTER,
        status: SubscriptionStatus.ACTIVE,
        billingPeriod: BillingPeriod.MONTHLY,
        usage: {
          devices: 24,
          users: 3,
          customers: 2,
          apiCalls: 45678,
          storage: 4.2,
          smsNotifications: 45,
        },
        trialEndsAt: undefined,
        nextBillingDate: this.generateNextBilling(BillingPeriod.MONTHLY),
        cancelledAt: undefined,
        userId: users[1]?.id || users[0].id,
        tenantId: users[1]?.tenantId || users[0].tenantId,
      },
      // 3. Professional Plan - Active (Yearly)
      {
        plan: SubscriptionPlan.PROFESSIONAL,
        status: SubscriptionStatus.ACTIVE,
        billingPeriod: BillingPeriod.YEARLY,
        usage: {
          devices: 89,
          users: 12,
          customers: 8,
          apiCalls: 245678,
          storage: 28.5,
          smsNotifications: 234,
        },
        trialEndsAt: undefined,
        nextBillingDate: this.generateNextBilling(BillingPeriod.YEARLY),
        cancelledAt: undefined,
        userId: users[2]?.id || users[0].id,
        tenantId: users[2]?.tenantId || users[0].tenantId,
      },
      // 4. Enterprise Plan - Active
      {
        plan: SubscriptionPlan.ENTERPRISE,
        status: SubscriptionStatus.ACTIVE,
        billingPeriod: BillingPeriod.YEARLY,
        usage: {
          devices: 567,
          users: 45,
          customers: 30,
          apiCalls: 5678901,
          storage: 234.8,
          smsNotifications: 1250,
        },
        trialEndsAt: undefined,
        nextBillingDate: this.generateNextBilling(BillingPeriod.YEARLY),
        cancelledAt: undefined,
        userId: users[3]?.id || this.getRandomItem(users).id,
        tenantId: users[3]?.tenantId || this.getRandomItem(users).tenantId,
      },
      // 5. Starter Plan - Trial (7 days left)
      {
        plan: SubscriptionPlan.STARTER,
        status: SubscriptionStatus.TRIAL,
        billingPeriod: BillingPeriod.MONTHLY,
        usage: {
          devices: 8,
          users: 2,
          customers: 1,
          apiCalls: 12345,
          storage: 1.5,
          smsNotifications: 15,
        },
        trialEndsAt: this.generateTrialEnd(7),
        nextBillingDate: undefined,
        cancelledAt: undefined,
        userId: users[4]?.id || this.getRandomItem(users).id,
        tenantId: users[4]?.tenantId || this.getRandomItem(users).tenantId,
      },
      // 6. Professional Plan - Trial (14 days left)
      {
        plan: SubscriptionPlan.PROFESSIONAL,
        status: SubscriptionStatus.TRIAL,
        billingPeriod: BillingPeriod.MONTHLY,
        usage: {
          devices: 15,
          users: 4,
          customers: 2,
          apiCalls: 34567,
          storage: 3.2,
          smsNotifications: 45,
        },
        trialEndsAt: this.generateTrialEnd(14),
        nextBillingDate: undefined,
        cancelledAt: undefined,
        userId: users[5]?.id || this.getRandomItem(users).id,
        tenantId: users[5]?.tenantId || this.getRandomItem(users).tenantId,
      },
      // 7. Starter Plan - Cancelled
      {
        plan: SubscriptionPlan.STARTER,
        status: SubscriptionStatus.CANCELLED,
        billingPeriod: BillingPeriod.MONTHLY,
        usage: {
          devices: 18,
          users: 3,
          customers: 1,
          apiCalls: 23456,
          storage: 2.8,
          smsNotifications: 25,
        },
        trialEndsAt: undefined,
        nextBillingDate: new Date(Date.now() + 15 * 24 * 60 * 60 * 1000), // Access until +15 days
        cancelledAt: new Date(Date.now() - 15 * 24 * 60 * 60 * 1000), // Cancelled 15 days ago
        userId: users[6]?.id || this.getRandomItem(users).id,
        tenantId: users[6]?.tenantId || this.getRandomItem(users).tenantId,
      },
      // 8. Professional Plan - Expired
      {
        plan: SubscriptionPlan.PROFESSIONAL,
        status: SubscriptionStatus.EXPIRED,
        billingPeriod: BillingPeriod.MONTHLY,
        usage: {
          devices: 45,
          users: 8,
          customers: 5,
          apiCalls: 123456,
          storage: 12.5,
          smsNotifications: 150,
        },
        trialEndsAt: undefined,
        nextBillingDate: undefined,
        cancelledAt: undefined,
        userId: users[7]?.id || this.getRandomItem(users).id,
        tenantId: users[7]?.tenantId || this.getRandomItem(users).tenantId,
      },
      // 9. Free Plan - Active (High usage)
      {
        plan: SubscriptionPlan.FREE,
        status: SubscriptionStatus.ACTIVE,
        billingPeriod: BillingPeriod.MONTHLY,
        usage: {
          devices: 4,
          users: 2,
          customers: 1,
          apiCalls: 8900,
          storage: 0.8,
          smsNotifications: 0,
        },
        trialEndsAt: undefined,
        nextBillingDate: undefined,
        cancelledAt: undefined,
        userId: users[8]?.id || this.getRandomItem(users).id,
        tenantId: users[8]?.tenantId || this.getRandomItem(users).tenantId,
      },
      // 10. Starter Plan - Active (Yearly)
      {
        plan: SubscriptionPlan.STARTER,
        status: SubscriptionStatus.ACTIVE,
        billingPeriod: BillingPeriod.YEARLY,
        usage: {
          devices: 32,
          users: 4,
          customers: 3,
          apiCalls: 67890,
          storage: 6.3,
          smsNotifications: 78,
        },
        trialEndsAt: undefined,
        nextBillingDate: this.generateNextBilling(BillingPeriod.YEARLY),
        cancelledAt: undefined,
        userId: users[9]?.id || this.getRandomItem(users).id,
        tenantId: users[9]?.tenantId || this.getRandomItem(users).tenantId,
      },
    ];

    let created = 0;
    let skipped = 0;

    for (const config of subscriptionConfigs) {
      const existing = await this.subscriptionRepository.findOne({
        where: { userId: config.userId },
      });

      if (!existing) {
        const subscription = this.subscriptionRepository.create({
          plan: config.plan,
          status: config.status,
          billingPeriod: config.billingPeriod,
          price: this.getPlanPrice(config.plan, config.billingPeriod),
          limits: this.getPlanLimits(config.plan),
          usage: config.usage,
          features: this.getPlanFeatures(config.plan),
          userId: config.userId,
          tenantId: config.tenantId,
          trialEndsAt: config.trialEndsAt,
          nextBillingDate: config.nextBillingDate,
          cancelledAt: config.cancelledAt,
          metadata: {
            lastUsageReset: new Date(),
          },
        });

        await this.subscriptionRepository.save(subscription);
        console.log(
          `✅ Created: ${config.plan} (${config.status}) - ${config.billingPeriod}`,
        );
        created++;
      } else {
        console.log(
          `⏭️  Skipped: Subscription exists for user ${config.userId.substring(0, 8)}...`,
        );
        skipped++;
      }
    }

    console.log(`\n🎉 Subscription seeding completed!`);
    console.log(`   ✅ Created: ${created}`);
    console.log(`   ⏭️  Skipped: ${skipped}`);
    console.log(`   📊 Total: ${subscriptionConfigs.length}\n`);
  }
}