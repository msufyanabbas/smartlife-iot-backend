import { Processor, Process } from '@nestjs/bull';
import { Logger } from '@nestjs/common';
import type { Job } from 'bull';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { AlarmsService } from '../../alarms/alarms.service';
import { TelemetryRollupService } from '../telemetry-rollup.service';
import { TelemetryRetentionService } from '../telemetry-retention.service';
import type {
  AggregateJobData,
  CleanupJobData,
  StatisticsJobData,
} from '../telemetry-maintenance.service';

// The `telemetry` queue IS registered — `BullModule.registerQueue({ name:
// 'telemetry' })` is in TelemetryModule's imports, so this processor is live
// and a @Processor with no registered queue would have thrown at startup.
// What was missing was a PRODUCER: nothing ever called
// `telemetryQueue.add(...)` for any of the three maintenance jobs below, so
// the handlers were unreachable code. `TelemetryMaintenanceService` is that
// producer.

/**
 * Consumer for the `telemetry` queue.
 *
 * ── Overlap safety ─────────────────────────────────────────────────────────
 * Three layers, because each catches a different race:
 *
 *  1. `TelemetryMaintenanceService` adds every job under a deterministic,
 *     tick-bucketed `jobId`, so N application instances ticking at once
 *     produce one job.
 *  2. `running` below rejects a second job for the same (job, tenant) while the
 *     first is still in flight inside THIS process — which is what happens when
 *     a job runs longer than its cron interval and Bull's concurrency lets the
 *     next one start.
 *  3. The work itself is idempotent and re-entrant: the rollup upsert
 *     recomputes a bucket from scratch (`ON CONFLICT DO UPDATE`, never `+=`),
 *     and the retention sweep deletes a bounded batch under `FOR UPDATE SKIP
 *     LOCKED`. Layer 3 is the one that holds across processes, where an
 *     in-memory set cannot help.
 *
 * ── Throwing ───────────────────────────────────────────────────────────────
 * These handlers let errors escape so Bull retries them with the backoff the
 * producer configured. A retry is safe precisely because of layer 3. The job
 * that must NOT throw is `process-telemetry`'s caller, and that is untouched.
 */
@Processor('telemetry')
export class TelemetryProcessor {
  private readonly logger = new Logger(TelemetryProcessor.name);

  /** In-flight (job name, tenant) pairs — see "Overlap safety", layer 2. */
  private readonly running = new Set<string>();

  constructor(
    private readonly eventEmitter: EventEmitter2,
    private readonly alarmsService: AlarmsService,
    private readonly rollupService: TelemetryRollupService,
    private readonly retentionService: TelemetryRetentionService,
  ) {}

  @Process('process-telemetry')
  async processTelemetry(
    job: Job<{ deviceId: string; data: Record<string, any>; timestamp: Date }>,
  ): Promise<void> {
    const { deviceId, data, timestamp } = job.data;
    this.logger.debug(`Processing telemetry for device ${deviceId}`);

    try {
      for (const [key, value] of Object.entries(data)) {
        if (typeof value === 'number') {
          await this.alarmsService.checkAlarmConditions(deviceId, key, value);
        }
      }

      this.eventEmitter.emit('telemetry.processed', {
        deviceId,
        data,
        timestamp,
      });
    } catch (error) {
      this.logger.error(
        `Failed to process telemetry for device ${deviceId}: ${(error as Error).message}`,
      );
      throw error; // triggers Bull retry
    }
  }

  // ══════════════════════════════════════════════════════════════════════════
  // AGGREGATION — hour and day rollups for one tenant
  // ══════════════════════════════════════════════════════════════════════════

  /**
   * Was: `telemetryRepository.find({ where: { deviceId } })` — every row the
   * device had ever sent, no date filter, into Node memory — then
   * `Math.min(...values)` over the lot, which throws
   * `RangeError: Maximum call stack size exceeded` somewhere north of 100k
   * values. The window it had already computed from `job.data.timestamp` was
   * never applied to the query, and the result was emitted as an event that
   * nothing subscribed to, so neither the cost nor the wrongness was visible.
   *
   * Now it is a single set-based upsert per granularity, bounded by
   * `TELEMETRY_ROLLUP_MAX_BUCKETS`, and the output is rows in
   * `telemetry_rollups` that the `timeseries` / `aggregated` / `statistics`
   * routes actually read.
   */
  @Process('aggregate-telemetry')
  async aggregateTelemetry(job: Job<AggregateJobData>): Promise<unknown> {
    const { tenantId } = job.data ?? ({} as AggregateJobData);
    if (!tenantId) {
      // A malformed job must fail loudly once, not retry three times.
      this.logger.warn(`aggregate-telemetry job ${job.id} has no tenantId`);
      return { skipped: 'no tenantId' };
    }

    return this.once(`aggregate:${tenantId}`, async () => {
      const results = await this.rollupService.aggregateTenant(tenantId);
      const built = results.filter((r) => r.rows > 0);

      if (built.length > 0) {
        this.logger.log(
          `Rolled up tenant ${tenantId}: ` +
            built
              .map(
                (r) => `${r.granularity}=${r.rows} rows [${r.from} → ${r.to})`,
              )
              .join(', '),
        );
      }

      this.eventEmitter.emit('telemetry.aggregated', { tenantId, results });
      return { tenantId, results };
    });
  }

  // ══════════════════════════════════════════════════════════════════════════
  // RETENTION — the bounded, config-driven sweep
  // ══════════════════════════════════════════════════════════════════════════

  /**
   * Was: one unbounded `DELETE FROM telemetry WHERE timestamp < cutoff` with
   * `daysOld` taken straight from the job payload — no tenant scope, so a
   * single job deleted every tenant's data to one tenant's (or nobody's)
   * retention, and no floor, so `{daysOld: 0}` meant "delete the table".
   *
   * Now the days come from `Subscription.limits.dataRetentionDays`, a tenant
   * whose retention is unset or zero is skipped, and the delete is batched.
   */
  @Process('cleanup-telemetry')
  async cleanupTelemetry(job: Job<CleanupJobData>): Promise<unknown> {
    const { tenantId } = job.data ?? ({} as CleanupJobData);
    if (!tenantId) {
      this.logger.warn(`cleanup-telemetry job ${job.id} has no tenantId`);
      return { skipped: 'no tenantId' };
    }

    return this.once(`cleanup:${tenantId}`, async () => {
      const result = await this.retentionService.sweepTenant(tenantId);
      this.eventEmitter.emit('telemetry.cleaned', result);
      return result;
    });
  }

  // ══════════════════════════════════════════════════════════════════════════
  // STATISTICS — week and month rollups, re-aggregated from the day rollups
  // ══════════════════════════════════════════════════════════════════════════

  /**
   * Was: the same unfiltered `find({ where: { deviceId } })` as the aggregate
   * handler, computing a period range it then ignored, and emitting the result
   * to nobody.
   *
   * "Statistics" is now the coarse end of the same rollup table: `week` and
   * `month` buckets, built from the `day` rows rather than from raw telemetry
   * (by the time a month is worth summarising its raw rows may be past
   * retention). `GET …/aggregated?interval=month`, `GET …/statistics` over a
   * long range, and `GET /telemetry/maintenance/status` all read them.
   */
  @Process('calculate-statistics')
  async calculateStatistics(job: Job<StatisticsJobData>): Promise<unknown> {
    const { tenantId } = job.data ?? ({} as StatisticsJobData);
    if (!tenantId) {
      this.logger.warn(`calculate-statistics job ${job.id} has no tenantId`);
      return { skipped: 'no tenantId' };
    }

    return this.once(`statistics:${tenantId}`, async () => {
      const results = await this.rollupService.computeStatistics(tenantId);
      const built = results.filter((r) => r.rows > 0);

      if (built.length > 0) {
        this.logger.log(
          `Statistics for tenant ${tenantId}: ` +
            built.map((r) => `${r.granularity}=${r.rows} rows`).join(', '),
        );
      }

      this.eventEmitter.emit('telemetry.statistics', { tenantId, results });
      return { tenantId, results };
    });
  }

  // ══════════════════════════════════════════════════════════════════════════
  // HELPERS
  // ══════════════════════════════════════════════════════════════════════════

  /**
   * Run `work` unless the same key is already running in this process.
   *
   * The second caller returns immediately with `{ skipped: 'already running' }`
   * rather than throwing: an overlapping tick is an expected condition on a
   * slow tenant, not a failure, and throwing would burn Bull retries and fill
   * the failed set with noise.
   */
  private async once<T>(
    key: string,
    work: () => Promise<T>,
  ): Promise<T | { skipped: string }> {
    if (this.running.has(key)) {
      this.logger.warn(`Skipping ${key}: previous run still in progress`);
      return { skipped: 'already running' };
    }
    this.running.add(key);
    try {
      return await work();
    } finally {
      // finally, not after the await: a throwing job must release the lock or
      // the tenant is never processed again until the process restarts.
      this.running.delete(key);
    }
  }
}
