import { Entity, Column, Index } from 'typeorm';
import { BaseEntity } from '../../../common/entities/base.entity';

export enum AuditAction {
  CREATE = 'create',
  READ = 'read',
  UPDATE = 'update',
  DELETE = 'delete',
  LOGIN = 'login',
  LOGOUT = 'logout',
  PASSWORD_CHANGE = 'password_change',
  PASSWORD_RESET = 'password_reset',
  EMAIL_VERIFY = 'email_verify',
  STATUS_CHANGE = 'status_change',
  ROLE_CHANGE = 'role_change',
  DEVICE_CONNECT = 'device_connect',
  DEVICE_DISCONNECT = 'device_disconnect',
  ALARM_TRIGGER = 'alarm_trigger',
  ALARM_ACKNOWLEDGE = 'alarm_acknowledge',
  NOTIFICATION_SENT = 'notification_sent',
  FILE_UPLOAD = 'file_upload',
  FILE_DELETE = 'file_delete',
  SETTINGS_CHANGE = 'settings_change',
  API_KEY_CREATE = 'api_key_create',
  API_KEY_REVOKE = 'api_key_revoke',
}

export enum AuditEntityType {
  USER = 'user',
  DEVICE = 'device',
  ALARM = 'alarm',
  NOTIFICATION = 'notification',
  DASHBOARD = 'dashboard',
  TELEMETRY = 'telemetry',
  RULE = 'rule',
  SETTINGS = 'settings',
  FILE = 'file',
  API_KEY = 'api_key',
}

export enum AuditSeverity {
  INFO = 'info',
  WARNING = 'warning',
  ERROR = 'error',
  CRITICAL = 'critical',
}

@Entity('audit_logs')
@Index(['userId', 'timestamp'])
@Index(['entityType', 'entityId'])
@Index(['action', 'timestamp'])
export class AuditLog extends BaseEntity {
  @Column({ nullable: true })
  @Index()
  userId?: string;

  @Column({ nullable: true })
  userName?: string;

  @Column({ nullable: true })
  userEmail?: string;

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

  @Column({ type: 'jsonb', nullable: true })
  metadata?: Record<string, any>;

  @Column({ type: 'jsonb', nullable: true })
  changes?: {
    before?: Record<string, any>;
    after?: Record<string, any>;
  };

  @Column({ nullable: true })
  ipAddress?: string;

  @Column({ nullable: true })
  userAgent?: string;

  @Column({
    type: 'enum',
    enum: AuditSeverity,
    default: AuditSeverity.INFO,
  })
  severity: AuditSeverity;

  @Column({ type: 'timestamp', default: () => 'CURRENT_TIMESTAMP' })
  @Index()
  timestamp: Date;

  @Column({ default: true })
  success: boolean;

  @Column({ type: 'text', nullable: true })
  errorMessage?: string;

  @Column({ nullable: true })
  tenantId?: string;
}
