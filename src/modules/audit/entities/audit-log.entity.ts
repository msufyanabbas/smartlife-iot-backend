// src/modules/audit/entities/audit-log.entity.ts
import { Entity, Column, Index, ManyToOne, JoinColumn } from 'typeorm';
import { BaseEntity } from '../../../common/entities/base.entity';
import { User } from '../../users/entities/user.entity';
import { Tenant } from '../../tenants/entities/tenant.entity';

export enum AuditAction {
  CREATE = 'create',
  READ = 'read',
  UPDATE = 'update',
  DELETE = 'delete',
  ACTIVATE = 'activate',
  DEACTIVATE = 'deactivate',
  LOGIN = 'login',
  LOGOUT = 'logout',
  LOGIN_FAILED = 'login_failed',
  PASSWORD_CHANGE = 'password_change',
  PASSWORD_RESET = 'password_reset',
  EMAIL_VERIFY = 'email_verify',
  STATUS_CHANGE = 'status_change',
  ROLE_CHANGE = 'role_change',
  PERMISSION_CHANGE = 'permission_change',
  DEVICE_CONNECT = 'device_connect',
  DEVICE_DISCONNECT = 'device_disconnect',
  DEVICE_COMMAND = 'device_command',
  ALARM_CREATE = 'alarm_create',
  ALARM_UPDATE = 'alarm_update',
  ALARM_ACKNOWLEDGE = 'alarm_acknowledge',
  ALARM_CLEAR = 'alarm_clear',
  NOTIFICATION_SENT = 'notification_sent',
  FILE_UPLOAD = 'file_upload',
  FILE_DELETE = 'file_delete',
  SETTINGS_CHANGE = 'settings_change',
  API_KEY_CREATE = 'api_key_create',
  API_KEY_REVOKE = 'api_key_revoke',
  SUBSCRIPTION_CREATE = 'subscription_create',
  SUBSCRIPTION_UPDATE = 'subscription_update',
  SUBSCRIPTION_CANCEL = 'subscription_cancel',
  PAYMENT_SUCCESS = 'payment_success',
  PAYMENT_FAILED = 'payment_failed',
  ALARM_TRIGGER = 'alarm_trigger',
}

export enum AuditEntityType {
  USER = 'user',
  TENANT = 'tenant',
  CUSTOMER = 'customer',
  DEVICE = 'device',
  DEVICE_PROFILE = 'device_profile',
  ASSET = 'asset',
  ALARM = 'alarm',
  NOTIFICATION = 'notification',
  DASHBOARD = 'dashboard',
  TELEMETRY = 'telemetry',
  RULE_CHAIN = 'rule_chain',
  RULE_NODE = 'rule_node',
  SETTINGS = 'settings',
  FILE = 'file',
  API_KEY = 'api_key',
  SUBSCRIPTION = 'subscription',
  PAYMENT = 'payment',
  WIDGET = 'widget',
  INTEGRATION = 'integration',
}

export enum AuditSeverity {
  INFO = 'info',
  WARNING = 'warning',
  ERROR = 'error',
  CRITICAL = 'critical',
}

@Entity('audit_logs')
@Index(['tenantId', 'timestamp'])
@Index(['userId', 'timestamp'])
@Index(['entityType', 'entityId'])
@Index(['action', 'timestamp'])
@Index(['severity', 'timestamp'])
export class AuditLog extends BaseEntity {
  // User who performed the action
  @Column({ nullable: true })
  @Index()
  userId?: string;

  @ManyToOne(() => User, { nullable: true, onDelete: 'SET NULL' })
  @JoinColumn({ name: 'userId' })
  user: User;

  @Column({ nullable: true })
  userName?: string;

  @Column({ nullable: true })
  userEmail?: string;

  // Tenant context
  @Column()
  @Index()
  tenantId: string;

  @ManyToOne(() => Tenant, { nullable:                     false, onDelete: 'CASCADE' })
  @JoinColumn({ name: 'tenantId' })
  tenant: Tenant;

  // Customer context (optional - for customer-level isolation)
  @Column({ nullable: true })
  @Index()
  customerId?: string;

  // Action details
  @Column({
    type: 'enum',
    enum: AuditAction,
  })
  @Index()
  action: AuditAction;

  @Column({
    type: 'enum',
    enum: AuditEntityType,
  })
  @Index()
  entityType: AuditEntityType;

  @Column({ nullable: true })
  @Index()
  entityId?: string;

  @Column({ nullable: true })
  entityName?: string;

  @Column({ type: 'text', nullable: true })
  description?: string;

  // Change tracking
  @Column({ type: 'jsonb', nullable: true })
  metadata?: Record<string, any>;

  @Column({ type: 'jsonb', nullable: true })
  changes?: {
    before?: Record<string, any>;
    after?: Record<string, any>;
  };

  // Request context
  @Column({ nullable: true })
  ipAddress?: string;

  @Column({ nullable: true })
  userAgent?: string;

  @Column({ nullable: true })
  requestId?: string;

  // Severity and status
  @Column({
    type: 'enum',
    enum: AuditSeverity,
    default: AuditSeverity.INFO,
  })
  @Index()
  severity: AuditSeverity;

  @Column({ type: 'timestamp', default: () => 'CURRENT_TIMESTAMP' })
  @Index()
  timestamp: Date;

  @Column({ default: true })
  success: boolean;

  @Column({ type: 'text', nullable: true })
  errorMessage?: string;

  // Additional context
  @Column({ type: 'jsonb', nullable: true })
  tags?: string[]; // For filtering/categorization
}