import { Entity, Column, Index } from 'typeorm';
import { BaseEntity } from '../../../common/entities/base.entity';

export enum SubscriptionPlan {
  FREE = 'free',
  STARTER = 'starter',
  PROFESSIONAL = 'professional',
  ENTERPRISE = 'enterprise',
}

export enum SubscriptionStatus {
  ACTIVE = 'active',
  CANCELLED = 'cancelled',
  EXPIRED = 'expired',
  TRIAL = 'trial',
  SUSPENDED = 'suspended',
}

export enum BillingPeriod {
  MONTHLY = 'monthly',
  YEARLY = 'yearly',
}

export enum SupportLevel {
  COMMUNITY = 'community',
  EMAIL = 'email',
  PRIORITY = 'priority',
  DEDICATED = 'dedicated',
}

/**
 * Subscription Limits Interface
 * Based on Smart Life Excel specifications
 */
export interface SubscriptionLimits {
  // Core Limits
  devices: number; // -1 = unlimited
  users: number; // -1 = unlimited
  customers: number; // -1 = unlimited
  apiCallsPerMonth: number; // -1 = unlimited
  dataRetentionDays: number;
  storageGB: number;

  // Dashboard & Visualization
  dashboardTemplates: number;
  customDashboards: number;

  // Integrations & API
  customIntegrations: number; // -1 = unlimited
  webhooks: number; // -1 = unlimited
  apiRateLimitPerMin: number;
  concurrentConnections: number;

  // Notifications
  smsNotificationsPerMonth: number; // -1 = unlimited

  // Data & Reporting
  historicalDataQueryDays: number;

  // Training & Support
  trainingSessions: number; // -1 = unlimited
}

/**
 * Subscription Features Interface
 * Based on Smart Life Excel specifications
 */
export interface SubscriptionFeatures {
  // Analytics & Automation
  realtimeAnalytics: boolean;
  advancedAutomation: boolean;
  ruleEngine: 'basic' | 'advanced' | 'premium';

  // Access & Integration
  restApiAccess: boolean;
  mqttAccess: boolean;
  customIntegrations: boolean;

  // Branding & Customization
  whiteLabelBranding: boolean;
  brandingLevel: 'none' | 'partial' | 'full';

  // Notifications
  emailNotifications: boolean;
  smsNotifications: boolean;
  mobileAppAccess: boolean;

  // Dashboards & Widgets
  widgetLibrary: 'basic' | 'standard' | 'advanced';
  alarmManagement: 'basic' | 'standard' | 'advanced';
  advancedAlarms: boolean;

  // Data Management
  dataExport: 'csv' | 'csv-json-excel' | 'all-formats';
  scheduledReports: 'none' | 'monthly' | 'weekly' | 'realtime';

  // Support & SLA
  supportLevel: SupportLevel;
  slaGuarantee: boolean;
  slaPercentage: number;
  onboardingSupport: 'none' | 'basic' | 'standard' | 'premium';

  // Development & Advanced
  floorMapping: number; // 0 = no, >0 = number of floors
  customDevelopment: boolean;
  multiTenancy: boolean;
  customerManagement: boolean;

  // Security & Compliance
  roleBasedAccess: boolean;
  auditLogs: boolean;
  backupRecovery: boolean;

  // Device Management
  otaUpdates: 'manual' | 'automatic';
  deviceGroups: boolean;
  assetManagement: 'none' | 'basic' | 'advanced';
  geofencing: boolean;
  customAttributes: boolean;
  rpcCommands: boolean;
  dataAggregation: boolean;
}

@Entity('subscriptions')
@Index(['userId', 'status'])
@Index(['tenantId'])
export class Subscription extends BaseEntity {
  @Column({
    type: 'enum',
    enum: SubscriptionPlan,
    default: SubscriptionPlan.FREE,
  })
  plan: SubscriptionPlan;

  @Column({
    type: 'enum',
    enum: SubscriptionStatus,
    default: SubscriptionStatus.ACTIVE,
  })
  status: SubscriptionStatus;

  @Column({
    type: 'enum',
    enum: BillingPeriod,
    default: BillingPeriod.MONTHLY,
  })
  billingPeriod: BillingPeriod;

  @Column({ type: 'decimal', precision: 10, scale: 2, default: 0 })
  price: number;

  @Column({ type: 'jsonb' })
  limits: SubscriptionLimits;

  @Column({ type: 'jsonb' })
  usage: {
    devices: number;
    users: number;
    customers: number;
    apiCalls: number;
    storage: number;
    smsNotifications: number;
  };

  @Column({ type: 'jsonb' })
  features: SubscriptionFeatures;

  @Column({ type: 'jsonb', nullable: true })
  metadata?: {
    scheduledDowngrade?: {
      plan: SubscriptionPlan;
      effectiveDate: Date | undefined;
    };
    lastUsageReset?: Date;
    [key: string]: any;
  };

  @Column({ name: 'next_billing_date', type: 'timestamp', nullable: true })
  nextBillingDate?: Date;

  @Column({ name: 'trial_ends_at', type: 'timestamp', nullable: true })
  trialEndsAt?: Date;

  @Column({ name: 'cancelled_at', type: 'timestamp', nullable: true })
  cancelledAt?: Date;

  @Column({ name: 'user_id' })
  userId: string;

  @Column({ name: 'tenant_id', nullable: true })
  tenantId?: string;

  // Helper method to check if unlimited
  isUnlimited(resource: keyof SubscriptionLimits): boolean {
    return (this.limits[resource] as number) === -1;
  }

  // Helper method to check if limit reached
  isLimitReached(
    resource: 'devices' | 'users' | 'customers' | 'apiCalls' | 'storage' | 'smsNotifications',
  ): boolean {
    const limit = this.getLimitValue(resource);
    if (limit === -1) return false; // unlimited
    return this.usage[resource] >= limit;
  }

  private getLimitValue(
    resource: 'devices' | 'users' | 'customers' | 'apiCalls' | 'storage' | 'smsNotifications',
  ): number {
    switch (resource) {
      case 'devices':
        return this.limits.devices;
      case 'users':
        return this.limits.users;
      case 'customers':
        return this.limits.customers;
      case 'apiCalls':
        return this.limits.apiCallsPerMonth;
      case 'storage':
        return this.limits.storageGB;
      case 'smsNotifications':
        return this.limits.smsNotificationsPerMonth;
      default:
        return 0;
    }
  }
}