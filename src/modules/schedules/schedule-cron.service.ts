// src/modules/schedules/services/schedule-cron.service.ts
import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { CronJob } from 'cron';
import { Schedule } from './entities/schedule.entity';
import { ScheduleExecutorService } from './schedule-executor.service';
import { TriggerSource } from './entities/schedule-execution-log.entity';

@Injectable()
export class ScheduleCronService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(ScheduleCronService.name);

  /** Map of scheduleId → running CronJob */
  private readonly jobs = new Map<string, CronJob>();

  constructor(
    @InjectRepository(Schedule)
    private readonly scheduleRepository: Repository<Schedule>,
    private readonly executor: ScheduleExecutorService,
  ) {}

  // ──────────────────────────────────────────────────────────────────────────
  // LIFECYCLE
  // ──────────────────────────────────────────────────────────────────────────

  async onModuleInit(): Promise<void> {
    this.logger.log('Initialising cron runner — loading enabled schedules…');

    const enabled = await this.scheduleRepository.find({
      where: { enabled: true },
    });

    this.logger.log(`Found ${enabled.length} enabled schedule(s) to register`);

    for (const schedule of enabled) {
      this.registerJob(schedule);
    }
  }

  onModuleDestroy(): void {
    this.logger.log('Stopping all cron jobs…');
    for (const [id, job] of this.jobs.entries()) {
      job.stop();
      this.logger.debug(`Stopped job for schedule ${id}`);
    }
    this.jobs.clear();
  }

  // ──────────────────────────────────────────────────────────────────────────
  // PUBLIC JOB MANAGEMENT API
  // ──────────────────────────────────────────────────────────────────────────

  /**
   * Register (and start) a CronJob for the given schedule.
   * Safe to call even if a job already exists — it will be replaced.
   */
  registerJob(schedule: Schedule): void {
    // Clean up any existing job first
    this.unregisterJob(schedule.id);

    if (!schedule.enabled) {
      this.logger.debug(
        `Skipping job registration for disabled schedule "${schedule.name}" (${schedule.id})`,
      );
      return;
    }

    try {
      const job = new CronJob(
        schedule.schedule,
        () => this.handleTick(schedule.id),
        null,   // onComplete
        true,   // start immediately
        'UTC',  // timeZone
      );

      this.jobs.set(schedule.id, job);

      this.logger.log(
        `Registered cron job for schedule "${schedule.name}" (${schedule.id}) — expression: "${schedule.schedule}"`,
      );
    } catch (err: any) {
      this.logger.error(
        `Failed to register cron job for schedule "${schedule.name}" (${schedule.id}): ${err?.message}`,
        err?.stack,
      );
    }
  }

  /**
   * Stop and remove the CronJob for the given scheduleId.
   * No-op if no job is registered.
   */
  unregisterJob(scheduleId: string): void {
    const existing = this.jobs.get(scheduleId);
    if (existing) {
      existing.stop();
      this.jobs.delete(scheduleId);
      this.logger.debug(`Unregistered cron job for schedule ${scheduleId}`);
    }
  }

  /**
   * Update an existing job with a new schedule entity.
   * Equivalent to unregister + register.
   */
  rescheduleJob(schedule: Schedule): void {
    this.logger.log(
      `Rescheduling job for schedule "${schedule.name}" (${schedule.id})`,
    );
    this.unregisterJob(schedule.id);
    this.registerJob(schedule);
  }

  // ──────────────────────────────────────────────────────────────────────────
  // INTERNAL TICK HANDLER
  // ──────────────────────────────────────────────────────────────────────────

  private async handleTick(scheduleId: string): Promise<void> {
    // Re-fetch from DB to get the latest state (could have been disabled mid-run)
    const schedule = await this.scheduleRepository.findOne({
      where: { id: scheduleId },
    });

    if (!schedule) {
      this.logger.warn(
        `Cron tick fired for scheduleId ${scheduleId} but the entity no longer exists — unregistering`,
      );
      this.unregisterJob(scheduleId);
      return;
    }

    if (!schedule.enabled) {
      this.logger.debug(
        `Cron tick for schedule "${schedule.name}" (${scheduleId}) skipped — disabled`,
      );
      return;
    }

    this.logger.log(
      `Cron tick: executing schedule "${schedule.name}" (${scheduleId})`,
    );

    try {
      const result = await this.executor.execute(schedule, TriggerSource.CRON);

      // Persist the recordExecution() changes made inside the executor
      await this.scheduleRepository.save(schedule);

      if (!result.success) {
        this.logger.warn(
          `Schedule "${schedule.name}" (${scheduleId}) execution failed: ${result.error}`,
        );
      }
    } catch (err: any) {
      this.logger.error(
        `Unhandled error during cron tick for schedule "${schedule.name}" (${scheduleId}): ${err?.message}`,
        err?.stack,
      );
    }
  }
}