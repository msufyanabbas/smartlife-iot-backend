// src/database/seeders/index.seeder.ts
import { UserSeeder } from './user/user.seeder';
import { TenantSeeder } from './tenant/tenant.seeder';
import { DeviceSeeder } from './device/device.seeder';
import { AlarmSeeder } from './alarm/alarm.seeder';
import { AnalyticsSeeder } from './analytics/analytics.seeder';
import { APILogSeeder } from './api-log/api-log.seeder';
import { AssetProfileSeeder } from './asset-profiles/asset-profile.seeder';
import { AssetSeeder } from './assets/assets.seeder';
import { AttributeSeeder } from './attribute/attribute.seeder';
import { AuditLogSeeder } from './audit-log/audit-log.seeder';
import { AutomationSeeder } from './automation/automation.seeder';
import { DashboardSeeder } from './dashboard/dashboard.seeder';
import { DeviceProfileSeeder } from './device-profile/device-profile.seeder';
import { EdgeInstanceSeeder } from './edge/edge-instance.seeder';
import { EmailTemplateSeeder } from './email-template/email-template.seeder';
import { ImageSeeder } from './image/images.seeder';
import { FloorPlanSeeder } from './floor-plan/floor-plan.seeder';
import { IntegrationSeeder } from './integrations/integrations.seeder';
import { NodeSeeder } from './nodes/nodes.seeder';
import { NotificationSeeder } from './notifications/notifications.seeder';
import { RefreshTokenSeeder } from './refresh-token/refresh-token.seeder';
import { ScheduleSeeder } from './schedule/schedule.seeder';
import { ShareSeeder } from './share/share.seeder';
import { SolutionTemplateSeeder } from './solution-template/solution-template.seeder';
import { SubscriptionSeeder } from './subscription/subscription.seeder';
import { TelemetrySeeder } from './telemetry/telemetry.seeder';
import { WidgetBundleSeeder } from './widget-bundle/widget-bundle.seeder';
import { WidgetTypeSeeder } from './widget-type/widget-type.seeder';
import { DeviceCredentialsSeeder } from './device-credentials/device-credentials.seeder';
import { DeviceCommandsSeeder } from './device-commands/device-commands.seeder';
import { PermissionSeeder } from "./permissions/permissions.seeder";
import {
  Tenant,
  Device,
  User,
  Alarm,
  Analytics,
  APILog,
  AssetProfile,
  Asset,
  Attribute,
  AuditLog,
  Automation,
  Dashboard,
  DeviceProfile,
  EdgeInstance,
  EmailTemplate,
  FloorPlan,
  Image,
  Integration,
  Node,
  Notification,
  RefreshToken,
  Schedule,
  Share,
  SolutionTemplate,
  Subscription,
  Telemetry,
  WidgetBundle,
  WidgetType,
  DeviceCredentials,
  DeviceCommand,
  Customer,
  Permission,
  Role,
  RuleChain
} from '@modules/index.entities';
import { CustomerSeeder } from './customer/customers.seeder';
import { RoleSeeder } from './roles/roles.seeder';
import { RuleChainSeeder } from './rule-chain/rule-chain.seeder';
export interface SeederConfig {
  name: string;
  seeder: any;
  emoji: string;
  entity: any;
}

/**
 * Define the order and configuration of seeders
 * Seeders will be executed in the order they appear in this array
 */
export const SEEDERS: SeederConfig[] = [
  {
    name: 'Users',
    seeder: UserSeeder,
    emoji: '👤',
    entity: User,
  },
  {
    name: 'Tenants',
    seeder: TenantSeeder,
    emoji: '🏢',
    entity: Tenant,
  },
  {
    name: 'Customers',
    seeder: CustomerSeeder,
    emoji: '🏢',
    entity: Customer,
  },
  {
    name: 'Devices',
    seeder: DeviceSeeder,
    emoji: '📱',
    entity: Device,
  },
  {
    name: 'Alarms',
    seeder: AlarmSeeder,
    emoji: '📢',
    entity: Alarm,
  },
  {
    name: 'Analytics',
    seeder: AnalyticsSeeder,
    emoji: '📊',
    entity: Analytics,
  },
  {
    name: 'API Logs',
    seeder: APILogSeeder,
    emoji: '📝',
    entity: APILog,
  },
  {
    name: 'Asset Profiles',
    seeder: AssetProfileSeeder,
    emoji: '🛠️',
    entity: AssetProfile,
  },
  {
    name: 'Assets',
    seeder: AssetSeeder,
    emoji: '📦',
    entity: Asset,
  },
  {
    name: 'Attributes',
    seeder: AttributeSeeder,
    emoji: '🔧',
    entity: Attribute,
  },
  {
    name: 'Audit Logs',
    seeder: AuditLogSeeder,
    emoji: '📝',
    entity: AuditLog,
  },
  {
    name: 'Automations',
    seeder: AutomationSeeder,
    emoji: '🤖',
    entity: Automation,
  },
  {
    name: 'Dashboards',
    seeder: DashboardSeeder,
    emoji: '📊',
    entity: Dashboard,
  },
  {
    name: 'Device Profiles',
    seeder: DeviceProfileSeeder,
    emoji: '📟',
    entity: DeviceProfile,
  },
  {
    name: 'Edge Instances',
    seeder: EdgeInstanceSeeder,
    emoji: '🌐',
    entity: EdgeInstance,
  },
  {
    name: 'Email Templates',
    seeder: EmailTemplateSeeder,
    emoji: '✉️',
    entity: EmailTemplate,
  },
  {
    name: 'Floor Plans',
    seeder: FloorPlanSeeder,
    emoji: '📐',
    entity: FloorPlan,
  },
  {
    name: 'Images',
    seeder: ImageSeeder,
    emoji: '🖼️',
    entity: Image,
  },
  {
    name: 'Integrations',
    seeder: IntegrationSeeder,
    emoji: '🔗',
    entity: Integration,
  },
  {
    name: 'Rule Chains',
    seeder: RuleChainSeeder,
    emoji: '🔗',
    entity: RuleChain,
  },
  {
    name: 'Nodes',
    seeder: NodeSeeder,
    emoji: '🧱',
    entity: Node,
  },
  {
    name: 'Notifications',
    seeder: NotificationSeeder,
    emoji: '🔔',
    entity: Notification,
  },
  {
    name: 'Refresh Tokens',
    seeder: RefreshTokenSeeder,
    emoji: '🔑',
    entity: RefreshToken,
  },
  {
    name: 'Schedules',
    seeder: ScheduleSeeder,
    emoji: '📅',
    entity: Schedule,
  },
  {
    name: 'Shares',
    seeder: ShareSeeder,
    emoji: '🤝',
    entity: Share,
  },
  {
    name: 'Solution Templates',
    seeder: SolutionTemplateSeeder,
    emoji: '🛠️',
    entity: SolutionTemplate,
  },
  {
    name: 'Subscriptions',
    seeder: SubscriptionSeeder,
    emoji: '💳',
    entity: Subscription,
  },
  {
    name: 'Telemetries',
    seeder: TelemetrySeeder,
    emoji: '📡',
    entity: Telemetry,
  },
  {
    name: 'Widget Bundles',
    seeder: WidgetBundleSeeder,
    emoji: '🧩',
    entity: WidgetBundle,
  },
  {
    name: 'Widget Types',
    seeder: WidgetTypeSeeder,
    emoji: '🔧',
    entity: WidgetType,
  },
  {
    name: 'Device Credentials',
    seeder: DeviceCredentialsSeeder,
    emoji: '🔑',
    entity: DeviceCredentials,
  },
  {
    name: 'Device Commands',
    seeder: DeviceCommandsSeeder,
    emoji: '📜',
    entity: DeviceCommand,
  },
  {
    name: 'Permissions',
    seeder: PermissionSeeder,
    emoji: '📜',
    entity: Permission,
  },
  {
    name: 'Roles',
    seeder: RoleSeeder,
    emoji: '📜',
    entity: Role,
  },
];

// Export individual seeders for backward compatibility
export {
  PermissionSeeder,
  UserSeeder,
  TenantSeeder,
  DeviceSeeder,
  AlarmSeeder,
  AnalyticsSeeder,
  APILogSeeder,
  AssetProfileSeeder,
  AssetSeeder,
  AttributeSeeder,
  AuditLogSeeder,
  AutomationSeeder,
  DashboardSeeder,
  DeviceProfileSeeder,
  EdgeInstanceSeeder,
  EmailTemplateSeeder,
  FloorPlanSeeder,
  DeviceCredentialsSeeder,
  DeviceCommandsSeeder,
};
