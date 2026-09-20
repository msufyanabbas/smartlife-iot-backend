import { Entity, Column, Index, ManyToOne, JoinColumn } from 'typeorm';
import { BaseEntity } from '@common/entities/base.entity';
import type { Relation } from 'typeorm';
import type { Tenant } from '../../tenants/entities/tenant.entity';
import type { Customer } from '../../customers/entities/customers.entity';
import type { User } from '../../users/entities/user.entity';
import {
  TriggerType,
  ActionType,
  AutomationStatus,
  AutomationTriggerType,
  AutomationConditionOperator,
  AutomationConditionSource,
  AutomationActionType,
  AutomationExecutionStatus,
} from '@common/enums/index.enum';

// -----------------------------------------------------------------------------
// jsonb shapes
// -----------------------------------------------------------------------------

export interface AutomationTrigger {
  type: AutomationTriggerType | TriggerType;

  // TELEMETRY / ATTRIBUTE / DEVICE_STATUS - narrow which devices are watched.
  // Every filter is optional; omitting all of them watches the whole tenant.
  deviceId?: string;
  deviceType?: string;
  assetId?: string;
  telemetryKey?: string;
  attributeKey?: string;

  // ALARM
  alarmSeverity?: string;
  alarmStatus?: string;

  // DEVICE_STATUS
  targetStatus?: string;

  // SCHEDULE
  cronExpression?: string;

  // -- legacy v1 fields (read-only; normalised into conditions on load) -------
  operator?: string;
  value?: any;
  value2?: any;
  schedule?: string;
  debounce?: number;
}

export interface AutomationCondition {
  key: string;
  operator: AutomationConditionOperator | string;
  value: any;
  /** Upper bound for BETWEEN. */
  value2?: any;
  type?: AutomationConditionSource | string;
  /** How this row combines with the NEXT one. Defaults to AND. */
  logic?: 'AND' | 'OR';
}

export interface AutomationAction {
  type: AutomationActionType | ActionType;
  /** Ascending execution order. Actions without one run last, in input order. */
  order: number;
  /** Seconds to wait before this action runs. */
  delay?: number;
  config: {
    // SEND_NOTIFICATION
    title?: string;
    message?: string;
    /** NotificationChannel values, e.g. ['in_app', 'email']. */
    channels?: string[];
    /** User ids. Defaults to the automation owner when omitted. */
    recipients?: string[];

    // SEND_COMMAND
    command?: Record<string, any>;
    commandType?: string;
    targetDeviceId?: string;

    // UPDATE_ATTRIBUTE
    scope?: string;
    attributes?: Array<{ key: string; value: any }>;

    // CREATE_ALARM / CLEAR_ALARM
    alarmName?: string;
    severity?: string;

    // TRIGGER_RULE_CHAIN
    ruleChainId?: string;

    // WEBHOOK
    url?: string;
    method?: string;
    headers?: Record<string, any>;
    body?: Record<string, any>;

    // UPDATE_DEVICE_STATUS
    status?: string;

    [key: string]: any;
  };
}

/** v1 single-action shape. Retained so pre-engine rows still deserialise. */
export interface LegacyAutomationAction {
  type: ActionType;
  deviceId?: string;
  command?: string;
  value?: any;
  message?: string;
  recipients?: string[];
  webhookUrl?: string;
  webhookMethod?: 'GET' | 'POST' | 'PUT';
  webhookHeaders?: Record<string, string>;
  webhookBody?: Record<string, any>;
}

// -----------------------------------------------------------------------------

@Entity('automations')
@Index(['tenantId', 'enabled'])
@Index(['tenantId', 'status'])
@Index(['tenantId', 'userId'])
export class Automation extends BaseEntity {
  // ==========================================================================
  // TENANT SCOPING (REQUIRED)
  // ==========================================================================

  @Column({ type: 'uuid' })
  tenantId: string;

  @ManyToOne('Tenant')
  @JoinColumn({ name: 'tenantId' })
  tenant: Relation<Tenant>;

  // ==========================================================================
  // CUSTOMER SCOPING (OPTIONAL)
  // ==========================================================================

  @Column({ type: 'uuid', nullable: true })
  customerId?: string;

  @ManyToOne('Customer', { nullable: true })
  @JoinColumn({ name: 'customerId' })
  customer?: Relation<Customer>;

  // ==========================================================================
  // OWNERSHIP - also the default notification recipient and the acting user
  // for actions that need one (device commands, attribute writes).
  // ==========================================================================

  @Column({ type: 'uuid' })
  userId: string;

  @ManyToOne('User')
  @JoinColumn({ name: 'userId' })
  user: Relation<User>;

  // ==========================================================================
  // BASIC INFO
  // ==========================================================================

  @Column({ type: 'varchar' })
  name: string;

  @Column({ type: 'text', nullable: true })
  description?: string | null;

  @Column({ type: 'boolean', default: true })
  enabled: boolean;

  @Column({ type: 'enum', enum: AutomationStatus, default: AutomationStatus.INACTIVE })
  status: AutomationStatus;

  // ==========================================================================
  // TRIGGER - WHEN does this run?
  // ==========================================================================

  @Column({ type: 'jsonb' })
  trigger: AutomationTrigger;
  // TELEMETRY:     { type: 'TELEMETRY', deviceId?, deviceType?, assetId?, telemetryKey? }
  // ATTRIBUTE:     { type: 'ATTRIBUTE', deviceId?, attributeKey? }
  // ALARM:         { type: 'ALARM', alarmSeverity?: 'critical', alarmStatus?: 'active' }
  // DEVICE_STATUS: { type: 'DEVICE_STATUS', deviceId?, targetStatus: 'offline' }
  // SCHEDULE:      { type: 'SCHEDULE', cronExpression: '0 8 * * *' }
  // MANUAL:        { type: 'MANUAL' }  - only runs via POST /automations/:id/execute

  // ==========================================================================
  // CONDITIONS - evaluated left to right; each row's logic joins it to the
  // next. An empty/absent list always passes.
  // ==========================================================================

  @Column({ type: 'jsonb', nullable: true })
  conditions?: AutomationCondition[] | null;

  // ==========================================================================
  // ACTIONS - executed in ascending order, sequentially. One failing action
  // does not abort the rest; the run is then reported as partial.
  // ==========================================================================

  @Column({ type: 'jsonb', default: () => "'[]'::jsonb" })
  actions: AutomationAction[];

  /**
   * v1 single-action column. Nullable since the engine landed; kept only so
   * pre-engine rows survive a round-trip. The AutomationEngine migration
   * backfilled every existing row's actions from it.
   *
   * @deprecated write actions instead.
   */
  @Column({ type: 'jsonb', nullable: true })
  action?: LegacyAutomationAction | null;

  // ==========================================================================
  // EXECUTION STATS (denormalised counters; full history is automation_logs)
  // ==========================================================================

  @Column({ type: 'int', default: 0 })
  executionCount: number;

  @Column({ type: 'int', default: 0 })
  successCount: number;

  @Column({ type: 'int', default: 0 })
  failureCount: number;

  @Column({ type: 'timestamp', nullable: true })
  lastExecutedAt?: Date | null;

  @Column({ type: 'varchar', nullable: true })
  lastExecutionStatus?: AutomationExecutionStatus | null;

  @Column({ type: 'timestamp', nullable: true })
  lastTriggered?: Date | null;

  @Column({ type: 'text', nullable: true })
  lastError?: string | null;

  // ==========================================================================
  // ADVANCED SETTINGS
  // ==========================================================================

  @Column({ type: 'jsonb', nullable: true })
  settings?: {
    /** Seconds to suppress re-execution after a run. */
    cooldown?: number;
    /** Hard cap on runs per calendar day, counted from automation_logs. */
    maxExecutionsPerDay?: number;
    /** Local-time window, inclusive. start > end means an overnight window. */
    activeHours?: { start: string; end: string };
    /** 0 = Sunday ... 6 = Saturday. */
    activeDays?: number[];
    retryOnFailure?: boolean;
    maxRetries?: number;
  } | null;

  // ==========================================================================
  // METADATA
  // ==========================================================================

  @Column({ type: 'jsonb', nullable: true })
  tags?: string[] | null;

  @Column({ type: 'jsonb', nullable: true })
  additionalInfo?: Record<string, any> | null;

  // ==========================================================================
  // HELPER METHODS
  // ==========================================================================

  /**
   * Time/cooldown gate. Deliberately does NOT consider status === ERROR:
   * a transient webhook failure must not disable an automation forever
   * (the v1 engine did exactly that and left rows permanently wedged).
   * maxExecutionsPerDay is enforced in the service, which can count logs.
   */
  canExecute(now: Date = new Date()): boolean {
    if (!this.enabled) return false;

    if (this.settings?.cooldown && this.lastExecutedAt) {
      const elapsed = now.getTime() - new Date(this.lastExecutedAt).getTime();
      if (elapsed < this.settings.cooldown * 1000) return false;
    }

    if (this.settings?.activeHours) {
      const { start, end } = this.settings.activeHours;
      const hh = String(now.getHours()).padStart(2, '0');
      const mm = String(now.getMinutes()).padStart(2, '0');
      const current = hh + ':' + mm;

      // start > end means the window wraps midnight (e.g. 22:00 -> 06:00).
      const inWindow =
        start <= end
          ? current >= start && current <= end
          : current >= start || current <= end;

      if (!inWindow) return false;
    }

    if (this.settings?.activeDays?.length) {
      if (!this.settings.activeDays.includes(now.getDay())) return false;
    }

    return true;
  }

  isActive(): boolean {
    return this.enabled && !this.deletedAt;
  }
}
