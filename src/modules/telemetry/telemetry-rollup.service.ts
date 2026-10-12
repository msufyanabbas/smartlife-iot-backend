import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import {
  TelemetryRollup,
  TelemetryRollupGranularity,
} from './entities/telemetry-rollup.entity';
import {
  resolveTelemetryMaintenanceConfig,
  TelemetryMaintenanceConfig,
} from './telemetry-maintenance.config';

/** The five columns `telemetry` denormalises out of `data`. */
const DENORMALISED_KEYS = [
  'temperature',
  'humidity',
  'pressure',
  'batteryLevel',
  'signalStrength',
] as const;

export interface RollupBuildResult {
  granularity: TelemetryRollupGranularity;
  /**
   * Inclusive start of the window that was (re)built, as Postgres's own
   * `timestamp` text — see `TIMESTAMP TEXT` on the class.
   */
  from: string | null;
  /** Exclusive end, same representation. */
  to: string | null;
  /** Rollup rows inserted or updated. */
  rows: number;
  /** Why nothing happened, when `rows` is 0 and no window was built. */
  skipped?: string;
}

/**
 * A window boundary: either a real instant (from an HTTP query parameter) or
 * Postgres's own `timestamp without time zone` text, which is passed through
 * untouched.
 */
export type WindowBound = Date | string;

const stamp = (value: WindowBound): string =>
  value instanceof Date ? value.toISOString() : value;

export interface RollupSeriesPoint {
  bucket: Date;
  key: string;
  sampleCount: number;
  rowCount: number;
  min: number | null;
  max: number | null;
  avg: number | null;
  sum: number | null;
  first: number | null;
  last: number | null;
}

/**
 * Builds and reads `telemetry_rollups`.
 *
 * Three things this service is careful about, because all three have bitten
 * other aggregation jobs in this codebase:
 *
 *  1. **Everything is set-based.** The window is turned into rollup rows by a
 *     single `INSERT … SELECT … ON CONFLICT DO UPDATE`. The abandoned
 *     `aggregate-telemetry` processor loaded `telemetryRepository.find({ where:
 *     { deviceId } })` — every row a device had ever sent, with no date filter
 *     at all, into Node memory — and then computed `Math.min(...values)` over
 *     it, which throws `RangeError: Maximum call stack size exceeded` past
 *     ~100k values anyway.
 *
 *  2. **The upsert is idempotent.** A bucket is recomputed from scratch, never
 *     incremented, so re-running a window — because a job retried, because two
 *     instances both ticked, because the watermark re-covers the last bucket —
 *     converges on the same numbers instead of double-counting them.
 *
 *  3. **Bucket boundaries come from Postgres**, via `date_trunc`, not from
 *     Node's `Date`. `telemetry.timestamp` is `timestamp without time zone`;
 *     truncating in Node and truncating in SQL disagree by the server's offset,
 *     which shows up as one duplicated or one missing bucket a day.
 *
 * ── TIMESTAMP TEXT, and why the watermark walk never touches a JS Date ─────
 * `node-postgres` parses a `timestamp without time zone` column into a JS
 * `Date` **in the process's local timezone**. Send that Date back as a
 * parameter — `date.toISOString()` — and it has moved by the offset. On a box
 * running in Asia/Riyadh (UTC+3) this cost exactly three hourly buckets and
 * thirteen hours of the current day's rollup on every run, silently, because
 * the sum of the buckets that *were* built still looked plausible.
 *
 * So every boundary this service computes stays as Postgres's own text
 * (`'2026-10-11 12:00:00'`) from the moment `date_trunc` produces it until it
 * is cast back to `timestamp` in the next statement. Only boundaries that enter
 * from outside — an HTTP `startDate`, which is a real instant — arrive as a
 * `Date`, and those are converted exactly as the pre-existing raw queries in
 * `TelemetryService` already do, so a rollup-backed read and a raw read filter
 * identically.
 */
@Injectable()
export class TelemetryRollupService {
  private readonly logger = new Logger(TelemetryRollupService.name);
  private readonly config: TelemetryMaintenanceConfig;

  constructor(
    @InjectRepository(TelemetryRollup)
    private readonly rollupRepository: Repository<TelemetryRollup>,
    configService: ConfigService,
  ) {
    this.config = resolveTelemetryMaintenanceConfig((key) =>
      configService.get(key),
    );
  }

  get settings(): TelemetryMaintenanceConfig {
    return this.config;
  }

  // ════════════════════════════════════════════════════════════════════════
  // TENANT DISCOVERY
  // ════════════════════════════════════════════════════════════════════════

  /**
   * Tenants that have written telemetry recently enough to be worth
   * aggregating.
   *
   * This is the answer to "idle tenants must not be swept into a cron that
   * scans every tenant every minute". The alternative — enumerate every tenant
   * and run a window query per tenant — is O(tenants) queries per tick for a
   * platform where most tenants send nothing most of the time. Here one
   * indexed range scan on `IDX(timestamp)` returns only the tenants with
   * anything new, and a tenant that has gone quiet drops out of the cron
   * entirely until it sends again.
   */
  async activeTenantIds(
    lookbackHours = this.config.rollupActiveLookbackHours,
  ): Promise<string[]> {
    const rows: Array<{ tenantId: string }> = await this.rollupRepository.query(
      `SELECT DISTINCT t."tenantId"
         FROM telemetry t
        WHERE t."timestamp" >= now()::timestamp - ($1 || ' hours')::interval`,
      [String(lookbackHours)],
    );
    return rows.map((r) => r.tenantId).filter(Boolean);
  }

  // ════════════════════════════════════════════════════════════════════════
  // WINDOW RESOLUTION
  // ════════════════════════════════════════════════════════════════════════

  /**
   * Newest bucket already rolled up for this tenant at this granularity, as
   * Postgres text. Deliberately NOT a `Date` — see `TIMESTAMP TEXT` above.
   */
  async watermark(
    tenantId: string,
    granularity: TelemetryRollupGranularity,
  ): Promise<string | null> {
    const [row] = await this.rollupRepository.query(
      `SELECT max("bucket")::text AS watermark
         FROM telemetry_rollups
        WHERE "tenantId" = $1 AND "granularity" = $2`,
      [tenantId, granularity],
    );
    return row?.watermark ?? null;
  }

  /**
   * `[from, to)` for the next build, resolved entirely in SQL.
   *
   * `to` is the start of the *current* bucket, so the bucket still being
   * written to is never rolled up — a half-finished hour stored as a rollup
   * would be served to a chart as if it were complete, and (because `from`
   * starts at the watermark) would then never be corrected.
   *
   * `from` is the watermark itself rather than the bucket after it: the
   * watermark bucket was the newest complete bucket last time, but a device
   * backfilling a late reading can add rows to it, and recomputing one bucket
   * is nearly free while missing those readings is permanent.
   */
  private async resolveWindow(
    tenantId: string,
    granularity: TelemetryRollupGranularity,
  ): Promise<{ from: string; to: string } | null> {
    const watermark = await this.watermark(tenantId, granularity);

    // Both boundaries come back as `::text` and the "is there anything to do"
    // comparison is made by Postgres, so no boundary is ever round-tripped
    // through a JS Date — see `TIMESTAMP TEXT` on the class.
    const [row] = await this.rollupRepository.query(
      `WITH bounds AS (
         SELECT
           date_trunc($1, now()::timestamp) AS current_bucket,
           COALESCE(
             $2::timestamp,
             date_trunc($1, now()::timestamp - ($3 || ' days')::interval)
           ) AS window_from
       ),
       resolved AS (
         SELECT
           window_from,
           LEAST(
             current_bucket,
             window_from + ($4 || ' ' || $1)::interval
           ) AS window_to
         FROM bounds
       )
       SELECT window_from::text AS window_from,
              window_to::text   AS window_to,
              (window_from < window_to) AS has_work
         FROM resolved`,
      [
        granularity,
        watermark,
        String(this.config.rollupBackfillDays),
        String(this.config.rollupMaxBuckets),
      ],
    );

    // Nothing has closed since the last run.
    if (!row?.has_work) return null;
    return { from: row.window_from, to: row.window_to };
  }

  // ════════════════════════════════════════════════════════════════════════
  // BUILD: hour / day, straight from telemetry
  // ════════════════════════════════════════════════════════════════════════

  /**
   * Roll up `[from, to)` of this tenant's raw telemetry at `granularity`.
   *
   * The key expansion is the interesting half. Each telemetry row becomes one
   * `(key, value)` pair per numeric thing it carries:
   *   - the five denormalised columns, under their canonical names, skipped
   *     when NULL;
   *   - plus every `data` entry whose `jsonb_typeof` is `number`, excluding
   *     those same five names so a row that has both does not count twice.
   *
   * `jsonb_typeof(…) = 'number'` rather than a cast with a regex guard: a cast
   * of `"25.5"` (a string in the payload, which several codecs emit) would
   * succeed and quietly mix string-typed and number-typed readings into one
   * series, while a cast of `"ok"` would abort the whole statement.
   */
  async buildFromTelemetry(
    tenantId: string,
    granularity: 'hour' | 'day',
    from: WindowBound,
    to: WindowBound,
  ): Promise<number> {
    const denormalisedList = DENORMALISED_KEYS.map((k) => `'${k}'`).join(', ');

    const result = await this.rollupRepository.query(
      `WITH src AS (
         SELECT t.id, t."tenantId", t."deviceId", t."deviceKey", t."timestamp",
                date_trunc($2, t."timestamp") AS bucket,
                t.temperature, t.humidity, t.pressure,
                t."batteryLevel", t."signalStrength", t.data
           FROM telemetry t
          WHERE t."tenantId" = $1
            AND t."timestamp" >= $3
            AND t."timestamp" <  $4
       ),
       rows_per_bucket AS (
         SELECT "deviceId", bucket, count(*)::int AS row_count
           FROM src GROUP BY 1, 2
       ),
       pairs AS (
         SELECT s."tenantId", s."deviceId", s."deviceKey", s.bucket,
                s."timestamp", kv.key, kv.value
           FROM src s
           CROSS JOIN LATERAL (
             SELECT c.key, c.value
               FROM (VALUES
                 ('temperature',    s.temperature::double precision),
                 ('humidity',       s.humidity::double precision),
                 ('pressure',       s.pressure::double precision),
                 ('batteryLevel',   s."batteryLevel"::double precision),
                 ('signalStrength', s."signalStrength"::double precision)
               ) AS c(key, value)
              WHERE c.value IS NOT NULL
             UNION ALL
             SELECT j.key, (j.value #>> '{}')::double precision
               FROM jsonb_each(COALESCE(s.data, '{}'::jsonb)) j
              WHERE jsonb_typeof(j.value) = 'number'
                AND j.key NOT IN (${denormalisedList})
                AND length(j.key) <= 128
           ) kv
       ),
       agg AS (
         SELECT p."tenantId", p."deviceId", p."deviceKey", p.bucket, p.key,
                count(p.value)::int                                   AS sample_count,
                r.row_count                                           AS row_count,
                min(p.value)                                          AS min_value,
                max(p.value)                                          AS max_value,
                sum(p.value)                                          AS sum_value,
                sum(p.value) / NULLIF(count(p.value), 0)              AS avg_value,
                (array_agg(p.value ORDER BY p."timestamp" ASC))[1]    AS first_value,
                (array_agg(p.value ORDER BY p."timestamp" DESC))[1]   AS last_value,
                min(p."timestamp")                                    AS first_at,
                max(p."timestamp")                                    AS last_at
           FROM pairs p
           JOIN rows_per_bucket r
             ON r."deviceId" = p."deviceId" AND r.bucket = p.bucket
          GROUP BY p."tenantId", p."deviceId", p."deviceKey", p.bucket, p.key,
                   r.row_count
       ),
       capped AS (
         SELECT agg.*,
                row_number() OVER (
                  PARTITION BY "deviceId", bucket ORDER BY key
                ) AS rn
           FROM agg
       )
       INSERT INTO telemetry_rollups
         ("tenantId", "deviceId", "deviceKey", "granularity", "bucket", "key",
          "sampleCount", "rowCount", "minValue", "maxValue", "sumValue",
          "avgValue", "firstValue", "lastValue", "firstAt", "lastAt")
       SELECT "tenantId", "deviceId", "deviceKey", $2, bucket, key,
              sample_count, row_count, min_value, max_value, sum_value,
              avg_value, first_value, last_value, first_at, last_at
         FROM capped
        WHERE rn <= $5
       ON CONFLICT ("tenantId", "deviceId", "granularity", "key", "bucket")
       DO UPDATE SET
         "deviceKey"   = EXCLUDED."deviceKey",
         "sampleCount" = EXCLUDED."sampleCount",
         "rowCount"    = EXCLUDED."rowCount",
         "minValue"    = EXCLUDED."minValue",
         "maxValue"    = EXCLUDED."maxValue",
         "sumValue"    = EXCLUDED."sumValue",
         "avgValue"    = EXCLUDED."avgValue",
         "firstValue"  = EXCLUDED."firstValue",
         "lastValue"   = EXCLUDED."lastValue",
         "firstAt"     = EXCLUDED."firstAt",
         "lastAt"      = EXCLUDED."lastAt",
         "updated_at"  = now()
       RETURNING "id"`,
      [
        tenantId,
        granularity,
        stamp(from),
        stamp(to),
        this.config.rollupKeyLimit,
      ],
    );

    // TypeORM hands back `raw.rows` for an INSERT, so RETURNING is what makes
    // the upserted count observable at all — without it the array is empty and
    // every run would report "0 rows" however much work it did.
    return Array.isArray(result) ? result.length : 0;
  }

  // ════════════════════════════════════════════════════════════════════════
  // BUILD: week / month, from the day rollups
  // ════════════════════════════════════════════════════════════════════════

  /**
   * Re-aggregate `day` rollups into `week` or `month` rollups.
   *
   * `avgValue` is `SUM(sumValue) / SUM(sampleCount)`, not `AVG(avgValue)`. An
   * average of averages is only correct when every bucket holds the same number
   * of samples, and a device that reported twice on Monday and 2,000 times on
   * Tuesday is the normal case after an outage — `AVG(avgValue)` would weight
   * Monday 1000× too heavily.
   */
  async buildFromDayRollups(
    tenantId: string,
    granularity: 'week' | 'month',
    from: WindowBound,
    to: WindowBound,
  ): Promise<number> {
    const result = await this.rollupRepository.query(
      `WITH agg AS (
         SELECT r."tenantId", r."deviceId",
                (array_agg(r."deviceKey" ORDER BY r.bucket DESC))[1] AS device_key,
                date_trunc($2, r.bucket) AS bucket,
                r.key,
                sum(r."sampleCount")::int                              AS sample_count,
                sum(r."rowCount")::int                                 AS row_count,
                min(r."minValue")                                      AS min_value,
                max(r."maxValue")                                      AS max_value,
                sum(r."sumValue")                                      AS sum_value,
                sum(r."sumValue") / NULLIF(sum(r."sampleCount"), 0)    AS avg_value,
                (array_agg(r."firstValue" ORDER BY r."firstAt" ASC NULLS LAST))[1]
                                                                       AS first_value,
                (array_agg(r."lastValue"  ORDER BY r."lastAt" DESC NULLS LAST))[1]
                                                                       AS last_value,
                min(r."firstAt")                                       AS first_at,
                max(r."lastAt")                                        AS last_at
           FROM telemetry_rollups r
          WHERE r."tenantId" = $1
            AND r."granularity" = 'day'
            AND r.bucket >= $3
            AND r.bucket <  $4
          GROUP BY r."tenantId", r."deviceId", date_trunc($2, r.bucket), r.key
       )
       INSERT INTO telemetry_rollups
         ("tenantId", "deviceId", "deviceKey", "granularity", "bucket", "key",
          "sampleCount", "rowCount", "minValue", "maxValue", "sumValue",
          "avgValue", "firstValue", "lastValue", "firstAt", "lastAt")
       SELECT "tenantId", "deviceId", device_key, $2, bucket, key,
              sample_count, row_count, min_value, max_value, sum_value,
              avg_value, first_value, last_value, first_at, last_at
         FROM agg
       ON CONFLICT ("tenantId", "deviceId", "granularity", "key", "bucket")
       DO UPDATE SET
         "deviceKey"   = EXCLUDED."deviceKey",
         "sampleCount" = EXCLUDED."sampleCount",
         "rowCount"    = EXCLUDED."rowCount",
         "minValue"    = EXCLUDED."minValue",
         "maxValue"    = EXCLUDED."maxValue",
         "sumValue"    = EXCLUDED."sumValue",
         "avgValue"    = EXCLUDED."avgValue",
         "firstValue"  = EXCLUDED."firstValue",
         "lastValue"   = EXCLUDED."lastValue",
         "firstAt"     = EXCLUDED."firstAt",
         "lastAt"      = EXCLUDED."lastAt",
         "updated_at"  = now()
       RETURNING "id"`,
      [tenantId, granularity, stamp(from), stamp(to)],
    );

    return Array.isArray(result) ? result.length : 0;
  }

  // ════════════════════════════════════════════════════════════════════════
  // JOB ENTRY POINTS
  // ════════════════════════════════════════════════════════════════════════

  /**
   * One tenant's `hour` and `day` rollups, brought up to the last closed
   * bucket (or as far as `rollupMaxBuckets` allows this run).
   */
  async aggregateTenant(tenantId: string): Promise<RollupBuildResult[]> {
    if (!this.config.rollupEnabled) {
      return [
        {
          granularity: 'hour',
          from: null,
          to: null,
          rows: 0,
          skipped: 'disabled',
        },
      ];
    }

    const results: RollupBuildResult[] = [];

    for (const granularity of ['hour', 'day'] as const) {
      const window = await this.resolveWindow(tenantId, granularity);
      if (!window) {
        results.push({
          granularity,
          from: null,
          to: null,
          rows: 0,
          skipped: 'up-to-date',
        });
        continue;
      }

      const rows = await this.buildFromTelemetry(
        tenantId,
        granularity,
        window.from,
        window.to,
      );
      results.push({ granularity, from: window.from, to: window.to, rows });
    }

    return results;
  }

  /**
   * One tenant's `week` and `month` rollups, re-aggregated from whatever `day`
   * rollups now exist.
   *
   * This is the "statistics" job. It is cheap — it reads rollups, not telemetry
   * — so it recomputes a trailing window rather than tracking its own
   * watermark: a day rollup that was rebuilt because a device backfilled must
   * pull its week and month along with it, and a separate watermark would not
   * notice.
   */
  async computeStatistics(
    tenantId: string,
    trailingDays = 400,
  ): Promise<RollupBuildResult[]> {
    if (!this.config.rollupEnabled) {
      return [
        {
          granularity: 'month',
          from: null,
          to: null,
          rows: 0,
          skipped: 'disabled',
        },
      ];
    }

    // `::text` for the same reason as `resolveWindow` — a boundary that becomes
    // a JS Date and comes back moves by the process's UTC offset.
    const [bounds] = await this.rollupRepository.query(
      `SELECT (date_trunc('day', now()::timestamp - ($1 || ' days')::interval))::text AS win_from,
              (date_trunc('day', now()::timestamp) + interval '1 day')::text          AS win_to`,
      [String(trailingDays)],
    );

    const from: string = bounds.win_from;
    const to: string = bounds.win_to;
    const results: RollupBuildResult[] = [];

    for (const granularity of ['week', 'month'] as const) {
      const rows = await this.buildFromDayRollups(
        tenantId,
        granularity,
        from,
        to,
      );
      results.push({ granularity, from, to, rows });
    }

    return results;
  }

  /**
   * Drop rollups the tenant is no longer entitled to keep.
   *
   * `hour` rollups expire with the raw rows — they are nearly as dense, so
   * keeping them for years just moves the unbounded-growth problem one table
   * over. `day`, `week` and `month` are the long history and are kept
   * `retentionDays * rollupRetentionFactor` (default 12×, so a 90-day
   * PROFESSIONAL tenant keeps roughly three years of daily history in a few
   * thousand rows).
   */
  async pruneRollups(
    tenantId: string,
    retentionDays: number,
  ): Promise<{ hour: number; coarse: number }> {
    if (!Number.isFinite(retentionDays) || retentionDays <= 0) {
      return { hour: 0, coarse: 0 };
    }

    const coarseDays = retentionDays * this.config.rollupRetentionFactor;

    const hour = await this.rollupRepository.query(
      `DELETE FROM telemetry_rollups
        WHERE "tenantId" = $1
          AND "granularity" = 'hour'
          AND "bucket" < now()::timestamp - ($2 || ' days')::interval`,
      [tenantId, String(retentionDays)],
    );
    const coarse = await this.rollupRepository.query(
      `DELETE FROM telemetry_rollups
        WHERE "tenantId" = $1
          AND "granularity" <> 'hour'
          AND "bucket" < now()::timestamp - ($2 || ' days')::interval`,
      [tenantId, String(coarseDays)],
    );

    return {
      hour: Array.isArray(hour) ? Number(hour[1] ?? 0) : 0,
      coarse: Array.isArray(coarse) ? Number(coarse[1] ?? 0) : 0,
    };
  }

  // ════════════════════════════════════════════════════════════════════════
  // READS — what the controller's timeseries / aggregated / statistics serve
  // ════════════════════════════════════════════════════════════════════════

  /**
   * True when a requested range is wide enough that rollups should answer it.
   *
   * Short ranges stay on raw telemetry for two reasons: raw rows are exact, and
   * the newest bucket is deliberately not rolled up, so a rollup-backed answer
   * to "the last two hours" would be missing the part the user is watching.
   */
  shouldUseRollups(startDate?: string, endDate?: string): boolean {
    if (!this.config.rollupEnabled) return false;
    if (!startDate || !endDate) return false;
    const start = new Date(startDate).getTime();
    const end = new Date(endDate).getTime();
    if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) {
      return false;
    }
    const days = (end - start) / 86_400_000;
    return days >= this.config.rollupReadMinRangeDays;
  }

  /**
   * Pick the coarsest granularity that still gives a usable number of points.
   * Charts want on the order of a few hundred points, not a few hundred
   * thousand.
   */
  pickGranularity(
    startDate: string,
    endDate: string,
    requested?: TelemetryRollupGranularity,
  ): TelemetryRollupGranularity {
    if (requested) return requested;
    const days =
      (new Date(endDate).getTime() - new Date(startDate).getTime()) /
      86_400_000;
    if (days <= 14) return 'hour';
    if (days <= 120) return 'day';
    if (days <= 730) return 'week';
    return 'month';
  }

  /** One key's rollup series for a device. Backs `…/timeseries` on wide ranges. */
  async readSeries(
    deviceId: string,
    granularity: TelemetryRollupGranularity,
    key: string,
    from: Date,
    to: Date,
    limit = 5000,
  ): Promise<RollupSeriesPoint[]> {
    const rows = await this.rollupRepository.query(
      `SELECT "bucket", "key", "sampleCount", "rowCount",
              "minValue", "maxValue", "avgValue", "sumValue",
              "firstValue", "lastValue"
         FROM telemetry_rollups
        WHERE "deviceId" = $1
          AND "granularity" = $2
          AND "key" = $3
          AND "bucket" >= $4
          AND "bucket" <  $5
        ORDER BY "bucket" ASC
        LIMIT $6`,
      [deviceId, granularity, key, from.toISOString(), to.toISOString(), limit],
    );
    return rows.map(this.toSeriesPoint);
  }

  /** Every key of a device over a window. Backs `…/rollups`. */
  async readAllKeys(
    deviceId: string,
    granularity: TelemetryRollupGranularity,
    from: Date,
    to: Date,
    keys?: string[],
    limit = 20000,
  ): Promise<RollupSeriesPoint[]> {
    const params: unknown[] = [
      deviceId,
      granularity,
      from.toISOString(),
      to.toISOString(),
    ];
    let keyFilter = '';
    if (keys && keys.length > 0) {
      params.push(keys);
      keyFilter = `AND "key" = ANY($${params.length})`;
    }
    params.push(limit);

    const rows = await this.rollupRepository.query(
      `SELECT "bucket", "key", "sampleCount", "rowCount",
              "minValue", "maxValue", "avgValue", "sumValue",
              "firstValue", "lastValue"
         FROM telemetry_rollups
        WHERE "deviceId" = $1
          AND "granularity" = $2
          AND "bucket" >= $3
          AND "bucket" <  $4
          ${keyFilter}
        ORDER BY "bucket" ASC, "key" ASC
        LIMIT $${params.length}`,
      params,
    );
    return rows.map(this.toSeriesPoint);
  }

  /**
   * Whole-range statistics per key, from rollups.
   *
   * `totalRecords` sums `rowCount` over DISTINCT buckets rather than over rows:
   * `rowCount` is repeated on every key of a bucket, so summing it across keys
   * would multiply the record count by the number of keys the device reports.
   */
  async readStatistics(
    deviceId: string,
    granularity: TelemetryRollupGranularity,
    from: Date,
    to: Date,
  ): Promise<{
    totalRecords: number;
    buckets: number;
    firstRecord: Date | null;
    lastRecord: Date | null;
    keys: Record<
      string,
      {
        count: number;
        min: number | null;
        max: number | null;
        avg: number | null;
        sum: number | null;
        first: number | null;
        last: number | null;
      }
    >;
  }> {
    const [totals] = await this.rollupRepository.query(
      `SELECT COALESCE(sum(row_count), 0)::bigint AS total_records,
              count(*)::int                       AS buckets
         FROM (
           SELECT DISTINCT "bucket", "rowCount" AS row_count
             FROM telemetry_rollups
            WHERE "deviceId" = $1 AND "granularity" = $2
              AND "bucket" >= $3 AND "bucket" < $4
         ) b`,
      [deviceId, granularity, from.toISOString(), to.toISOString()],
    );

    const perKey = await this.rollupRepository.query(
      `SELECT "key",
              sum("sampleCount")::int                            AS count,
              min("minValue")                                    AS min,
              max("maxValue")                                    AS max,
              sum("sumValue")                                    AS sum,
              sum("sumValue") / NULLIF(sum("sampleCount"), 0)    AS avg,
              (array_agg("firstValue" ORDER BY "firstAt" ASC NULLS LAST))[1]  AS first,
              (array_agg("lastValue"  ORDER BY "lastAt" DESC NULLS LAST))[1]  AS last,
              min("firstAt")                                     AS first_at,
              max("lastAt")                                      AS last_at
         FROM telemetry_rollups
        WHERE "deviceId" = $1 AND "granularity" = $2
          AND "bucket" >= $3 AND "bucket" < $4
        GROUP BY "key"
        ORDER BY "key"`,
      [deviceId, granularity, from.toISOString(), to.toISOString()],
    );

    const keys: Record<string, any> = {};
    let firstRecord: Date | null = null;
    let lastRecord: Date | null = null;

    for (const row of perKey) {
      keys[row.key] = {
        count: Number(row.count) || 0,
        min: this.numOrNull(row.min),
        max: this.numOrNull(row.max),
        avg: this.numOrNull(row.avg),
        sum: this.numOrNull(row.sum),
        first: this.numOrNull(row.first),
        last: this.numOrNull(row.last),
      };
      if (row.first_at) {
        const at = new Date(row.first_at);
        if (!firstRecord || at < firstRecord) firstRecord = at;
      }
      if (row.last_at) {
        const at = new Date(row.last_at);
        if (!lastRecord || at > lastRecord) lastRecord = at;
      }
    }

    return {
      totalRecords: Number(totals?.total_records) || 0,
      buckets: Number(totals?.buckets) || 0,
      firstRecord,
      lastRecord,
      keys,
    };
  }

  /**
   * What has actually been rolled up, per granularity, for a tenant.
   * Read by `GET /telemetry/maintenance/status` — an operator about to let a
   * destructive sweep run wants to see the rollups are caught up first.
   */
  async coverage(tenantId: string): Promise<
    Array<{
      granularity: string;
      rows: number;
      oldestBucket: string | null;
      newestBucket: string | null;
    }>
  > {
    // Buckets are reported as Postgres text rather than as JS Dates: an
    // operator comparing this against `telemetry.timestamp` wants the database's
    // own wall clock, and parsing it into a local Date shifts it.
    const rows = await this.rollupRepository.query(
      `SELECT "granularity",
              count(*)::int        AS rows,
              min("bucket")::text  AS oldest_bucket,
              max("bucket")::text  AS newest_bucket
         FROM telemetry_rollups
        WHERE "tenantId" = $1
        GROUP BY "granularity"
        ORDER BY "granularity"`,
      [tenantId],
    );

    return rows.map((r: any) => ({
      granularity: r.granularity,
      rows: Number(r.rows) || 0,
      oldestBucket: r.oldest_bucket ?? null,
      newestBucket: r.newest_bucket ?? null,
    }));
  }

  // ── helpers ──────────────────────────────────────────────────────────────

  private numOrNull(value: unknown): number | null {
    if (value === null || value === undefined) return null;
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }

  private toSeriesPoint = (row: any): RollupSeriesPoint => ({
    bucket: new Date(row.bucket),
    key: row.key,
    sampleCount: Number(row.sampleCount) || 0,
    rowCount: Number(row.rowCount) || 0,
    min: this.numOrNull(row.minValue),
    max: this.numOrNull(row.maxValue),
    avg: this.numOrNull(row.avgValue),
    sum: this.numOrNull(row.sumValue),
    first: this.numOrNull(row.firstValue),
    last: this.numOrNull(row.lastValue),
  });
}
