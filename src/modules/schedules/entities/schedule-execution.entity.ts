// src/modules/schedules/entities/schedule-execution.entity.ts
import { Entity, Column, Index, ManyToOne, JoinColumn } from 'typeorm';
import type { Relation } from 'typeorm';
import { BaseEntity } from '@common/entities/base.entity';
import type { Schedule } from './schedule.entity';
import {
  ScheduleExecutionStatus,
  ScheduleTriggerSource,
} from '@common/enums/index.enum';

/**
 * One row per schedule run.
 *
 * Replaces the previous `schedule_execution_logs` table, which the migration
 * drops. That table was written but never read by anything other than the
 * schedule history endpoint, and held zero rows in every environment checked.
 */
@Entity('schedule_executions')
@Index(['scheduleId', 'executedAt'])
@Index(['tenantId', 'executedAt'])
@Index(['scheduleId', 'status'])
export class ScheduleExecution extends BaseEntity {
  @Column({ type: 'uuid' })
  @Index()
  scheduleId: string;

  @ManyToOne('Schedule', { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'scheduleId' })
  schedule: Relation<Schedule>;

  @Column({ type: 'uuid' })
  tenantId: string;

  @Column({ type: 'varchar' })
  status: ScheduleExecutionStatus;

  /** Timer tick vs. operator pressing "run now". */
  @Column({ type: 'varchar', default: ScheduleTriggerSource.CRON })
  triggeredBy: ScheduleTriggerSource;

  @Column({ type: 'timestamp' })
  executedAt: Date;

  @Column({ type: 'int', nullable: true })
  durationMs: number | null;

  /** JSON-serialised action result. Text, not jsonb — payloads can be large. */
  @Column({ type: 'text', nullable: true })
  result: string | null;

  @Column({ type: 'text', nullable: true })
  error: string | null;

  /** Structured counters, e.g. `{ devicesAffected: 5, commandsSent: 5 }`. */
  @Column({ type: 'jsonb', nullable: true })
  metadata: Record<string, any> | null;
}
