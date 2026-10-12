import { Entity, Column, ManyToOne, JoinColumn, Index, Unique } from 'typeorm';
import { BaseEntity } from '@common/entities/base.entity';
import type { Relation } from 'typeorm';
import type { Device } from '../../devices/entities/device.entity';
import type { Tenant } from '../../tenants/entities/tenant.entity';

/**
 * Coarse granularities a rollup row can describe.
 *
 * `hour` and `day` are built directly from `telemetry`. `week` and `month` are
 * re-aggregated from the `day` rows, never from raw telemetry — by the time a
 * month is worth summarising its raw rows may already be past retention, and
 * re-reading a month of raw telemetry per device to produce one number is the
 * exact scan the rollup exists to avoid.
 *
 * Deliberately a TS union over a `character varying` column, NOT a PG enum:
 * adding a granularity to a PG enum needs `ALTER TYPE … ADD VALUE` before a new
 * member can be stored, and `@IsEnum` happily accepts the value the INSERT then
 * rejects (CLAUDE.md §4e). `device_profiles.transportType` is varchar for the
 * same reason.
 */
export type TelemetryRollupGranularity = 'hour' | 'day' | 'week' | 'month';

export const TELEMETRY_ROLLUP_GRANULARITIES: TelemetryRollupGranularity[] = [
  'hour',
  'day',
  'week',
  'month',
];

/**
 * One pre-aggregated (device, granularity, bucket, key) summary of `telemetry`.
 *
 * ── Why a table and not a materialised view ────────────────────────────────
 * A matview cannot be refreshed incrementally per tenant, and `REFRESH
 * MATERIALIZED VIEW CONCURRENTLY` re-reads the whole telemetry table — which on
 * a platform where that table is the thing growing without bound is the problem
 * restated. These rows are upserted window by window, per tenant, and the
 * upsert is idempotent, so a job that overlaps or retries converges on the same
 * numbers.
 *
 * ── Why one row per KEY rather than one row per bucket ────────────────────
 * `telemetry.data` is free-form jsonb: a Milesight AM300 reports co2/voc/pm25,
 * a smart meter reports voltage/current/power, and the five denormalised
 * columns (temperature, humidity, pressure, batteryLevel, signalStrength) cover
 * none of them. A row-per-bucket shape could only ever roll up those five, so
 * `GET /telemetry/devices/:id/timeseries?key=co2` over a year would still have
 * to scan raw rows. Long and narrow also means a new sensor key needs no
 * migration.
 *
 * `rowCount` is the number of telemetry rows in the bucket and is therefore the
 * same on every key of that bucket; `sampleCount` is how many of those rows
 * carried a numeric value for THIS key. Both are needed: `rowCount` answers
 * "how much did this device report" (what `GET …/aggregated` returns as
 * `count`), `sampleCount` is the denominator of `avgValue`.
 *
 * `sumValue` is stored alongside `avgValue` because an average of averages is
 * wrong when buckets hold different numbers of samples — a week's mean has to
 * be `SUM(sumValue) / SUM(sampleCount)`.
 *
 * ── Column types ──────────────────────────────────────────────────────────
 * `tenantId` and `deviceId` are `uuid` with real FKs, because they carry
 * `@ManyToOne` relations and a join column takes the referenced key's type and
 * gets a constraint whether the migration says so or not (CLAUDE.md §4f).
 * `telemetry` itself is shaped this way, and a rollup is strictly derived from
 * telemetry — it should not outlive the device it describes.
 *
 * The column is `granularity`, not `interval`: `interval` is a PostgreSQL type
 * name and a column called that only works while every reference stays quoted.
 */
@Entity('telemetry_rollups')
@Unique('UQ_telemetry_rollups_bucket', [
  'tenantId',
  'deviceId',
  'granularity',
  'key',
  'bucket',
])
// Chart reads: every key of one device over a window.
@Index('IDX_telemetry_rollups_device_window', [
  'tenantId',
  'deviceId',
  'granularity',
  'bucket',
])
// Watermark reads: the newest bucket this tenant has at a granularity.
@Index('IDX_telemetry_rollups_tenant_window', [
  'tenantId',
  'granularity',
  'bucket',
])
export class TelemetryRollup extends BaseEntity {
  // ── Tenant scoping (required) ─────────────────────────────────────────────

  @Column()
  tenantId: string;

  @ManyToOne('Tenant')
  @JoinColumn({ name: 'tenantId' })
  tenant: Relation<Tenant>;

  // ── Device reference ──────────────────────────────────────────────────────

  @Column()
  deviceId: string;

  @ManyToOne('Device')
  @JoinColumn({ name: 'deviceId' })
  device: Relation<Device>;

  /** Denormalised exactly as `telemetry.deviceKey` is, for the same reason. */
  @Column()
  deviceKey: string;

  // ── Bucket identity ───────────────────────────────────────────────────────

  @Column({ type: 'varchar', length: 16 })
  granularity: TelemetryRollupGranularity;

  /** `date_trunc(granularity, timestamp)` — the inclusive start of the bucket. */
  @Column({ type: 'timestamp' })
  bucket: Date;

  /**
   * The telemetry key this row summarises: one of the five denormalised columns
   * by its canonical name, or any numeric key found in `telemetry.data`.
   */
  @Column({ type: 'varchar', length: 128 })
  key: string;

  // ── The numbers ───────────────────────────────────────────────────────────

  /** Telemetry rows in this bucket that carried a numeric value for `key`. */
  @Column({ type: 'int', default: 0 })
  sampleCount: number;

  /** Telemetry rows in this bucket in total, whatever keys they carried. */
  @Column({ type: 'int', default: 0 })
  rowCount: number;

  @Column({ type: 'double precision', nullable: true })
  minValue: number | null;

  @Column({ type: 'double precision', nullable: true })
  maxValue: number | null;

  @Column({ type: 'double precision', nullable: true })
  sumValue: number | null;

  @Column({ type: 'double precision', nullable: true })
  avgValue: number | null;

  /** Value of the earliest sample in the bucket — a gauge's opening reading. */
  @Column({ type: 'double precision', nullable: true })
  firstValue: number | null;

  /** Value of the latest sample in the bucket — a meter's closing reading. */
  @Column({ type: 'double precision', nullable: true })
  lastValue: number | null;

  @Column({ type: 'timestamp', nullable: true })
  firstAt: Date | null;

  @Column({ type: 'timestamp', nullable: true })
  lastAt: Date | null;
}
