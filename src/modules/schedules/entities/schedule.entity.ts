import { Entity, Column, Index } from 'typeorm';
import { BaseEntity } from '../../../common/entities/base.entity';

export enum ScheduleType {
  REPORT = 'report',
  BACKUP = 'backup',
  CLEANUP = 'cleanup',
  EXPORT = 'export',
}

@Entity('schedules')
@Index(['userId', 'enabled'])
export class Schedule extends BaseEntity {
  @Column()
  name: string;

  @Column({ type: 'text', nullable: true })
  description?: string;

  @Column({
    type: 'enum',
    enum: ScheduleType,
  })
  type: ScheduleType;

  @Column()
  schedule: string; // cron expression

  @Column({ default: true })
  enabled: boolean;

  @Column({ type: 'jsonb' })
  configuration: {
    reportType?: string;
    recipients?: string[];
    format?: string;
    retention?: number;
  };

  @Column({ name: 'last_run', type: 'timestamp', nullable: true })
  lastRun?: Date;

  @Column({ name: 'next_run', type: 'timestamp' })
  nextRun: Date;

  @Column({ name: 'execution_count', default: 0 })
  executionCount: number;

  @Column({ name: 'user_id' })
  @Index()
  userId: string;

  @Column({ name: 'tenant_id', nullable: true })
  @Index()
  tenantId?: string;
}
