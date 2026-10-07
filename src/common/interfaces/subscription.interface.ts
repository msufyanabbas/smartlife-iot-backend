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
  /** Rule chains a tenant may own. -1 = unlimited. Counter key: usage.ruleChains */
  ruleChains?: number;

  // Floor plans
  /**
   * Floor plans a tenant may own in total. -1 = unlimited.
   * Enforced by FloorPlansService.create().
   */
  maxFloorPlans?: number;
  /**
   * Devices that may be placed on a single floor plan. -1 = unlimited.
   * Enforced by FloorPlansService.placeDevice() on new placements only.
   */
  maxDevicesPerFloorPlan?: number;

  // Solution Templates
  /** Concurrent SUCCESS installations allowed. -1 = unlimited. */
  maxTemplateInstalls?: number;
  /** Custom (non-system) templates the tenant may own. -1 = unlimited. */
  maxCustomTemplates?: number;
  /**
   * Total intentional installs ever allowed, counting SUCCESS and ROLLED_BACK
   * (i.e. installed-then-uninstalled) rows. FAILED and INSTALLING attempts are
   * NOT counted — a rolled-back failure provisions nothing, so it must not burn
   * budget. Uninstalling does NOT free lifetime budget — on FREE (1) a tenant
   * that installs then uninstalls can never install again. -1 = unlimited.
   */
  templateInstallsLifetime?: number;
}

/**
 * Subscription Features Interface
 * Based on Smart Life Excel specifications
 */
export interface SubscriptionFeatures {
  overview?: boolean;
  solutionTemplates?: boolean;
  solutionDashboards?: boolean;
  assetProfiles?: boolean;
  settings?: boolean;
  deviceProfiles?: boolean;
  alerts?: boolean;
  analytics?: boolean;
  userRoles?: boolean;
  integration?: boolean;
  edge?: boolean;
  scheduleManagement?: boolean;
  subscription?: boolean;
  resources?: boolean;
  notifications?: boolean;
  sharingCenter?: boolean;
  apiMonitoring?: boolean;
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
  bulkOperations?: boolean;

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

  // ── Firmware / OTA ────────────────────────────────────────────────────────
  // `otaUpdates` above is a CAPABILITY descriptor ('manual' | 'automatic'), not
  // a gate. Subscription.hasFeature() compares with `=== true`, so a plan that
  // actually sets otaUpdates:'automatic' would be DENIED while a plan that
  // omits it is allowed — the string can never satisfy the check. `firmware` is
  // the boolean gate; otaUpdates says which mode the plan is entitled to.
  firmware?: boolean;

  // Resources sub-sections. The frontend sidebar and the resource pages gate on
  // these individually; before this they existed only in the frontend's copy of
  // this interface, so they were always undefined and the pages 403'd for
  // everyone.
  widgets?: boolean;
  imageLibrary?: boolean;
  scriptLibrary?: boolean;

  // Aliases the frontend sidebar reads. Kept as separate keys rather than
  // renamed because existing subscription rows store the old spelling in their
  // `features` jsonb and a rename would silently hide those menus.
  //   integrations    ← alias of `integration`
  //   edgeManagement  ← alias of `edge`
  integrations?: boolean;
  edgeManagement?: boolean;
}

/**
 * Every feature key the frontend sidebar gates a menu entry on.
 *
 * The frontend hides an item when `features[key] !== true` — a MISSING key
 * hides the menu. The backend's guards do the opposite (`hasFeature` treats a
 * missing key as allowed). That asymmetry is why menus disappeared: any key the
 * plan table forgot became an invisible menu rather than a visible one.
 *
 * `PLAN_FEATURES` in src/modules/subscriptions/plan-features.ts is typed
 * against this list, so a key added to the sidebar that nobody set on a plan is
 * a compile error instead of a missing menu in production.
 */
export const NAVIGATION_FEATURE_KEYS = [
  'overview',
  'solutionTemplates',
  'solutionDashboards',
  'deviceProfiles',
  'assetProfiles',
  'devices',
  'assets',
  'dashboards',
  'floorPlans',
  'alerts',
  'analytics',
  'userRoles',
  'automations',
  'integration',
  'integrations',
  'edge',
  'edgeManagement',
  'firmware',
  'scheduleManagement',
  'resources',
  'widgets',
  'imageLibrary',
  'scriptLibrary',
  'notifications',
  'sharingCenter',
  'apiAccess',
  'apiMonitoring',
  'auditLogs',
  'subscription',
  'settings',
  'customerManagement',
] as const satisfies readonly (keyof SubscriptionFeatures)[];

export type NavigationFeatureKey = (typeof NAVIGATION_FEATURE_KEYS)[number];

/** Every navigation flag, all present — no optionals, so none can be forgotten. */
export type NavigationFeatures = Record<NavigationFeatureKey, boolean>;

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
  ruleChains: number;

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
  ruleChains: 0,
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
  ruleChains: 'ruleChains',
  users: 'users',
  customers: 'customers',
  apiCalls: 'apiCallsPerMonth',
  storageGB: 'storageGB',
  smsNotifications: 'smsNotificationsPerMonth',
};