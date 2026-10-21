/**
 * ─────────────────────────────────────────────────────────────────────────────
 * Guard: the application actually boots
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * Nothing in this repository ran `node dist/main.js` until something had
 * already broken it.
 *
 * `tsc` cannot see a dependency-injection graph. `check:swagger` builds a
 * `ProbeModule` rather than the real `AppModule`, so it never resolves most
 * feature modules — its claim to be "the only check that covers bootstrap()"
 * was overstated. Every other guard reads source or constructs a service by
 * hand.
 *
 * The bug that prompted this: `TelemetryGateway` had been dead code, present
 * in no module's `providers`, so Nest never instantiated it. Registering it in
 * `TelemetryModule` made it real — and made its `@UseGuards(WsJwtGuard)`
 * resolvable only in a module that provides `JwtService`, which
 * `TelemetryModule` did not:
 *
 *     Nest can't resolve dependencies of the WsJwtGuard (?, ConfigService).
 *     Please make sure that the argument JwtService at index [0] is available
 *     in the TelemetryModule context.
 *
 * The application would not start at all. Every static guard passed, the build
 * succeeded (SWC does not typecheck, and this was not a type error anyway),
 * and both typecheck configs were clean.
 *
 * So this one does the only thing that could have caught it: it builds, starts
 * the real process, and waits for it to answer an HTTP request.
 *
 *   npm run check:boot [db]
 *
 * It needs Postgres. It synchronises the schema into its own scratch database
 * first, because a boot against an empty database dies on an unhandled
 * `relation "schedules" does not exist` from a startup query — worth knowing,
 * but a different failure from the one being guarded here.
 */
import { spawn, spawnSync } from 'child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { DataSource } from 'typeorm';

import * as entities from '../src/modules/index.entities';

const root = join(__dirname, '..');
const database = process.argv[2] ?? 'bootcheck';
const PORT = Number(process.env.BOOT_CHECK_PORT ?? 3399);
// The Redis-down phase boots a second time, which roughly doubles the run.
// `--no-redis-phase` skips it for a quick DI-only check.
const skipRedisDownPhase = process.argv.includes('--no-redis-phase');

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

const PG = {
  host: process.env.DB_HOST ?? 'localhost',
  port: process.env.DB_PORT ?? '5432',
  user: process.env.DB_USERNAME ?? 'postgres',
  password: process.env.DB_PASSWORD ?? '123456',
};

/**
 * The minimum environment the application insists on.
 *
 * Most of these are `envRequired()` or an explicit throw in a module's
 * constructor — deliberate fail-fast checks, so they are satisfied rather than
 * weakened. Values are obvious placeholders: nothing here reaches a real
 * service, because every outbound integration is switched off below.
 *
 * Keeping this list in the guard has a side benefit: it is an executable
 * record of what a deployment genuinely cannot start without, and it fails
 * the moment that set grows.
 */
function bootEnv(): Record<string, string> {
  return {
    NODE_ENV: 'development',
    PORT: String(PORT),

    DB_HOST: PG.host,
    DB_PORT: PG.port,
    DB_USERNAME: PG.user,
    DB_PASSWORD: PG.password,
    DB_DATABASE: database,

    REDIS_HOST: process.env.REDIS_HOST ?? '127.0.0.1',
    REDIS_PORT: process.env.REDIS_PORT ?? '6379',

    // Every outbound transport off: this asserts that the process starts and
    // serves, not that a broker is reachable. Kafka and MQTT are meant to
    // degrade rather than block the boot (§11a) — if that regresses, this
    // guard is where it shows up.
    MQTT_ENABLED: 'false',
    KAFKA_ENABLED: 'false',
    MODBUS_ENABLED: 'false',
    SNMP_ENABLED: 'false',
    COAP_ENABLED: 'false',
    OPCUA_ENABLED: 'false',
    BACNET_ENABLED: 'false',
    // Required by env.validation even when KAFKA_ENABLED=false.
    KAFKA_BROKERS: '127.0.0.1:9092',
    MQTT_BROKER_URL: 'mqtt://127.0.0.1:1883',

    JWT_SECRET: 'check-boot-secret-long-enough-to-satisfy-validation',
    JWT_REFRESH_SECRET: 'check-boot-refresh-secret-long-enough-to-satisfy',
    ENCRYPTION_KEY:
      '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',

    // Absolute URLs — validation rejects a bare string.
    BACKEND_URL: `http://localhost:${PORT}`,
    OTA_PUBLIC_URL: `http://localhost:${PORT}`,
    FRONTEND_URL: 'http://localhost:5173',

    // Passport strategies construct eagerly and throw without a clientID.
    GOOGLE_CLIENT_ID: 'check-boot-google-id',
    GOOGLE_CLIENT_SECRET: 'check-boot-google-secret',
    GOOGLE_CALLBACK_URL: `http://localhost:${PORT}/auth/google/callback`,
    GITHUB_CLIENT_ID: 'check-boot-github-id',
    GITHUB_CLIENT_SECRET: 'check-boot-github-secret',
    GITHUB_CALLBACK_URL: `http://localhost:${PORT}/auth/github/callback`,
    APPLE_CLIENT_ID: 'check-boot-apple-id',
    APPLE_TEAM_ID: 'check-boot-team',
    APPLE_KEY_ID: 'check-boot-key',
    APPLE_CALLBACK_URL: `http://localhost:${PORT}/auth/apple/callback`,

    MOYASAR_API_KEY: 'sk_test_check_boot',
    MOYASAR_PUBLISHABLE_KEY: 'pk_test_check_boot',
  };
}

async function get(path: string, timeoutMs = 4000): Promise<{ status: number; body: string } | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(`http://127.0.0.1:${PORT}${path}`, {
      signal: controller.signal,
    });
    return { status: response.status, body: await response.text() };
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

(async () => {
  console.log(`\n── Boot check (database "${database}", port ${PORT}) ───────────\n`);

  // ── 0. Schema ───────────────────────────────────────────────────────────
  spawnSync('createdb', ['-h', PG.host, '-p', PG.port, '-U', PG.user, database], {
    env: { ...process.env, PGPASSWORD: PG.password },
    stdio: 'ignore',
  });

  const schema = new DataSource({
    type: 'postgres',
    host: PG.host,
    port: Number(PG.port),
    username: PG.user,
    password: PG.password,
    database,
    entities: Object.values(entities) as any[],
    synchronize: true,
    logging: false,
  });
  try {
    await schema.initialize();
    await schema.destroy();
    ok('the entity graph synchronises into a fresh database', true);
  } catch (error) {
    ok('the entity graph synchronises into a fresh database', false, (error as Error).message);
    console.error('\n\u001b[31mFAIL\u001b[0m — cannot prepare a schema to boot against\n');
    process.exit(1);
  }

  // ── 0b. The connection's time zone ──────────────────────────────────────
  //
  // Every timestamp column here is `timestamp WITHOUT time zone`, and several
  // queries compare one against `NOW()` (a timestamptz). Postgres reads the
  // naive side in the session time zone, so anything but UTC shifts those
  // comparisons by the offset — a trial ending an hour from now reports as
  // expired, scheduled notifications fire early, and nothing errors.
  //
  // The pool pins `-c timezone=UTC`. This asserts the pin actually reaches a
  // connection, against a server deliberately set to a non-UTC zone — because
  // a check that passes only because the server already runs UTC proves
  // nothing about the deployment that does not.
  {
    // Apply the boot environment first, then load the application's own
    // DataSource so its env-dependent module body can evaluate.
    Object.assign(process.env, bootEnv());
    // `require` rather than `await import(...)`: this file compiles under
    // moduleResolution node16, where a relative dynamic import needs an
    // explicit .js extension that does not exist in the TS source tree.
    // ts-node runs this as CommonJS, so require is the honest spelling.
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { AppDataSource } = require('../src/database/data-source');
    const appPoolExtra = (AppDataSource.options as any).extra;

    const probe = new DataSource({
      type: 'postgres',
      host: PG.host,
      port: Number(PG.port),
      username: PG.user,
      password: PG.password,
      database,
      entities: [],
      synchronize: false,
      logging: false,
      // The APPLICATION'S OWN pool settings, not a hardcoded pin. Copying
      // `options: '-c timezone=UTC'` in here would prove only that the
      // technique works — it would pass just as happily if the application
      // had no pin at all.
      //
      // Imported lazily: data-source.ts calls envRequired('DB_HOST') at module
      // load, so importing it at the top of this file throws before the boot
      // environment has been assembled.
      extra: appPoolExtra,
    } as any);
    try {
      await probe.initialize();
      const [{ TimeZone }] = await probe.query('SHOW TimeZone');
      ok(
        'the pool pins the session time zone to UTC',
        String(TimeZone).toUpperCase() === 'UTC',
        `SHOW TimeZone returned "${TimeZone}" — naive timestamp vs NOW() comparisons will skew`,
      );

      // The discriminating case: a value one hour in the FUTURE must not read
      // as past. Under a local-time session it does.
      const [{ expired }] = await probe.query(
        `SELECT (((now() AT TIME ZONE 'UTC') + interval '1 hour')::timestamp <= NOW()) AS expired`,
      );
      ok(
        'a timestamp one hour in the future does not read as already past',
        expired === false,
        'this is exactly how trials expire early and schedules fire early',
      );
      await probe.destroy();
    } catch (error) {
      ok('the time-zone probe connects', false, (error as Error).message);
      if (probe.isInitialized) await probe.destroy();
    }
  }

  // ── 1. Build ────────────────────────────────────────────────────────────
  const build = spawnSync('npm', ['run', 'build'], {
    cwd: root,
    encoding: 'utf8',
    timeout: 8 * 60 * 1000,
  });
  ok('the project builds', build.status === 0, build.stderr?.slice(-400));
  if (build.status !== 0) {
    console.error('\n\u001b[31mFAIL\u001b[0m — nothing to boot\n');
    process.exit(1);
  }

  // ── 2. Boot ─────────────────────────────────────────────────────────────
  const envDir = mkdtempSync(join(tmpdir(), 'check-boot-'));
  // Written to a file as well as passed in the environment: ConfigModule is
  // configured to load `.env.${NODE_ENV}`, and a stray one in the working
  // directory would otherwise override what is set here.
  writeFileSync(
    join(envDir, 'boot.env'),
    Object.entries(bootEnv())
      .map(([k, v]) => `${k}=${v}`)
      .join('\n'),
  );

  const child = spawn('node', ['dist/main.js'], {
    cwd: root,
    env: { ...process.env, ...bootEnv() },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  let output = '';
  child.stdout.on('data', (chunk) => (output += chunk.toString()));
  child.stderr.on('data', (chunk) => (output += chunk.toString()));

  let exited: number | null = null;
  child.on('exit', (code) => (exited = code ?? -1));

  // Poll rather than sleep a fixed time: a slow machine should not fail, and
  // a fast one should not wait.
  let health: Awaited<ReturnType<typeof get>> = null;
  const deadline = Date.now() + 90_000;
  while (Date.now() < deadline) {
    if (exited !== null) break;
    health = await get('/health');
    if (health) break;
    await sleep(1000);
  }

  const plain = output.replace(/\u001b\[[0-9;]*m/g, '');

  ok(
    'the process does not exit during startup',
    exited === null,
    exited !== null
      ? plain
          .split('\n')
          .filter((l) => /ERROR|Error:/.test(l))
          .slice(0, 3)
          .join('\n       ')
      : undefined,
  );

  ok(
    'GET /health answers 200 — the real AppModule resolved and is serving',
    health?.status === 200,
    health ? `status ${health.status}` : 'no response within 90s',
  );

  // The DI failure this guard exists for surfaces as this exact message.
  ok(
    'no dependency could not be resolved',
    !/can't resolve dependencies/.test(plain),
    plain
      .split('\n')
      .find((l) => l.includes("can't resolve dependencies"))
      ?.slice(0, 220),
  );

  ok(
    'no module is missing from an import graph',
    !/Nest cannot create the module instance|UnknownModuleException/.test(plain),
  );

  const cluster = await get('/health/cluster');
  ok(
    'GET /health/cluster answers, so cron skips are observable (§12)',
    cluster?.status === 200,
    cluster ? `status ${cluster.status}` : 'no response',
  );
  if (cluster?.status === 200) {
    let parsed: any;
    try {
      parsed = JSON.parse(cluster.body);
    } catch {
      parsed = undefined;
    }
    const payload = parsed?.data ?? parsed;
    ok(
      'and it reports whether this replica is dropping scheduled work',
      typeof payload?.degraded === 'boolean',
      payload,
    );
  }

  // Kafka and MQTT are off; neither should have stopped the boot.
  ok(
    'the boot survives Kafka being disabled (§11a)',
    !/KafkaJSNonRetriableError[\s\S]{0,200}ExceptionHandler/.test(plain),
  );

  child.kill('SIGTERM');
  await sleep(1500);
  if (exited === null) child.kill('SIGKILL');

  // ── 3. The same boot, with Redis unreachable ────────────────────────────
  //
  // `CacheModule` did `store: await redisStore(...)`, and a rejected provider
  // factory makes Nest abort the DI graph before `app.listen()`. So an
  // unreachable Redis meant NO application — no HTTP server, no /health, just
  // `connect ECONNREFUSED 127.0.0.1:6379` with nothing naming the cache as
  // the cause. And `CACHE_MANAGER` has zero consumers: the platform refused
  // to start over a cache no code reads.
  //
  // Redis is pointed at a port nothing listens on rather than stopping the
  // real server, so running this guard cannot disrupt anything else.
  if (!skipRedisDownPhase) {
    const deadPort = String(Number(process.env.REDIS_PORT ?? 6379) + 2017);
    const degraded = spawn('node', ['dist/main.js'], {
      cwd: root,
      env: { ...process.env, ...bootEnv(), REDIS_PORT: deadPort },
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let degradedOut = '';
    degraded.stdout.on('data', (c) => (degradedOut += c.toString()));
    degraded.stderr.on('data', (c) => (degradedOut += c.toString()));
    let degradedExited: number | null = null;
    degraded.on('exit', (code) => (degradedExited = code ?? -1));

    let degradedHealth: Awaited<ReturnType<typeof get>> = null;
    const degradedDeadline = Date.now() + 90_000;
    while (Date.now() < degradedDeadline) {
      if (degradedExited !== null) break;
      degradedHealth = await get('/health');
      if (degradedHealth) break;
      await sleep(1000);
    }

    ok(
      'the boot survives Redis being unreachable, and still serves /health',
      degradedHealth?.status === 200,
      degradedExited !== null
        ? `the process exited (${degradedExited}) — a cache with no consumers must not block the boot`
        : 'no response within 90s',
    );
    ok(
      'and it says so, rather than failing quietly',
      /in-memory store|Could not reach Redis/.test(
        degradedOut.replace(/\u001b\[[0-9;]*m/g, ''),
      ),
      'an operator needs to know the cache is now per-replica',
    );

    degraded.kill('SIGTERM');
    await sleep(1500);
    if (degradedExited === null) degraded.kill('SIGKILL');
  }

  rmSync(envDir, { recursive: true, force: true });

  if (failures > 0) {
    console.log('\n── the first lines of the process output ─────────────────────');
    console.log(
      plain
        .split('\n')
        .filter((l) => l.trim())
        .slice(0, 25)
        .map((l) => `  ${l}`)
        .join('\n'),
    );
  }

  console.log(
    failures === 0
      ? `\n\u001b[32mPASS\u001b[0m — ${checks} checks: the application boots and serves requests\n`
      : `\n\u001b[31mFAIL\u001b[0m — ${failures} of ${checks} checks failed\n`,
  );
  process.exit(failures === 0 ? 0 : 1);
})().catch((error) => {
  console.error('\n\u001b[31mFAIL\u001b[0m — the boot check itself crashed:', error);
  process.exit(1);
});
