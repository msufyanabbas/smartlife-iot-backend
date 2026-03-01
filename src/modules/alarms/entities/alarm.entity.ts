// src/modules/alarms/entities/alarm.entity.ts
import { Entity, Column, ManyToOne, JoinColumn, Index } from 'typeorm';
import { BaseEntity } from '@common/entities/base.entity';
import { User, Device, Tenant, Customer } from '@modules/index.entities';
import { AlarmSeverity, AlarmCondition, AlarmStatus } from '@/common/enums/index.enum';
import type { AlarmRule } from '@/common/interfaces/index.interface';
@Entity('alarms')
// ── Composite indexes for tenant-scoped queries ────────────────────────────
@Index(['tenantId', 'status', 'severity'])       // List alarms by status + severity
@Index(['tenantId', 'deviceId', 'status'])       // Device alarms
@Index(['tenantId', 'customerId', 'status'])     // Customer alarms
@Index(['tenantId', 'createdBy'])                // User's alarms
@Index(['status', 'isEnabled', 'triggeredAt'])   // Active alarms processing
export class Alarm extends BaseEntity {
  // ══════════════════════════════════════════════════════════════════════════
  // TENANT SCOPING (REQUIRED)
  // ══════════════════════════════════════════════════════════════════════════
  
  @Column()
  @Index()
  tenantId: string;

  @ManyToOne(() => Tenant)
  @JoinColumn({ name: 'tenantId' })
  tenant: Tenant;

  // ══════════════════════════════════════════════════════════════════════════
  // CUSTOMER SCOPING (OPTIONAL - inherited from device)
  // ══════════════════════════════════════════════════════════════════════════
  
  @Column({ nullable: true })
  @Index()
  customerId?: string;  // Denormalized from device.customerId for fast filtering

  @ManyToOne(() => Customer, { nullable: true })
  @JoinColumn({ name: 'customerId' })
  customer?: Customer;

  // ══════════════════════════════════════════════════════════════════════════
  // ALARM DETAILS
  // ══════════════════════════════════════════════════════════════════════════
  @Column()
  name: string;

  @Column({ type: 'text', nullable: true })
  description?: string;

  @Column({ type: 'enum', enum: AlarmSeverity, default: AlarmSeverity.WARNING })
  severity: AlarmSeverity;

  @Column({ type: 'enum', enum: AlarmStatus, default: AlarmStatus.ACTIVE })
  status: AlarmStatus;

  // ══════════════════════════════════════════════════════════════════════════
  // DEVICE REFERENCE (OPTIONAL - alarms can be device-specific or general)
  // ══════════════════════════════════════════════════════════════════════════

  @Column({ nullable: true })
  @Index()
  deviceId?: string;

  @ManyToOne(() => Device, { nullable: true })
  @JoinColumn({ name: 'deviceId' })
  device?: Device;

  // ══════════════════════════════════════════════════════════════════════════
  // ALARM RULE (What triggers this alarm?)
  // ══════════════════════════════════════════════════════════════════════════

  @Column({ type: 'jsonb' })
  rule: AlarmRule;
  // Example:
  // {
  //   telemetryKey: 'temperature',
  //   condition: AlarmCondition.GREATER_THAN,
  //   value: 30,
  //   duration: 300  // seconds - only trigger if condition persists
  // }

  // ══════════════════════════════════════════════════════════════════════════
  // TRIGGER DATA
  // ══════════════════════════════════════════════════════════════════════════

  @Column({ type: 'decimal', precision: 10, scale: 2, nullable: true })
  currentValue?: number;  // Value that triggered the alarm

  @Column({ type: 'text', nullable: true })
  message?: string;  // Auto-generated or custom message

  @Column({ type: 'timestamp', nullable: true })
  @Index()
  triggeredAt?: Date;  // When alarm first triggered

  @Column({ type: 'timestamp', nullable: true })
  lastTriggeredAt?: Date;  // Most recent trigger

  @Column({ type: 'int', default: 0 })
  triggerCount: number;  // How many times triggered

  // ══════════════════════════════════════════════════════════════════════════
  // LIFECYCLE TRACKING
  // ══════════════════════════════════════════════════════════════════════════

  // Acknowledged (user saw it)
  @Column({ type: 'timestamp', nullable: true })
  acknowledgedAt?: Date;

  @Column({ nullable: true })
  acknowledgedBy?: string;

  @ManyToOne(() => User, { nullable: true })
  @JoinColumn({ name: 'acknowledgedBy' })
  acknowledger?: User;

  // Cleared (condition no longer true)
  @Column({ type: 'timestamp', nullable: true })
  clearedAt?: Date;

  // Resolved (fixed by user)
  @Column({ type: 'timestamp', nullable: true })
  resolvedAt?: Date;

  @Column({ nullable: true })
  resolvedBy?: string;

  @ManyToOne(() => User, { nullable: true })
  @JoinColumn({ name: 'resolvedBy' })
  resolver?: User;

  @Column({ type: 'text', nullable: true })
  resolutionNote?: string;

  // ══════════════════════════════════════════════════════════════════════════
  // CONFIGURATION
  // ══════════════════════════════════════════════════════════════════════════

  @Column({ default: true })
  @Index()
  isEnabled: boolean;  // Can disable without deleting

  @Column({ default: true })
  autoClear: boolean;  // Auto-clear when condition resolves

  // ══════════════════════════════════════════════════════════════════════════
  // NOTIFICATIONS
  // ══════════════════════════════════════════════════════════════════════════
  
  @Column({ type: 'jsonb', nullable: true })
  notifications?: {
    email?: boolean;
    sms?: boolean;
    push?: boolean;
    webhook?: string;
  };

  @Column({ type: 'jsonb', nullable: true })
  recipients?: {
    userIds?: string[];
    emails?: string[];
    phones?: string[];
  };

  // ══════════════════════════════════════════════════════════════════════════
  // METADATA
  // ══════════════════════════════════════════════════════════════════════════

  @Column({ type: 'jsonb', nullable: true })
  metadata?: Record<string, any>;

  @Column({ type: 'jsonb', nullable: true })
  tags?: string[];

  // ══════════════════════════════════════════════════════════════════════════
  // HELPER METHODS
  // ══════════════════════════════════════════════════════════════════════════

  /**
   * Trigger the alarm with a new value
   */
  trigger(value: number, message?: string): void {
    this.status = AlarmStatus.ACTIVE;
    this.currentValue = value;
    this.message = message || this.generateMessage(value);
    this.triggeredAt = this.triggeredAt || new Date(); // Set only on first trigger
    this.lastTriggeredAt = new Date();
    this.triggerCount++;
  }

  /**
   * Acknowledge the alarm (user has seen it)
   */
  acknowledge(userId: string): void {
    if (this.status === AlarmStatus.ACTIVE) {
      this.status = AlarmStatus.ACKNOWLEDGED;
      this.acknowledgedAt = new Date();
      this.acknowledgedBy = userId;
    }
  }

  /**
   * Clear the alarm (condition no longer true)
   */
  clear(): void {
    if (this.status !== AlarmStatus.RESOLVED) {
      this.status = AlarmStatus.CLEARED;
      this.clearedAt = new Date();
    }
  }

  /**
   * Resolve the alarm (user fixed the issue)
   */
  resolve(userId: string, note?: string): void {
    this.status = AlarmStatus.RESOLVED;
    this.resolvedAt = new Date();
    this.resolvedBy = userId;
    this.resolutionNote = note;
  }

  /**
   * Check if alarm is active (not cleared/resolved)
   */
  isActive(): boolean {
    return this.status === AlarmStatus.ACTIVE || this.status === AlarmStatus.ACKNOWLEDGED;
  }

  /**
   * Check if alarm should send notifications
   */
  shouldNotify(): boolean {
    return this.isEnabled && this.isActive();
  }

  /**
   * Generate human-readable alarm message
   */
  private generateMessage(value: number): string {
    const { telemetryKey, condition, value: threshold } = this.rule;
    const conditionText = this.getConditionText(condition);
    return `${telemetryKey} ${conditionText} ${threshold}. Current value: ${value}`;
  }

  /**
   * Get human-readable condition text
   */
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
