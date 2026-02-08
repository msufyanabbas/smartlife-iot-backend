import e from 'express';
import { UserRole } from './user_roles/entities/user_roles.entity';

// User & Auth entities
export { User } from './users/entities/user.entity';
export { RefreshToken } from './auth/entities/refresh-token.entity';
export { Role } from './roles/entities/roles.entity';
export { Permission } from './permissions/entities/permissions.entity';
export { RolePermission } from './role_permissions/entities/role_permissions.entity';
export { UserRole } from './user_roles/entities/user_roles.entity';

// Device & IoT entities
export { Device } from './devices/entities/device.entity';
export { Telemetry } from './telemetry/entities/telemetry.entity';
export { Asset } from './assets/entities/asset.entity';
export { EdgeInstance } from './edge/entities/edge-instance.entity';

// Profile entities
export { DeviceProfile } from './profiles/entities/device-profile.entity';
export { AssetProfile } from './profiles/entities/asset-profile.entity';

// Dashboard & Visualization entities
export { Dashboard } from './dashboards/entities/dashboard.entity';
export { WidgetBundle } from './widgets/entities/widget-bundle.entity';
export { WidgetType } from './widgets/entities/widget-type.entity';
export { FloorPlan } from './floor-plans/entities/floor-plan.entity';

// Notification & Communication entities
export { Alarm } from './alarms/entities/alarm.entity';
export { Notification } from './notifications/entities/notification.entity';
export { EmailTemplate } from './email-templates/entities/email-template.entity';

// Monitoring & Analytics entities
export { Analytics } from './analytics/entities/analytics.entity';
export { AuditLog } from './audit/entities/audit-log.entity';
export { APILog } from './api-monitoring/entities/api-log.entity';

// Integration & Automation entities
export { Integration } from './integrations/entities/integration.entity';
export { Automation } from './automation/entities/automation.entity';
export { Schedule } from './schedules/entities/schedule.entity';

// Subscription & Sharing entities
export { Subscription } from './subscriptions/entities/subscription.entity';
export { Share } from './sharing/entities/sharing.entity';

// Template & Resource entities
export { SolutionTemplate } from './solution-templates/entities/solution-template.entity';
export { Image } from './images/entities/image.entity';

export { Attribute } from './attributes/entities/attribute.entity';

export { Tenant } from './tenants/entities/tenant.entity';

export { Node } from './nodes/entities/node.entity';
export { DeviceCredentials } from './devices/entities/device-credentials.entity';
export { DeviceCommand } from './device-commands/entities/device-commands.entity';
export { OAuthAccount } from './auth/entities/oauth-account.entity';
export { TokenBlacklist } from './auth/entities/token-blacklist.entity';
export { Payment } from './payments/entities/payment.entity';
export { TwoFactorAuth } from './two-factor/entities/two-factor-auth.entity';
export { Customer } from './customers/entities/customers.entity';
export { Invitation } from './auth/entities/invitation.entity';
export { UserSettings } from './user-settings/entities/user-settings.entity';