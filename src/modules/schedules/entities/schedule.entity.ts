// src/modules/schedules/entities/schedule.entity.ts
import { Entity, Column, Index, ManyToOne, JoinColumn } from 'typeorm';
import { BaseEntity } from '@common/entities/base.entity';
import { Tenant, User } from '@modules/index.entities';
import { ScheduleType } from '@common/enums/index.enum';

@Entity('schedules')
@Index(['userId', 'enabled'])
@Index(['tenantId', 'type'])
@Index(['nextRun'])
export class Schedule extends BaseEntity {
  // ══════════════════════════════════════════════════════════════════════════
  // TENANT SCOPING (REQUIRED)
  // ══════════════════════════════════════════════════════════════════════════

  @Column()

  tenantId: string;

  @ManyToOne(() => Tenant)
  @JoinColumn({ name: 'tenantId' })
  tenant: Tenant;

  // ══════════════════════════════════════════════════════════════════════════
  // OWNER
  // ══════════════════════════════════════════════════════════════════════════

  @Column()

  userId: string;

  @ManyToOne(() => User)
  @JoinColumn({ name: 'userId' })
  user: User;

  // ══════════════════════════════════════════════════════════════════════════
  // SCHEDULE INFO
  // ══════════════════════════════════════════════════════════════════════════

  @Column()
  name: string;

  @Column({ type: 'text', nullable: true })
  description?: string;

  @Column({
    type: 'enum',
    enum: ScheduleType,
  })

  type: ScheduleType;

  // ══════════════════════════════════════════════════════════════════════════
  // CRON CONFIGURATION
  // ══════════════════════════════════════════════════════════════════════════

  @Column()
  schedule: string;  // cron expression (e.g., '0 0 * * *')

  @Column({ default: true })

  enabled: boolean;

  // ══════════════════════════════════════════════════════════════════════════
  // TASK CONFIGURATION
  // ══════════════════════════════════════════════════════════════════════════

  @Column({ type: 'jsonb' })
  configuration: {
    reportType?: string;
    recipients?: string[];
    format?: string;
    retention?: number;
    [key: string]: any;
  };

  // ══════════════════════════════════════════════════════════════════════════
  // EXECUTION TRACKING
  // ══════════════════════════════════════════════════════════════════════════

  @Column({ type: 'timestamp', nullable: true })
  lastRun?: Date;

  @Column({ type: 'timestamp' })

  nextRun: Date;

  @Column({ default: 0 })
  executionCount: number;

  @Column({ default: 0 })
  failureCount: number;

  @Column({ type: 'text', nullable: true })
  lastError?: string;

  // ══════════════════════════════════════════════════════════════════════════
  // HELPER METHODS
  // ══════════════════════════════════════════════════════════════════════════

  isOverdue(): boolean {
    if (!this.enabled) return false;
    return new Date() > this.nextRun;
  }

  recordExecution(success: boolean, error?: string): void {
    this.lastRun = new Date();
    this.executionCount += 1;

    if (!success) {
      this.failureCount += 1;
      this.lastError = error;
    } else {
      this.lastError = undefined;
    }
  }
}
