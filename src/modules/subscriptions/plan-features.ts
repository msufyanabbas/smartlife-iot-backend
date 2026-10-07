import {
  SubscriptionFeatures,
  NavigationFeatures,
  NAVIGATION_FEATURE_KEYS,
} from '@common/interfaces/subscription.interface';
import { SubscriptionPlan, SupportLevel } from '@common/enums/index.enum';

/**
 * ─────────────────────────────────────────────────────────────────────────────
 * Plan → feature flags. THE single source of truth.
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * Previously this table lived inside subscription.seeder.ts and nothing else
 * could reach it, which produced two bugs that between them hid most of the
 * sidebar:
 *
 *   1. `defaultFeatures` never set `devices`, `assets`, `floorPlans`,
 *      `automations`, `apiAccess` or `settings`. The frontend hides a menu when
 *      `features[key] !== true`, so on FREE / STARTER / PROFESSIONAL the
 *      Objects group (Devices + Assets), Floor Plans, Automation, API
 *      Monitoring and Settings were all invisible — not because they were
 *      disabled, but because nobody ever said they were enabled.
 *
 *   2. The ENTERPRISE entry did not spread `defaultFeatures` at all, so the
 *      most expensive plan was missing ~17 navigation flags and showed the
 *      LEAST. It only looked survivable because the backend guards read a
 *      missing key as "allowed" while the frontend reads it as "hidden".
 *
 * Two rules keep it from happening again:
 *
 *   - `NavigationFeatures` is `Record<NavigationFeatureKey, boolean>` — every
 *     navigation flag is REQUIRED. Adding a menu flag without setting it on
 *     every plan is a compile error.
 *   - `resolveFeatures()` merges stored values over the plan baseline on read,
 *     so a subscription row written before a flag existed still answers for it.
 */

// ── Navigation baseline ──────────────────────────────────────────────────────
// What every plan can see. Paid-only menus are switched on per plan below.
// Exhaustive by type: leaving a key out does not compile.
const FREE_NAVIGATION: NavigationFeatures = {
  overview: true,
  solutionTemplates: true,
  solutionDashboards: true,
  deviceProfiles: true,
  assetProfiles: true,
  devices: true,
  assets: true,
  dashboards: true,
  floorPlans: true,
  alerts: true,
  analytics: false,
  userRoles: true,
  automations: true,
  integration: false,
  integrations: false,
  edge: true,
  edgeManagement: true,
  firmware: true,
  scheduleManagement: false,
  resources: true,
  widgets: true,
  imageLibrary: true,
  scriptLibrary: true,
  notifications: true,
  sharingCenter: false,
  apiAccess: false,
  apiMonitoring: false,
  auditLogs: false,
  subscription: true,
  settings: true,
  customerManagement: false,
};

// ── Non-navigation capabilities ──────────────────────────────────────────────
// Depth-of-feature settings, quotas and support tiers. These are not menu
// gates, so they stay optional.
const FREE_CAPABILITIES: SubscriptionFeatures = {
  realtimeAnalytics: false,
  advancedAutomation: false,
  ruleEngine: 'basic',
  restApiAccess: true,
  mqttAccess: true,
  customIntegrations: false,
  whiteLabelBranding: false,
  whiteLabel: false,
  brandingLevel: 'none',
  emailNotifications: true,
  smsNotifications: false,
  mobileAppAccess: true,
  widgetLibrary: 'basic',
  alarmManagement: 'basic',
  advancedAlarms: false,
  bulkOperations: false,
  dataExport: 'csv',
  scheduledReports: 'none',
  supportLevel: SupportLevel.COMMUNITY,
  slaGuarantee: false,
  onboardingSupport: 'none',
  customDevelopment: false,
  multiTenancy: false,
  roleBasedAccess: true,
  backupRecovery: false,
  // Manual OTA on every plan: a device you cannot patch is a device you cannot
  // secure, so the gate (`firmware`) is open everywhere and only the automatic
  // rollout mode is a paid upgrade.
  otaUpdates: 'manual',
  deviceGroups: false,
  assetManagement: 'basic',
  geofencing: false,
  customAttributes: true,
  rpcCommands: true,
  dataAggregation: false,
};

const FREE: SubscriptionFeatures = { ...FREE_NAVIGATION, ...FREE_CAPABILITIES };

const STARTER: SubscriptionFeatures = {
  ...FREE,
  analytics: true,
  scheduleManagement: true,
  realtimeAnalytics: true,
  advancedAutomation: true,
  ruleEngine: 'advanced',
  smsNotifications: true,
  widgetLibrary: 'standard',
  bulkOperations: true,
  dataExport: 'csv-json-excel',
  scheduledReports: 'monthly',
  supportLevel: SupportLevel.EMAIL,
  onboardingSupport: 'basic',
  deviceGroups: true,
  dataAggregation: true,
};

const PROFESSIONAL: SubscriptionFeatures = {
  ...STARTER,
  integration: true,
  integrations: true,
  sharingCenter: true,
  apiAccess: true,
  apiMonitoring: true,
  auditLogs: true,
  customerManagement: true,
  customIntegrations: true,
  whiteLabelBranding: true,
  whiteLabel: true,
  brandingLevel: 'partial',
  widgetLibrary: 'advanced',
  alarmManagement: 'standard',
  advancedAlarms: true,
  scheduledReports: 'weekly',
  supportLevel: SupportLevel.PRIORITY,
  onboardingSupport: 'standard',
  multiTenancy: true,
  assetManagement: 'advanced',
  geofencing: true,
  backupRecovery: true,
  otaUpdates: 'automatic',
};

const ENTERPRISE: SubscriptionFeatures = {
  // Spreading PROFESSIONAL is deliberate. The previous table built ENTERPRISE
  // from scratch and silently lost every navigation flag.
  ...PROFESSIONAL,
  ruleEngine: 'premium',
  brandingLevel: 'full',
  alarmManagement: 'advanced',
  dataExport: 'all-formats',
  scheduledReports: 'realtime',
  supportLevel: SupportLevel.DEDICATED,
  slaGuarantee: true,
  slaPercentage: 99.9,
  onboardingSupport: 'premium',
  customDevelopment: true,
};

export const PLAN_FEATURES: Record<SubscriptionPlan, SubscriptionFeatures> = {
  [SubscriptionPlan.FREE]: FREE,
  [SubscriptionPlan.STARTER]: STARTER,
  [SubscriptionPlan.PROFESSIONAL]: PROFESSIONAL,
  [SubscriptionPlan.ENTERPRISE]: ENTERPRISE,
};

/** Baseline flags for a plan. Always a fresh object — never hand out the table. */
export function getPlanFeatures(plan: SubscriptionPlan): SubscriptionFeatures {
  return { ...(PLAN_FEATURES[plan] ?? FREE) };
}

/**
 * What the API should return for a subscription row.
 *
 * Stored values win — an admin who switched a flag off for one tenant keeps
 * that. The plan baseline only fills keys the stored object does not mention,
 * which is what makes flags added after a row was written work without a
 * backfill migration.
 *
 * `undefined` stored values are dropped rather than spread, otherwise an
 * explicit `{devices: undefined}` would punch a hole back through the baseline
 * and hide the menu again.
 */
export function resolveFeatures(
  plan: SubscriptionPlan | undefined | null,
  stored: SubscriptionFeatures | undefined | null,
): SubscriptionFeatures {
  const baseline = getPlanFeatures(plan ?? SubscriptionPlan.FREE);
  if (!stored) return baseline;

  const defined = Object.fromEntries(
    Object.entries(stored).filter(([, value]) => value !== undefined),
  ) as SubscriptionFeatures;

  return { ...baseline, ...defined };
}

/**
 * Navigation flags only, every key present and boolean.
 *
 * A non-boolean stored value (someone wrote `'automatic'` where the sidebar
 * expects a boolean) would otherwise reach the frontend's strict `=== true`
 * check and hide the menu, so it is coerced here.
 */
export function resolveNavigationFeatures(
  plan: SubscriptionPlan | undefined | null,
  stored: SubscriptionFeatures | undefined | null,
): NavigationFeatures {
  const resolved = resolveFeatures(plan, stored);
  const navigation = {} as NavigationFeatures;
  for (const key of NAVIGATION_FEATURE_KEYS) {
    navigation[key] = resolved[key] === true;
  }
  return navigation;
}
