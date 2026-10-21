/**
 * ─────────────────────────────────────────────────────────────────────────────
 * End-to-end: does a telemetry push actually reach a browser?
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * "Live telemetry never reaches the browser" has now been diagnosed twice from
 * reading code — once as a namespace mismatch (`/` vs `/ws`), once as event
 * names that did not line up. Both diagnoses were right, and neither was ever
 * executed. Nothing in this repository has ever observed a message leave the
 * server and arrive at a client.
 *
 * So this boots the real gateway over a real HTTP server, connects a real
 * socket.io-client with a real signed JWT, subscribes to a device, and calls
 * the broadcast method that the telemetry consumer calls. Then it waits for
 * the message. A pass means the wire works; a timeout means it does not,
 * whatever the source says.
 *
 * It is also the regression test for the authorization added alongside it:
 * scoping subscriptions is exactly the kind of change that silences a working
 * stream, so the happy path is asserted here, not assumed.
 *
 *   npx ts-node -T -r tsconfig-paths/register scripts/verify-ws-telemetry-delivery.ts [db]
 */
import { randomUUID } from 'crypto';
import { INestApplication } from '@nestjs/common';
import { JwtModule, JwtService } from '@nestjs/jwt';
import { ConfigModule } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import { TypeOrmModule } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { io, Socket as ClientSocket } from 'socket.io-client';

import * as entities from '../src/modules/index.entities';
import { UserRole } from '../src/common/enums/user.enum';
import { WsAuthorizationModule } from '../src/common/websocket/ws-authorization.module';
import { WebsocketGateway } from '../src/modules/websocket/websocket.gateway';
import { Dashboard } from '../src/modules/dashboards/entities/dashboard.entity';
import { Telemetry } from '../src/modules/telemetry/entities/telemetry.entity';

const database = process.argv[2] ?? 'wsauthz';
const PORT = Number(process.env.WS_TEST_PORT ?? 4311);
const JWT_SECRET = 'ws-delivery-test-secret';

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

const TENANT_A = randomUUID();
const TENANT_B = randomUUID();
const OWNER = randomUUID();
const DEV_A = randomUUID();
const DEV_B = randomUUID();

/** Resolve on the next matching event, or `null` after `ms`. */
function waitFor<T = any>(socket: ClientSocket, event: string, ms = 4000): Promise<T | null> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      socket.off(event, handler);
      resolve(null);
    }, ms);
    const handler = (payload: T) => {
      clearTimeout(timer);
      socket.off(event, handler);
      resolve(payload);
    };
    socket.on(event, handler);
  });
}

/** Emit and wait for the handler's return value as a Socket.IO ack. */
function emitWithAck(socket: ClientSocket, event: string, data: unknown, ms = 4000): Promise<any> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve({ __timeout: true }), ms);
    socket.emit(event, data, (response: unknown) => {
      clearTimeout(timer);
      resolve(response);
    });
  });
}

/**
 * `handleConnection` emits 'connected' immediately, so a listener registered
 * after the connect promise resolves can miss it. The listener is attached to
 * the socket before it connects and the payload is parked on the socket for
 * the assertion to read — otherwise the test reports a missing greeting that
 * was in fact delivered.
 */
type TestSocket = ClientSocket & { welcome?: unknown };

function connect(token: string, namespace = '/ws'): Promise<TestSocket> {
  return new Promise((resolve, reject) => {
    const socket = io(`http://127.0.0.1:${PORT}${namespace}`, {
      transports: ['websocket'],
      auth: { token },
      forceNew: true,
      reconnection: false,
    }) as TestSocket;

    socket.on('connected', (payload: unknown) => {
      socket.welcome = payload;
    });

    const timer = setTimeout(() => reject(new Error('connect timeout')), 6000);
    socket.on('connect', () => {
      clearTimeout(timer);
      // Give the server's immediate 'connected' emit a tick to land.
      setTimeout(() => resolve(socket), 150);
    });
    socket.on('connect_error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
  });
}

(async () => {
  let app: INestApplication | undefined;
  const sockets: TestSocket[] = [];

  try {
    const moduleRef = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({ isGlobal: true, ignoreEnvFile: true }),
        TypeOrmModule.forRoot({
          type: 'postgres',
          host: process.env.DB_HOST ?? 'localhost',
          port: Number(process.env.DB_PORT ?? 5432),
          username: process.env.DB_USERNAME ?? 'postgres',
          password: process.env.DB_PASSWORD ?? '123456',
          database,
          entities: Object.values(entities) as any[],
          synchronize: true,
          logging: false,
        }),
        TypeOrmModule.forFeature([Dashboard, Telemetry]),
        WsAuthorizationModule,
        JwtModule.register({ secret: JWT_SECRET, signOptions: { expiresIn: '1h' } }),
      ],
      providers: [WebsocketGateway],
    }).compile();

    app = moduleRef.createNestApplication();
    // WsJwtGuard reads JWT_SECRET from the environment, not from JwtModule.
    process.env.JWT_SECRET = JWT_SECRET;
    await app.listen(PORT);

    const jwt = app.get(JwtService);
    const gateway = app.get(WebsocketGateway);
    // The injection token is the DataSource class itself, not the string
    // 'DataSource' — Nest answers the latter with UnknownElementException.
    const dataSource = moduleRef.get(DataSource, { strict: false });
    const q = (sql: string, params: any[] = []) => dataSource.query(sql, params);

    const cleanup = async () => {
      await q('DELETE FROM devices WHERE id = ANY($1)', [[DEV_A, DEV_B]]);
      await q('DELETE FROM users WHERE id = $1', [OWNER]);
      await q('DELETE FROM tenants WHERE id = ANY($1)', [[TENANT_A, TENANT_B]]);
    };
    await cleanup();

    for (const [id, label] of [
      [TENANT_A, 'a'],
      [TENANT_B, 'b'],
    ] as const) {
      await q('INSERT INTO tenants (id, name, email) VALUES ($1, $2, $3)', [
        id,
        `ws-delivery-${label}`,
        `${label}-${id.slice(0, 8)}@example.test`,
      ]);
    }
    await q('INSERT INTO users (id, name, email, password) VALUES ($1, $2, $3, $4)', [
      OWNER,
      'ws-delivery-owner',
      `owner-${OWNER.slice(0, 8)}@example.test`,
      'not-a-real-hash',
    ]);
    for (const [id, tenantId] of [
      [DEV_A, TENANT_A],
      [DEV_B, TENANT_B],
    ] as const) {
      await q(
        `INSERT INTO devices (id, name, "deviceKey", "tenantId", "userId")
         VALUES ($1, $2, $3, $4, $5)`,
        [id, `dev-${id.slice(0, 8)}`, `key-${id.slice(0, 8)}`, tenantId, OWNER],
      );
    }

    const tokenFor = (tenantId: string, role: UserRole, customerId?: string) =>
      jwt.sign({
        sub: randomUUID(),
        email: `u-${randomUUID().slice(0, 8)}@example.test`,
        role,
        tenantId,
        ...(customerId ? { customerId } : {}),
      });

    // ── The claim under test ────────────────────────────────────────────────
    section('1. A telemetry push reaches a subscribed browser');

    const clientA = await connect(tokenFor(TENANT_A, UserRole.TENANT_ADMIN));
    sockets.push(clientA);
    ok('a client can connect to the /ws namespace', clientA.connected);

    ok(
      'the server greets the connection',
      clientA.welcome !== undefined,
      clientA.welcome,
    );

    const ack = await emitWithAck(clientA, 'device:subscribe', { deviceId: DEV_A });
    ok(
      'subscribing to a device of the caller’s own tenant succeeds',
      ack?.success === true,
      ack,
    );
    ok('the ack names the room that was joined', ack?.room === `device:${DEV_A}`, ack);

    // This is the method TelemetryConsumer calls when a reading lands.
    const pushed = waitFor(clientA, 'device:telemetry', 4000);
    gateway.broadcastDeviceTelemetry(DEV_A, { data: { temperature: 21.5 }, temperature: 21.5, timestamp: new Date() });
    const received: any = await pushed;

    ok(
      'the push ARRIVES at the client — the wire actually works',
      received !== null,
      'timed out waiting for device:telemetry; the stream is broken',
    );
    ok(
      'the payload carries the telemetry values intact',
      received?.data?.temperature === 21.5 || received?.telemetry?.temperature === 21.5,
      received,
    );
    ok(
      'the payload identifies the device it came from',
      received?.deviceId === DEV_A,
      received,
    );

    // ── The hole that was open ──────────────────────────────────────────────
    section('2. A foreign tenant is refused, and receives nothing');

    const clientB = await connect(tokenFor(TENANT_B, UserRole.TENANT_ADMIN));
    sockets.push(clientB);

    const refusal = await emitWithAck(clientB, 'device:subscribe', { deviceId: DEV_A });
    ok(
      'tenant B is refused a subscription to tenant A’s device',
      refusal?.success === false,
      refusal,
    );
    ok(
      'the refusal does not confirm the device exists',
      typeof refusal?.error === 'string' && /not found/i.test(refusal.error),
      refusal,
    );

    // The decisive assertion: refused, and therefore silent. A refusal that
    // still joined the room would pass the check above and leak anyway.
    const leaked = waitFor(clientB, 'device:telemetry', 2500);
    gateway.broadcastDeviceTelemetry(DEV_A, { data: { temperature: 22.5 }, temperature: 22.5, timestamp: new Date() });
    const leakedPayload = await leaked;
    ok(
      'tenant B receives NO telemetry for tenant A’s device',
      leakedPayload === null,
      leakedPayload,
    );

    // ...while tenant A, subscribed to the same device, still does. Proves the
    // silence above is scoping, not a broadcast that stopped working.
    const stillWorks = waitFor(clientA, 'device:telemetry', 3000);
    gateway.broadcastDeviceTelemetry(DEV_A, { data: { temperature: 23.5 }, temperature: 23.5, timestamp: new Date() });
    ok(
      'tenant A still receives it, so the silence is scoping and not breakage',
      (await stillWorks) !== null,
    );

    // ── Widget and dashboard paths ──────────────────────────────────────────
    section('3. The widget path refuses foreign ids inside a batch');

    const widgetAck = await emitWithAck(clientB, 'widget:subscribe', {
      widgetId: randomUUID(),
      deviceIds: [DEV_A, DEV_B],
    });
    ok(
      'a widget batch joins only the ids the caller may see',
      widgetAck?.subscribedDevices === 1 && widgetAck?.refusedDevices === 1,
      widgetAck,
    );

    const widgetLeak = waitFor(clientB, 'device:telemetry', 2500);
    gateway.broadcastDeviceTelemetry(DEV_A, { data: { temperature: 24.5 }, temperature: 24.5, timestamp: new Date() });
    ok(
      'the refused id in that batch streams nothing',
      (await widgetLeak) === null,
    );

    await cleanup();

    console.log(
      failures === 0
        ? `\n\u001b[32mPASS\u001b[0m — ${checks} checks: telemetry reaches its own tenant's browser and no one else's\n`
        : `\n\u001b[31mFAIL\u001b[0m — ${failures} of ${checks} checks failed\n`,
    );
  } finally {
    for (const socket of sockets) socket.close();
    if (app) await app.close();
  }

  process.exit(failures === 0 ? 0 : 1);
})().catch((error) => {
  console.error('\n\u001b[31mFAIL\u001b[0m — the verifier itself crashed:', error);
  process.exit(1);
});
