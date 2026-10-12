/**
 * Every knob the telemetry retention / rollup machinery has, in one place.
 *
 * Retention is read from the tenant's own `Subscription.limits.dataRetentionDays`
 * (which already exists per plan: FREE 7, STARTER 30, PROFESSIONAL 90,
 * ENTERPRISE 365 — see `database/seeds/subscription/subscription.seeder.ts`).
 * That jsonb column is the per-tenant override: an operator can raise one
 * tenant's `dataRetentionDays` without moving them to another plan, exactly as
 * `maxFloorPlans` is overridden today.
 *
 * The env vars below are the platform-wide guard rails around that number, not
 * a substitute for it. In particular `fallbackRetentionDays` defaults to **0**,
 * which means *skip the tenant*: a tenant with no subscription row, or a
 * subscription whose `limits` has no `dataRetentionDays`, has never been told
 * how long to keep data, and guessing on the destructive side of that is how a
 * sweep silently eats a customer's history. The same convention is already used
 * for quota checks, which are skipped for tenants with no subscription row
 * precisely so that adding a limit key never retroactively locks anyone out
 * (CLAUDE.md §4a).
 */
export interface TelemetryMaintenanceConfig {
  // ── Retention ───────────────────────────────────────────────────────────
  /** Master kill switch. `TELEMETRY_RETENTION_ENABLED=false` disables the sweep. */
  retentionEnabled: boolean;
  /**
   * Days to keep for a tenant whose subscription does not say.
   * 0 (the default) means "do not sweep that tenant at all".
   */
  fallbackRetentionDays: number;
  /**
   * Floor on any effective retention. A tenant configured below this is
   * skipped and logged rather than swept — a fat-fingered `dataRetentionDays:
   * 0` must not mean "delete everything".
   */
  minRetentionDays: number;
  /** Rows deleted per statement. */
  retentionBatchSize: number;
  /**
   * Batches per tenant per run. Caps the worst case at
   * `batchSize * maxBatches` rows; whatever is left is swept on the next run,
   * so a huge first sweep is spread over days instead of locking the table.
   */
  retentionMaxBatches: number;
  /**
   * How much longer rollups live than the raw rows they summarise.
   * `day`/`week`/`month` rollups are kept `retentionDays * factor`; `hour`
   * rollups are kept for `retentionDays`, since they are nearly as dense as
   * the raw data and lose their point once it is gone.
   */
  rollupRetentionFactor: number;

  // ── Aggregation ─────────────────────────────────────────────────────────
  /** Master kill switch for the rollup builder. */
  rollupEnabled: boolean;
  /**
   * Buckets built per tenant per granularity per run. The bound is what stops
   * a tenant with two years of unaggregated telemetry from turning one cron
   * tick into an hours-long scan.
   */
  rollupMaxBuckets: number;
  /**
   * How far back to start when a tenant has no rollups at all. Bounded for the
   * same reason: the first run after deploy must not try to roll up all of
   * history. Successive runs walk forward from the watermark until they catch
   * up.
   */
  rollupBackfillDays: number;
  /**
   * Distinct keys rolled up per (device, bucket). A device whose payload keys
   * are generated (`sensor_1718…`) would otherwise write an unbounded number
   * of rollup rows per bucket.
   */
  rollupKeyLimit: number;
  /**
   * A read whose requested range is at least this many days is served from
   * rollups instead of raw telemetry. Below it, raw rows are both exact and
   * cheap, and — more importantly — are the only thing that exists for the
   * current, not-yet-aggregated bucket.
   */
  rollupReadMinRangeDays: number;
  /**
   * Tenants with no telemetry newer than this are not enqueued by the
   * aggregation cron at all. This is what keeps a per-15-minute job off the
   * ~100% of rows belonging to tenants that are idle.
   */
  rollupActiveLookbackHours: number;
}

type Getter = (key: string) => unknown;

const num = (get: Getter, key: string, fallback: number, min = 0): number => {
  const parsed = Number(get(key));
  if (!Number.isFinite(parsed)) return fallback;
  return parsed < min ? fallback : Math.floor(parsed);
};

const bool = (get: Getter, key: string, fallback: boolean): boolean => {
  const raw = get(key);
  if (raw === undefined || raw === null || raw === '') return fallback;
  return !['false', '0', 'no', 'off'].includes(String(raw).toLowerCase());
};

export function resolveTelemetryMaintenanceConfig(
  get: Getter,
): TelemetryMaintenanceConfig {
  return {
    retentionEnabled: bool(get, 'TELEMETRY_RETENTION_ENABLED', true),
    fallbackRetentionDays: num(get, 'TELEMETRY_RETENTION_FALLBACK_DAYS', 0),
    minRetentionDays: num(get, 'TELEMETRY_RETENTION_MIN_DAYS', 1, 1),
    retentionBatchSize: num(get, 'TELEMETRY_RETENTION_BATCH_SIZE', 5000, 1),
    retentionMaxBatches: num(get, 'TELEMETRY_RETENTION_MAX_BATCHES', 200, 1),
    rollupRetentionFactor: num(get, 'TELEMETRY_ROLLUP_RETENTION_FACTOR', 12, 1),

    rollupEnabled: bool(get, 'TELEMETRY_ROLLUP_ENABLED', true),
    rollupMaxBuckets: num(get, 'TELEMETRY_ROLLUP_MAX_BUCKETS', 168, 1),
    rollupBackfillDays: num(get, 'TELEMETRY_ROLLUP_BACKFILL_DAYS', 7, 1),
    rollupKeyLimit: num(get, 'TELEMETRY_ROLLUP_KEY_LIMIT', 50, 1),
    rollupReadMinRangeDays: num(
      get,
      'TELEMETRY_ROLLUP_READ_MIN_RANGE_DAYS',
      2,
      1,
    ),
    rollupActiveLookbackHours: num(
      get,
      'TELEMETRY_ROLLUP_ACTIVE_LOOKBACK_HOURS',
      48,
      1,
    ),
  };
}
