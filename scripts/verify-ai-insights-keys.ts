/**
 * ─────────────────────────────────────────────────────────────────────────────
 * Runtime proof: AI insights can see a device's telemetry keys
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * The bug: `POST /ai/insights/device/:id` answered 400
 *
 *     "This device has no telemetry in the selected window, so there is
 *      nothing to analyse."
 *
 * for a device whose telemetry was plainly visible in the Telemetry tab,
 * reported minutes earlier.
 *
 * The window was not the problem — insights defaults to seven days.
 * `AiInsightsService.analyseDevice()` asks `TelemetryService.getStatistics()`
 * for the device's key list:
 *
 *     const keys = Array.isArray(stats?.keys)
 *       ? stats.keys
 *       : Object.keys(stats?.statistics ?? {});
 *
 * and `getStatistics()` returned **neither** field in a usable form:
 *
 *   • the raw branch returned no `keys` and no `statistics` at all — it
 *     aggregates five hardcoded columns and never looks at `data`;
 *   • the rollup branch returned `keys` as a Record, not an array, so
 *     `Array.isArray` was false there too and the fallback found no
 *     `statistics` either.
 *
 * So `keys` was `[]` on every path and the route **always** 400'd, for every
 * device, regardless of telemetry. A feature that could never once have
 * worked — and that typechecks, because the consumer reads `any`.
 *
 * The second half matters as much: this device reports `co2`, which lives
 * only in the `data` jsonb. Aggregating the five denormalised columns would
 * still not have found it. Statistics are now computed over the actual keys
 * present.
 *
 *   npx ts-node -T -r tsconfig-paths/register scripts/verify-ai-insights-keys.ts [db]
 */
import { randomUUID } from 'crypto';
import { DataSource } from 'typeorm';

import * as entities from '../src/modules/index.entities';
import { Telemetry } from '../src/modules/telemetry/entities/telemetry.entity';
import { Device } from '../src/modules/devices/entities/device.entity';
import { TelemetryService } from '../src/modules/telemetry/telemetry.service';
import { UserRole } from '../src/common/enums/user.enum';
import { AiInsightsService } from '../src/modules/ai/ai-insights.service';
import { BadRequestException } from '@nestjs/common';
import { HttpExceptionFilter } from '../src/common/filters/http-exception.filter';

const database = process.argv[2] ?? 'aiinsights';

let failures = 0;
let checks = 0;
const ok = (label: string, condition: boolean, detail?: unknown) => {
  checks++;
  if (condition) console.log(`  \u001b[32m✓\u001b[0m ${label}`);
  else {
    failures++;
    console.error(`  \u001b[31m✗\u001b[0m ${label}`, detail ?? '');
  }
};
const section = (title: string) =>
  console.log(`\n── ${title} ${'─'.repeat(Math.max(0, 58 - title.length))}`);

const TENANT = randomUUID();
const USER = randomUUID();
const DEVICE = randomUUID();
const DEVICE_KEY = `key-${DEVICE.slice(0, 8)}`;

(async () => {
  const dataSource = new DataSource({
    type: 'postgres',
    host: process.env.DB_HOST ?? 'localhost',
    port: Number(process.env.DB_PORT ?? 5432),
    username: process.env.DB_USERNAME ?? 'postgres',
    password: process.env.DB_PASSWORD ?? '123456',
    database,
    entities: Object.values(entities) as any[],
    synchronize: true,
    logging: false,
  });
  await dataSource.initialize();

  const q = (sql: string, params: any[] = []) => dataSource.query(sql, params);

  // Swept by tenant-name prefix, not just this run's ids: a run killed before
  // its cleanup leaves devices behind, and `tenants.name` is UNIQUE, so the
  // next run would fail on a foreign key or a duplicate key rather than on
  // anything it is meant to test. Children first — devices reference tenants.
  const cleanup = async () => {
    const stale = `SELECT id FROM tenants WHERE name LIKE 'ai-insights-keys%'`;
    await q(`DELETE FROM telemetry WHERE "tenantId" IN (${stale})`);
    await q('DELETE FROM telemetry WHERE "deviceId" = $1', [DEVICE]);
    await q(`DELETE FROM devices WHERE "tenantId" IN (${stale})`);
    await q(`DELETE FROM users WHERE "tenantId" IN (${stale})`);
    await q(`DELETE FROM tenants WHERE name LIKE 'ai-insights-keys%'`);
  };
  await cleanup();

  await q('INSERT INTO tenants (id, name, email) VALUES ($1, $2, $3)', [
    TENANT,
    `ai-insights-keys ${TENANT.slice(0, 8)}`,
    `t-${TENANT.slice(0, 8)}@example.test`,
  ]);
  await q(
    'INSERT INTO users (id, name, email, password, "tenantId", role) VALUES ($1,$2,$3,$4,$5,$6)',
    [
      USER,
      'ai-insights-user',
      `u-${USER.slice(0, 8)}@example.test`,
      'not-a-real-hash',
      TENANT,
      UserRole.TENANT_ADMIN,
    ],
  );
  await q(
    `INSERT INTO devices (id, name, "deviceKey", "tenantId", "userId")
     VALUES ($1, $2, $3, $4, $5)`,
    [DEVICE, 'ai-insights-device', DEVICE_KEY, TENANT, USER],
  );

  // Exactly the reported shape: co2 lives ONLY in the jsonb payload, while
  // temperature is also denormalised onto its column. A fix that only reads
  // the columns would find temperature and silently lose co2 — which is the
  // half of this bug that would otherwise survive.
  const now = Date.now();
  for (let i = 0; i < 6; i++) {
    await q(
      `INSERT INTO telemetry (id, "deviceId", "deviceKey", "tenantId", timestamp, data, temperature)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [
        randomUUID(),
        DEVICE,
        DEVICE_KEY,
        TENANT,
        new Date(now - i * 60_000),
        JSON.stringify({ co2: 40 + i, temperature: 22 + i * 0.5 }),
        22 + i * 0.5,
      ],
    );
  }

  const noop: any = new Proxy({}, { get: () => async () => undefined });
  const rollupStub: any = {
    shouldUseRollups: () => false,
    pickGranularity: () => 'hour',
    readStatistics: async () => ({ buckets: 0, keys: {} }),
    readSeries: async () => [],
    readAllKeys: async () => [],
  };

  const service = new TelemetryService(
    dataSource.getRepository(Telemetry) as any,
    dataSource.getRepository(Device) as any,
    noop, // RedisService
    { read: async () => null, write: async () => undefined } as any, // latest cache
    noop, // ProfileAlarmService
    noop, // IntegrationDispatchService
    noop, // AutomationService
    rollupStub,
    noop, // TelemetryRetentionService
  );

  const caller = { id: USER, role: UserRole.TENANT_ADMIN, tenantId: TENANT };
  const start = new Date(now - 7 * 24 * 60 * 60 * 1000).toISOString();
  const end = new Date(now + 60_000).toISOString();

  // ── The contract AiInsightsService actually depends on ──────────────────
  section('1. getStatistics answers the question insights asks');

  const stats: any = await service.getStatistics(DEVICE, USER, start, end);

  ok('there is telemetry in the window', stats.totalRecords === 6, stats.totalRecords);

  // This is the exact expression in AiInsightsService.analyseDevice().
  const keys: string[] = Array.isArray(stats?.keys)
    ? stats.keys
    : Object.keys(stats?.statistics ?? {});

  ok(
    'the key list is non-empty — the 400 does not fire',
    keys.length > 0,
    'getStatistics returned neither a keys array nor a statistics map',
  );
  ok(
    'a jsonb-only key (co2) is found, not just the denormalised columns',
    keys.includes('co2'),
    keys,
  );
  ok('a denormalised key (temperature) is found too', keys.includes('temperature'), keys);
  ok(
    'the key list has no duplicates when a key is in BOTH data and a column',
    new Set(keys).size === keys.length,
    keys,
  );

  // ── Per-key statistics ──────────────────────────────────────────────────
  section('2. The numbers are right, not merely present');

  const co2 = stats.statistics?.co2;
  ok('co2 statistics are returned', !!co2, stats.statistics);
  // Values inserted: 40..45
  ok('co2 min is 40', co2?.min === 40, co2);
  ok('co2 max is 45', co2?.max === 45, co2);
  ok('co2 avg is 42.5', Math.abs((co2?.avg ?? 0) - 42.5) < 0.0001, co2);
  ok('co2 count is 6', co2?.count === 6, co2);

  // ── Non-numeric values must not poison the aggregate ────────────────────
  section('3. A non-numeric key is listed but not averaged');

  await q(
    `INSERT INTO telemetry (id, "deviceId", "deviceKey", "tenantId", timestamp, data)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [
      randomUUID(),
      DEVICE,
      DEVICE_KEY,
      TENANT,
      new Date(now - 7 * 60_000),
      JSON.stringify({ co2: 46, status: 'online' }),
    ],
  );

  const withText: any = await service.getStatistics(DEVICE, USER, start, end);
  const textKeys: string[] = Array.isArray(withText?.keys)
    ? withText.keys
    : Object.keys(withText?.statistics ?? {});

  ok('the text key appears in the key list', textKeys.includes('status'), textKeys);
  ok(
    'and it did not break the numeric aggregation of other keys',
    withText.statistics?.co2?.count === 7,
    withText.statistics?.co2,
  );
  ok(
    'a non-numeric key reports no average rather than NaN',
    withText.statistics?.status?.avg === null ||
      withText.statistics?.status?.avg === undefined,
    withText.statistics?.status,
  );

  // ── The rollup path must answer the same question ───────────────────────
  section('4. The rollup path returns the same shape');

  const rollupService: any = {
    shouldUseRollups: () => true,
    pickGranularity: () => 'hour',
    readStatistics: async () => ({
      buckets: 3,
      totalRecords: 7,
      firstRecord: new Date(now - 7 * 60_000),
      lastRecord: new Date(now),
      keys: {
        co2: { avg: 42.5, min: 40, max: 46, count: 7 },
        temperature: { avg: 23.25, min: 22, max: 24.5, count: 6 },
      },
    }),
    readSeries: async () => [],
    readAllKeys: async () => [],
  };

  const rollupBacked = new TelemetryService(
    dataSource.getRepository(Telemetry) as any,
    dataSource.getRepository(Device) as any,
    noop,
    { read: async () => null, write: async () => undefined } as any,
    noop,
    noop,
    noop,
    rollupService,
    noop,
  );

  const rolled: any = await rollupBacked.getStatistics(DEVICE, USER, start, end);
  const rolledKeys: string[] = Array.isArray(rolled?.keys)
    ? rolled.keys
    : Object.keys(rolled?.statistics ?? {});

  ok('the rollup branch was taken', rolled.source === 'rollup', rolled.source);
  ok(
    'and insights can read its keys with the SAME expression',
    rolledKeys.includes('co2') && rolledKeys.includes('temperature'),
    rolledKeys,
  );
  ok(
    'per-key statistics are present on the rollup path too',
    rolled.statistics?.co2?.max === 46,
    rolled.statistics?.co2,
  );

  // ── Genuinely empty must still refuse ───────────────────────────────────
  section('5. A device with no telemetry still reports none');

  const emptyWindowStart = new Date(now - 90 * 24 * 60 * 60 * 1000).toISOString();
  const emptyWindowEnd = new Date(now - 60 * 24 * 60 * 60 * 1000).toISOString();
  const empty: any = await service.getStatistics(
    DEVICE,
    USER,
    emptyWindowStart,
    emptyWindowEnd,
  );
  const emptyKeys: string[] = Array.isArray(empty?.keys)
    ? empty.keys
    : Object.keys(empty?.statistics ?? {});
  ok(
    'an empty window yields no keys, so the 400 is still correct there',
    emptyKeys.length === 0,
    emptyKeys,
  );

  // ── The rest of the chain insights depends on ───────────────────────────
  section('6. getTimeSeries serves every key the list advertises');

  // Finding the keys is only the first gate. analyseDevice() then calls
  // getTimeSeries() per key and throws NO_NUMERIC_TELEMETRY if every one comes
  // back empty — so a key list that getTimeSeries cannot serve just moves the
  // 400 one line down.
  for (const key of ['co2', 'temperature']) {
    const points = await service.getTimeSeries(DEVICE, USER, key, start, end, 2000);
    ok(
      `getTimeSeries returns points for "${key}"`,
      Array.isArray(points) && points.length > 0,
      points,
    );
    ok(
      `the points for "${key}" carry numeric values`,
      points.every((p: any) => typeof p.value === 'number' && Number.isFinite(p.value)),
      points?.slice(0, 2),
    );
  }

  // ── SQL injection through the key name ──────────────────────────────────
  section('7. A crafted key name cannot alter the query');

  // `key` arrives raw from @Query('key'). It used to be interpolated into the
  // SELECT as `telemetry.data->>'<key>'`. The `data ? :key` predicate limits
  // that but does not close it: ingestion accepts ARBITRARY key names, so a
  // tenant can store a row whose jsonb key IS the injected fragment and make
  // the predicate match.
  //
  // So the fixture stores exactly such a row, which is the condition the old
  // code needed to be exploitable.
  const CRAFTED = `x' AS v, (SELECT current_database()) AS "value" --`;
  await q(
    `INSERT INTO telemetry (id, "deviceId", "deviceKey", "tenantId", timestamp, data)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [
      randomUUID(),
      DEVICE,
      DEVICE_KEY,
      TENANT,
      new Date(now - 8 * 60_000),
      JSON.stringify({ [CRAFTED]: 7 }),
    ],
  );

  let injectionThrew = false;
  let injected: any[] = [];
  try {
    injected = await service.getTimeSeries(DEVICE, USER, CRAFTED, start, end, 10);
  } catch {
    // A syntax error would also mean "not executed as SQL", but the bound
    // form should simply treat it as a key name.
    injectionThrew = true;
  }

  ok(
    'a key containing quotes is treated as a key, not as SQL',
    !injectionThrew,
    'the crafted key reached the parser',
  );
  ok(
    'and it returns the stored VALUE, not the result of the injected SELECT',
    injected.length === 1 && Number(injected[0]?.value) === 7,
    injected,
  );
  ok(
    'the database name does not appear in the result',
    !injected.some((p: any) => String(p?.value) === database),
    injected,
  );

  // ── analyseDevice itself, which is what the user actually calls ────────
  section('8. The real analyseDevice, end to end');

  // The earlier sections stop at getTimeSeries. That is one gate short:
  // analyseDevice() then calls summarise() per key, which returns null for a
  // series of fewer than MIN_POINTS_PER_SERIES readings — so a device with a
  // single reading still 400s, now with NOT_ENOUGH_READINGS. Testing the
  // pieces and not the whole is how that gate was missed the first time.
  const insights = new AiInsightsService(
    { resolveDefaultModel: async () => null, complete: async () => ({}) } as any,
    { get: () => service } as any,
  );
  // AiInsightsService resolves TelemetryService in onModuleInit, not in its
  // constructor, so a hand-built instance has `this.telemetry` undefined until
  // the hook runs. Nest calls it; a script has to.
  insights.onModuleInit();

  const analyse = async (deviceId: string) => {
    try {
      await insights.analyseDevice({
        deviceId,
        userId: USER,
        tenantId: TENANT,
      } as any);
      return { code: 'OK', message: '' };
    } catch (error: any) {
      const body = error?.response ?? error;
      return { code: body?.code ?? error?.name, message: body?.message ?? '' };
    }
  };

  // This device has 6+ readings for co2, so it must get PAST the telemetry
  // gates. It stops at the model gate, which is the correct next failure for
  // a tenant with no AI model configured.
  const rich = await analyse(DEVICE);
  ok(
    'a device with real telemetry gets past the telemetry gates',
    rich.code === 'NO_AI_MODEL_CONFIGURED',
    rich,
  );

  // A device with exactly ONE reading — the reported case.
  const THIN = randomUUID();
  const THIN_KEY = `key-${THIN.slice(0, 8)}`;
  await q(
    `INSERT INTO devices (id, name, "deviceKey", "tenantId", "userId")
     VALUES ($1, $2, $3, $4, $5)`,
    [THIN, 'thin-device', THIN_KEY, TENANT, USER],
  );
  await q(
    `INSERT INTO telemetry (id, "deviceId", "deviceKey", "tenantId", timestamp, data)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [randomUUID(), THIN, THIN_KEY, TENANT, new Date(now), JSON.stringify({ co2: 48 })],
  );

  const thin = await analyse(THIN);
  ok(
    'one reading is reported as NOT_ENOUGH_READINGS, not "no telemetry"',
    thin.code === 'NOT_ENOUGH_READINGS',
    thin,
  );
  ok(
    'and the message says how many were found and how many are needed',
    /only 1 reading/.test(thin.message) && /at least 2/.test(thin.message),
    thin.message,
  );
  ok(
    'it does not claim the device has no telemetry',
    !/no telemetry/i.test(thin.message),
    thin.message,
  );

  // A device whose only key is textual: a different problem, different answer.
  const TEXT = randomUUID();
  const TEXT_KEY = `key-${TEXT.slice(0, 8)}`;
  await q(
    `INSERT INTO devices (id, name, "deviceKey", "tenantId", "userId")
     VALUES ($1, $2, $3, $4, $5)`,
    [TEXT, 'text-device', TEXT_KEY, TENANT, USER],
  );
  for (let i = 0; i < 3; i++) {
    await q(
      `INSERT INTO telemetry (id, "deviceId", "deviceKey", "tenantId", timestamp, data)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [
        randomUUID(),
        TEXT,
        TEXT_KEY,
        TENANT,
        new Date(now - i * 60_000),
        JSON.stringify({ state: 'online' }),
      ],
    );
  }

  const textual = await analyse(TEXT);
  ok(
    'a textual-only device is reported as NO_NUMERIC_TELEMETRY',
    textual.code === 'NO_NUMERIC_TELEMETRY',
    textual,
  );
  ok(
    'and the message names the key it found',
    /state/.test(textual.message),
    textual.message,
  );

  // A device with genuinely nothing keeps the original answer.
  const BARE = randomUUID();
  await q(
    `INSERT INTO devices (id, name, "deviceKey", "tenantId", "userId")
     VALUES ($1, $2, $3, $4, $5)`,
    [BARE, 'bare-device', `key-${BARE.slice(0, 8)}`, TENANT, USER],
  );
  const bare = await analyse(BARE);
  ok(
    'a device with no telemetry at all still reports NO_TELEMETRY_IN_WINDOW',
    bare.code === 'NO_TELEMETRY_IN_WINDOW',
    bare,
  );

  await q('DELETE FROM telemetry WHERE "deviceId" = ANY($1)', [[THIN, TEXT, BARE]]);
  await q('DELETE FROM devices WHERE id = ANY($1)', [[THIN, TEXT, BARE]]);

  // ── The wire format, which is what the UI switches on ──────────────────
  section('9. The exception filter forwards the error code');

  // Closing the loop: a service that throws a code is useless if the filter
  // drops it. It did — which is why the UI had to substring-match English
  // prose, and why rewording a message silently reclassified the error.
  {
    const captured: { status?: number; body?: any } = {};
    const host: any = {
      switchToHttp: () => ({
        getResponse: () => ({
          status(code: number) {
            captured.status = code;
            return this;
          },
          json(body: any) {
            captured.body = body;
          },
        }),
        getRequest: () => ({ url: '/ai/insights/device/x', method: 'POST' }),
      }),
    };

    new HttpExceptionFilter().catch(
      new BadRequestException({
        code: 'NOT_ENOUGH_READINGS',
        message: 'only 1 reading(s) ... at least 2 are needed',
        details: { minimumReadings: 2, keys: [{ key: 'co2', readings: 1 }] },
      }),
      host,
    );

    ok('the response is a 400', captured.status === 400, captured.status);
    ok(
      'the machine-readable code survives the filter',
      captured.body?.code === 'NOT_ENOUGH_READINGS',
      captured.body,
    );
    ok(
      'the structured details survive too',
      captured.body?.details?.minimumReadings === 2,
      captured.body?.details,
    );
    ok(
      'and the human message is still there',
      typeof captured.body?.message === 'string' &&
        captured.body.message.includes('at least 2'),
      captured.body?.message,
    );
  }

  // ── Tenancy is unchanged ────────────────────────────────────────────────
  section('10. Scoping still applies');

  let refused = false;
  try {
    await service.getStatistics(DEVICE, randomUUID(), start, end);
  } catch {
    refused = true;
  }
  ok('a caller who cannot see the device is refused', refused);

  await cleanup();
  await dataSource.destroy();

  console.log(
    failures === 0
      ? `\n\u001b[32mPASS\u001b[0m — ${checks} checks: AI insights can see a device's telemetry keys\n`
      : `\n\u001b[31mFAIL\u001b[0m — ${failures} of ${checks} checks failed\n`,
  );
  process.exit(failures === 0 ? 0 : 1);
})().catch((error) => {
  console.error('\n\u001b[31mFAIL\u001b[0m — the verifier itself crashed:', error);
  process.exit(1);
});
