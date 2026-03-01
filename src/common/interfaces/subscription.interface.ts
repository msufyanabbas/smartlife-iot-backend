import { SupportLevel } from "@common/enums/index.enum";

/**
 * Subscription Limits Interface
 * Based on Smart Life Excel specifications
 */
export interface SubscriptionLimits {
  // Core Limits
  devices?: number; // -1 = unlimited
  users?: number; // -1 = unlimited
  customers?: number; // -1 = unlimited
  apiCallsPerMonth?: number; // -1 = unlimited
  dataRetentionDays?: number;
  storageGB?: number;

  // Dashboard & Visualization
  dashboardTemplates?: number;
  customDashboards?: number;

  // Integrations & API
  customIntegrations?: number; // -1 = unlimited
  webhooks?: number; // -1 = unlimited
  apiRateLimitPerMin?: number;
  concurrentConnections?: number;

  // Notifications
  smsNotificationsPerMonth?: number; // -1 = unlimited

  // Data & Reporting
  historicalDataQueryDays?: number;

  // Training & Support
  trainingSessions?: number; // -1 = unlimited
  dashboards?: number;
  assets?: number;
  floorPlans?: number;
  automations?: number;
}

/**
 * Subscription Features Interface
 * Based on Smart Life Excel specifications
 */
export interface SubscriptionFeatures {
  // Analytics & Automation
  realtimeAnalytics?: boolean;
  advancedAutomation?: boolean;
  ruleEngine?: 'basic' | 'advanced' | 'premium';

  // Access & Integration
  restApiAccess?: boolean;
  mqttAccess?: boolean;
  customIntegrations?: boolean;

  // Branding & Customization
  whiteLabelBranding?: boolean;
  brandingLevel?: 'none' | 'partial' | 'full';

  // Notifications
  emailNotifications?: boolean;
  smsNotifications?: boolean;
  mobileAppAccess?: boolean;

  // Dashboards & Widgets
  widgetLibrary?: 'basic' | 'standard' | 'advanced';
  alarmManagement?: 'basic' | 'standard' | 'advanced';
  advancedAlarms?: boolean;

  // Data Management
  dataExport?: 'csv' | 'csv-json-excel' | 'all-formats';
  scheduledReports?: 'none' | 'monthly' | 'weekly' | 'realtime';

  // Support & SLA
  supportLevel?: SupportLevel;
  slaGuarantee?: boolean;
  slaPercentage?: number;
  onboardingSupport?: 'none' | 'basic' | 'standard' | 'premium';

  // Development & Advanced
  floorMapping?: number; // 0 = no, >0 = number of floors
  customDevelopment?: boolean;
  multiTenancy?: boolean;
  customerManagement?: boolean;

  // Security & Compliance
  roleBasedAccess?: boolean;
  auditLogs?: boolean;
  backupRecovery?: boolean;

  // Device Management
  otaUpdates?: 'manual' | 'automatic';
  deviceGroups?: boolean;
  assetManagement?: 'none' | 'basic' | 'advanced';
  geofencing?: boolean;
  customAttributes?: boolean;
  rpcCommands?: boolean;
  dataAggregation?: boolean;

  // new ones
  devices?: boolean;
  dashboards?: boolean;
  assets?: boolean;
  floorPlans?: boolean;
  automations?: boolean;
  // platform features
  apiAccess?: boolean;
  whiteLabel?: boolean;
}

// ─────────────────────────────────────────────────────────────────────────────
// SubscriptionUsage
//
// Cached counters — NEVER query COUNT(*) in guards. These are incremented
// and decremented by the assignment service inside transactions.
//
// SYNC RULE: keys here must match the keys in Customer.usageCounters and
// the ResourceType type in assignment.service.ts.
// ─────────────────────────────────────────────────────────────────────────────
export interface SubscriptionUsage {
  // Resource assignments (incremented when assigned to customer)
  devices: number;
  dashboards: number;
  assets: number;
  floorPlans: number;
  automations: number;

  // Org counts (incremented when created)
  users: number;
  customers: number;

  // Usage-based (incremented on API call / SMS send, reset monthly)
  apiCalls: number;
  storageGB: number;
  smsNotifications: number;
}

// Default usage object for new subscriptions
export const EMPTY_USAGE: SubscriptionUsage = {
  devices: 0,
  dashboards: 0,
  assets: 0,
  floorPlans: 0,
  automations: 0,
  users: 0,
  customers: 0,
  apiCalls: 0,
  storageGB: 0,
  smsNotifications: 0,
};

// Maps usage keys to their corresponding limits key
// Used internally to look up the right limit for any given usage counter
export const USAGE_TO_LIMIT_KEY: Record<keyof SubscriptionUsage, keyof SubscriptionLimits> = {
  devices: 'devices',
  dashboards: 'dashboards',
  assets: 'assets',
  floorPlans: 'floorPlans',
  automations: 'automations',
  users: 'users',
  customers: 'customers',
  apiCalls: 'apiCallsPerMonth',
  storageGB: 'storageGB',
  smsNotifications: 'smsNotificationsPerMonth',
};