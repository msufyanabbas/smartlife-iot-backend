import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { InjectQueue } from '@nestjs/bull';
// Type-only import, for the same isolatedModules/emitDecoratorMetadata reason
// documented in alarms.consumer.ts: the DI token comes from @InjectQueue, so
// `Queue` must not survive into the emitted `design:paramtypes`.
import type { Queue } from 'bull';
import { TelemetryRollupService } from './telemetry-rollup.service';
import { TelemetryRetentionService } from './telemetry-retention.service';

export const TELEMETRY_JOB = {
  AGGREGATE: 'aggregate-telemetry',
  CLEANUP: 'cleanup-telemetry',
  STATISTICS: 'calculate-statistics',
} as const;

export interface AggregateJobData {
  tenantId: string;
}
export interface CleanupJobData {
  tenantId: string;
}
export interface StatisticsJobData {
  tenantId: string;
}

/**
 * The producer for the `telemetry` Bull queue.
 *
 * Before this existed, `TelemetryProcessor` carried `@Process` handlers for
 * `aggregate-telemetry`, `cleanup-telemetry` and `calculate-statistics` and
 * **nothing enqueued any of them** — the only trace of a producer was a
 * commented-out `await this.telemetryQueue.add('process-telemetry', record)` in
 * the note where a broken `batchProcess` had been removed. Three handlers, zero
 * callers, and `TelemetryService.deleteOldData(daysToKeep = 90)` with no caller
 * and no cron either, which is why the telemetry table grows for ever.
 *
 * ── Cron or event, per job ──────────────────────────────────────────────────
 *
 * **`aggregate-telemetry` → cron (every 15 minutes).** A rollup summarises a
 * closed time window, and no event means "that hour is now complete" — only the
 * clock does. Enqueuing per telemetry frame instead would mean one job per
 * reading (a 100-device tenant reporting each minute is ~144k jobs a day, i.e.
 * the queue becomes a second, worse copy of the telemetry table) and would
 * recompute the same bucket thousands of times before it closed. Fifteen
 * minutes rather than one: nothing downstream reads a bucket until it closes,
 * so a tighter tick buys nothing and multiplies the per-tenant query count by
 * fifteen.
 *
 * **`cleanup-telemetry` → cron (daily, 03:20).** Retention is calendar-driven
 * by definition: a row becomes expired because time passed, not because
 * anything happened. Daily matches `IntegrationEventsService.prune()`, offset
 * 20 minutes from its 03:00 so the two destructive sweeps do not contend for
 * the same I/O.
 *
 * **`calculate-statistics` → cron (daily, 03:40), after the sweep.** Week and
 * month rollups are re-aggregated from the day rollups, so the natural trigger
 * is "a day has closed". It is deliberately *not* hung off the
 * `telemetry.aggregated` event: that event fires every 15 minutes per active
 * tenant, and recomputing monthly statistics 96 times a day per tenant to
 * produce the same number is work for nothing. Running it after retention also
 * means the statistics reflect what survived the sweep.
 *
 * ── Why a queue at all, rather than doing the work in the cron body ────────
 * `IntegrationEventsService.prune()` and `DevicesService.checkOfflineDevices()`
 * both do their work inline, and that is right for them — they are one bounded
 * statement each. These jobs are not: a first retention sweep can delete a
 * million rows and a backfill can roll up a week of history. Handing them to
 * Bull gets three things inline work cannot: the scheduler's timer is not
 * blocked for minutes, a failure retries with backoff instead of being lost
 * until tomorrow, and — because every application instance runs its own
 * `@Cron` — a deterministic `jobId` collapses N instances' ticks into one
 * actual run.
 */
@Injectable()
export class TelemetryMaintenanceService {
  private readonly logger = new Logger(TelemetryMaintenanceService.name);

  /**
   * If this many jobs are already waiting or active, a tick enqueues nothing.
   *
   * Without it, a queue that has stalled (no consumer, Redis slow, a tenant
   * whose sweep keeps hitting the batch cap) grows by one job per tenant every
   * fifteen minutes for ever. Skipping a tick costs nothing: the next one
   * recomputes the window from the watermark, so no work is lost — only
   * deferred.
   */
  private static readonly BACKPRESSURE_LIMIT = 1000;

  constructor(
    @InjectQueue('telemetry')
    private readonly telemetryQueue: Queue,
    private readonly rollupService: TelemetryRollupService,
    private readonly retentionService: TelemetryRetentionService,
  ) {}

  // ════════════════════════════════════════════════════════════════════════
  // CRONS
  // ════════════════════════════════════════════════════════════════════════

  /**
   * Enqueue a rollup build for every tenant with recent telemetry.
   *
   * Tenant discovery is the guard rail that matters here: a cron that walked
   * every tenant every tick would do almost all of its work on tenants that
   * sent nothing. `activeTenantIds()` is one indexed range scan and returns
   * only tenants that have written inside the lookback window, so an idle
   * tenant costs zero jobs and zero queries until it reports again.
   */
  @Cron('0 */15 * * * *', { name: 'telemetry-aggregate' })
  async enqueueAggregation(): Promise<void> {
    await this.guard('aggregation', async () => {
      if (!this.rollupService.settings.rollupEnabled) {
        this.logger.debug('Rollups disabled (TELEMETRY_ROLLUP_ENABLED=false)');
        return;
      }
      if (await this.underBackpressure()) return;

      const tenantIds = await this.rollupService.activeTenantIds();
      if (tenantIds.length === 0) {
        this.logger.debug('No tenant has telemetry in the lookback window');
        return;
      }

      // 15-minute slot, so two instances ticking at 10:00:00 and 10:00:04
      // produce the same job id and Bull keeps one.
      const slot = Math.floor(Date.now() / (15 * 60 * 1000));
      let queued = 0;
      for (const tenantId of tenantIds) {
        queued += (await this.enqueue(
          TELEMETRY_JOB.AGGREGATE,
          { tenantId },
          `agg:${tenantId}:${slot}`,
        ))
          ? 1
          : 0;
      }
      this.logger.log(
        `Queued ${queued}/${tenantIds.length} telemetry rollup job(s)`,
      );
    });
  }

  /**
   * Enqueue the retention sweep. Daily, 03:20 — see the class comment for the
   * offset from `IntegrationEventsService.prune()`.
   */
  @Cron('0 20 3 * * *', { name: 'telemetry-retention' })
  async enqueueCleanup(): Promise<void> {
    await this.guard('retention', async () => {
      if (!this.retentionService.settings.retentionEnabled) {
        this.logger.warn(
          'Telemetry retention sweep is disabled (TELEMETRY_RETENTION_ENABLED=false) — the telemetry table will grow without bound',
        );
        return;
      }
      if (await this.underBackpressure()) return;

      const tenantIds = await this.retentionService.candidateTenantIds();
      const day = this.dayStamp();
      let queued = 0;
      for (const tenantId of tenantIds) {
        queued += (await this.enqueue(
          TELEMETRY_JOB.CLEANUP,
          { tenantId },
          `retention:${tenantId}:${day}`,
        ))
          ? 1
          : 0;
      }
      this.logger.log(
        `Queued ${queued}/${tenantIds.length} telemetry retention sweep(s)`,
      );
    });
  }

  /** Enqueue the week/month statistics rebuild. Daily, 03:40 — after the sweep. */
  @Cron('0 40 3 * * *', { name: 'telemetry-statistics' })
  async enqueueStatistics(): Promise<void> {
    await this.guard('statistics', async () => {
      if (!this.rollupService.settings.rollupEnabled) return;
      if (await this.underBackpressure()) return;

      // Statistics are derived from day rollups, which exist only for tenants
      // that have been aggregated — so the same discovery query applies, with a
      // wider lookback so a tenant that went quiet yesterday still gets its
      // last week and month closed out.
      const tenantIds = await this.rollupService.activeTenantIds(24 * 8);
      const day = this.dayStamp();
      let queued = 0;
      for (const tenantId of tenantIds) {
        queued += (await this.enqueue(
          TELEMETRY_JOB.STATISTICS,
          { tenantId },
          `stats:${tenantId}:${day}`,
        ))
          ? 1
          : 0;
      }
      this.logger.log(
        `Queued ${queued}/${tenantIds.length} telemetry statistics job(s)`,
      );
    });
  }

  // ════════════════════════════════════════════════════════════════════════
  // HELPERS
  // ════════════════════════════════════════════════════════════════════════

  /**
   * A `@Cron` body must never reject: an unhandled rejection out of the
   * scheduler is logged by Nest and then nothing reschedules the work, and in
   * older Node it takes the process down. Every producer runs inside this.
   */
  private async guard(label: string, work: () => Promise<void>): Promise<void> {
    try {
      await work();
    } catch (error) {
      this.logger.error(
        `Telemetry ${label} producer failed: ${(error as Error).message}`,
      );
    }
  }

  /**
   * `add()` with a deterministic id. Returns false when Bull dropped the add
   * because that id already exists — which is the multi-instance duplicate
   * being collapsed, not an error.
   *
   * `removeOnComplete: 50` rather than `true` on purpose: a completed job keeps
   * its id while it is retained, so a second instance whose clock is a few
   * seconds behind still finds the id taken and does not re-run the work.
   */
  private async enqueue(
    name: string,
    data: Record<string, unknown>,
    jobId: string,
  ): Promise<boolean> {
    try {
      const job = await this.telemetryQueue.add(name, data, {
        jobId,
        attempts: 3,
        backoff: { type: 'exponential', delay: 60_000 },
        removeOnComplete: 50,
        removeOnFail: 100,
      });
      return Boolean(job?.id);
    } catch (error) {
      this.logger.warn(
        `Could not enqueue ${name} (${jobId}): ${(error as Error).message}`,
      );
      return false;
    }
  }

  private async underBackpressure(): Promise<boolean> {
    try {
      const [waiting, active] = await Promise.all([
        this.telemetryQueue.getWaitingCount(),
        this.telemetryQueue.getActiveCount(),
      ]);
      const pending = waiting + active;
      if (pending >= TelemetryMaintenanceService.BACKPRESSURE_LIMIT) {
        this.logger.warn(
          `Skipping tick: ${pending} telemetry job(s) already pending ` +
            `(limit ${TelemetryMaintenanceService.BACKPRESSURE_LIMIT})`,
        );
        return true;
      }
      return false;
    } catch (error) {
      // Redis unreachable. Let the tick proceed — enqueue() will fail and warn
      // per job, which is more informative than a silent skip.
      this.logger.debug(
        `Backpressure check unavailable: ${(error as Error).message}`,
      );
      return false;
    }
  }

  /** UTC day stamp, so instances in different zones agree on the job id. */
  private dayStamp(): string {
    return new Date().toISOString().slice(0, 10);
  }
}
