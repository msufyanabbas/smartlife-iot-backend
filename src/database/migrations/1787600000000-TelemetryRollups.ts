import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * telemetry_rollups: pre-aggregated telemetry buckets.
 *
 * ── Why the table exists ────────────────────────────────────────────────────
 * `telemetry` grows without bound (there was no retention sweep, no cron, and
 * `deleteOldData()` had no caller), and the three read routes that have to span
 * long ranges — `…/timeseries`, `…/aggregated`, `…/statistics` — all scan it
 * directly. A tenant with 100 devices reporting each minute writes ~144k rows a
 * day, so "a year of this sensor" is a 50M-row scan per chart. Retention alone
 * does not fix that: it makes the table smaller by *destroying the history*, so
 * something has to keep the history in a form that survives the sweep. These
 * rows are that form.
 *
 * ── Shape ───────────────────────────────────────────────────────────────────
 * Long and narrow: one row per (tenant, device, granularity, bucket, key).
 * `telemetry.data` is free-form jsonb and the five denormalised columns cover
 * almost none of what real devices report (co2, voc, pm25, voltage, power…), so
 * a wide one-row-per-bucket table could only ever roll up those five. Narrow
 * also means a new sensor key needs no migration.
 *
 * `sampleCount` vs `rowCount`: `rowCount` is telemetry rows in the bucket and is
 * therefore identical on every key of that bucket — it is what
 * `…/aggregated` returns as `count`. `sampleCount` is how many of those rows
 * carried a numeric value for THIS key, and is the denominator of `avgValue`.
 * `sumValue` is stored so a week can be re-aggregated correctly: an average of
 * averages is wrong once buckets hold different sample counts.
 *
 * ── Column types ────────────────────────────────────────────────────────────
 * `tenantId` and `deviceId` are `uuid` with real foreign keys because the
 * entity declares `@ManyToOne('Tenant')` / `@ManyToOne('Device')` against them:
 * a join column takes the referenced key's type and gets a constraint whatever
 * the migration says, so writing `character varying` here would leave this file
 * permanently at odds with the schema `synchronize` builds (CLAUDE.md §4f).
 * `telemetry` itself is shaped exactly this way, and a rollup is strictly
 * derived from telemetry.
 *
 * `granularity` is `character varying`, NOT a PostgreSQL enum. A new
 * granularity would otherwise need `ALTER TYPE … ADD VALUE IF NOT EXISTS`
 * before it could be stored, and `@IsEnum` would accept a value the INSERT then
 * rejects — the failure mode that broke the "Apache Kafka" integration tile
 * (CLAUDE.md §4e). The column is called `granularity` and not `interval`
 * because `interval` is a PostgreSQL type name.
 *
 * The numeric columns are `double precision`, not `numeric(10,2)` like
 * `telemetry.temperature`. A rollup stores sums and means, and a sum of 144k
 * readings overflows two decimal places of precision long before it overflows
 * the scale; `double precision` also means the JS driver hands back numbers
 * rather than strings, so `avgValue` does not silently become `"21.50"`.
 *
 * ── Indexes ─────────────────────────────────────────────────────────────────
 * The UNIQUE constraint is the upsert's conflict target, which is what makes
 * re-running a window idempotent rather than double-counting it. The two
 * secondary indexes serve the only two access patterns: one device's window
 * (chart reads) and one tenant's newest bucket (the aggregation watermark).
 *
 * down() drops the table. Nothing is lost that cannot be rebuilt — every row is
 * derived from `telemetry` — except for buckets whose raw rows have since been
 * swept, which is the whole point of keeping them; so do not run down() in
 * production without a reason.
 *
 * `migration:run` is blocked (CLAUDE.md §11), so apply this one on its own:
 *   npm run migration:telemetry-rollups <database> [up|down]
 */
export class TelemetryRollups1787600000000 implements MigrationInterface {
  name = 'TelemetryRollups1787600000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "telemetry_rollups" (
        "id"            uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
        "created_at"    TIMESTAMP NOT NULL DEFAULT now(),
        "updated_at"    TIMESTAMP NOT NULL DEFAULT now(),
        "deleted_at"    TIMESTAMP,
        "created_by"    character varying,
        "updated_by"    character varying,
        "deleted_by"    character varying,
        "tenantId"      uuid NOT NULL,
        "deviceId"      uuid NOT NULL,
        "deviceKey"     character varying NOT NULL,
        "granularity"   character varying(16) NOT NULL,
        "bucket"        TIMESTAMP NOT NULL,
        "key"           character varying(128) NOT NULL,
        "sampleCount"   integer NOT NULL DEFAULT 0,
        "rowCount"      integer NOT NULL DEFAULT 0,
        "minValue"      double precision,
        "maxValue"      double precision,
        "sumValue"      double precision,
        "avgValue"      double precision,
        "firstValue"    double precision,
        "lastValue"     double precision,
        "firstAt"       TIMESTAMP,
        "lastAt"        TIMESTAMP,
        CONSTRAINT "UQ_telemetry_rollups_bucket"
          UNIQUE ("tenantId", "deviceId", "granularity", "key", "bucket"),
        CONSTRAINT "FK_telemetry_rollups_tenant"
          FOREIGN KEY ("tenantId") REFERENCES "tenants"("id"),
        CONSTRAINT "FK_telemetry_rollups_device"
          FOREIGN KEY ("deviceId") REFERENCES "devices"("id")
      )
    `);

    // Chart reads: every key of one device over a window.
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "IDX_telemetry_rollups_device_window"
        ON "telemetry_rollups" ("tenantId", "deviceId", "granularity", "bucket")
    `);

    // Aggregation watermark: max(bucket) for one tenant at one granularity.
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "IDX_telemetry_rollups_tenant_window"
        ON "telemetry_rollups" ("tenantId", "granularity", "bucket")
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS "telemetry_rollups"`);
  }
}
