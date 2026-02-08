// ============================================
// INFRASTRUCTURE MODULES (from NestJS packages)
// ============================================
export { Module } from '@nestjs/common';
export { ConfigModule } from '@nestjs/config';
export { TypeOrmModule } from '@nestjs/typeorm';
export { CacheModule } from '@nestjs/cache-manager';
export { BullModule } from '@nestjs/bull';
export { EventEmitterModule } from '@nestjs/event-emitter';
export { ScheduleModule } from '@nestjs/schedule';
export { ThrottlerModule } from '@nestjs/throttler';
export { SeederModule } from '../database/seeds/seeder.module';
export { HealthModule } from './health/health.module';
export { MetricsModule } from './metrics/metrics.module';
export {CustomersModule} from './customers/customers.module';
export {UserSettingsModule} from './user-settings/user-settings.module';
export { RolesModule } from './roles/roles.module';
export { PermissionsModule } from './permissions/permissions.module';

// ============================================
// FEATURE MODULES (application modules)
// ============================================

// Core modules
export { AuthModule } from './auth/auth.module';
export { UsersModule } from './users/users.module';
export { ProfilesModule } from './profiles/profiles.module';
export { TenantsModule } from './tenants/tenants.module';

// Device & IoT modules
export { DevicesModule } from './devices/devices.module';
export { TelemetryModule } from './telemetry/telemetry.module';
export { GatewayModule } from './gateway/gateway.module';
export { AssetsModule } from './assets/assets.module';
export { AttributesModule } from './attributes/attributes.module';
export { NodesModule } from './nodes/nodes.module';

// Communication modules
export { WebsocketModule } from './websocket/websocket.module';
export { MailModule } from './mail/mail.module';
export { EmailTemplatesModule } from './email-templates/email-templates.module';
export { NotificationsModule } from './notifications/notifications.module';

// Dashboard & Visualization modules
export { DashboardsModule } from './dashboards/dashboards.module';
export { WidgetsModule } from './widgets/widgets.module';
export { FloorPlansModule } from './floor-plans/floor-plans.module';

// Monitoring & Analytics modules
export { AlarmsModule } from './alarms/alarms.module';
export { AnalyticsModule } from './analytics/analytics.module';
export { AuditModule } from './audit/audit.module';
export { ApiMonitoringModule } from './api-monitoring/api-monitoring.module';

// Integration & Automation modules
export { IntegrationsModule } from './integrations/integrations.module';
export { ScriptsModule } from './scripts/scripts.module';
export { SchedulesModule } from './schedules/schedule.module';
export { SubscriptionsModule } from './subscriptions/subscriptions.module';

// Resource & Template modules
export { ImagesModule } from './images/images.module';
export { SolutionTemplatesModule } from './solution-templates/solution-templates.module';
export { SharingModule } from './sharing/sharing.module';

// ============================================
// IMPORT MODULES FOR FEATURE ARRAY
// ============================================
import { AuthModule } from './auth/auth.module';
import { UsersModule } from './users/users.module';
import { ProfilesModule } from './profiles/profiles.module';
import { TenantsModule } from './tenants/tenants.module';
import { DevicesModule } from './devices/devices.module';
import { TelemetryModule } from './telemetry/telemetry.module';
import { GatewayModule } from './gateway/gateway.module';
import { AssetsModule } from './assets/assets.module';
import { AttributesModule } from './attributes/attributes.module';
import { NodesModule } from './nodes/nodes.module';
import { WebsocketModule } from './websocket/websocket.module';
import { UserSettingsModule } from './user-settings/user-settings.module';
import { MailModule } from './mail/mail.module';
import { EmailTemplatesModule } from './email-templates/email-templates.module';
import { NotificationsModule } from './notifications/notifications.module';
import { SeederModule } from '../database/seeds/seeder.module';
import { DashboardsModule } from './dashboards/dashboards.module';
import { WidgetsModule } from './widgets/widgets.module';
import { FloorPlansModule } from './floor-plans/floor-plans.module';
import { AlarmsModule } from './alarms/alarms.module';
import { AnalyticsModule } from './analytics/analytics.module';
import { AuditModule } from './audit/audit.module';
import { ApiMonitoringModule } from './api-monitoring/api-monitoring.module';
import { IntegrationsModule } from './integrations/integrations.module';
import { ScriptsModule } from './scripts/scripts.module';
import { SchedulesModule } from './schedules/schedule.module';
import { SubscriptionsModule } from './subscriptions/subscriptions.module';
import { ImagesModule } from './images/images.module';
import { SolutionTemplatesModule } from './solution-templates/solution-templates.module';
import { SharingModule } from './sharing/sharing.module';
import { ProtocolsModule } from './protocols/protocols.module';
import { DeviceCommandsModule } from './device-commands/device-commands.module';
import { HealthModule } from './health/health.module';
import { MetricsModule } from './metrics/metrics.module';
import { PaymentsModule } from './payments/payments.module';
import { TwoFactorAuthModule } from './two-factor/two-factor-auth.module';
import { CustomersModule } from './customers/customers.module';
import { CustomerUsersModule } from './customer-users/customer-users.module';
import { CodecModule } from './devices/codecs/codec.module';
import { AutomationModule } from './automation/automation.module';
import { RolesModule } from './roles/roles.module';
import { PermissionsModule } from './permissions/permissions.module';

// ============================================
// FEATURE MODULES ARRAY (for spreading in app.module.ts)
// ============================================
export const featureModules = [
  PermissionsModule,
  CodecModule,
  CustomerUsersModule,
  CustomersModule,
  PaymentsModule,
  TwoFactorAuthModule,
  UserSettingsModule,
  RolesModule,
  // Core
  AuthModule,
  UsersModule,
  ProfilesModule,
  TenantsModule,
  SeederModule,
  MetricsModule,
  HealthModule,

  // Device & IoT
  DevicesModule,
  TelemetryModule,
  GatewayModule,
  AssetsModule,
  AttributesModule,
  NodesModule,

  // Communication
  WebsocketModule,
  MailModule,
  EmailTemplatesModule,
  NotificationsModule,

  // Dashboard & Visualization
  DashboardsModule,
  WidgetsModule,
  FloorPlansModule,

  // Monitoring & Analytics
  AlarmsModule,
  AnalyticsModule,
  AuditModule,
  ApiMonitoringModule,

  // Integration & Automation
  AutomationModule,
  IntegrationsModule,
  ScriptsModule,
  SchedulesModule,
  SubscriptionsModule,

  // Resource & Template
  ImagesModule,
  SolutionTemplatesModule,
  SharingModule,
  ProtocolsModule,
  DeviceCommandsModule,
];
