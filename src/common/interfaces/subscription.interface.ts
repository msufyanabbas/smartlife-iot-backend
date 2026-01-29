import { SupportLevel } from "@common/enums/index.enum";

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