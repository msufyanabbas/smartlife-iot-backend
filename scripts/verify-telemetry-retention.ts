/**
 * Verifies telemetry retention, aggregation and statistics against a real
 * PostgreSQL database.
 *
 *   createdb telcheck && npx ts-node -r tsconfig-paths/register \
 *     scripts/verify-telemetry-retention.ts telcheck
 *
 * Why this and not an e2e HTTP test: booting the application needs a reachable
 * Kafka broker (CLAUDE.md §11), so the services are constructed by hand here.
 * Everything below them is the real thing — real TypeORM repositories, real
 * SQL, real `date_trunc` bucketing, real batched `DELETE … FOR UPDATE SKIP
 * LOCKED`.
 *
 * What it proves, in order:
 *   1. The entity initialises. A nullable column whose TS property is a union
 *      takes the whole application down at `DataSource.initialize` if it has no
 *      explicit `type`.
 *   2. **Aggregation arithmetic**, against a fixture whose min/max/sum/avg/
 *      first/last are known by hand — not eyeballed. Including that a key
 *      present in `data` but absent from a later reading gets the right
 *      `sampleCount` while `rowCount` still counts every row, that non-numeric
 *      values are excluded, and that the denormalised columns and the jsonb
 *      keys do not double count.
 *   3. Re-running the same window is **idempotent** — the upsert converges
 *      instead of doubling.
 *   4. Week/month statistics re-aggregate from the day rollups with a
 *      sample-weighted mean, which `AVG(avgValue)` would get wrong.
 *   5. **Retention deletes expired rows and only those.** Rows newer than the
 *      cutoff survive, to the row.
 *   6. **Retention respects the plan**: a FREE tenant (7d) and an ENTERPRISE
 *      tenant (365d) with identical data are swept differently, and one
 *      tenant's sweep never touches another's rows.
 *   7. **A tenant whose retention is unset, zero, negative or below the floor
 *      is never swept.**
 *   8. **The batch bound holds** on a 12,000-row fixture: batch size 500 and a
 *      cap of 3 batches deletes exactly 1,500 rows and reports
 *      `moreRemaining`.
 *   9. **A second cron tick while the first job is still running does not
 *      double-process** — both at the producer (deterministic jobId) and at
 *      the consumer (in-flight lock).
 *  10. Every job is safe on an empty database, and a throwing job releases its
 *      lock instead of wedging the tenant for ever.
 */
import { DataSource, Repository } from 'typeorm';
import { randomUUID } from 'crypto';
import { EventEmitter2 } from '@nestjs/event-emitter';
import * as entities from '../src/modules/index.entities';
import { Telemetry } from '../src/modules/telemetry/entities/telemetry.entity';
import { TelemetryRollup } from '../src/modules/telemetry/entities/telemetry-rollup.entity';
import { Subscription } from '../src/modules/subscriptions/entities/subscription.entity';
import { TelemetryRollupService } from '../src/modules/telemetry/telemetry-rollup.service';
import { TelemetryRetentionService } from '../src/modules/telemetry/telemetry-retention.service';
import { TelemetryMaintenanceService } from '../src/modules/telemetry/telemetry-maintenance.service';
import { TelemetryProcessor } from '../src/modules/telemetry/processors/telemetry.processor';
import { TelemetryService } from '../src/modules/telemetry/telemetry.service';

const database = process.argv[2] ?? 'telcheck';

let failures = 0;
const check = (label: string, condition: boolean, detail?: unknown) => {
  if (condition) {
    console.log(`  ✓ ${label}`);
  } else {
    failures++;
    console.error(`  ✗ ${label}`, detail === undefined ? '' : detail);
  }
};
const near = (a: number | null, b: number, eps = 1e-9) =>
  a !== null && Math.abs(a - b) < eps;
const section = (title: string) => console.log(`\n── ${title} ─────────────`);

// FREE (7d), ENTERPRISE (365d), retention unset, retention 0.
const T_FREE = randomUUID();
const T_ENT = randomUUID();
const T_UNSET = randomUUID();
const T_ZERO = randomUUID();
const T_BULK = randomUUID();
const USER = randomUUID();
// Telemetry reads are tenant-scoped (see TelemetryService.resolveDeviceForUser),
// so the read assertions below — which deliberately range across several
// fixture tenants to check rollup arithmetic — need a caller entitled to make
// them. Access control itself is asserted by verify-telemetry-tenant-scoping.ts;
// using a tenant-scoped fixture here would conflate the two concerns.
const SUPER_USER = randomUUID();

/** `offsetMinutes` back from a fixed anchor so the fixture is deterministic. */
const ANCHOR = new Date('2026-03-10T00:00:00.000Z');

/**
 * A ConfigService stand-in. The real one reads process.env; the overrides map
 * lets each section exercise a different bound without re-booting anything.
 */
const makeConfig = (overrides: Record<string, unknown> = {}) =>
  ({ get: (key: string) => overrides[key] }) as any;

(async () => {
  const dataSource = new DataSource({
    type: 'postgres',
    host: process.env.DB_HOST ?? 'localhost',
    port: Number(process.env.DB_PORT ?? 5432),
    username: process.env.DB_USERNAME ?? 'postgres',
    password: process.env.DB_PASSWORD ?? '123456',
    database,
    // TelemetryRollup is listed explicitly: index.entities.ts is owned by the
    // coordinator, so until the export line lands there it is not in
    // Object.values(entities). Harmless either way — TypeORM de-duplicates.
    entities: [...(Object.values(entities) as any[]), TelemetryRollup],
    synchronize: true,
    logging: false,
  });

  section('1. Schema');
  await dataSource.initialize();
  check('DataSource initialises with TelemetryRollup registered', true);

  const telemetryRepo: Repository<Telemetry> =
    dataSource.getRepository(Telemetry);
  const rollupRepo: Repository<TelemetryRollup> =
    dataSource.getRepository(TelemetryRollup);
  const subscriptionRepo: Repository<Subscription> =
    dataSource.getRepository(Subscription);

  const TENANTS = [T_FREE, T_ENT, T_UNSET, T_ZERO, T_BULK];

  // Clean slate for repeated runs. Order matters — FKs.
  await rollupRepo.query('DELETE FROM telemetry_rollups');
  await telemetryRepo.query('DELETE FROM telemetry');
  await telemetryRepo.query(
    'DELETE FROM subscriptions WHERE "tenantId" = ANY($1)',
    [TENANTS],
  );
  await telemetryRepo.query('DELETE FROM devices WHERE "tenantId" = ANY($1)', [
    TENANTS,
  ]);
  await telemetryRepo.query('DELETE FROM users WHERE id = $1', [USER]);
  await telemetryRepo.query('DELETE FROM tenants WHERE id = ANY($1)', [
    TENANTS,
  ]);

  // Real tenant / user / device rows: telemetry.tenantId and telemetry.deviceId
  // carry @ManyToOne relations, so the schema has real FKs and invented uuids
  // fail the insert.
  for (const [i, id] of TENANTS.entries()) {
    await telemetryRepo.query(
      `INSERT INTO tenants (id, name, email) VALUES ($1, $2, $3)`,
      [
        id,
        `Telemetry fixture ${i} ${id.slice(0, 8)}`,
        `tel${i}-${id.slice(0, 8)}@example.invalid`,
      ],
    );
  }
  await telemetryRepo.query(
    `INSERT INTO users (id, email, password, name, role, "tenantId")
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [
      USER,
      `fixture-${USER.slice(0, 8)}@example.invalid`,
      'not-a-real-hash',
      'Fixture admin',
      'tenant_admin',
      T_FREE,
    ],
  );

  await telemetryRepo.query(
    `INSERT INTO users (id, email, password, name, role, "tenantId")
     VALUES ($1, $2, $3, $4, $5, NULL)`,
    [
      SUPER_USER,
      `fixture-super-${SUPER_USER.slice(0, 8)}@example.invalid`,
      'not-a-real-hash',
      'Fixture super admin',
      'super_admin',
    ],
  );

  const devices: Record<string, string> = {};
  for (const tenantId of TENANTS) {
    const deviceId = randomUUID();
    devices[tenantId] = deviceId;
    await telemetryRepo.query(
      `INSERT INTO devices (id, "tenantId", "deviceKey", name, "userId")
       VALUES ($1, $2, $3, $4, $5)`,
      [
        deviceId,
        tenantId,
        `fixture-${deviceId.slice(0, 8)}`,
        'Fixture device',
        USER,
      ],
    );
  }

  // Plans, with the retention each seeded plan carries.
  const seedSubscription = async (
    tenantId: string,
    plan: string,
    limits: Record<string, unknown>,
  ) => {
    await subscriptionRepo.query(
      `INSERT INTO subscriptions ("tenantId", plan, status, limits, features)
       VALUES ($1, $2, 'active', $3::jsonb, '{}'::jsonb)`,
      [tenantId, plan, JSON.stringify(limits)],
    );
  };
  await seedSubscription(T_FREE, 'free', { devices: 5, dataRetentionDays: 7 });
  await seedSubscription(T_ENT, 'enterprise', {
    devices: -1,
    dataRetentionDays: 365,
  });
  await seedSubscription(T_UNSET, 'free', { devices: 5 }); // no dataRetentionDays
  await seedSubscription(T_ZERO, 'free', { devices: 5, dataRetentionDays: 0 });
  await seedSubscription(T_BULK, 'starter', {
    devices: 50,
    dataRetentionDays: 30,
  });

  const insertTelemetry = async (
    tenantId: string,
    timestamp: Date,
    data: Record<string, unknown>,
    denorm: Partial<{
      temperature: number;
      humidity: number;
      pressure: number;
      batteryLevel: number;
      signalStrength: number;
    }> = {},
  ) => {
    await telemetryRepo.query(
      `INSERT INTO telemetry
         ("tenantId", "deviceId", "deviceKey", "timestamp", data,
          temperature, humidity, pressure, "batteryLevel", "signalStrength")
       VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7, $8, $9, $10)`,
      [
        tenantId,
        devices[tenantId],
        `fixture-${devices[tenantId].slice(0, 8)}`,
        timestamp.toISOString(),
        JSON.stringify(data),
        denorm.temperature ?? null,
        denorm.humidity ?? null,
        denorm.pressure ?? null,
        denorm.batteryLevel ?? null,
        denorm.signalStrength ?? null,
      ],
    );
  };

  // ════════════════════════════════════════════════════════════════════════
  section('2. Aggregation arithmetic (hand-computed fixture)');
  // ════════════════════════════════════════════════════════════════════════
  //
  // Four readings inside ONE hour bucket (10:00) plus one in the next (11:00).
  //
  //   10:05  temperature 10  humidity 50  co2 400  label "a"
  //   10:15  temperature 20  humidity 60  co2 500
  //   10:45  temperature 30               co2 600
  //   10:55  temperature 40               co2 "high"   ← string, must be ignored
  //   11:05  temperature 100
  //
  // Expected, bucket 10:00:
  //   rowCount                4  (every key's row carries the same rowCount)
  //   temperature  n=4 min=10 max=40  sum=100  avg=25   first=10 last=40
  //   humidity     n=2 min=50 max=60  sum=110  avg=55   first=50 last=60
  //   co2          n=3 min=400 max=600 sum=1500 avg=500 first=400 last=600
  //   'label' must not appear at all (non-numeric).
  // Expected, bucket 11:00: temperature n=1, rowCount 1.
  const H = (minutes: number) => new Date(ANCHOR.getTime() + minutes * 60_000);
  //                              10:05 = 605 minutes after 2026-03-10T00:00
  await insertTelemetry(
    T_FREE,
    H(605),
    { temperature: 10, humidity: 50, co2: 400, label: 'a' },
    { temperature: 10, humidity: 50 },
  );
  await insertTelemetry(
    T_FREE,
    H(615),
    { temperature: 20, humidity: 60, co2: 500 },
    { temperature: 20, humidity: 60 },
  );
  await insertTelemetry(
    T_FREE,
    H(645),
    { temperature: 30, co2: 600 },
    { temperature: 30 },
  );
  await insertTelemetry(
    T_FREE,
    H(655),
    { temperature: 40, co2: 'high' },
    { temperature: 40 },
  );
  await insertTelemetry(
    T_FREE,
    H(665),
    { temperature: 100 },
    { temperature: 100 },
  );

  const rollupService = new TelemetryRollupService(
    rollupRepo,
    makeConfig({ TELEMETRY_ROLLUP_KEY_LIMIT: 50 }),
  );

  const windowFrom = H(600);
  const windowTo = H(720);
  const built = await rollupService.buildFromTelemetry(
    T_FREE,
    'hour',
    windowFrom,
    windowTo,
  );
  check('hour rollup upserted rows', built > 0, { built });

  const bucket10 = await rollupRepo.find({
    where: { tenantId: T_FREE, granularity: 'hour' },
    order: { bucket: 'ASC', key: 'ASC' },
  });
  const at = (bucketIso: string, key: string) =>
    bucket10.find(
      (r) => r.bucket.toISOString().startsWith(bucketIso) && r.key === key,
    );

  // The bucket label depends on how Postgres stores these `timestamp` values;
  // derive it from the data rather than hardcoding a timezone assumption.
  const buckets = [...new Set(bucket10.map((r) => r.bucket.getTime()))].sort();
  check('exactly two hour buckets exist', buckets.length === 2, {
    buckets: buckets.map((b) => new Date(b).toISOString()),
  });

  const b0 = new Date(buckets[0]).toISOString().slice(0, 13);
  const b1 = new Date(buckets[1]).toISOString().slice(0, 13);

  const keysInB0 = bucket10
    .filter((r) => r.bucket.getTime() === buckets[0])
    .map((r) => r.key)
    .sort();
  check(
    'bucket 1 rolled up exactly co2, humidity, temperature — the string co2 and the text label are excluded',
    JSON.stringify(keysInB0) ===
      JSON.stringify(['co2', 'humidity', 'temperature']),
    keysInB0,
  );

  const temp0 = at(b0, 'temperature');
  check(
    'temperature sampleCount = 4',
    temp0?.sampleCount === 4,
    temp0?.sampleCount,
  );
  check('temperature rowCount = 4', temp0?.rowCount === 4, temp0?.rowCount);
  check(
    'temperature min = 10',
    near(temp0?.minValue ?? null, 10),
    temp0?.minValue,
  );
  check(
    'temperature max = 40',
    near(temp0?.maxValue ?? null, 40),
    temp0?.maxValue,
  );
  check(
    'temperature sum = 100',
    near(temp0?.sumValue ?? null, 100),
    temp0?.sumValue,
  );
  check(
    'temperature avg = 25',
    near(temp0?.avgValue ?? null, 25),
    temp0?.avgValue,
  );
  check(
    'temperature first = 10',
    near(temp0?.firstValue ?? null, 10),
    temp0?.firstValue,
  );
  check(
    'temperature last = 40',
    near(temp0?.lastValue ?? null, 40),
    temp0?.lastValue,
  );

  const hum0 = at(b0, 'humidity');
  check(
    'humidity sampleCount = 2 but rowCount is still 4 — a key missing from a reading must not shrink the record count',
    hum0?.sampleCount === 2 && hum0?.rowCount === 4,
    { sampleCount: hum0?.sampleCount, rowCount: hum0?.rowCount },
  );
  check(
    'humidity avg = 55 (110/2, not 110/4)',
    near(hum0?.avgValue ?? null, 55),
    hum0?.avgValue,
  );

  const co20 = at(b0, 'co2');
  check(
    'co2 from jsonb: n=3 sum=1500 avg=500 min=400 max=600',
    co20?.sampleCount === 3 &&
      near(co20?.sumValue ?? null, 1500) &&
      near(co20?.avgValue ?? null, 500) &&
      near(co20?.minValue ?? null, 400) &&
      near(co20?.maxValue ?? null, 600),
    co20,
  );
  check(
    'co2 counted once, not twice — a jsonb key is not double counted against a denormalised column',
    bucket10.filter((r) => r.bucket.getTime() === buckets[0] && r.key === 'co2')
      .length === 1,
  );

  const temp1 = at(b1, 'temperature');
  check(
    'second bucket is temperature only, n=1 rowCount=1 avg=100',
    temp1?.sampleCount === 1 &&
      temp1?.rowCount === 1 &&
      near(temp1?.avgValue ?? null, 100),
    temp1,
  );

  // ════════════════════════════════════════════════════════════════════════
  section('3. Re-running the same window is idempotent');
  // ════════════════════════════════════════════════════════════════════════
  const countBefore = await rollupRepo.count({ where: { tenantId: T_FREE } });
  await rollupService.buildFromTelemetry(T_FREE, 'hour', windowFrom, windowTo);
  await rollupService.buildFromTelemetry(T_FREE, 'hour', windowFrom, windowTo);
  const countAfter = await rollupRepo.count({ where: { tenantId: T_FREE } });
  check(
    'two extra builds added no rows (ON CONFLICT DO UPDATE, not INSERT)',
    countBefore === countAfter,
    { countBefore, countAfter },
  );
  const tempAfter = await rollupRepo.findOne({
    where: {
      tenantId: T_FREE,
      granularity: 'hour',
      key: 'temperature',
      bucket: temp0!.bucket,
    },
  });
  check(
    'and the numbers did not double (sum still 100, not 300)',
    near(tempAfter?.sumValue ?? null, 100) && tempAfter?.sampleCount === 4,
    { sum: tempAfter?.sumValue, n: tempAfter?.sampleCount },
  );

  // ════════════════════════════════════════════════════════════════════════
  section('4. Statistics: week/month from day rollups, sample-weighted');
  // ════════════════════════════════════════════════════════════════════════
  //
  // Two days in one month, deliberately lopsided so a plain AVG(avgValue)
  // gives the wrong answer:
  //   day A: 1 reading  of 100   → avg 100
  //   day B: 9 readings of 0     → avg 0
  // Sample-weighted month mean = 100 / 10 = 10.   AVG(avgValue) would say 50.
  const DAY_A = new Date('2026-03-02T09:00:00.000Z');
  const DAY_B = new Date('2026-03-03T09:00:00.000Z');
  await insertTelemetry(T_ENT, DAY_A, { power: 100 });
  for (let i = 0; i < 9; i++) {
    await insertTelemetry(T_ENT, new Date(DAY_B.getTime() + i * 60_000), {
      power: 0,
    });
  }
  await rollupService.buildFromTelemetry(
    T_ENT,
    'day',
    new Date('2026-03-01T00:00:00.000Z'),
    new Date('2026-03-05T00:00:00.000Z'),
  );
  const dayRows = await rollupRepo.find({
    where: { tenantId: T_ENT, granularity: 'day', key: 'power' },
    order: { bucket: 'ASC' },
  });
  check(
    'two day buckets built for power',
    dayRows.length === 2,
    dayRows.length,
  );

  await rollupService.buildFromDayRollups(
    T_ENT,
    'month',
    new Date('2026-03-01T00:00:00.000Z'),
    new Date('2026-04-01T00:00:00.000Z'),
  );
  const monthRow = await rollupRepo.findOne({
    where: { tenantId: T_ENT, granularity: 'month', key: 'power' },
  });
  check(
    'month avg = 10 (sample-weighted), NOT 50 (average of averages)',
    near(monthRow?.avgValue ?? null, 10),
    monthRow?.avgValue,
  );
  check(
    'month sampleCount = 10, sum = 100, min = 0, max = 100',
    monthRow?.sampleCount === 10 &&
      near(monthRow?.sumValue ?? null, 100) &&
      near(monthRow?.minValue ?? null, 0) &&
      near(monthRow?.maxValue ?? null, 100),
    monthRow,
  );
  check(
    'month first = 100 (earliest day) and last = 0 (latest day)',
    near(monthRow?.firstValue ?? null, 100) &&
      near(monthRow?.lastValue ?? null, 0),
    { first: monthRow?.firstValue, last: monthRow?.lastValue },
  );

  // readStatistics must not multiply totalRecords by the number of keys.
  await insertTelemetry(T_ENT, new Date(DAY_A.getTime() + 60_000), {
    power: 5,
    voltage: 230,
  });
  await rollupService.buildFromTelemetry(
    T_ENT,
    'day',
    new Date('2026-03-01T00:00:00.000Z'),
    new Date('2026-03-05T00:00:00.000Z'),
  );
  const stats = await rollupService.readStatistics(
    devices[T_ENT],
    'day',
    new Date('2026-03-01T00:00:00.000Z'),
    new Date('2026-03-05T00:00:00.000Z'),
  );
  check(
    'readStatistics totalRecords = 11 raw rows, not inflated by the two keys',
    stats.totalRecords === 11,
    { totalRecords: stats.totalRecords, buckets: stats.buckets },
  );
  check(
    'readStatistics reports both power and voltage',
    Boolean(stats.keys.power) && Boolean(stats.keys.voltage),
    Object.keys(stats.keys),
  );

  // ════════════════════════════════════════════════════════════════════════
  section('5. Retention deletes expired rows and only those');
  // ════════════════════════════════════════════════════════════════════════
  const retentionService = new TelemetryRetentionService(
    telemetryRepo,
    subscriptionRepo,
    rollupService,
    makeConfig({}),
  );

  // Wipe the aggregation fixtures so the counts below are unambiguous.
  await telemetryRepo.query('DELETE FROM telemetry');
  await rollupRepo.query('DELETE FROM telemetry_rollups');

  const daysAgo = (n: number) => new Date(Date.now() - n * 86_400_000);
  // FREE keeps 7 days. 3 rows well past it, 3 rows well inside it.
  for (const n of [30, 20, 9])
    await insertTelemetry(T_FREE, daysAgo(n), { temperature: n });
  for (const n of [5, 2, 0])
    await insertTelemetry(T_FREE, daysAgo(n), { temperature: n });
  // ENTERPRISE keeps 365 days; the same ages must all survive.
  for (const n of [30, 20, 9, 5, 2, 0])
    await insertTelemetry(T_ENT, daysAgo(n), { temperature: n });

  const resolvedFree = await retentionService.resolveRetention(T_FREE);
  check(
    'FREE tenant resolves to 7 days from its subscription limits',
    resolvedFree.days === 7 && resolvedFree.source === 'subscription',
    resolvedFree,
  );
  const resolvedEnt = await retentionService.resolveRetention(T_ENT);
  check(
    'ENTERPRISE tenant resolves to 365 days',
    resolvedEnt.days === 365,
    resolvedEnt,
  );

  const freeSweep = await retentionService.sweepTenant(T_FREE);
  check(
    'FREE sweep deleted exactly the 3 rows older than 7 days',
    freeSweep.deleted === 3,
    freeSweep,
  );
  const freeLeft: Array<{ n: string }> = await telemetryRepo.query(
    `SELECT count(*)::text AS n FROM telemetry WHERE "tenantId" = $1`,
    [T_FREE],
  );
  check(
    'FREE tenant still has its 3 recent rows',
    freeLeft[0].n === '3',
    freeLeft[0],
  );
  const freeOldest: Array<{ oldest: Date }> = await telemetryRepo.query(
    `SELECT min("timestamp") AS oldest FROM telemetry WHERE "tenantId" = $1`,
    [T_FREE],
  );
  const oldestAgeDays =
    (Date.now() - new Date(freeOldest[0].oldest).getTime()) / 86_400_000;
  check(
    'the oldest surviving FREE row is inside the 7-day window',
    oldestAgeDays < 7,
    { oldestAgeDays },
  );

  const entLeftBefore: Array<{ n: string }> = await telemetryRepo.query(
    `SELECT count(*)::text AS n FROM telemetry WHERE "tenantId" = $1`,
    [T_ENT],
  );
  check(
    "one tenant's sweep did not touch another tenant's rows",
    entLeftBefore[0].n === '6',
    entLeftBefore[0],
  );

  const entSweep = await retentionService.sweepTenant(T_ENT);
  check(
    'ENTERPRISE sweep deleted nothing — same data, longer plan',
    entSweep.deleted === 0 && entSweep.retentionDays === 365,
    entSweep,
  );

  // ════════════════════════════════════════════════════════════════════════
  section('6. A tenant whose retention is unset or zero is never swept');
  // ════════════════════════════════════════════════════════════════════════
  for (const n of [500, 400, 30]) {
    await insertTelemetry(T_UNSET, daysAgo(n), { temperature: n });
    await insertTelemetry(T_ZERO, daysAgo(n), { temperature: n });
  }

  const unsetSweep = await retentionService.sweepTenant(T_UNSET);
  check(
    'subscription with no dataRetentionDays → skipped, 0 deleted',
    unsetSweep.deleted === 0 && Boolean(unsetSweep.skipped),
    unsetSweep,
  );
  const zeroSweep = await retentionService.sweepTenant(T_ZERO);
  check(
    'dataRetentionDays: 0 → skipped, 0 deleted (not "delete everything")',
    zeroSweep.deleted === 0 && Boolean(zeroSweep.skipped),
    zeroSweep,
  );
  const survived: Array<{ n: string }> = await telemetryRepo.query(
    `SELECT count(*)::text AS n FROM telemetry WHERE "tenantId" = ANY($1)`,
    [[T_UNSET, T_ZERO]],
  );
  check(
    'all 6 of their rows, up to 500 days old, survive',
    survived[0].n === '6',
    survived[0],
  );

  // A tenant with no subscription row at all.
  const orphan = randomUUID();
  await telemetryRepo.query(
    `INSERT INTO tenants (id, name, email) VALUES ($1, $2, $3)`,
    [
      orphan,
      `Orphan ${orphan.slice(0, 8)}`,
      `orphan-${orphan.slice(0, 8)}@example.invalid`,
    ],
  );
  const orphanSweep = await retentionService.sweepTenant(orphan);
  check(
    'tenant with no subscription row → skipped',
    orphanSweep.deleted === 0 && Boolean(orphanSweep.skipped),
    orphanSweep,
  );

  // -1 is "unlimited" everywhere else in SubscriptionLimits; for retention that
  // must mean never delete.
  const unlimited = randomUUID();
  await telemetryRepo.query(
    `INSERT INTO tenants (id, name, email) VALUES ($1, $2, $3)`,
    [
      unlimited,
      `Unlimited ${unlimited.slice(0, 8)}`,
      `unl-${unlimited.slice(0, 8)}@example.invalid`,
    ],
  );
  await seedSubscription(unlimited, 'enterprise', { dataRetentionDays: -1 });
  const unlimitedResolved = await retentionService.resolveRetention(unlimited);
  check(
    'dataRetentionDays: -1 (unlimited) → never swept',
    unlimitedResolved.days === null,
    unlimitedResolved,
  );

  // A floor below which a configured value is refused.
  const flooredService = new TelemetryRetentionService(
    telemetryRepo,
    subscriptionRepo,
    rollupService,
    makeConfig({ TELEMETRY_RETENTION_MIN_DAYS: 14 }),
  );
  const flooredFree = await flooredService.resolveRetention(T_FREE);
  check(
    "TELEMETRY_RETENTION_MIN_DAYS=14 refuses the FREE plan's 7 days rather than deleting",
    flooredFree.days === null && String(flooredFree.reason).includes('below'),
    flooredFree,
  );

  // The env fallback is what lets a subscription-less tenant be swept at all.
  const fallbackService = new TelemetryRetentionService(
    telemetryRepo,
    subscriptionRepo,
    rollupService,
    makeConfig({ TELEMETRY_RETENTION_FALLBACK_DAYS: 90 }),
  );
  const fallbackResolved = await fallbackService.resolveRetention(T_UNSET);
  check(
    'TELEMETRY_RETENTION_FALLBACK_DAYS=90 gives an unset tenant 90 days, flagged as the fallback',
    fallbackResolved.days === 90 && fallbackResolved.source === 'fallback',
    fallbackResolved,
  );

  // ════════════════════════════════════════════════════════════════════════
  section('7. The batch bound holds on a large fixture');
  // ════════════════════════════════════════════════════════════════════════
  // 12,000 rows, all expired. batchSize 500, maxBatches 3 → exactly 1,500.
  await telemetryRepo.query(
    `INSERT INTO telemetry ("tenantId", "deviceId", "deviceKey", "timestamp", data)
     SELECT $1, $2, $3,
            now()::timestamp - interval '200 days' + (g || ' seconds')::interval,
            jsonb_build_object('temperature', (g % 50))
       FROM generate_series(1, 12000) g`,
    [T_BULK, devices[T_BULK], `fixture-${devices[T_BULK].slice(0, 8)}`],
  );
  const bulkBefore: Array<{ n: string }> = await telemetryRepo.query(
    `SELECT count(*)::text AS n FROM telemetry WHERE "tenantId" = $1`,
    [T_BULK],
  );
  check(
    '12,000-row fixture inserted',
    bulkBefore[0].n === '12000',
    bulkBefore[0],
  );

  const boundedService = new TelemetryRetentionService(
    telemetryRepo,
    subscriptionRepo,
    rollupService,
    makeConfig({
      TELEMETRY_RETENTION_BATCH_SIZE: 500,
      TELEMETRY_RETENTION_MAX_BATCHES: 3,
    }),
  );
  const bounded = await boundedService.sweepTenant(T_BULK);
  check(
    'sweep deleted exactly batchSize × maxBatches = 1,500 rows and stopped',
    bounded.deleted === 1500 && bounded.batches === 3,
    bounded,
  );
  check(
    'and reported moreRemaining, so the next run continues rather than claiming it finished',
    bounded.moreRemaining === true,
    bounded,
  );
  const bulkMid: Array<{ n: string }> = await telemetryRepo.query(
    `SELECT count(*)::text AS n FROM telemetry WHERE "tenantId" = $1`,
    [T_BULK],
  );
  check('10,500 rows remain', bulkMid[0].n === '10500', bulkMid[0]);

  // A second bounded run makes further progress — proving the sweep resumes.
  const bounded2 = await boundedService.sweepTenant(T_BULK);
  check(
    'a second run deletes another 1,500',
    bounded2.deleted === 1500,
    bounded2,
  );

  // Unbounded-but-batched: finish the job and confirm the final partial batch
  // is what terminates the loop (moreRemaining false).
  const finishService = new TelemetryRetentionService(
    telemetryRepo,
    subscriptionRepo,
    rollupService,
    makeConfig({
      TELEMETRY_RETENTION_BATCH_SIZE: 4000,
      TELEMETRY_RETENTION_MAX_BATCHES: 100,
    }),
  );
  const finished = await finishService.sweepTenant(T_BULK);
  check(
    'a run with room to finish deletes the remaining 9,000 in ⌈9000/4000⌉ = 3 batches and reports done',
    finished.deleted === 9000 &&
      finished.batches === 3 &&
      finished.moreRemaining === false,
    finished,
  );
  const bulkAfter: Array<{ n: string }> = await telemetryRepo.query(
    `SELECT count(*)::text AS n FROM telemetry WHERE "tenantId" = $1`,
    [T_BULK],
  );
  check('the bulk tenant is now empty', bulkAfter[0].n === '0', bulkAfter[0]);

  // ════════════════════════════════════════════════════════════════════════
  section('8. Overlapping cron ticks do not double-process');
  // ════════════════════════════════════════════════════════════════════════
  //
  // Two layers are tested separately because they catch different races.

  // ── Layer 1: the producer. Two ticks inside the same slot must produce one
  //    job, because the jobId is deterministic and slot-bucketed.
  const added: Array<{ name: string; jobId: string }> = [];
  const seenJobIds = new Set<string>();
  const fakeQueue: any = {
    // Emulates Bull: an add() whose jobId already exists is dropped.
    add: async (name: string, _data: unknown, opts: { jobId: string }) => {
      if (seenJobIds.has(opts.jobId)) return null;
      seenJobIds.add(opts.jobId);
      added.push({ name, jobId: opts.jobId });
      return { id: opts.jobId };
    },
    getWaitingCount: async () => 0,
    getActiveCount: async () => 0,
  };

  // Give the aggregation cron something to find: a recent reading.
  await insertTelemetry(T_FREE, new Date(), { temperature: 21 });

  const maintenance = new TelemetryMaintenanceService(
    fakeQueue,
    rollupService,
    retentionService,
  );

  await maintenance.enqueueAggregation();
  const afterFirstTick = added.length;
  await maintenance.enqueueAggregation();
  const afterSecondTick = added.length;
  check(
    'two aggregation ticks in the same 15-minute slot enqueue one job per tenant, not two',
    afterFirstTick > 0 && afterSecondTick === afterFirstTick,
    { afterFirstTick, afterSecondTick, jobIds: added.map((a) => a.jobId) },
  );

  await maintenance.enqueueCleanup();
  const cleanupCount = added.filter(
    (a) => a.name === 'cleanup-telemetry',
  ).length;
  await maintenance.enqueueCleanup();
  check(
    'two retention ticks on the same day enqueue one sweep per tenant',
    added.filter((a) => a.name === 'cleanup-telemetry').length ===
      cleanupCount && cleanupCount > 0,
    { cleanupCount },
  );

  // Idle tenants must not be enqueued at all. T_UNSET/T_ZERO have only rows
  // hundreds of days old, so they are outside the aggregation lookback.
  const aggregationJobIds = added
    .filter((a) => a.name === 'aggregate-telemetry')
    .map((a) => a.jobId);
  check(
    'an idle tenant (no telemetry in the lookback window) is not enqueued for aggregation',
    !aggregationJobIds.some(
      (id) => id.includes(T_UNSET) || id.includes(T_ZERO),
    ),
    aggregationJobIds,
  );

  // ── Layer 2: the consumer. A second job for the same tenant arriving while
  //    the first is still in flight must return `skipped`, not run the work.
  const emitter = new EventEmitter2();
  const alarmsStub: any = { checkAlarmConditions: async () => undefined };

  let concurrentCalls = 0;
  let maxConcurrent = 0;
  const slowRollupService: any = {
    settings: rollupService.settings,
    aggregateTenant: async (tenantId: string) => {
      concurrentCalls++;
      maxConcurrent = Math.max(maxConcurrent, concurrentCalls);
      await new Promise((resolve) => setTimeout(resolve, 150));
      concurrentCalls--;
      return [{ granularity: 'hour', from: null, to: null, rows: 1 }];
    },
    computeStatistics: async () => [],
    pruneRollups: async () => ({ hour: 0, coarse: 0 }),
  };

  const processor = new TelemetryProcessor(
    emitter,
    alarmsStub,
    slowRollupService,
    retentionService,
  );

  const [runA, runB] = await Promise.all([
    processor.aggregateTelemetry({
      id: 'a',
      data: { tenantId: T_FREE },
    } as any),
    processor.aggregateTelemetry({
      id: 'b',
      data: { tenantId: T_FREE },
    } as any),
  ]);
  check(
    'the overlapping job never entered the critical section (maxConcurrent = 1)',
    maxConcurrent === 1,
    { maxConcurrent },
  );
  const skippedOne =
    (runA as any)?.skipped === 'already running' ||
    (runB as any)?.skipped === 'already running';
  check(
    'exactly one of the two overlapping jobs reported skipped',
    skippedOne,
    {
      runA,
      runB,
    },
  );

  // A different tenant must NOT be blocked by the first tenant's lock.
  let parallelTenantsRan = 0;
  const countingRollupService: any = {
    settings: rollupService.settings,
    aggregateTenant: async () => {
      parallelTenantsRan++;
      await new Promise((resolve) => setTimeout(resolve, 50));
      return [];
    },
  };
  const processor2 = new TelemetryProcessor(
    emitter,
    alarmsStub,
    countingRollupService,
    retentionService,
  );
  await Promise.all([
    processor2.aggregateTelemetry({
      id: 'c',
      data: { tenantId: T_FREE },
    } as any),
    processor2.aggregateTelemetry({
      id: 'd',
      data: { tenantId: T_ENT },
    } as any),
  ]);
  check(
    'the lock is per tenant — two different tenants aggregate concurrently',
    parallelTenantsRan === 2,
    { parallelTenantsRan },
  );

  // ── Layer 3, the one that holds across processes: running the real window
  //    build twice concurrently still converges on the right numbers.
  await telemetryRepo.query('DELETE FROM telemetry WHERE "tenantId" = $1', [
    T_FREE,
  ]);
  await rollupRepo.query(
    'DELETE FROM telemetry_rollups WHERE "tenantId" = $1',
    [T_FREE],
  );
  await insertTelemetry(
    T_FREE,
    H(605),
    { temperature: 10 },
    { temperature: 10 },
  );
  await insertTelemetry(
    T_FREE,
    H(615),
    { temperature: 20 },
    { temperature: 20 },
  );
  await Promise.all([
    rollupService.buildFromTelemetry(T_FREE, 'hour', windowFrom, windowTo),
    rollupService.buildFromTelemetry(T_FREE, 'hour', windowFrom, windowTo),
    rollupService.buildFromTelemetry(T_FREE, 'hour', windowFrom, windowTo),
  ]).catch(() => undefined); // a serialisation conflict is acceptable; the numbers are not
  const concurrent = await rollupRepo.find({
    where: { tenantId: T_FREE, granularity: 'hour', key: 'temperature' },
  });
  check(
    'three concurrent builds of the same window leave one row with sum 30, not three rows or sum 90',
    concurrent.length === 1 &&
      near(concurrent[0].sumValue, 30) &&
      concurrent[0].sampleCount === 2,
    concurrent.map((c) => ({ sum: c.sumValue, n: c.sampleCount })),
  );

  // ════════════════════════════════════════════════════════════════════════
  section('9. Empty database, missing payloads and throwing jobs are safe');
  // ════════════════════════════════════════════════════════════════════════
  const emptyTenant = randomUUID();
  await telemetryRepo.query(
    `INSERT INTO tenants (id, name, email) VALUES ($1, $2, $3)`,
    [
      emptyTenant,
      `Empty ${emptyTenant.slice(0, 8)}`,
      `empty-${emptyTenant.slice(0, 8)}@example.invalid`,
    ],
  );
  await seedSubscription(emptyTenant, 'free', { dataRetentionDays: 7 });

  const emptyAgg = await rollupService.aggregateTenant(emptyTenant);
  check(
    'aggregating a tenant with zero rows succeeds and writes nothing',
    emptyAgg.every((r) => r.rows === 0),
    emptyAgg,
  );
  const emptyStats = await rollupService.computeStatistics(emptyTenant);
  check(
    'statistics on a tenant with zero rollups succeeds and writes nothing',
    emptyStats.every((r) => r.rows === 0),
    emptyStats,
  );
  const emptySweep = await retentionService.sweepTenant(emptyTenant);
  check(
    'sweeping a tenant with zero rows deletes 0 in 1 batch and reports done',
    emptySweep.deleted === 0 && emptySweep.moreRemaining === false,
    emptySweep,
  );

  const noTenantJob = await processor.aggregateTelemetry({
    id: 'x',
    data: {},
  } as any);
  check(
    'a job with no tenantId is refused rather than throwing or aggregating everything',
    (noTenantJob as any)?.skipped === 'no tenantId',
    noTenantJob,
  );

  // A throwing job must release its lock, or that tenant is wedged until the
  // process restarts.
  const throwingRollupService: any = {
    settings: rollupService.settings,
    aggregateTenant: async () => {
      throw new Error('simulated database failure');
    },
  };
  const throwingProcessor = new TelemetryProcessor(
    emitter,
    alarmsStub,
    throwingRollupService,
    retentionService,
  );
  let threw = false;
  try {
    await throwingProcessor.aggregateTelemetry({
      id: 'y',
      data: { tenantId: T_FREE },
    } as any);
  } catch {
    threw = true;
  }
  check('a failing job propagates so Bull can retry it', threw);

  let ranAfterThrow = false;
  (throwingProcessor as any).rollupService = {
    settings: rollupService.settings,
    aggregateTenant: async () => {
      ranAfterThrow = true;
      return [];
    },
  };
  await throwingProcessor.aggregateTelemetry({
    id: 'z',
    data: { tenantId: T_FREE },
  } as any);
  check(
    'the lock was released in `finally`, so the retry actually runs',
    ranAfterThrow,
  );

  // The producer must swallow its own failures: a @Cron that rejects leaves
  // nothing to reschedule the work.
  const brokenQueue: any = {
    add: async () => {
      throw new Error('redis unreachable');
    },
    getWaitingCount: async () => {
      throw new Error('redis unreachable');
    },
    getActiveCount: async () => {
      throw new Error('redis unreachable');
    },
  };
  const brokenMaintenance = new TelemetryMaintenanceService(
    brokenQueue,
    rollupService,
    retentionService,
  );
  let producerThrew = false;
  try {
    await brokenMaintenance.enqueueAggregation();
    await brokenMaintenance.enqueueCleanup();
    await brokenMaintenance.enqueueStatistics();
  } catch {
    producerThrew = true;
  }
  check(
    'an unreachable queue does not make the cron body reject',
    !producerThrew,
  );

  // ════════════════════════════════════════════════════════════════════════
  section('10. Rollup pruning and the watermark');
  // ════════════════════════════════════════════════════════════════════════
  await rollupRepo.query(
    'DELETE FROM telemetry_rollups WHERE "tenantId" = $1',
    [T_FREE],
  );
  await rollupRepo.query(
    `INSERT INTO telemetry_rollups
       ("tenantId","deviceId","deviceKey","granularity","bucket","key","sampleCount","rowCount","avgValue")
     VALUES
       ($1,$2,$3,'hour', now()::timestamp - interval '400 days','temperature',1,1,1),
       ($1,$2,$3,'day',  now()::timestamp - interval '400 days','temperature',1,1,1),
       ($1,$2,$3,'day',  now()::timestamp - interval '10 days','temperature',1,1,1)`,
    [T_FREE, devices[T_FREE], `fixture-${devices[T_FREE].slice(0, 8)}`],
  );
  // FREE keeps 7 days raw; hour rollups expire with it, day rollups at 7×12=84.
  const pruned = await rollupService.pruneRollups(T_FREE, 7);
  check(
    'the 400-day hour rollup and the 400-day day rollup are pruned, the 10-day one is kept',
    pruned.hour === 1 && pruned.coarse === 1,
    pruned,
  );
  const remaining = await rollupRepo.count({ where: { tenantId: T_FREE } });
  check('one rollup row remains', remaining === 1, { remaining });

  const wm = await rollupService.watermark(T_FREE, 'day');
  check('watermark returns the newest day bucket', wm !== null, wm);
  const noWm = await rollupService.watermark(T_FREE, 'month');
  check(
    'watermark is null when nothing has been rolled up',
    noWm === null,
    noWm,
  );
  check(
    'pruneRollups refuses a zero/negative retention rather than deleting everything',
    JSON.stringify(await rollupService.pruneRollups(T_FREE, 0)) ===
      JSON.stringify({ hour: 0, coarse: 0 }),
  );

  // ════════════════════════════════════════════════════════════════════════
  section('11. The cron path end to end, and the reads it feeds');
  // ════════════════════════════════════════════════════════════════════════
  //
  // Sections 2–4 drove `buildFromTelemetry` with explicit windows. This drives
  // the job entry point instead, so the watermark resolution, the "do not roll
  // up the current bucket" rule and the read-side granularity choice are all
  // exercised against the real clock.
  const liveTenant = T_ENT;
  await telemetryRepo.query('DELETE FROM telemetry WHERE "tenantId" = $1', [
    liveTenant,
  ]);
  await rollupRepo.query(
    'DELETE FROM telemetry_rollups WHERE "tenantId" = $1',
    [liveTenant],
  );

  // Five days of hourly readings, ending two hours ago so at least one bucket
  // is closed. value = hour index, so the day means are known.
  await telemetryRepo.query(
    `INSERT INTO telemetry ("tenantId", "deviceId", "deviceKey", "timestamp", data, temperature)
     SELECT $1, $2, $3,
            date_trunc('hour', now()::timestamp) - ((g + 2) || ' hours')::interval,
            jsonb_build_object('temperature', g::double precision),
            g
       FROM generate_series(1, 120) g`,
    [
      liveTenant,
      devices[liveTenant],
      `fixture-${devices[liveTenant].slice(0, 8)}`,
    ],
  );

  const liveRun = await rollupService.aggregateTenant(liveTenant);
  const hourResult = liveRun.find((r) => r.granularity === 'hour');
  const dayResult = liveRun.find((r) => r.granularity === 'day');
  check(
    'aggregateTenant built both hour and day rollups from the watermark',
    (hourResult?.rows ?? 0) > 0 && (dayResult?.rows ?? 0) > 0,
    liveRun,
  );

  const hourRowsAfterFirst = await rollupRepo.count({
    where: { tenantId: liveTenant, granularity: 'hour' },
  });
  await rollupService.aggregateTenant(liveTenant);
  const hourRowsAfterSecond = await rollupRepo.count({
    where: { tenantId: liveTenant, granularity: 'hour' },
  });
  check(
    'a second run adds no rows — the watermark stops it re-walking history',
    hourRowsAfterFirst === hourRowsAfterSecond && hourRowsAfterFirst > 0,
    { hourRowsAfterFirst, hourRowsAfterSecond },
  );

  const currentBucketRow = await rollupRepo.query(
    `SELECT count(*)::int AS n FROM telemetry_rollups
      WHERE "tenantId" = $1 AND "granularity" = 'hour'
        AND "bucket" >= date_trunc('hour', now()::timestamp)`,
    [liveTenant],
  );
  check(
    'the still-open current hour was NOT rolled up',
    currentBucketRow[0].n === 0,
    currentBucketRow[0],
  );

  await rollupService.computeStatistics(liveTenant);
  const weekRows = await rollupRepo.count({
    where: { tenantId: liveTenant, granularity: 'week' },
  });
  const monthRows = await rollupRepo.count({
    where: { tenantId: liveTenant, granularity: 'month' },
  });
  check(
    'the statistics job produced week and month rollups from the day rows',
    weekRows > 0 && monthRows > 0,
    { weekRows, monthRows },
  );

  // Now read them back through TelemetryService, which is what the controller's
  // timeseries / aggregated / statistics routes call.
  const noop: any = new Proxy({}, { get: () => async () => undefined });
  const telemetryService = new TelemetryService(
    telemetryRepo,
    dataSource.getRepository(entities.Device as any) as any,
    noop, // RedisService
    noop, // ProfileAlarmService
    noop, // IntegrationDispatchService
    noop, // AutomationService
    rollupService,
    retentionService,
  );

  const readFrom = new Date(Date.now() - 6 * 86_400_000).toISOString();
  const readTo = new Date().toISOString();

  const series = await telemetryService.getTimeSeries(
    devices[liveTenant],
    SUPER_USER,
    'temperature',
    readFrom,
    readTo,
  );
  check(
    'getTimeSeries over 6 days is served from rollups, with min/max/count per point',
    series.length > 0 &&
      series[0].source === 'rollup' &&
      typeof series[0].count === 'number' &&
      series[0].min !== undefined,
    series[0],
  );
  check(
    'and it covers the whole range rather than the oldest `limit` raw points',
    series.length >= 100,
    { points: series.length },
  );

  const aggregated = await telemetryService.getAggregated(
    devices[liveTenant],
    SUPER_USER,
    'day',
    readFrom,
    readTo,
  );
  check(
    'getAggregated(day) is served from rollups and keeps its original shape',
    aggregated.length > 0 &&
      aggregated[0].source === 'rollup' &&
      aggregated[0].temperature?.avg !== undefined &&
      typeof aggregated[0].count === 'number',
    aggregated[0],
  );
  check(
    'and it now also exposes every rolled-up key, not just the five denormalised columns',
    Boolean(aggregated[0].keys?.temperature),
    Object.keys(aggregated[0].keys ?? {}),
  );

  const serviceStats = await telemetryService.getStatistics(
    devices[liveTenant],
    SUPER_USER,
    readFrom,
    readTo,
  );
  // 120 hourly readings were inserted; the two most recent hours are excluded
  // by the "do not roll up the open bucket" rule only if they fall in it, so
  // assert the sum rather than an exact count: temperature = g for g in 1..120.
  check(
    'getStatistics over 6 days is served from rollups',
    serviceStats.source === 'rollup' && serviceStats.totalRecords > 0,
    { source: serviceStats.source, totalRecords: serviceStats.totalRecords },
  );
  check(
    'and its temperature min/max match the fixture (1 and 120)',
    near(serviceStats.temperature.min, 1) &&
      near(serviceStats.temperature.max, 120),
    serviceStats.temperature,
  );

  // A short range must stay on raw telemetry — the open bucket is not rolled up,
  // so a rollup answer to "the last hour" would be missing exactly the part the
  // user is watching.
  const shortFrom = new Date(Date.now() - 3 * 3_600_000).toISOString();
  const shortStats = await telemetryService.getStatistics(
    devices[liveTenant],
    SUPER_USER,
    shortFrom,
    readTo,
  );
  check(
    'a 3-hour range is answered from raw telemetry, not rollups',
    shortStats.source === 'raw',
    { source: shortStats.source },
  );

  // And the route still works before anything has been aggregated.
  const freshTenant = randomUUID();
  await telemetryRepo.query(
    `INSERT INTO tenants (id, name, email) VALUES ($1, $2, $3)`,
    [
      freshTenant,
      `Fresh ${freshTenant.slice(0, 8)}`,
      `fresh-${freshTenant.slice(0, 8)}@example.invalid`,
    ],
  );
  const freshDevice = randomUUID();
  await telemetryRepo.query(
    `INSERT INTO devices (id, "tenantId", "deviceKey", name, "userId")
     VALUES ($1, $2, $3, $4, $5)`,
    [
      freshDevice,
      freshTenant,
      `fresh-${freshDevice.slice(0, 8)}`,
      'Fresh device',
      USER,
    ],
  );
  await telemetryRepo.query(
    `INSERT INTO telemetry ("tenantId", "deviceId", "deviceKey", "timestamp", data, temperature)
     VALUES ($1, $2, $3, now()::timestamp - interval '3 days', '{"temperature": 7}'::jsonb, 7)`,
    [freshTenant, freshDevice, `fresh-${freshDevice.slice(0, 8)}`],
  );
  const freshStats = await telemetryService.getStatistics(
    freshDevice,
    SUPER_USER,
    readFrom,
    readTo,
  );
  check(
    'a wide range with no rollups yet falls back to a raw scan instead of returning nothing',
    freshStats.source === 'raw' && freshStats.totalRecords === 1,
    { source: freshStats.source, totalRecords: freshStats.totalRecords },
  );

  const rollupsRead = await telemetryService.getRollups(
    devices[liveTenant],
    SUPER_USER,
    'day' as any,
    readFrom,
    readTo,
    ['temperature'],
  );
  check(
    'getRollups returns the un-pivoted rows for a named key',
    rollupsRead.length > 0 && rollupsRead.every((r) => r.key === 'temperature'),
    rollupsRead[0],
  );

  const status = await telemetryService.getMaintenanceStatus(liveTenant);
  check(
    'getMaintenanceStatus reports the effective retention, its source and the expired-row count',
    status.retention.retention.days === 365 &&
      status.retention.retention.source === 'subscription' &&
      typeof status.retention.expiredRows === 'number' &&
      status.rollups.length >= 3,
    {
      retention: status.retention.retention,
      expiredRows: status.retention.expiredRows,
      granularities: status.rollups.map((r: any) => r.granularity),
    },
  );
  const unsetStatus = await telemetryService.getMaintenanceStatus(T_UNSET);
  check(
    "and flags a tenant nothing will ever sweep as source 'unset'",
    unsetStatus.retention.retention.source === 'unset' &&
      unsetStatus.retention.retention.days === null,
    unsetStatus.retention.retention,
  );

  await dataSource.destroy();

  console.log(
    failures
      ? `\nFAIL — ${failures} check(s) failed`
      : '\nPASS — retention is plan-driven and bounded, aggregation arithmetic is exact, and overlapping ticks do not double-process',
  );
  process.exit(failures ? 1 : 0);
})().catch((error) => {
  console.error('\nFAILED:', error?.message);
  console.error(error?.stack);
  process.exit(1);
});
