// src/modules/schedules/entities/schedule-execution-log.entity.ts
import {
  Entity,
  Column,
  Index,
  ManyToOne,
  JoinColumn,
  CreateDateColumn,
  PrimaryGeneratedColumn,
} from 'typeorm';
import { Schedule } from './schedule.entity';

export enum ExecutionStatus {
  SUCCESS = 'success',
  FAILED = 'failed',
  SKIPPED = 'skipped',
}

export enum TriggerSource {
  CRON = 'cron',
  MANUAL = 'manual',
}

@Entity('schedule_execution_logs')
@Index(['scheduleId', 'startedAt'])
@Index(['tenantId', 'startedAt'])
export class ScheduleExecutionLog {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  // ══════════════════════════════════════════════════════════════════════════
  // RELATIONS
  // ══════════════════════════════════════════════════════════════════════════

  @Column()
  @Index()
  scheduleId: string;

  @ManyToOne(() => Schedule, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'scheduleId' })
  schedule: Schedule;

  @Column()
  tenantId: string;

  // ══════════════════════════════════════════════════════════════════════════
  // STATUS
  // ══════════════════════════════════════════════════════════════════════════

  @Column({ type: 'enum', enum: ExecutionStatus })
  status: ExecutionStatus;

  @Column({ type: 'enum', enum: TriggerSource })
  triggeredBy: TriggerSource;

  // ══════════════════════════════════════════════════════════════════════════
  // TIMING
  // ══════════════════════════════════════════════════════════════════════════

  @CreateDateColumn()
  startedAt: Date;

  @Column({ type: 'timestamp', nullable: true })
  finishedAt?: Date;

  @Column({ type: 'int', nullable: true })
  durationMs?: number;

  // ══════════════════════════════════════════════════════════════════════════
  // PAYLOAD
  // ══════════════════════════════════════════════════════════════════════════

  @Column({ type: 'jsonb', nullable: true })
  output?: Record<string, any>;
}