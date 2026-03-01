// src/database/seeds/subscription/subscription.seeder.ts
import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import {
  Subscription,
  Tenant
} from '@modules/index.entities';
import {
  SubscriptionPlan,
  SubscriptionStatus,
  BillingPeriod,
  SupportLevel
} from '@common/enums/index.enum';
import {
  EMPTY_USAGE,
  type SubscriptionLimits,
  type SubscriptionFeatures
} from '@/common/interfaces/index.interface';
import { ISeeder } from '../seeder.interface';

@Injectable()
export class SubscriptionSeeder implements ISeeder {
  private readonly logger = new Logger(SubscriptionSeeder.name);

  constructor(
    @InjectRepository(Subscription)
    private readonly subscriptionRepository: Repository<Subscription>,
    @InjectRepository(Tenant)
    private readonly tenantRepository: Repository<Tenant>,
  ) { }

  /**
   * Helper: Get plan limits based on plan type
   */
  private getPlanLimits(plan: SubscriptionPlan): SubscriptionLimits {
    const defaultLimits: SubscriptionLimits = {
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
    };

    const limitsMap: Record<SubscriptionPlan, SubscriptionLimits> = {
      [SubscriptionPlan.FREE]: { ...defaultLimits },
      [SubscriptionPlan.STARTER]: {
        ...defaultLimits,
        devices: 50,
        users: 5,
        customers: 5,
        apiCallsPerMonth: 100000,
        dataRetentionDays: 30,
        storageGB: 10,
      },
      [SubscriptionPlan.PROFESSIONAL]: {
        ...defaultLimits,
        devices: 200,
        users: 20,
        customers: 20,
        apiCallsPerMonth: 500000,
        dataRetentionDays: 90,
        storageGB: 50,
        dashboardTemplates: -1,
        customIntegrations: -1,
        webhooks: -1,
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
    const defaultFeatures: SubscriptionFeatures = {
      realtimeAnalytics: false,
      advancedAutomation: false,
      ruleEngine: 'basic',
      restApiAccess: true,
      mqttAccess: true,
      emailNotifications: true,
      smsNotifications: false,
      mobileAppAccess: true,
      widgetLibrary: 'basic',
      alarmManagement: 'basic',
      supportLevel: SupportLevel.COMMUNITY,
    };

    const featuresMap: Record<SubscriptionPlan, SubscriptionFeatures> = {
      [SubscriptionPlan.FREE]: { ...defaultFeatures },
      [SubscriptionPlan.STARTER]: {
        ...defaultFeatures,
        realtimeAnalytics: true,
        advancedAutomation: true,
        ruleEngine: 'advanced',
        smsNotifications: true,
        widgetLibrary: 'standard',
        supportLevel: SupportLevel.EMAIL,
      },
      [SubscriptionPlan.PROFESSIONAL]: {
        ...defaultFeatures,
        realtimeAnalytics: true,
        advancedAutomation: true,
        ruleEngine: 'advanced',
        smsNotifications: true,
        whiteLabelBranding: true,
        widgetLibrary: 'advanced',
        supportLevel: SupportLevel.PRIORITY,
        multiTenancy: true,
        customerManagement: true,
      },
      [SubscriptionPlan.ENTERPRISE]: {
        realtimeAnalytics: true,
        advancedAutomation: true,
        ruleEngine: 'premium',
        restApiAccess: true,
        mqttAccess: true,
        whiteLabelBranding: true,
        brandingLevel: 'full',
        emailNotifications: true,
        smsNotifications: true,
        mobileAppAccess: true,
        widgetLibrary: 'advanced',
        alarmManagement: 'advanced',
        supportLevel: SupportLevel.DEDICATED,
        slaGuarantee: true,
        multiTenancy: true,
        customerManagement: true,
        customDevelopment: true,
      },
    };

    return featuresMap[plan];
  }

  // FIX: Use BillingPeriod enum values as keys instead of raw string literals
  // to guarantee the lookup always matches regardless of enum value.
  private getPlanPrice(plan: SubscriptionPlan, period: BillingPeriod): number {
    const prices: Record<SubscriptionPlan, Record<BillingPeriod, number>> = {
      [SubscriptionPlan.FREE]: {
        [BillingPeriod.MONTHLY]: 0,
        [BillingPeriod.YEARLY]: 0,
      },
      [SubscriptionPlan.STARTER]: {
        [BillingPeriod.MONTHLY]: 19,
        [BillingPeriod.YEARLY]: 190,
      },
      [SubscriptionPlan.PROFESSIONAL]: {
        [BillingPeriod.MONTHLY]: 99,
        [BillingPeriod.YEARLY]: 990,
      },
      [SubscriptionPlan.ENTERPRISE]: {
        [BillingPeriod.MONTHLY]: 499,
        [BillingPeriod.YEARLY]: 4990,
      },
    };
    return prices[plan][period];
  }

  async seed(): Promise<void> {
    this.logger.log('🌱 Starting subscription seeding...');

    const tenants = await this.tenantRepository.find();
    if (tenants.length === 0) {
      this.logger.warn('⚠️ No tenants found. Please seed tenants first.');
      return;
    }

    const plans = [
      SubscriptionPlan.FREE,
      SubscriptionPlan.STARTER,
      SubscriptionPlan.PROFESSIONAL,
      SubscriptionPlan.ENTERPRISE,
    ];

    let createdCount = 0;
    let skippedCount = 0;

    for (const [index, tenant] of tenants.entries()) {
      const existing = await this.subscriptionRepository.findOne({
        where: { tenantId: tenant.id },
      });

      if (!existing) {
        const plan = plans[index % plans.length];
        const billingPeriod = index % 2 === 0 ? BillingPeriod.MONTHLY : BillingPeriod.YEARLY;

        const subscription = this.subscriptionRepository.create({
          tenantId: tenant.id,
          plan,
          status: SubscriptionStatus.ACTIVE,
          billingPeriod,
          price: this.getPlanPrice(plan, billingPeriod),
          limits: this.getPlanLimits(plan),
          features: this.getPlanFeatures(plan),
          usage: { ...EMPTY_USAGE },
          nextBillingDate: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
          metadata: {
            paymentProvider: 'system_manual',
            lastUsageReset: new Date(),  // FIX: initialise typed Date field
            notes: 'Initial seed subscription',
          },
        });

        await this.subscriptionRepository.save(subscription);
        this.logger.log(`✅ Created ${plan} subscription for tenant: ${tenant.name}`);
        createdCount++;
      } else {
        this.logger.log(`⏭️  Subscription already exists for tenant: ${tenant.name}`);
        skippedCount++;
      }
    }

    this.logger.log(`🎉 Subscription seeding completed! Created: ${createdCount}, Skipped: ${skippedCount}`);
  }
}