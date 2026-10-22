/**
 * ─────────────────────────────────────────────────────────────────────────────
 * Boot the real application and talk to it over HTTP
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * `scripts/check-boot.ts` proved that booting the REAL `AppModule` is the only
 * thing that catches a DI graph that does not resolve (§4s) — every other guard
 * reads source text or hand-constructs a service, and `npm run build` uses SWC,
 * which does not typecheck.
 *
 * This is that harness, extracted so a verification can do more than wait for
 * `/health`: it can log in, carry the token, and assert what the API actually
 * answers. A scoping fix asserted against a hand-built service proves the
 * service; only a request proves the stack of nine guards in front of it.
 *
 * `check-boot.ts` keeps its own copy of this logic deliberately — it asserts
 * things about the boot itself (the Redis-down phase, the stderr of a failed
 * start) that a helper returning a live server cannot express, and a guard that
 * depends on a helper it is also guarding can fail open.
 */
import { spawn, spawnSync, type ChildProcess } from 'child_process';
import { DataSource } from 'typeorm';

import * as entities from '../../src/modules/index.entities';

export const PG = {
  host: process.env.DB_HOST ?? 'localhost',
  port: process.env.DB_PORT ?? '5432',
  user: process.env.DB_USERNAME ?? 'postgres',
  password: process.env.DB_PASSWORD ?? '123456',
};

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * The minimum environment the application insists on — the same set
 * `check-boot.ts` documents. Every outbound transport is off: a verification
 * must not depend on a broker, and must not send mail.
 */
export function bootEnv(
  database: string,
  port: number,
  overrides: Record<string, string> = {},
): Record<string, string> {
  return {
    NODE_ENV: 'development',
    PORT: String(port),

    DB_HOST: PG.host,
    DB_PORT: PG.port,
    DB_USERNAME: PG.user,
    DB_PASSWORD: PG.password,
    DB_DATABASE: database,

    REDIS_HOST: process.env.REDIS_HOST ?? '127.0.0.1',
    REDIS_PORT: process.env.REDIS_PORT ?? '6379',

    MQTT_ENABLED: 'false',
    KAFKA_ENABLED: 'false',
    MODBUS_ENABLED: 'false',
    SNMP_ENABLED: 'false',
    COAP_ENABLED: 'false',
    OPCUA_ENABLED: 'false',
    BACNET_ENABLED: 'false',
    KAFKA_BROKERS: '127.0.0.1:9092',
    MQTT_BROKER_URL: 'mqtt://127.0.0.1:1883',

    JWT_SECRET: 'boot-app-secret-long-enough-to-satisfy-validation',
    JWT_REFRESH_SECRET: 'boot-app-refresh-secret-long-enough-to-satisfy',
    ENCRYPTION_KEY:
      '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',

    BACKEND_URL: `http://localhost:${port}`,
    OTA_PUBLIC_URL: `http://localhost:${port}`,
    FRONTEND_URL: 'http://localhost:5173',

    GOOGLE_CLIENT_ID: 'boot-app-google-id',
    GOOGLE_CLIENT_SECRET: 'boot-app-google-secret',
    GOOGLE_CALLBACK_URL: `http://localhost:${port}/auth/google/callback`,
    GITHUB_CLIENT_ID: 'boot-app-github-id',
    GITHUB_CLIENT_SECRET: 'boot-app-github-secret',
    GITHUB_CALLBACK_URL: `http://localhost:${port}/auth/github/callback`,
    APPLE_CLIENT_ID: 'boot-app-apple-id',
    APPLE_TEAM_ID: 'boot-app-team',
    APPLE_KEY_ID: 'boot-app-key',
    APPLE_CALLBACK_URL: `http://localhost:${port}/auth/apple/callback`,

    MOYASAR_API_KEY: 'sk_test_boot_app',
    MOYASAR_PUBLISHABLE_KEY: 'pk_test_boot_app',

    // Nothing must leave the host. SMTP is unset, so MailService logs a warning
    // and sends nothing — which is also why a verification reads an invitation
    // token from the database rather than from an inbox.
    SMS_ENABLED: 'false',
    PUSH_ENABLED: 'false',

    // One process, so the ticks need no Redis to run. A verification that
    // depended on a lock would SKIP where Redis is absent, not fail — but it
    // would also be measuring the scheduler rather than its own subject.
    CLUSTER_LOCKS_ENABLED: 'false',
    REPORT_SCHEDULER_ENABLED: 'false',

    ...overrides,
  };
}

export interface Json {
  status: number;
  body: any;
  raw: string;
}

export interface BootedApp {
  port: number;
  /** Everything the process wrote, with ANSI stripped. */
  output(): string;
  request(
    method: string,
    path: string,
    options?: { token?: string; body?: unknown; timeoutMs?: number },
  ): Promise<Json>;
  stop(): Promise<void>;
}

/**
 * Create the database if missing and synchronise the entity graph into it.
 *
 * `DB_SYNCHRONIZE=true` is NOT enough — it is gated on `NODE_ENV` as well, and
 * booting against an empty database dies on an unhandled
 * `relation "schedules" does not exist` from a startup query, which names
 * nothing. So the schema is built here, before the process starts.
 */
export async function prepareSchema(database: string): Promise<void> {
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
  await schema.initialize();
  await schema.destroy();
}

/** A DataSource against the same database, for fixtures and for reading rows. */
export function dataSource(database: string): DataSource {
  return new DataSource({
    type: 'postgres',
    host: PG.host,
    port: Number(PG.port),
    username: PG.user,
    password: PG.password,
    database,
    entities: Object.values(entities) as any[],
    synchronize: false,
    logging: false,
  });
}

export async function build(root: string): Promise<{ ok: boolean; stderr: string }> {
  const result = spawnSync('npm', ['run', 'build'], {
    cwd: root,
    encoding: 'utf8',
    timeout: 8 * 60 * 1000,
  });
  return { ok: result.status === 0, stderr: result.stderr?.slice(-600) ?? '' };
}

/**
 * Start `node dist/main.js` and resolve once `GET /health` answers — or reject
 * with what the process printed, which is the only place a DI failure appears.
 *
 * Routes are served from the ROOT, not under `/api`: `main.ts` only calls
 * `setGlobalPrefix` when `API_PREFIX_ENABLED=true`. So paths here are
 * `/auth/login`, not `/api/auth/login`.
 */
export async function bootApp(
  root: string,
  database: string,
  port: number,
  envOverrides: Record<string, string> = {},
): Promise<BootedApp> {
  const env = bootEnv(database, port, envOverrides);
  const child: ChildProcess = spawn('node', ['dist/main.js'], {
    cwd: root,
    env: { ...process.env, ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  let output = '';
  child.stdout?.on('data', (c) => (output += c.toString()));
  child.stderr?.on('data', (c) => (output += c.toString()));

  let exited: number | null = null;
  child.on('exit', (code) => (exited = code ?? -1));

  const plain = () => output.replace(/\u001b\[[0-9;]*m/g, '');

  const request = async (
    method: string,
    path: string,
    options: { token?: string; body?: unknown; timeoutMs?: number } = {},
  ): Promise<Json> => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? 15_000);
    try {
      const response = await fetch(`http://127.0.0.1:${port}${path}`, {
        method,
        signal: controller.signal,
        headers: {
          ...(options.body ? { 'Content-Type': 'application/json' } : {}),
          ...(options.token ? { Authorization: `Bearer ${options.token}` } : {}),
        },
        body: options.body ? JSON.stringify(options.body) : undefined,
      });
      const raw = await response.text();
      let parsed: any;
      try {
        parsed = JSON.parse(raw);
      } catch {
        parsed = undefined;
      }
      return { status: response.status, body: parsed, raw };
    } catch (error) {
      // A transport failure is reported as status 0 rather than thrown: a
      // verification asserting "this request is refused" must not pass because
      // the server fell over.
      return { status: 0, body: undefined, raw: String(error) };
    } finally {
      clearTimeout(timer);
    }
  };

  const stop = async () => {
    child.kill('SIGTERM');
    for (let i = 0; i < 30 && exited === null; i++) await sleep(100);
    if (exited === null) child.kill('SIGKILL');
  };

  // Poll rather than sleep a fixed time.
  const deadline = Date.now() + 120_000;
  while (Date.now() < deadline) {
    if (exited !== null) {
      const errors = plain()
        .split('\n')
        .filter((l) => /ERROR|Error:|can't resolve/.test(l))
        .slice(0, 6)
        .join('\n       ');
      throw new Error(`the application exited during startup (code ${exited}):\n       ${errors}`);
    }
    const health = await request('GET', '/health', { timeoutMs: 4000 });
    if (health.status === 200) {
      return { port, output: plain, request, stop };
    }
    await sleep(1000);
  }

  await stop();
  throw new Error('the application did not answer GET /health within 120s');
}
