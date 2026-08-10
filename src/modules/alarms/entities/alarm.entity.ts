// src/modules/alarms/entities/alarm.entity.ts
import { Entity, Column, ManyToOne, JoinColumn, Index, AfterLoad } from 'typeorm';
import type { Relation } from 'typeorm';
import { BaseEntity } from '@common/entities/base.entity';
import type { User } from '../../users/entities/user.entity';
import type { Device } from '../../devices/entities/device.entity';
import type { Asset } from '../../assets/entities/asset.entity';
import type { Tenant } from '../../tenants/entities/tenant.entity';
import type { Customer } from '../../customers/entities/customers.entity';
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
  tenantId: string;

  @ManyToOne('Tenant')
  @JoinColumn({ name: 'tenantId' })
  tenant: Relation<Tenant>;

  // ══════════════════════════════════════════════════════════════════════════
  // CUSTOMER SCOPING (OPTIONAL - inherited from device)
  // ══════════════════════════════════════════════════════════════════════════

  @Column({ nullable: true })
  customerId?: string;  // Denormalized from device.customerId for fast filtering

  @ManyToOne('Customer', { nullable: true })
  @JoinColumn({ name: 'customerId' })
  customer?: Relation<Customer>;

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

  deviceId?: string;

  @ManyToOne('Device', { nullable: true })
  @JoinColumn({ name: 'deviceId' })
  device?: Relation<Device>;

  // ══════════════════════════════════════════════════════════════════════════
  // ASSET REFERENCE (OPTIONAL - an alarm can be raised on an asset instead of,
  // or alongside, a device — e.g. a building-level rule)
  // ══════════════════════════════════════════════════════════════════════════

  @Column({ type: 'uuid', nullable: true })
  assetId?: string;

  @ManyToOne('Asset', { nullable: true })
  @JoinColumn({ name: 'assetId' })
  asset?: Relation<Asset>;

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
  currentValue?: number | any;  // Value that triggered the alarm

  @Column({ type: 'text', nullable: true })
  message?: string;  // Auto-generated or custom message

  @Column({ type: 'timestamp', nullable: true })

  triggeredAt?: Date;  // When alarm first triggered

  @Column({ type: 'timestamp', nullable: true })
  lastTriggeredAt?: Date;  // Most recent trigger

  @Column({ type: 'int', default: 0 })
  triggerCount: number;  // How many times triggered

  // ══════════════════════════════════════════════════════════════════════════
  // LIFECYCLE TRACKING
  // ══════════════════════════════════════════════════════════════════════════

  // Acknowledged (user saw it)
  // Typed `| null` because clearing a column requires assigning null —
  // TypeORM's save() treats an undefined property as "leave unchanged", so
  // resetting these on re-trigger with undefined would silently no-op.
  @Column({ type: 'timestamp', nullable: true })
  acknowledgedAt?: Date | null;

  @Column({ nullable: true })
  acknowledgedBy?: string | null;

  @ManyToOne('User', { nullable: true })
  @JoinColumn({ name: 'acknowledgedBy' })
  acknowledger?: Relation<User>;

  // Cleared (condition no longer true)
  @Column({ type: 'timestamp', nullable: true })
  clearedAt?: Date | null;

  /**
   * Who cleared it. Null when the clear was automatic (autoClear on the rule
   * engine), which is how ThingsBoard distinguishes an operator clear from a
   * condition-resolved clear.
   */
  @Column({ type: 'uuid', nullable: true })
  clearedBy?: string | null;

  // ══════════════════════════════════════════════════════════════════════════
  // ASSIGNMENT (who is handling this alarm)
  // ══════════════════════════════════════════════════════════════════════════

  @Column({ type: 'uuid', nullable: true })
  assignedTo?: string | null;

  @Column({ type: 'timestamp', nullable: true })
  assignedAt?: Date | null;

  // Resolved (fixed by user)
  @Column({ type: 'timestamp', nullable: true })
  resolvedAt?: Date;

  @Column({ nullable: true })
  resolvedBy?: string;

  @ManyToOne('User', { nullable: true })
  @JoinColumn({ name: 'resolvedBy' })
  resolver?: Relation<User>;

  @Column({ type: 'text', nullable: true })
  resolutionNote?: string;

  // ══════════════════════════════════════════════════════════════════════════
  // CONFIGURATION
  // ══════════════════════════════════════════════════════════════════════════

  @Column({ default: true })

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
  // ESCALATION
  // ══════════════════════════════════════════════════════════════════════════

  /** 0 = not escalated, 1 = first escalation, 2 = second, … */
  @Column({ type: 'int', default: 0 })
  escalationLevel: number;

  /**
   * Typed `| null` for the same reason as acknowledgedAt: save() skips
   * undefined properties, so a re-trigger must write null to actually clear it.
   */
  @Column({ type: 'timestamp', nullable: true })
  escalatedAt: Date | null;

  @Column({ type: 'jsonb', nullable: true })
  escalationHistory: Array<{
    level: number;
    escalatedAt: string;
    channel: string;
    recipient: string;
    message: string;
  }> | null;

  /**
   * Per-alarm override. When null, AlarmEscalationPolicy resolves defaults by
   * severity — see alarm-escalation.policy.ts.
   */
  @Column({ type: 'jsonb', nullable: true })
  escalationRules: Array<{
    level: number;
    afterMinutes: number;
    channels: string[];
    notifyRoles: string[];
    message?: string;
  }> | null;

  // ══════════════════════════════════════════════════════════════════════════
  // METADATA
  // ══════════════════════════════════════════════════════════════════════════

  @Column({ type: 'jsonb', nullable: true })
  metadata?: Record<string, any>;

  /**
   * Free-text operator notes carried on the alarm. Distinct from `message`,
   * which is generated from the rule at trigger time and is overwritten on
   * every re-trigger — `details` is authored by whoever configured the alarm
   * and is never touched by the engine.
   */
  @Column({ type: 'text', nullable: true })
  details?: string;

  @Column({ type: 'jsonb', nullable: true })
  tags?: string[];

  // ══════════════════════════════════════════════════════════════════════════
  // THINGSBOARD-COMPATIBLE COMPOUND STATUS (derived, not stored)
  // ══════════════════════════════════════════════════════════════════════════

  /**
   * ThingsBoard expresses alarm state as a 2×2 matrix of
   * active/cleared × acked/unacked. This platform stores a flat 5-value
   * `status` plus `acknowledgedAt`, which carries strictly more information
   * (it also has INACTIVE for a dormant profile rule and RESOLVED for the
   * operator resolve workflow, neither of which ThingsBoard models).
   *
   * Rather than collapse the stored enum and lose those two states, the
   * ThingsBoard value is computed here and serialised alongside `status`.
   * Populated on load and after every state transition, so it is an own
   * property and survives JSON.stringify (a prototype getter would not).
   *
   * INACTIVE has no ThingsBoard equivalent and is passed through as-is;
   * RESOLVED maps to CLEARED_ACK, since resolving implies both.
   */
  tbStatus: string;

  @AfterLoad()
  computeTbStatus(): void {
    const acked = !!this.acknowledgedAt;

    switch (this.status) {
      case AlarmStatus.INACTIVE:
        this.tbStatus = 'INACTIVE';
        break;
      case AlarmStatus.RESOLVED:
        this.tbStatus = 'CLEARED_ACK';
        break;
      case AlarmStatus.CLEARED:
        this.tbStatus = acked ? 'CLEARED_ACK' : 'CLEARED_UNACK';
        break;
      case AlarmStatus.ACKNOWLEDGED:
        this.tbStatus = 'ACTIVE_ACK';
        break;
      case AlarmStatus.ACTIVE:
      default:
        this.tbStatus = acked ? 'ACTIVE_ACK' : 'ACTIVE_UNACK';
        break;
    }
  }

  // ══════════════════════════════════════════════════════════════════════════
  // HELPER METHODS
  // ══════════════════════════════════════════════════════════════════════════

  /**
   * Trigger the alarm with a new value
   */
  trigger(value: number, message?: string): void {
    this.status = AlarmStatus.ACTIVE;
    this.currentValue = typeof value === 'number' ? value : null;
    this.message = message || this.generateMessage(value);
    this.triggeredAt = this.triggeredAt || new Date(); // Set only on first trigger
    this.lastTriggeredAt = new Date();
    this.triggerCount++;
    // A re-trigger after a clear starts a fresh unacknowledged cycle —
    // otherwise a stale acknowledgedAt would report the new occurrence as
    // ACTIVE_ACK and it would be filtered out of "needs attention" views.
    // null, not undefined: save() skips undefined properties.
    this.acknowledgedAt = null;
    this.acknowledgedBy = null;
    this.clearedAt = null;
    this.clearedBy = null;
    // A fresh occurrence starts at escalation level 0. Without this reset a
    // re-triggered alarm would inherit the previous cycle's level and every
    // rule would be skipped by the `escalationLevel < rule.level` guard, so it
    // would never escalate again. History is preserved deliberately — it is
    // the audit trail across occurrences.
    this.escalationLevel = 0;
    this.escalatedAt = null;
    this.computeTbStatus();
  }

  /**
   * Record an escalation to `level`. Notification dispatch is the consumer's
   * job; this only moves the entity's state forward.
   */
  escalate(
    level: number,
    entry: {
      channel: string;
      recipient: string;
      message: string;
    },
  ): void {
    this.escalationLevel = level;
    this.escalatedAt = new Date();
    this.escalationHistory = [
      ...(this.escalationHistory ?? []),
      { level, escalatedAt: new Date().toISOString(), ...entry },
    ];
  }

  /**
   * Acknowledge the alarm (user has seen it).
   *
   * Acknowledging a CLEARED alarm is allowed and leaves it cleared — that is
   * the ThingsBoard CLEARED_UNACK → CLEARED_ACK transition. Only the stored
   * `status` stays put; the acknowledgement is recorded on the timestamp
   * columns, which is what tbStatus reads.
   */
  acknowledge(userId: string): void {
    if (this.status === AlarmStatus.ACTIVE) {
      this.status = AlarmStatus.ACKNOWLEDGED;
    }
    this.acknowledgedAt = new Date();
    this.acknowledgedBy = userId;
    this.computeTbStatus();
  }

  /**
   * Clear the alarm (condition no longer true).
   *
   * @param userId operator who cleared it; omit for an automatic clear.
   */
  clear(userId?: string): void {
    if (this.status !== AlarmStatus.RESOLVED) {
      this.status = AlarmStatus.CLEARED;
      this.clearedAt = new Date();
      this.clearedBy = userId;
    }
    this.computeTbStatus();
  }

  /**
   * Resolve the alarm (user fixed the issue)
   */
  resolve(userId: string, note?: string): void {
    this.status = AlarmStatus.RESOLVED;
    this.resolvedAt = new Date();
    this.resolvedBy = userId;
    this.resolutionNote = note;
    this.computeTbStatus();
  }

  /**
   * Assign the alarm to a user for handling. Pass null to unassign.
   *
   * Unassigning writes null rather than undefined — save() ignores undefined
   * properties, so undefined would leave the previous assignee in place.
   */
  assign(userId: string | null): void {
    this.assignedTo = userId;
    this.assignedAt = userId ? new Date() : null;
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
 private generateMessage(value: any): string {
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
    [AlarmCondition.CONTAINS]: 'contains',         // ← add
    [AlarmCondition.NOT_CONTAINS]: 'does not contain', // ← add
    [AlarmCondition.EXISTS]: 'exists',              // ← add
  };
  return map[condition] || condition;
}
}
