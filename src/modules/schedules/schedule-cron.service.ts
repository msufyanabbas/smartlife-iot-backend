// src/modules/schedules/schedule-cron.service.ts
import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { CronJob } from 'cron';
import * as cronParser from 'cron-parser';
import { formatInTimeZone } from 'date-fns-tz';

import {
  DEFAULT_SCHEDULE_TIMEZONE,
  Schedule,
} from './entities/schedule.entity';
import { ScheduleExecutorService } from './schedule-executor.service';
import {
  ScheduleTriggerSource,
  ScheduleTriggerType,
} from '@common/enums/index.enum';

/** A registered timer, either a cron job or an interval/one-shot handle. */
type RegisteredJob =
  | { kind: 'cron'; job: CronJob }
  | { kind: 'interval'; handle: NodeJS.Timeout }
  | { kind: 'timeout'; handle: NodeJS.Timeout };

@Injectable()
export class ScheduleCronService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(ScheduleCronService.name);

  /** scheduleId → running timer */
  private readonly jobs = new Map<string, RegisteredJob>();

  /**
   * Schedules currently mid-execution.
   *
   * A schedule whose action outlives its own period (a 90-day telemetry
   * archive on a one-minute cron, say) would otherwise pile runs on top of
   * each other until the connection pool is exhausted. Overlapping ticks are
   * dropped, not queued.
   */
  private readonly running = new Set<string>();

  constructor(
    @InjectRepository(Schedule)
    private readonly scheduleRepository: Repository<Schedule>,
    private readonly executor: ScheduleExecutorService,
  ) {}

  // ══════════════════════════════════════════════════════════════════════════
  // LIFECYCLE
  // ══════════════════════════════════════════════════════════════════════════

  async onModuleInit(): Promise<void> {
    this.logger.log(
      'Initialising schedule runner — loading enabled schedules…',
    );

    const enabled = await this.scheduleRepository.find({
      where: { enabled: true },
    });

    let registered = 0;
    for (const schedule of enabled) {
      if (this.registerJob(schedule)) registered += 1;
    }

    this.logger.log(
      `Schedule runner ready — ${registered}/${enabled.length} enabled schedule(s) registered`,
    );
  }

  onModuleDestroy(): void {
    this.logger.log(`Stopping ${this.jobs.size} schedule timer(s)…`);
    for (const id of [...this.jobs.keys()]) this.unregisterJob(id);
  }

  // ══════════════════════════════════════════════════════════════════════════
  // PUBLIC JOB MANAGEMENT
  // ══════════════════════════════════════════════════════════════════════════

  /**
   * Register (and start) a timer for the schedule. Replaces any existing one.
   * Returns true when a timer is now running for this schedule.
   */
  registerJob(schedule: Schedule): boolean {
    this.unregisterJob(schedule.id);

    if (!schedule.enabled) {
      this.logger.debug(
        `Not registering disabled schedule "${schedule.name}" (${schedule.id})`,
      );
      return false;
    }

    if (schedule.isExpired()) {
      this.logger.log(
        `Not registering "${schedule.name}" (${schedule.id}) — endTime ${schedule.endTime?.toISOString()} has passed`,
      );
      return false;
    }

    try {
      switch (schedule.type) {
        case ScheduleTriggerType.CRON:
          return this.registerCron(schedule);
        case ScheduleTriggerType.INTERVAL:
          return this.registerInterval(schedule);
        case ScheduleTriggerType.ONE_TIME:
          return this.registerOneTime(schedule);
        default:
          this.logger.error(
            `Schedule "${schedule.name}" (${schedule.id}) has unknown type "${schedule.type}" — not registered`,
          );
          return false;
      }
    } catch (err: unknown) {
      this.logger.error(
        `Failed to register schedule "${schedule.name}" (${schedule.id}): ${
          err instanceof Error ? err.message : String(err)
        }`,
        err instanceof Error ? err.stack : undefined,
      );
      return false;
    }
  }

  /** Stop and forget the timer for a schedule. No-op if none is registered. */
  unregisterJob(scheduleId: string): void {
    const existing = this.jobs.get(scheduleId);
    if (!existing) return;

    if (existing.kind === 'cron') existing.job.stop();
    else if (existing.kind === 'interval') clearInterval(existing.handle);
    else clearTimeout(existing.handle);

    this.jobs.delete(scheduleId);
    this.logger.debug(`Unregistered timer for schedule ${scheduleId}`);
  }

  /** Unregister + register, for when timing fields change. */
  rescheduleJob(schedule: Schedule): boolean {
    this.unregisterJob(schedule.id);
    return this.registerJob(schedule);
  }

  /** Diagnostics for `GET /schedules/statistics`. */
  getRegisteredCount(): number {
    return this.jobs.size;
  }

  isRegistered(scheduleId: string): boolean {
    return this.jobs.has(scheduleId);
  }

  // ══════════════════════════════════════════════════════════════════════════
  // REGISTRATION PER TRIGGER TYPE
  // ══════════════════════════════════════════════════════════════════════════

  private registerCron(schedule: Schedule): boolean {
    if (!schedule.cronExpression) {
      this.logger.error(
        `CRON schedule "${schedule.name}" (${schedule.id}) has no cronExpression — not registered`,
      );
      return false;
    }

    const timezone = this.resolveTimezone(schedule);

    // `cron` v4 keeps the positional constructor; the timezone argument is what
    // makes "0 8 * * *" mean 08:00 in Riyadh rather than 08:00 UTC.
    const job = new CronJob(
      schedule.cronExpression,
      () => void this.handleTick(schedule.id),
      null,
      true,
      timezone,
    );

    this.jobs.set(schedule.id, { kind: 'cron', job });
    this.logger.log(
      `Registered CRON "${schedule.name}" (${schedule.id}) — "${schedule.cronExpression}" [${timezone}], next ${this.formatNext(schedule)}`,
    );
    return true;
  }

  private registerInterval(schedule: Schedule): boolean {
    if (!schedule.intervalMs || schedule.intervalMs < 1000) {
      this.logger.error(
        `INTERVAL schedule "${schedule.name}" (${schedule.id}) has invalid intervalMs — not registered`,
      );
      return false;
    }

    // intervalMs is a bigint column; TypeORM hands bigints back as strings.
    const period = Number(schedule.intervalMs);

    if (period > 2_147_483_647) {
      this.logger.error(
        `INTERVAL schedule "${schedule.name}" (${schedule.id}) exceeds the 32-bit timer ceiling (~24.8 days) — use a CRON schedule instead`,
      );
      return false;
    }

    const handle = setInterval(() => void this.handleTick(schedule.id), period);
    this.jobs.set(schedule.id, { kind: 'interval', handle });
    this.logger.log(
      `Registered INTERVAL "${schedule.name}" (${schedule.id}) — every ${period}ms`,
    );
    return true;
  }

  private registerOneTime(schedule: Schedule): boolean {
    if (!schedule.startTime) {
      this.logger.error(
        `ONE_TIME schedule "${schedule.name}" (${schedule.id}) has no startTime — not registered`,
      );
      return false;
    }

    const delay = schedule.startTime.getTime() - Date.now();

    if (delay <= 0) {
      // Fired while the process was down. Running it now would surprise an
      // operator returning from a weekend outage far more than skipping it,
      // so it is left for them to trigger manually.
      this.logger.warn(
        `ONE_TIME schedule "${schedule.name}" (${schedule.id}) was due at ${schedule.startTime.toISOString()} — missed while offline, not run automatically`,
      );
      return false;
    }

    if (delay > 2_147_483_647) {
      // setTimeout overflows past ~24.8 days and would fire immediately.
      // Re-arm in chunks until the real moment arrives.
      const handle = setTimeout(
        () => void this.rearmOneTime(schedule.id),
        2_147_483_647,
      );
      this.jobs.set(schedule.id, { kind: 'timeout', handle });
      this.logger.log(
        `Registered ONE_TIME "${schedule.name}" (${schedule.id}) — due ${schedule.startTime.toISOString()} (long delay, re-arming in stages)`,
      );
      return true;
    }

    const handle = setTimeout(() => void this.handleTick(schedule.id), delay);
    this.jobs.set(schedule.id, { kind: 'timeout', handle });
    this.logger.log(
      `Registered ONE_TIME "${schedule.name}" (${schedule.id}) — due ${schedule.startTime.toISOString()}`,
    );
    return true;
  }

  /** Re-reads the schedule and re-arms a long ONE_TIME timer. */
  private async rearmOneTime(scheduleId: string): Promise<void> {
    const schedule = await this.scheduleRepository.findOne({
      where: { id: scheduleId },
    });
    if (schedule?.enabled) this.registerJob(schedule);
    else this.unregisterJob(scheduleId);
  }

  // ══════════════════════════════════════════════════════════════════════════
  // TICK HANDLER
  // ══════════════════════════════════════════════════════════════════════════

  private async handleTick(scheduleId: string): Promise<void> {
    if (this.running.has(scheduleId)) {
      this.logger.warn(
        `Tick for schedule ${scheduleId} skipped — previous run still in progress`,
      );
      return;
    }

    // Re-read: the schedule may have been disabled, retargeted or deleted
    // since the timer was armed.
    const schedule = await this.scheduleRepository.findOne({
      where: { id: scheduleId },
    });

    if (!schedule) {
      this.logger.warn(
        `Tick fired for schedule ${scheduleId} but it no longer exists — unregistering`,
      );
      this.unregisterJob(scheduleId);
      return;
    }

    if (!schedule.enabled) {
      this.logger.debug(`Tick for "${schedule.name}" skipped — disabled`);
      this.unregisterJob(scheduleId);
      return;
    }

    if (schedule.isPending()) {
      this.logger.debug(
        `Tick for "${schedule.name}" skipped — startTime ${schedule.startTime?.toISOString()} not reached`,
      );
      return;
    }

    if (schedule.isExpired()) {
      this.logger.log(
        `Schedule "${schedule.name}" passed its endTime — disabling and unregistering`,
      );
      await this.scheduleRepository.update(
        { id: scheduleId },
        { enabled: false, nextRunAt: null },
      );
      this.unregisterJob(scheduleId);
      return;
    }

    this.running.add(scheduleId);
    try {
      await this.executor.execute(
        schedule,
        ScheduleTriggerSource.CRON,
        this.calculateNextRun(schedule),
      );

      // A one-shot has now done its one thing.
      if (schedule.type === ScheduleTriggerType.ONE_TIME) {
        await this.scheduleRepository.update(
          { id: scheduleId },
          { enabled: false, nextRunAt: null },
        );
        this.unregisterJob(scheduleId);
        this.logger.log(
          `ONE_TIME schedule "${schedule.name}" completed and disabled`,
        );
      }
    } catch (err: unknown) {
      // execute() already captures action failures; reaching here means the
      // recording itself broke.
      this.logger.error(
        `Unhandled error during tick for "${schedule.name}" (${scheduleId}): ${
          err instanceof Error ? err.message : String(err)
        }`,
        err instanceof Error ? err.stack : undefined,
      );
    } finally {
      this.running.delete(scheduleId);
    }
  }

  // ══════════════════════════════════════════════════════════════════════════
  // NEXT-RUN CALCULATION
  // ══════════════════════════════════════════════════════════════════════════

  /**
   * The instant this schedule should next fire, or null when it never will
   * again (disabled, expired, or a spent ONE_TIME).
   *
   * Returned as a real UTC `Date`. For CRON the expression is evaluated in the
   * schedule's own timezone — `cron-parser` resolves IANA zones through the
   * ICU database, so DST transitions are handled by the library rather than by
   * arithmetic here.
   */
  calculateNextRun(schedule: Schedule, from: Date = new Date()): Date | null {
    if (!schedule.enabled) return null;
    if (schedule.isExpired(from)) return null;

    // A schedule not yet started next runs at its start.
    const basis =
      schedule.startTime && from < schedule.startTime
        ? schedule.startTime
        : from;

    let next: Date | null;

    switch (schedule.type) {
      case ScheduleTriggerType.ONE_TIME:
        // Only in the future; once fired there is no next run.
        next =
          schedule.startTime && schedule.startTime > from
            ? schedule.startTime
            : null;
        break;

      case ScheduleTriggerType.INTERVAL:
        next = schedule.intervalMs
          ? new Date(basis.getTime() + Number(schedule.intervalMs))
          : null;
        break;

      case ScheduleTriggerType.CRON: {
        if (!schedule.cronExpression) return null;
        try {
          next = cronParser
            .parseExpression(schedule.cronExpression, {
              currentDate: basis,
              tz: this.resolveTimezone(schedule),
            })
            .next()
            .toDate();
        } catch (err: unknown) {
          this.logger.warn(
            `Cannot compute next run for "${schedule.name}" (${schedule.id}): ${
              err instanceof Error ? err.message : String(err)
            }`,
          );
          return null;
        }
        break;
      }

      default:
        return null;
    }

    if (next && schedule.endTime && next > schedule.endTime) return null;
    return next;
  }

  /**
   * Validate a timezone. Throws when it is not a zone the ICU database knows.
   *
   * Needed as a separate check because `cron-parser` does NOT reject an
   * unknown `tz` at parse time — `parseExpression('0 8 * * *', {tz:'UTC+3'})`
   * returns happily and only throws later, inside `.next()`. Without this a
   * schedule saved with an offset-style zone was accepted with a 201 and then
   * silently got `nextRunAt = null`, i.e. it never fired and said nothing.
   */
  validateTimezone(timezone: string): void {
    // Throws RangeError on an unknown zone; accepts only IANA names.
    new Intl.DateTimeFormat('en-US', { timeZone: timezone });
  }

  /**
   * Validate a cron expression against a timezone without registering it.
   * Throws with the parser's own message, which names the offending field.
   */
  validateCron(expression: string, timezone: string): void {
    this.validateTimezone(timezone);
    // `.next()` is where the expression and zone are actually exercised —
    // parseExpression alone accepts inputs that blow up on first evaluation.
    cronParser.parseExpression(expression, { tz: timezone }).next();
  }

  /**
   * Falls back to the platform default when a schedule carries an
   * unresolvable zone, rather than refusing to run it. An unknown zone is a
   * data problem; silently never firing would be a worse outcome than firing
   * in Riyadh time and logging loudly.
   */
  private resolveTimezone(schedule: Schedule): string {
    const tz = schedule.timezone || DEFAULT_SCHEDULE_TIMEZONE;
    try {
      this.validateTimezone(tz);
      return tz;
    } catch {
      this.logger.warn(
        `Schedule "${schedule.name}" (${schedule.id}) has unrecognised timezone "${tz}" — ` +
          `falling back to ${DEFAULT_SCHEDULE_TIMEZONE}. Use an IANA zone name, not a UTC offset.`,
      );
      return DEFAULT_SCHEDULE_TIMEZONE;
    }
  }

  /**
   * Next run rendered in the schedule's own timezone alongside UTC — a log
   * line saying only "05:00Z" for a "0 8 * * *" Riyadh schedule reads as a
   * bug to whoever is checking that their 8 AM job is armed.
   */
  private formatNext(schedule: Schedule): string {
    const next = this.calculateNextRun(schedule);
    if (!next) return 'never';

    const tz = this.resolveTimezone(schedule);
    try {
      return `${formatInTimeZone(next, tz, 'yyyy-MM-dd HH:mm:ss')} ${tz} (${next.toISOString()})`;
    } catch {
      return next.toISOString();
    }
  }
}
