// src/modules/schedules/entities/schedule.entity.ts
import { Entity, Column, Index, ManyToOne, JoinColumn } from 'typeorm';
import { BaseEntity } from '@common/entities/base.entity';
import type { Relation } from 'typeorm';
import type { Tenant } from '../../tenants/entities/tenant.entity';
import type { User } from '../../users/entities/user.entity';
import {
  ScheduleTriggerType,
  ScheduleActionType,
  ScheduleExecutionStatus,
} from '@common/enums/index.enum';
import type { ScheduleActionConfig } from '../interfaces/schedule-action.interface';

/** Default timezone for new schedules — Arabia Standard Time (UTC+3). */
export const DEFAULT_SCHEDULE_TIMEZONE = 'Asia/Riyadh';

@Entity('schedules')
@Index(['userId', 'enabled'])
@Index(['tenantId', 'type'])
@Index(['tenantId', 'actionType'])
@Index(['nextRunAt'])
export class Schedule extends BaseEntity {
  // ══════════════════════════════════════════════════════════════════════════
  // TENANT SCOPING (REQUIRED)
  // ══════════════════════════════════════════════════════════════════════════

  @Column()
  tenantId: string;

  @ManyToOne('Tenant')
  @JoinColumn({ name: 'tenantId' })
  tenant: Relation<Tenant>;

  // ══════════════════════════════════════════════════════════════════════════
  // OWNER
  // ══════════════════════════════════════════════════════════════════════════

  @Column()
  userId: string;

  @ManyToOne('User')
  @JoinColumn({ name: 'userId' })
  user: Relation<User>;

  // ══════════════════════════════════════════════════════════════════════════
  // SCHEDULE INFO
  // ══════════════════════════════════════════════════════════════════════════

  @Column()
  name: string;

  @Column({ type: 'text', nullable: true })
  description?: string;

  // ══════════════════════════════════════════════════════════════════════════
  // TIMING
  // ══════════════════════════════════════════════════════════════════════════

  /**
   * CRON | INTERVAL | ONE_TIME.
   *
   * varchar, not a PG enum: the column previously *was* a PG enum holding the
   * old REPORT/BACKUP/… values, and adding a timing mode should not need a
   * schema migration. Same idiom as `DeviceProfile.transportType`.
   */
  @Column({ type: 'varchar' })
  type: ScheduleTriggerType;

  /** Standard 5-field cron expression. Required when `type` is CRON. */
  @Column({ type: 'varchar', nullable: true })
  cronExpression?: string | null;

  /** Fire every N milliseconds. Required when `type` is INTERVAL. */
  @Column({ type: 'bigint', nullable: true })
  intervalMs?: number | null;

  /**
   * ONE_TIME: the single moment the schedule fires.
   * CRON/INTERVAL: the schedule stays dormant until this instant, if set.
   */
  @Column({ type: 'timestamp', nullable: true })
  startTime?: Date | null;

  /** After this instant the schedule stops firing and is auto-disabled. */
  @Column({ type: 'timestamp', nullable: true })
  endTime?: Date | null;

  /**
   * IANA timezone the cron expression is evaluated in — e.g. 'Asia/Riyadh'.
   *
   * Must be an IANA zone name, NOT a UTC offset string like 'UTC+3': both
   * `cron` and `cron-parser` resolve zones through the ICU database and throw
   * on offset notation. 'Asia/Riyadh' is UTC+3 year-round (Saudi Arabia
   * observes no DST), so it is the correct spelling of AST here.
   */
  @Column({ type: 'varchar', default: DEFAULT_SCHEDULE_TIMEZONE })
  timezone: string;

  @Column({ default: true })
  enabled: boolean;

  // ══════════════════════════════════════════════════════════════════════════
  // ACTION — what this schedule does when it fires
  // ══════════════════════════════════════════════════════════════════════════

  @Column({ type: 'varchar' })
  actionType: ScheduleActionType;

  /**
   * Action parameters, keyed by action. Exactly one key is populated and it
   * must correspond to `actionType` — enforced at the DTO layer by
   * `@ValidateScheduleActionConfig` and again at execution time by each
   * handler, since `actionType` can be changed by a PATCH that omits
   * `actionConfig`.
   */
  @Column({ type: 'jsonb' })
  actionConfig: ScheduleActionConfig;

  // ══════════════════════════════════════════════════════════════════════════
  // EXECUTION TRACKING
  // ══════════════════════════════════════════════════════════════════════════

  @Column({ type: 'timestamp', nullable: true })
  lastRunAt?: Date | null;

  /**
   * Nullable: a ONE_TIME schedule that has fired, a disabled schedule, and a
   * schedule past its `endTime` all have no next run. The old column was NOT
   * NULL, which forced a meaningless placeholder date in exactly those cases.
   */
  @Column({ type: 'timestamp', nullable: true })
  nextRunAt?: Date | null;

  @Column({ type: 'varchar', nullable: true })
  lastRunStatus?: ScheduleExecutionStatus | null;

  @Column({ type: 'text', nullable: true })
  lastRunError?: string | null;

  @Column({ type: 'int', default: 0 })
  runCount: number;

  @Column({ type: 'int', default: 0 })
  failCount: number;

  // ══════════════════════════════════════════════════════════════════════════
  // HELPER METHODS
  // ══════════════════════════════════════════════════════════════════════════

  isOverdue(): boolean {
    if (!this.enabled || !this.nextRunAt) return false;
    return new Date() > this.nextRunAt;
  }

  /** True once `endTime` has passed — the runner unregisters such schedules. */
  isExpired(at: Date = new Date()): boolean {
    return Boolean(this.endTime && at > this.endTime);
  }

  /** True while `startTime` is still in the future. */
  isPending(at: Date = new Date()): boolean {
    return Boolean(this.startTime && at < this.startTime);
  }
}
