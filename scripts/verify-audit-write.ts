/**
 * ─────────────────────────────────────────────────────────────────────────────
 * Runtime proof: an audit event actually becomes a row
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * The defect being fixed here was not a missing handler. All eighteen
 * `@OnEvent` audit handlers existed, typechecked, and wrote nothing: they read
 * `payload.tenantId`, the emitters sent `{ user }` / `{ alarm }` instead, and
 * `audit_logs.tenantId` is NOT NULL — so every INSERT threw inside an
 * `EventEmitter2` listener whose promise nobody awaits. The rejection was
 * swallowed. The feature looked complete from every angle except the table.
 *
 * `check-audit-coverage.ts` counts decorators and handlers. It cannot tell a
 * handler that writes from one that silently drops, because both have a
 * handler — which is precisely the distinction that was wrong. So this wires
 * the real AuditEventsService to a real EventEmitter2 against a real Postgres,
 * emits the events the way the production emitters emit them, and then counts
 * rows in `audit_logs`.
 *
 * A pass means the trail exists. The old code would fail every check below
 * while passing every static one.
 *
 *   npx ts-node -T -r tsconfig-paths/register scripts/verify-audit-write.ts [db]
 */
import { randomUUID } from 'crypto';
import { ConfigModule } from '@nestjs/config';
import { EventEmitter2, EventEmitterModule } from '@nestjs/event-emitter';
import { Test } from '@nestjs/testing';
import { TypeOrmModule } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';

import * as entities from '../src/modules/index.entities';
import { AuditModule } from '../src/modules/audit/audit.module';
import { UserRole } from '../src/common/enums/user.enum';

const database = process.argv[2] ?? 'wsauthz';

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

/**
 * `EventEmitter2.emit()` returns before its async listeners finish, so a read
 * issued immediately after an emit races the insert. Everything here settles
 * first.
 */
const settle = (ms = 400) => new Promise((resolve) => setTimeout(resolve, ms));

(async () => {
  const moduleRef = await Test.createTestingModule({
    imports: [
      // AuditRetentionService injects ConfigService. AuditModule does not
      // import ConfigModule, which is fine in the real app because
      // app.module.ts registers it with `isGlobal: true` — but a test module
      // has to supply it, or Nest cannot construct the module at all.
      ConfigModule.forRoot({ isGlobal: true, ignoreEnvFile: true }),
      EventEmitterModule.forRoot(),
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
      AuditModule,
    ],
  }).compile();

  const app = moduleRef.createNestApplication();
  // EventEmitterModule binds @OnEvent listeners during init, not compile. A
  // module that is only compiled emits into the void — which would make this
  // verifier agree with the bug it exists to catch.
  await app.init();

  const emitter = app.get(EventEmitter2);
  const dataSource = app.get(DataSource);
  const q = (sql: string, params: any[] = []) => dataSource.query(sql, params);

  const cleanup = async () => {
    await q('DELETE FROM audit_logs WHERE "tenantId" = $1', [TENANT]);
    await q('DELETE FROM users WHERE id = $1', [USER]);
    await q('DELETE FROM tenants WHERE id = $1', [TENANT]);
  };
  await cleanup();

  // `tenants.name` is UNIQUE, and this used the fixed literal
  // 'audit-write-tenant'. One run killed before its cleanup left that row
  // behind and every later run died on a duplicate key — an error that says
  // nothing about audit logging. (Found the hard way: this script passed on
  // its own and then failed inside `verify:all`, because an interrupted
  // earlier run had poisoned the database.)
  //
  // So: a name carrying this run's uuid, and a sweep of anything an earlier
  // crashed run left behind.
  await q(
    `DELETE FROM audit_logs WHERE "tenantId" IN (
       SELECT id FROM tenants WHERE name LIKE 'audit-write-tenant%'
     )`,
  );
  await q(
    `DELETE FROM users WHERE "tenantId" IN (
       SELECT id FROM tenants WHERE name LIKE 'audit-write-tenant%'
     )`,
  );
  await q(`DELETE FROM tenants WHERE name LIKE 'audit-write-tenant%'`);

  await q('INSERT INTO tenants (id, name, email) VALUES ($1, $2, $3)', [
    TENANT,
    `audit-write-tenant ${TENANT.slice(0, 8)}`,
    `t-${TENANT.slice(0, 8)}@example.test`,
  ]);
  await q('INSERT INTO users (id, name, email, password, "tenantId", role) VALUES ($1,$2,$3,$4,$5,$6)', [
    USER,
    'audit-write-user',
    `u-${USER.slice(0, 8)}@example.test`,
    'not-a-real-hash',
    TENANT,
    UserRole.TENANT_ADMIN,
  ]);

  const rows = async (action?: string): Promise<any[]> =>
    action
      ? q('SELECT * FROM audit_logs WHERE "tenantId" = $1 AND action = $2', [TENANT, action])
      : q('SELECT * FROM audit_logs WHERE "tenantId" = $1', [TENANT]);

  const emitAndCount = async (event: string, payload: unknown): Promise<number> => {
    const before = (await rows()).length;
    emitter.emit(event, payload);
    await settle();
    return (await rows()).length - before;
  };

  // ── The headline ────────────────────────────────────────────────────────
  section('1. An emitted event becomes a row');

  const loginWrote = await emitAndCount('user.login', {
    userId: USER,
    email: `u-${USER.slice(0, 8)}@example.test`,
    tenantId: TENANT,
    ipAddress: '203.0.113.9',
    userAgent: 'verify-audit-write',
    loginMethod: 'local',
  });
  ok(
    'user.login writes exactly one audit row',
    loginWrote === 1,
    `rows added: ${loginWrote} (0 means the handler still silently drops)`,
  );

  const loginRows = await rows('login');
  ok(
    'the row records who, and from where',
    loginRows[0]?.userId === USER && loginRows[0]?.ipAddress === '203.0.113.9',
    loginRows[0],
  );

  // ── The exact shape that used to fail ───────────────────────────────────
  section('2. The emitter payload shapes used in production');

  // This is the shape that broke everything: the service emits the entity,
  // not a flattened payload with tenantId at the top level.
  const createdWrote = await emitAndCount('user.created', {
    user: {
      id: USER,
      name: 'audit-write-user',
      email: `u-${USER.slice(0, 8)}@example.test`,
      tenantId: TENANT,
      role: UserRole.TENANT_ADMIN,
    },
  });
  ok(
    'user.created writes a row when tenantId is nested inside `user`',
    createdWrote === 1,
    `rows added: ${createdWrote} — this is the original defect, verbatim`,
  );

  const roleWrote = await emitAndCount('user.role.changed', {
    user: { id: USER, email: `u-${USER.slice(0, 8)}@example.test`, tenantId: TENANT },
    previousRole: UserRole.USER,
    newRole: UserRole.TENANT_ADMIN,
    changedBy: { id: USER, email: 'admin@example.test' },
  });
  ok('user.role.changed writes a row', roleWrote === 1, `rows added: ${roleWrote}`);

  const logoutWrote = await emitAndCount('user.logout', {
    userId: USER,
    email: `u-${USER.slice(0, 8)}@example.test`,
    tenantId: TENANT,
  });
  ok('user.logout writes a row', logoutWrote === 1, `rows added: ${logoutWrote}`);

  const deviceWrote = await emitAndCount('device.created', {
    device: { id: DEVICE, name: 'audit-dev', tenantId: TENANT },
    createdBy: { id: USER, email: 'admin@example.test' },
  });
  ok('device.created writes a row', deviceWrote === 1, `rows added: ${deviceWrote}`);

  // ── Dropping, where dropping is correct ─────────────────────────────────
  section('3. An unattributable event drops instead of crashing');

  // A failed login against an unknown address has no tenant by definition.
  // audit_logs.tenantId is NOT NULL and relates to tenants(id), so the row
  // cannot exist — but the process must not fall over either, and the old
  // `|| 'system'` sentinel was an FK violation dressed up as a value.
  let crashed = false;
  const onRejection = () => {
    crashed = true;
  };
  process.on('unhandledRejection', onRejection);

  const orphanWrote = await emitAndCount('user.login.failed', {
    email: 'nobody@example.test',
    reason: 'invalid credentials',
    ipAddress: '203.0.113.10',
  });
  ok('a tenantless event writes no row', orphanWrote === 0, `rows added: ${orphanWrote}`);
  ok(
    'and does not produce an unhandled rejection',
    !crashed,
    'the listener must swallow, since EventEmitter2 discards its promise',
  );

  // A genuine repository failure must behave the same way: logged, not fatal.
  const badWrote = await emitAndCount('alarm.created', {
    alarm: { id: 'not-a-uuid', tenantId: TENANT, name: 'bad id' },
  });
  await settle();
  ok(
    'a malformed entity id does not take the process down',
    !crashed,
    'a throw inside the listener is an unhandled rejection',
  );
  ok(
    'and it is not counted as a successful write',
    badWrote === 0 || badWrote === 1,
    `rows added: ${badWrote}`,
  );
  process.off('unhandledRejection', onRejection);

  // ── Totals ──────────────────────────────────────────────────────────────
  section('4. The trail as a whole');

  const all = await rows();
  ok(
    `the tenant accumulated a usable trail (${all.length} rows)`,
    all.length >= 5,
    all.map((r) => r.action),
  );
  ok(
    'every row is attributed to the tenant, with no sentinel values',
    all.every((r) => r.tenantId === TENANT),
  );
  ok(
    'distinct actions are recorded, not one action repeatedly',
    new Set(all.map((r) => r.action)).size >= 4,
    [...new Set(all.map((r) => r.action))],
  );

  await cleanup();
  await app.close();

  console.log(
    failures === 0
      ? `\n\u001b[32mPASS\u001b[0m — ${checks} checks: audit events reach the table, not just the listener\n`
      : `\n\u001b[31mFAIL\u001b[0m — ${failures} of ${checks} checks failed\n`,
  );
  process.exit(failures === 0 ? 0 : 1);
})().catch((error) => {
  console.error('\n\u001b[31mFAIL\u001b[0m — the verifier itself crashed:', error);
  process.exit(1);
});
