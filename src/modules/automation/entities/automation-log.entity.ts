import { Entity, Column, Index, ManyToOne, JoinColumn } from 'typeorm';
import { BaseEntity } from '@common/entities/base.entity';
import type { Relation } from 'typeorm';
import type { Tenant } from '../../tenants/entities/tenant.entity';
import { Automation } from './automation.entity';
import { AutomationExecutionStatus } from '@common/enums/index.enum';

export interface AutomationConditionResult {
  key: string;
  operator: string;
  value: any;
  actualValue: any;
  passed: boolean;
}

export interface AutomationActionResult {
  type: string;
  order: number;
  status: 'success' | 'failed' | 'skipped';
  durationMs: number;
  error?: string;
}

/**
 * One row per execution attempt. This is the audit trail behind
 * GET /automations/:id/logs, and the source of truth for the
 * `maxExecutionsPerDay` cap (the counters on Automation are denormalised
 * and cannot answer "how many times today").
 */
@Entity('automation_logs')
@Index(['tenantId', 'automationId', 'executedAt'])
@Index(['automationId'])
@Index(['tenantId', 'status'])
export class AutomationLog extends BaseEntity {
  @Column({ type: 'uuid' })
  automationId: string;

  // CASCADE: a deleted automation takes its history with it. Automations are
  // soft-deleted, so this only fires on a hard delete.
  @ManyToOne(() => Automation, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'automationId' })
  automation: Relation<Automation>;

  @Column({ type: 'uuid' })
  tenantId: string;

  @ManyToOne('Tenant')
  @JoinColumn({ name: 'tenantId' })
  tenant: Relation<Tenant>;

  @Column({ type: 'varchar' })
  status: AutomationExecutionStatus;

  @Column({ type: 'int', default: 0 })
  durationMs: number;

  /** What set the run off: the telemetry frame, the alarm, the status change. */
  @Column({ type: 'jsonb', nullable: true })
  triggerData?: Record<string, any> | null;

  /** Per-condition outcome, so a non-firing automation can be debugged. */
  @Column({ type: 'jsonb', nullable: true })
  conditionResults?: AutomationConditionResult[] | null;

  @Column({ type: 'jsonb', nullable: true })
  actionResults?: AutomationActionResult[] | null;

  @Column({ type: 'text', nullable: true })
  error?: string | null;

  /** Originating device, when the trigger had one. Not a FK - a device can be
   *  hard-deleted and its execution history should survive. */
  @Column({ type: 'uuid', nullable: true })
  deviceId?: string | null;

  /** How the run was started: 'TELEMETRY' | 'ALARM' | 'MANUAL' | ... */
  @Column({ type: 'varchar', nullable: true })
  triggerType?: string | null;

  /** User id for a manual run; null for engine-driven runs. */
  @Column({ type: 'uuid', nullable: true })
  triggeredBy?: string | null;

  @Column({ type: 'timestamp' })
  executedAt: Date;
}
