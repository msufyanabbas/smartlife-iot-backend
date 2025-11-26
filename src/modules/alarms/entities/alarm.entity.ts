import { Entity, Column, ManyToOne, JoinColumn, Index } from 'typeorm';
import { BaseEntity } from '../../../common/entities/base.entity';
import { User } from '../../users/entities/user.entity';
import { Device } from '../../devices/entities/device.entity';

export enum AlarmSeverity {
  INFO = 'info',
  WARNING = 'warning',
  ERROR = 'error',
  CRITICAL = 'critical',
}

export enum AlarmStatus {
  ACTIVE = 'active',
  ACKNOWLEDGED = 'acknowledged',
  CLEARED = 'cleared',
  RESOLVED = 'resolved',
}

export enum AlarmCondition {
  GREATER_THAN = 'gt',
  LESS_THAN = 'lt',
  EQUAL = 'eq',
  NOT_EQUAL = 'neq',
  GREATER_THAN_OR_EQUAL = 'gte',
  LESS_THAN_OR_EQUAL = 'lte',
  BETWEEN = 'between',
  OUTSIDE = 'outside',
}

export interface AlarmRule {
  telemetryKey: string;
  condition: AlarmCondition;
  value: number;
  value2?: number; // For BETWEEN and OUTSIDE conditions
  duration?: number; // How long condition must be true (seconds)
}

@Entity('alarms')
@Index(['deviceId', 'status'])
@Index(['userId', 'severity'])
@Index(['status', 'severity'])
export class Alarm extends BaseEntity {
  @Column()
  name: string;

  @Column({ type: 'text', nullable: true })
  description?: string;

  @Column({ type: 'enum', enum: AlarmSeverity, default: AlarmSeverity.WARNING })
  severity: AlarmSeverity;

  @Column({ type: 'enum', enum: AlarmStatus, default: AlarmStatus.ACTIVE })
  status: AlarmStatus;

  @Column()
  userId: string;

  @ManyToOne(() => User)
  @JoinColumn({ name: 'userId' })
  user: User;

  @Column({ nullable: true })
  deviceId?: string;

  @ManyToOne(() => Device, { nullable: true })
  @JoinColumn({ name: 'deviceId' })
  device?: Device;

  // Alarm Rule
  @Column({ type: 'jsonb' })
  rule: AlarmRule;

  // Current value that triggered the alarm
  @Column({ type: 'decimal', precision: 10, scale: 2, nullable: true })
  currentValue?: number;

  // Message generated when alarm triggered
  @Column({ type: 'text', nullable: true })
  message?: string;

  // When alarm was triggered
  @Column({ type: 'timestamp', nullable: true })
  triggeredAt?: Date;

  // When alarm was acknowledged
  @Column({ type: 'timestamp', nullable: true })
  acknowledgedAt?: Date;

  @Column({ nullable: true })
  acknowledgedBy?: string; // User ID

  // When alarm condition cleared
  @Column({ type: 'timestamp', nullable: true })
  clearedAt?: Date;

  // When alarm was resolved
  @Column({ type: 'timestamp', nullable: true })
  resolvedAt?: Date;

  @Column({ nullable: true })
  resolvedBy?: string; // User ID

  @Column({ type: 'text', nullable: true })
  resolutionNote?: string;

  // Enable/Disable alarm
  @Column({ default: true })
  isEnabled: boolean;

  // Auto-clear alarm when condition no longer true
  @Column({ default: true })
  autoClear: boolean;

  // Notification settings
  @Column({ type: 'jsonb', nullable: true })
  notifications?: {
    email?: boolean;
    sms?: boolean;
    push?: boolean;
    webhook?: string;
  };

  // Recipients for notifications
  @Column({ type: 'jsonb', nullable: true })
  recipients?: {
    userIds?: string[];
    emails?: string[];
    phones?: string[];
  };

  // Trigger count
  @Column({ type: 'int', default: 0 })
  triggerCount: number;

  // Last triggered
  @Column({ type: 'timestamp', nullable: true })
  lastTriggeredAt?: Date;

  // Metadata
  @Column({ type: 'jsonb', nullable: true })
  metadata?: Record<string, any>;

  @Column({ type: 'jsonb', nullable: true })
  tags?: string[];

  // Helper methods
  trigger(value: number, message?: string): void {
    this.status = AlarmStatus.ACTIVE;
    this.currentValue = value;
    this.message = message || this.generateMessage(value);
    this.triggeredAt = new Date();
    this.lastTriggeredAt = new Date();
    this.triggerCount++;
  }

  acknowledge(userId: string): void {
    this.status = AlarmStatus.ACKNOWLEDGED;
    this.acknowledgedAt = new Date();
    this.acknowledgedBy = userId;
  }

  clear(): void {
    this.status = AlarmStatus.CLEARED;
    this.clearedAt = new Date();
  }

  resolve(userId: string, note?: string): void {
    this.status = AlarmStatus.RESOLVED;
    this.resolvedAt = new Date();
    this.resolvedBy = userId;
    this.resolutionNote = note;
  }

  private generateMessage(value: number): string {
    const { telemetryKey, condition, value: threshold } = this.rule;
    const conditionText = this.getConditionText(condition);
    return `${telemetryKey} ${conditionText} ${threshold}. Current value: ${value}`;
  }

  private getConditionText(condition: AlarmCondition): string {
    const map = {
      [AlarmCondition.GREATER_THAN]: 'is greater than',
      [AlarmCondition.LESS_THAN]: 'is less than',
      [AlarmCondition.EQUAL]: 'equals',
      [AlarmCondition.NOT_EQUAL]: 'does not equal',
      [AlarmCondition.GREATER_THAN_OR_EQUAL]: 'is greater than or equal to',
      [AlarmCondition.LESS_THAN_OR_EQUAL]: 'is less than or equal to',
      [AlarmCondition.BETWEEN]: 'is between',
      [AlarmCondition.OUTSIDE]: 'is outside range',
    };
    return map[condition] || condition;
  }
}
