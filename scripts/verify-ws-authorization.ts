/**
 * ─────────────────────────────────────────────────────────────────────────────
 * Runtime proof: a socket cannot subscribe outside its own scope
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * `check-ws-authorization.ts` reads the source and asserts that every
 * subscribe handler calls the authorizer. That is worth having, but it proves
 * only that a call exists — not that the call says no. The whole class of bug
 * this session kept producing is code that is present, typechecks, and does
 * nothing.
 *
 * So this runs the real WsSubscriptionAuthorizer against a real Postgres with
 * two tenants, two customers and a handful of devices, and asserts the
 * partition it produces. A leak here is a number that does not match, not a
 * stack trace.
 *
 *   npx ts-node -T -r tsconfig-paths/register scripts/verify-ws-authorization.ts [db]
 *
 * It creates its own throwaway rows in whatever database is named (default
 * `wsauthz`) and deletes them again.
 */
import { randomUUID } from 'crypto';
import { DataSource } from 'typeorm';

import * as entities from '../src/modules/index.entities';
import { Device } from '../src/modules/devices/entities/device.entity';
import { UserRole } from '../src/common/enums/user.enum';
import { WsSubscriptionAuthorizer } from '../src/common/websocket/ws-subscription-authorizer';

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

const TENANT_A = randomUUID();
const TENANT_B = randomUUID();
const CUSTOMER_A1 = randomUUID();
const CUSTOMER_A2 = randomUUID();
/** devices.userId is NOT NULL with an FK, so the fixture needs a real owner. */
const OWNER = randomUUID();

// Devices: two for tenant A (one per customer), one unassigned to a customer,
// and one for tenant B.
const DEV_A_C1 = randomUUID();
const DEV_A_C2 = randomUUID();
const DEV_A_NOCUST = randomUUID();
const DEV_B = randomUUID();

/** A socket as the gateways present it to the authorizer. */
const socket = (data: Record<string, unknown>) => ({ id: 'sock-test', data });

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

  const deviceRepo = dataSource.getRepository(Device);
  const q = (sql: string, params: any[] = []) => deviceRepo.query(sql, params);

  const ids = [DEV_A_C1, DEV_A_C2, DEV_A_NOCUST, DEV_B];
  const tenantIds = [TENANT_A, TENANT_B];
  const customerIds = [CUSTOMER_A1, CUSTOMER_A2];

  const cleanup = async () => {
    await q('DELETE FROM devices WHERE id = ANY($1)', [ids]);
    await q('DELETE FROM customers WHERE id = ANY($1)', [customerIds]);
    await q('DELETE FROM users WHERE id = $1', [OWNER]);
    await q('DELETE FROM tenants WHERE id = ANY($1)', [tenantIds]);
  };
  await cleanup();

  // `devices.userId` is NOT NULL with an FK to users, and tenantId/customerId
  // are FKs too, so the fixture has to be a real graph — a bare device row
  // cannot exist. Found by running this, not by reading the entity.
  await q('INSERT INTO tenants (id, name, email) VALUES ($1, $2, $3)', [
    TENANT_A,
    'ws-authz-tenant-a',
    `a-${TENANT_A.slice(0, 8)}@example.test`,
  ]);
  await q('INSERT INTO tenants (id, name, email) VALUES ($1, $2, $3)', [
    TENANT_B,
    'ws-authz-tenant-b',
    `b-${TENANT_B.slice(0, 8)}@example.test`,
  ]);
  await q('INSERT INTO users (id, name, email, password) VALUES ($1, $2, $3, $4)', [
    OWNER,
    'ws-authz-owner',
    `owner-${OWNER.slice(0, 8)}@example.test`,
    'not-a-real-hash',
  ]);
  for (const [id, label] of [
    [CUSTOMER_A1, 'customer-1'],
    [CUSTOMER_A2, 'customer-2'],
  ] as const) {
    await q('INSERT INTO customers (id, "tenantId", email) VALUES ($1, $2, $3)', [
      id,
      TENANT_A,
      `${label}-${id.slice(0, 8)}@example.test`,
    ]);
  }

  // Inserted with raw SQL so the fixture does not depend on which columns the
  // Device entity currently marks required — the authorizer only reads
  // id/tenantId/customerId.
  const insert = async (id: string, tenantId: string, customerId: string | null) =>
    q(
      `INSERT INTO devices (id, name, "deviceKey", "tenantId", "customerId", "userId")
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [id, `dev-${id.slice(0, 8)}`, `key-${id.slice(0, 8)}`, tenantId, customerId, OWNER],
    );

  await insert(DEV_A_C1, TENANT_A, CUSTOMER_A1);
  await insert(DEV_A_C2, TENANT_A, CUSTOMER_A2);
  await insert(DEV_A_NOCUST, TENANT_A, null);
  await insert(DEV_B, TENANT_B, null);

  const authorizer = new WsSubscriptionAuthorizer(deviceRepo);

  const ALL = [DEV_A_C1, DEV_A_C2, DEV_A_NOCUST, DEV_B];
  const same = (a: string[], b: string[]) =>
    a.length === b.length && [...a].sort().join() === [...b].sort().join();

  // ── The headline case ───────────────────────────────────────────────────
  section('1. Cross-tenant subscription is refused');

  const tenantAdminA = socket({
    userId: randomUUID(),
    role: UserRole.TENANT_ADMIN,
    tenantId: TENANT_A,
  });

  ok(
    'a tenant admin of A cannot subscribe to a device of tenant B',
    (await authorizer.canSubscribeToDevice(tenantAdminA, DEV_B)) === false,
    'this is the exact hole: an authenticated user naming another tenant’s uuid',
  );
  ok(
    'the same admin CAN subscribe to its own tenant’s device',
    (await authorizer.canSubscribeToDevice(tenantAdminA, DEV_A_C1)) === true,
    'denying everything would pass a security check and break the product',
  );

  const batch = await authorizer.authorizeDevices(tenantAdminA, ALL);
  ok(
    'a mixed batch is partitioned, not accepted or rejected wholesale',
    same(batch.allowed, [DEV_A_C1, DEV_A_C2, DEV_A_NOCUST]) &&
      same(batch.refused, [DEV_B]),
    batch,
  );

  // ── Customer scoping ────────────────────────────────────────────────────
  section('2. A customer user sees only its own customer');

  const customerUserA1 = socket({
    userId: randomUUID(),
    role: UserRole.CUSTOMER_USER,
    tenantId: TENANT_A,
    customerId: CUSTOMER_A1,
  });

  const custBatch = await authorizer.authorizeDevices(customerUserA1, ALL);
  ok(
    'a customer user of A/customer-1 gets only customer-1’s device',
    same(custBatch.allowed, [DEV_A_C1]),
    custBatch,
  );
  ok(
    'it cannot reach a sibling customer in the SAME tenant',
    custBatch.refused.includes(DEV_A_C2),
    'tenant isolation alone is not enough inside a multi-customer tenant',
  );
  ok(
    'it cannot reach a tenant-level device with no customer assigned',
    custBatch.refused.includes(DEV_A_NOCUST),
  );

  // ── The exception, and the fail-closed direction ────────────────────────
  section('3. Super admin, and tokens that prove nothing');

  const superAdmin = socket({
    userId: randomUUID(),
    role: UserRole.SUPER_ADMIN,
    tenantId: null,
  });
  const superBatch = await authorizer.authorizeDevices(superAdmin, ALL);
  ok(
    'a super admin is cross-tenant by design',
    same(superBatch.allowed, ALL),
    superBatch,
  );

  // A token with no tenant claim is the dangerous case: the naive
  // implementation builds `where: { tenantId: undefined }`, which TypeORM
  // drops from the query — turning "scope me to nothing" into "return
  // everything".
  const noTenant = socket({
    userId: randomUUID(),
    role: UserRole.USER,
    tenantId: null,
  });
  const noTenantBatch = await authorizer.authorizeDevices(noTenant, ALL);
  ok(
    'a non-super-admin with NO tenantId is refused everything',
    noTenantBatch.allowed.length === 0 && same(noTenantBatch.refused, ALL),
    noTenantBatch,
  );

  const noRole = socket({ userId: randomUUID() });
  ok(
    'an empty principal is refused everything',
    (await authorizer.authorizeDevices(noRole, ALL)).allowed.length === 0,
  );

  // ── Malformed input ─────────────────────────────────────────────────────
  section('4. Malformed input refuses instead of throwing');

  // `In(['not-a-uuid'])` reaches Postgres as a uuid comparison and raises
  // `invalid input syntax for type uuid`. Unhandled, a bad subscribe payload
  // becomes a 500 — and a retrying widget turns it into a loop.
  let threw = false;
  let mixed: Awaited<ReturnType<typeof authorizer.authorizeDevices>> = {
    allowed: [],
    refused: [],
  };
  try {
    mixed = await authorizer.authorizeDevices(tenantAdminA, [
      DEV_A_C1,
      'not-a-uuid',
      '',
      '../../etc/passwd',
    ]);
  } catch {
    threw = true;
  }
  ok('a malformed id does not throw', !threw);
  ok(
    'the well-formed id in the same batch still works',
    same(mixed.allowed, [DEV_A_C1]),
    mixed,
  );
  ok(
    'the malformed ids are reported as refused',
    mixed.refused.includes('not-a-uuid') && mixed.refused.includes('../../etc/passwd'),
    mixed,
  );

  ok(
    'an absent device id is refused',
    (await authorizer.canSubscribeToDevice(tenantAdminA, undefined)) === false,
  );
  ok(
    'a well-formed uuid that does not exist is refused',
    (await authorizer.canSubscribeToDevice(tenantAdminA, randomUUID())) === false,
  );
  ok(
    'an empty request list is not an error',
    (await authorizer.authorizeDevices(tenantAdminA, [])).allowed.length === 0,
  );

  // ── Customer rooms ──────────────────────────────────────────────────────
  section('5. customer:<id> alarm rooms');

  ok(
    'a customer user may watch its own customer',
    authorizer.canSubscribeToCustomer(customerUserA1, CUSTOMER_A1) === true,
  );
  ok(
    'a customer user may NOT watch a sibling customer',
    authorizer.canSubscribeToCustomer(customerUserA1, CUSTOMER_A2) === false,
  );
  ok(
    'a tenant admin may watch a customer of its tenant',
    authorizer.canSubscribeToCustomer(tenantAdminA, CUSTOMER_A1) === true,
  );
  ok(
    'a principal with no tenant may watch no customer',
    authorizer.canSubscribeToCustomer(noTenant, CUSTOMER_A1) === false,
  );
  ok(
    'a malformed customer id is refused',
    authorizer.canSubscribeToCustomer(tenantAdminA, 'nope') === false,
  );

  // ── Fail-closed on infrastructure failure ───────────────────────────────
  section('6. A broken database denies rather than opens');

  // The direction that matters. An authorizer that cannot answer must not
  // answer "yes", so the query is made to fail and the result inspected.
  const brokenRepo = {
    find: async () => {
      throw new Error('connection terminated');
    },
  } as any;
  const brokenAuthorizer = new WsSubscriptionAuthorizer(brokenRepo);
  const brokenResult = await brokenAuthorizer.authorizeDevices(tenantAdminA, ALL);
  ok(
    'a database failure refuses every id',
    brokenResult.allowed.length === 0 && same(brokenResult.refused, ALL),
    brokenResult,
  );

  await cleanup();
  await dataSource.destroy();

  console.log(
    failures === 0
      ? `\n\u001b[32mPASS\u001b[0m — ${checks} checks: subscription scoping holds against a real database\n`
      : `\n\u001b[31mFAIL\u001b[0m — ${failures} of ${checks} checks failed\n`,
  );
  process.exit(failures === 0 ? 0 : 1);
})().catch((error) => {
  console.error('\n\u001b[31mFAIL\u001b[0m — the verifier itself crashed:', error);
  process.exit(1);
});
