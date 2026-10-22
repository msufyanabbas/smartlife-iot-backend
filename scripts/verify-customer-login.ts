/**
 * ─────────────────────────────────────────────────────────────────────────────
 * Runtime proof: a customer and a customer user can actually LOG IN, and see
 * only their own things
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * Reported as: "I don't see any option for login for customers, and no option
 * of login for customer users — what is the purpose of those users, if they
 * cannot login? Also the permission to those users are not working."
 *
 * Every other verification in this suite hand-constructs a service or reads
 * source text. Neither can answer this question, because the answer depends on
 * nine global guards, a JWT, a password hash written by an entity hook, a mail
 * path that is switched off, and an `emailVerified` flag set in a different
 * module. So this one boots the REAL `node dist/main.js` and uses the HTTP API
 * exactly as the browser does.
 *
 * What it pins, in order:
 *
 *   1. a tenant admin can log in                       (the baseline)
 *   2. creating a customer MINTS a login user           (role=customer, invited)
 *   3. that login is refused before activation          (the invite is required)
 *   4. the invitation activates it and LOGIN SUCCEEDS   ← the actual question
 *   5. the token is single-use                          (a replay is refused)
 *   6. the customer sees its own device, and neither a sibling customer's nor
 *      another tenant's
 *   7. the permission matrix DECIDES: revoking devices:list 403s the very next
 *      request, and restoring it allows the one after
 *   8. a customer user, created under that customer, activates and logs in
 *   9. a custom role's permissions are INHERITED by assignment, and are still
 *      capped by the customer's ceiling (the intersection, both directions)
 *
 * Check 7 is the one that was broken and is the reason this script exists.
 * `setGrantedPermissions` emitted `customer.permissions.changed` with a comment
 * saying cached resolutions were now stale, and **nothing in the repository
 * listened for that event**. `PermissionGuard` caches the resolved set per user
 * under a per-tenant epoch, so a grant change took up to
 * PERMISSION_CACHE_TTL_SECONDS (60) to apply, per replica. An admin who
 * unchecked a box, hit save and tested immediately saw no change — which is
 * exactly the report. Revert the `permissionCache.bumpTenant()` call in
 * `CustomersService.setGrantedPermissions` and §7 fails.
 *
 *   npx ts-node -T -r tsconfig-paths/register scripts/verify-customer-login.ts [db] [port]
 */
import { randomUUID } from 'crypto';
import { join } from 'path';
import type { DataSource } from 'typeorm';

import { Customer } from '../src/modules/customers/entities/customers.entity';
import { Permission } from '../src/modules/permissions/entities/permissions.entity';
import { Role } from '../src/modules/roles/entities/roles.entity';
import { User } from '../src/modules/users/entities/user.entity';
import { CustomerStatus, SubscriptionPlan, UserRole, UserStatus } from '../src/common/enums/index.enum';
import { getPlanFeatures } from '../src/modules/subscriptions/plan-features';
import { bootApp, build, dataSource, prepareSchema, type BootedApp } from './support/boot-app';

const database = process.argv[2] ?? 'custlogin';
const PORT = Number(process.argv[3] ?? 5097);
const root = join(__dirname, '..');

const PASSWORD = 'Str0ng!Passw0rd';

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

/**
 * Unwrap the response envelope.
 *
 * `TransformInterceptor` wraps every success as `{success, data, timestamp}` —
 * but several handlers ALSO return their own `{message, data}`, so the real
 * payload sits TWO levels deep on those and one level deep everywhere else.
 * `POST /customers` is one of the two-deep ones. Unwrapping a fixed single
 * level reads `{message, data}` as the customer and finds no `id`, which looks
 * exactly like a handler that returned nothing.
 *
 * So unwrap while there is a `data` to unwrap. A paginated body is
 * `{data: [...], meta}`, which this reduces to the array — call sites then use
 * `payload(x)?.data ?? payload(x)` so both shapes work.
 */
const payload = (body: any): any => {
  let value = body;
  for (let depth = 0; depth < 3; depth++) {
    if (value && typeof value === 'object' && !Array.isArray(value) && 'data' in value) {
      value = (value as any).data;
    } else break;
  }
  return value;
};

/** A run-unique suffix: `tenants.name` is UNIQUE and a crashed run must not
 *  make every later run fail on a duplicate key that says nothing (§4r). */
const RUN = randomUUID().slice(0, 8);
const mail = (local: string) => `${local}-${RUN}@example.test`;

/**
 * Remove this script's fixtures, including residue from a run that crashed.
 *
 * `tenants.name` is UNIQUE, so a surviving row makes every later run fail on a
 * duplicate key that says nothing about logins (§4r) — hence the sweep is by
 * NAME PREFIX, not by this run's ids.
 *
 * The dependent-table pass is driven by the FOREIGN KEY CATALOGUE rather than a
 * hand-written list. A real boot serving real requests writes rows this script
 * never mentions — `api_logs` is written by middleware on every request, and
 * `audit_logs` by an interceptor on every write — so a hand-written list is
 * guaranteed to be incomplete, and incomplete here means the SECOND run fails
 * with a foreign-key violation while the first passed. Asking Postgres which
 * tables reference `users` and `tenants` cannot drift.
 */
async function sweep(ds: DataSource): Promise<void> {
  const q = (sql: string, p: any[] = []) => ds.query(sql, p);
  const stale = `SELECT id FROM tenants WHERE name LIKE 'custlogin-%'`;

  for (const parent of ['users', 'tenants', 'customers', 'roles', 'devices']) {
    const refs: Array<{ table: string; column: string }> = await q(
      `SELECT c.conrelid::regclass::text AS table,
              a.attname               AS column
         FROM pg_constraint c
         JOIN pg_attribute a
           ON a.attrelid = c.conrelid AND a.attnum = c.conkey[1]
        WHERE c.contype = 'f'
          AND c.confrelid = $1::regclass
          AND array_length(c.conkey, 1) = 1`,
      [parent],
    );
    const doomed =
      parent === 'tenants'
        ? stale
        : `SELECT id FROM ${parent} WHERE "tenantId" IN (${stale})`;
    for (const ref of refs) {
      if (ref.table === parent) continue; // self-reference: the parent delete handles it
      await q(
        `DELETE FROM ${ref.table} WHERE "${ref.column}" IN (${doomed})`,
      ).catch(() => undefined);
    }
  }

  await q(`DELETE FROM devices WHERE "tenantId" IN (${stale})`).catch(() => undefined);
  await q(`DELETE FROM subscriptions WHERE "tenantId" IN (${stale})`).catch(() => undefined);
  await q(`DELETE FROM users WHERE "tenantId" IN (${stale})`);
  await q(`DELETE FROM roles WHERE "tenantId" IN (${stale})`).catch(() => undefined);
  await q(`DELETE FROM customers WHERE "tenantId" IN (${stale})`);
  await q(`DELETE FROM tenants WHERE name LIKE 'custlogin-%'`);
  // The tenantId-NULL catalogue rows, which no tenant delete cascades to.
  await q(`DELETE FROM customer_permissions WHERE "permissionId" IN (SELECT id FROM permissions WHERE description = $1)`, [CATALOGUE_MARKER]).catch(() => undefined);
  await q(`DELETE FROM role_permissions WHERE "permissionId" IN (SELECT id FROM permissions WHERE description = $1)`, [CATALOGUE_MARKER]).catch(() => undefined);
  await q(`DELETE FROM user_permissions WHERE "permissionId" IN (SELECT id FROM permissions WHERE description = $1)`, [CATALOGUE_MARKER]).catch(() => undefined);
  await q(`DELETE FROM permissions WHERE description = $1`, [CATALOGUE_MARKER]);
}

/**
 * The permission catalogue the grants resolve against.
 *
 * Seeded here rather than by running the full seeder: a customer's default
 * grants are `CUSTOMER_GRANTABLE_RESOURCES × ['read','list']` looked up in this
 * table, so an empty table means empty grants, an empty intersection, and a
 * 403 on every permission-gated route — which would look exactly like the bug
 * this script is meant to detect.
 */
const CATALOGUE_MARKER = 'custlogin fixture permission';

const CATALOGUE: Array<[string, string]> = [
  ['devices', 'read'], ['devices', 'list'], ['devices', 'create'],
  ['devices', 'update'], ['devices', 'delete'], ['devices', 'control'],
  ['dashboards', 'read'], ['dashboards', 'list'],
  ['assets', 'read'], ['assets', 'list'],
  ['alerts', 'read'], ['alerts', 'list'],
  ['telemetry', 'read'], ['telemetry', 'list'],
  // The customer's own users — a separate resource from `users`, and the one
  // whose defaults are not read-only (a customer admin must be able to invite
  // its own staff).
  ['customer_users', 'read'], ['customer_users', 'list'],
  ['customer_users', 'create'], ['customer_users', 'update'],
  ['customer_users', 'delete'],
  // Deliberately NOT grantable to a customer — used to prove the allow-list.
  ['customers', 'create'], ['customers', 'list'],
  ['tenants', 'delete'],
  ['users', 'create'], ['users', 'list'], ['users', 'read'],
];

interface Fixture {
  tenantA: string;
  tenantB: string;
  adminEmail: string;
  customerBId: string;
  deviceOwn: string;
  deviceSibling: string;
  deviceOtherTenant: string;
}

async function seed(ds: DataSource): Promise<Fixture> {
  const q = (sql: string, p: any[] = []) => ds.query(sql, p);
  const tenantA = randomUUID();
  const tenantB = randomUUID();

  for (const [id, label] of [[tenantA, 'a'], [tenantB, 'b']] as const) {
    await q('INSERT INTO tenants (id, name, email) VALUES ($1, $2, $3)', [
      id,
      `custlogin-${label}-${RUN}`,
      mail(`tenant-${label}`),
    ]);
  }

  // The permission catalogue: system rows, tenantId NULL.
  //
  // There is no `name` column — `Permission.permissionString` is a GETTER over
  // resource + action, so the string form exists only in TypeScript. The
  // marker in `description` is how the sweep finds these rows again: the
  // unique constraint is (tenantId, resource, action) and Postgres treats
  // NULLs as DISTINCT, so a tenantId-NULL row does not conflict with itself
  // and a re-run would otherwise stack duplicate catalogues forever.
  for (const [resource, action] of CATALOGUE) {
    await q(
      `INSERT INTO permissions (id, resource, action, description, "isSystem", "tenantId")
       VALUES ($1, $2, $3, $4, true, NULL)`,
      [randomUUID(), resource, action, CATALOGUE_MARKER],
    );
  }

  // The tenant admin goes through the REPOSITORY, not raw SQL: the password is
  // hashed by an @BeforeInsert hook on the entity, and a raw INSERT would
  // store the plaintext and then fail every login for a reason that looks like
  // a broken auth service.
  const users = ds.getRepository(User);
  const mkAdmin = async (tenantId: string, label: string) => {
    const saved = await users.save(
      users.create({
        name: `Tenant Admin ${label.toUpperCase()}`,
        email: mail(`admin-${label}`),
        password: PASSWORD,
        role: UserRole.TENANT_ADMIN,
        status: UserStatus.ACTIVE,
        emailVerified: true,
        tenantId,
      }),
    );
    return saved;
  };
  const adminA = await mkAdmin(tenantA, 'a');
  // Tenant B needs an owner of its own: `devices.userId` is NOT NULL, so the
  // other-tenant control device cannot be owned by tenant A's admin without
  // making the fixture lie about who owns what.
  const adminB = await mkAdmin(tenantB, 'b');
  const adminEmail = adminA.email;

  // ── A subscription per tenant ───────────────────────────────────────────
  //
  // `SubscriptionGuard` is global and answers 403 "No subscription found for
  // this tenant" for a tenant with no row — so without this, POST /customers
  // fails before any of the Users & Roles logic is reached. Worth knowing when
  // testing by hand: a tenant created outside the registration flow has no
  // subscription, and every guarded write refuses it.
  //
  // ENTERPRISE with everything unlimited, so neither FeatureLimitGuard nor
  // SubscriptionLimitGuard can mask a permission result: a 403 in this script
  // must mean the permission gate, not a quota.
  const limits = {
    devices: -1, users: -1, customers: -1, assets: -1, dashboards: -1,
    floorPlans: -1, automations: -1, ruleChains: -1, webhooks: -1,
    customIntegrations: -1, apiCallsPerMonth: -1, smsNotificationsPerMonth: -1,
    trainingSessions: -1, maxFloorPlans: -1, maxDevicesPerFloorPlan: -1,
    maxTemplateInstalls: -1, maxCustomTemplates: -1, templateInstallsLifetime: -1,
    storageGB: 1024, dataRetentionDays: 3650, historicalDataQueryDays: 3650,
    apiRateLimitPerMin: 100000, concurrentConnections: 10000,
    dashboardTemplates: -1, customDashboards: -1,
  };
  const features = getPlanFeatures(SubscriptionPlan.ENTERPRISE);

  for (const tenantId of [tenantA, tenantB]) {
    await q(
      `INSERT INTO subscriptions (id, "tenantId", plan, status, limits, features)
       VALUES ($1, $2, $3, 'active', $4, $5)`,
      [randomUUID(), tenantId, SubscriptionPlan.ENTERPRISE, JSON.stringify(limits), JSON.stringify(features)],
    );
  }

  // A sibling customer in the SAME tenant — the negative control that tenant
  // isolation alone does not catch.
  const customerBId = randomUUID();
  await q(
    `INSERT INTO customers (id, name, email, "tenantId", status)
     VALUES ($1, $2, $3, $4, $5)`,
    [customerBId, `custlogin-sibling-${RUN}`, mail('sibling'), tenantA, CustomerStatus.ACTIVE],
  );

  const mkDevice = async (
    tenantId: string,
    userId: string,
    customerId: string | null,
    label: string,
  ) => {
    const id = randomUUID();
    await q(
      `INSERT INTO devices (id, name, "deviceKey", "tenantId", "userId", "customerId", status, type, protocol)
       VALUES ($1, $2, $3, $4, $5, $6, 'active', 'sensor', 'generic_mqtt')`,
      [id, `custlogin-${label}-${RUN}`, `key-${label}-${RUN}`, tenantId, userId, customerId],
    );
    return id;
  };

  return {
    tenantA,
    tenantB,
    adminEmail,
    customerBId,
    // `deviceOwn` is attached to the customer created over HTTP below, so its
    // customerId is set later.
    deviceOwn: await mkDevice(tenantA, adminA.id, null, 'own'),
    deviceSibling: await mkDevice(tenantA, adminA.id, customerBId, 'sibling'),
    deviceOtherTenant: await mkDevice(tenantB, adminB.id, null, 'other-tenant'),
  };
}

/**
 * The ids in a list response, or [] for any shape that is not a list.
 *
 * A refusal body is `{success:false, ...}`, and calling `.map` on it throws —
 * which aborts the run and takes every REMAINING check with it, so one failure
 * reports as a collapse. A list read must degrade to "saw nothing".
 */
const ids = (body: any): string[] => {
  const unwrapped = payload(body);
  const rows = Array.isArray(unwrapped) ? unwrapped : unwrapped?.data;
  return Array.isArray(rows) ? rows.map((r: any) => r?.id) : [];
};

const login = async (app: BootedApp, email: string, password = PASSWORD) =>
  app.request('POST', '/auth/login', { body: { email, password } });

(async () => {
  console.log(
    `\n── Customer login (database "${database}", port ${PORT}) ─────────────\n`,
  );

  const built = await build(root);
  ok('the project builds', built.ok, built.stderr);
  if (!built.ok) {
    console.error('\n\u001b[31mFAIL\u001b[0m — nothing to boot\n');
    process.exit(1);
  }

  await prepareSchema(database);
  const ds = dataSource(database);
  await ds.initialize();
  await sweep(ds);
  const fx = await seed(ds);

  let app: BootedApp;
  try {
    app = await bootApp(root, database, PORT);
    ok('the application boots and serves', true);
  } catch (error) {
    ok('the application boots and serves', false, (error as Error).message);
    await ds.destroy();
    console.error('\n\u001b[31mFAIL\u001b[0m — cannot verify an API that is not running\n');
    process.exit(1);
  }

  try {
    // ── 1. The baseline ────────────────────────────────────────────────────
    section('1. a tenant admin can log in');

    const adminLogin = await login(app, fx.adminEmail);
    ok('POST /auth/login answers 200 for the tenant admin', adminLogin.status === 200, adminLogin.raw.slice(0, 200));
    const adminToken = payload(adminLogin.body)?.accessToken;
    ok('and returns an accessToken', typeof adminToken === 'string' && adminToken.length > 20);
    if (!adminToken) throw new Error('no admin token — nothing further can be asserted');

    // ── 2. Creating a customer mints a login ───────────────────────────────
    section('2. creating a customer mints a login account');

    const customerEmail = mail('customer-a');
    const created = await app.request('POST', '/customers', {
      token: adminToken,
      body: { name: `custlogin-cust-${RUN}`, email: customerEmail, phone: `+9665${RUN.slice(0, 7)}` },
    });
    ok('POST /customers succeeds', created.status === 201 || created.status === 200, created.raw.slice(0, 300));
    const customerId = payload(created.body)?.id;
    ok('and returns the customer id', typeof customerId === 'string', payload(created.body));
    if (!customerId) throw new Error('no customer id — nothing further can be asserted');

    const loginUser = await ds.getRepository(User).findOne({
      where: { email: customerEmail },
      select: ['id', 'email', 'role', 'status', 'emailVerified', 'customerId', 'tenantId', 'setPasswordToken', 'setPasswordExpires'],
    });
    ok('a User row was created for the customer', !!loginUser);
    ok('with role=customer', loginUser?.role === UserRole.CUSTOMER, loginUser?.role);
    ok('scoped to the creating tenant', loginUser?.tenantId === fx.tenantA);
    ok('linked to the customer row', loginUser?.customerId === customerId, loginUser?.customerId);
    ok('holding an invitation token', !!loginUser?.setPasswordToken);
    ok('and not yet email-verified', loginUser?.emailVerified === false);

    const token = loginUser?.setPasswordToken as string;

    // The list endpoint has to SAY there is a login, or the screen cannot
    // offer the action — which is what "I don't see any option for login" was.
    const list = await app.request('GET', '/customers?limit=100', { token: adminToken });
    ok('GET /customers answers 200', list.status === 200, list.raw.slice(0, 200));
    const rows: any[] = payload(list.body)?.data ?? payload(list.body) ?? [];
    const row = rows.find((r) => r?.id === customerId);
    ok('the customer appears in the list', !!row);
    ok('carrying its login email', row?.loginEmail === customerEmail, row?.loginEmail);
    ok('and an invitation-pending flag the UI can render', row?.invitationPending === true, {
      invitationPending: row?.invitationPending,
      loginStatus: row?.loginStatus,
    });

    // ── 3. The invitation is required ──────────────────────────────────────
    section('3. the login is refused before activation');

    const premature = await login(app, customerEmail);
    ok('logging in before setting a password is refused', premature.status === 401, `status ${premature.status}`);
    ok(
      'and the refusal does not leak a token',
      !payload(premature.body)?.accessToken,
    );

    // ── 4. Activation, and the login that was the question ─────────────────
    section('4. the invitation activates the account and login SUCCEEDS');

    const activate = await app.request('POST', '/auth/set-password', {
      body: { token, password: PASSWORD },
    });
    ok('POST /auth/set-password accepts the invitation token', activate.status === 200, activate.raw.slice(0, 250));

    const custLogin = await login(app, customerEmail);
    ok('POST /auth/login now answers 200 for the CUSTOMER', custLogin.status === 200, custLogin.raw.slice(0, 250));
    const custToken = payload(custLogin.body)?.accessToken;
    ok('and returns an accessToken', typeof custToken === 'string' && custToken.length > 20);

    const me = await app.request('GET', '/auth/me', { token: custToken });
    ok('GET /auth/me answers 200 with that token', me.status === 200, me.raw.slice(0, 200));
    const meBody = payload(me.body);
    ok('the session reports role=customer', meBody?.role === UserRole.CUSTOMER, meBody?.role);
    ok('and carries the customerId', meBody?.customerId === customerId, meBody?.customerId);
    ok('and the tenantId', meBody?.tenantId === fx.tenantA, meBody?.tenantId);

    const afterActivation = await ds.getRepository(User).findOne({
      where: { email: customerEmail },
      select: ['id', 'status', 'emailVerified', 'setPasswordToken'],
    });
    ok('the account is ACTIVE', afterActivation?.status === UserStatus.ACTIVE, afterActivation?.status);
    ok('and email-verified (login checks this, in a different module)', afterActivation?.emailVerified === true);

    const customerRow = await ds.getRepository(Customer).findOne({ where: { id: customerId } });
    ok(
      'the customers row followed the activation out of INACTIVE',
      customerRow?.status === CustomerStatus.ACTIVE,
      customerRow?.status,
    );

    // ── 5. The token is single-use ─────────────────────────────────────────
    section('5. the invitation token is consumed');

    ok('the token column is cleared', !afterActivation?.setPasswordToken, afterActivation?.setPasswordToken);
    const replay = await app.request('POST', '/auth/set-password', {
      body: { token, password: 'An0ther!Passw0rd' },
    });
    ok(
      'replaying the same link is refused — it is not a reusable password reset',
      replay.status === 400,
      `status ${replay.status}`,
    );

    // ── 6. The customer sees its own things only ───────────────────────────
    section('6. the customer sees its own device, and no one else\'s');

    // Attach the unassigned device to this customer now that it exists.
    await ds.query('UPDATE devices SET "customerId" = $1 WHERE id = $2', [customerId, fx.deviceOwn]);

    const devices = await app.request('GET', '/devices?limit=100', { token: custToken });
    ok('GET /devices answers 200 for the customer', devices.status === 200, devices.raw.slice(0, 250));
    const visible: string[] = ids(devices.body);
    ok('its own device is visible', visible.includes(fx.deviceOwn), visible);
    ok('a SIBLING customer\'s device in the same tenant is not', !visible.includes(fx.deviceSibling));
    ok('another tenant\'s device is not', !visible.includes(fx.deviceOtherTenant));

    const sibling = await app.request('GET', `/devices/${fx.deviceSibling}`, { token: custToken });
    ok(
      'fetching the sibling\'s device by uuid answers 404, not 403 (§4g)',
      sibling.status === 404,
      `status ${sibling.status}`,
    );
    const foreign = await app.request('GET', `/devices/${fx.deviceOtherTenant}`, { token: custToken });
    ok('fetching another tenant\'s device by uuid answers 404', foreign.status === 404, `status ${foreign.status}`);

    // ── 7. The permission matrix decides — immediately ─────────────────────
    section('7. the permission matrix decides access');

    const grantable = await app.request('GET', '/customers/permissions/grantable', { token: adminToken });
    ok('GET /customers/permissions/grantable answers 200', grantable.status === 200, grantable.raw.slice(0, 200));
    const grantableRows: any[] = payload(grantable.body) ?? [];
    ok('it offers permissions to grant', grantableRows.length > 0);
    ok(
      'and offers NO tenant-administration resource',
      !grantableRows.some((p) => ['customers', 'tenants', 'users'].includes(p?.resource)),
      grantableRows.filter((p) => ['customers', 'tenants', 'users'].includes(p?.resource)).map((p) => `${p?.resource}:${p?.action}`),
    );

    const current = await app.request('GET', `/customers/${customerId}/permissions`, { token: adminToken });
    ok('GET /customers/:id/permissions answers 200', current.status === 200, current.raw.slice(0, 200));
    const held: any[] = payload(current.body) ?? [];
    ok('the customer was seeded with default grants', held.length > 0, held.length);
    ok(
      'and they are read/list only, except the customer\'s own users',
      held.every((p) =>
        p?.resource === 'customer_users'
          ? ['read', 'list', 'create', 'update'].includes(p?.action)
          : ['read', 'list'].includes(p?.action),
      ),
      held.map((p) => `${p?.resource}:${p?.action}`),
    );
    ok(
      'and they let the customer admin invite its own users',
      held.some((p) => p?.resource === 'customer_users' && p?.action === 'create'),
      held.filter((p) => p?.resource === 'customer_users').map((p) => p?.action),
    );

    // Revoke every devices:* grant and re-ask IMMEDIATELY. Before the
    // `bumpTenant` fix the guard answered from its cache and this stayed 200
    // for up to 60s.
    const withoutDevices = held.filter((p) => p?.resource !== 'devices').map((p) => p.id);
    const revoke = await app.request('PUT', `/customers/${customerId}/permissions`, {
      token: adminToken,
      body: { permissionIds: withoutDevices },
    });
    ok('PUT /customers/:id/permissions accepts the change', revoke.status === 200, revoke.raw.slice(0, 250));

    const afterRevoke = await app.request('GET', '/devices?limit=100', { token: custToken });
    ok(
      'revoking devices:list 403s the VERY NEXT request (no cache lag)',
      afterRevoke.status === 403,
      `status ${afterRevoke.status} — a 200 here means the permission cache was not invalidated`,
    );

    const restore = await app.request('PUT', `/customers/${customerId}/permissions`, {
      token: adminToken,
      body: { permissionIds: held.map((p) => p.id) },
    });
    ok('restoring the grant succeeds', restore.status === 200, restore.raw.slice(0, 200));
    const afterRestore = await app.request('GET', '/devices?limit=100', { token: custToken });
    ok(
      'and the next request is allowed again',
      afterRestore.status === 200,
      `status ${afterRestore.status}`,
    );

    // The allow-list, server-side. The picker hides these; a crafted request
    // must not get past it.
    const forbiddenPerm = await ds.getRepository(Permission).findOne({
      where: { resource: 'tenants', action: 'delete' },
    });
    const escalate = await app.request('PUT', `/customers/${customerId}/permissions`, {
      token: adminToken,
      body: { permissionIds: [...held.map((p) => p.id), forbiddenPerm!.id] },
    });
    ok(
      'a customer cannot be granted tenants:delete even by direct request',
      escalate.status === 400,
      `status ${escalate.status}`,
    );

    // ── 8. A customer user logs in too ─────────────────────────────────────
    section('8. a customer user activates and logs in');

    const cuEmail = mail('cust-user');
    const cuCreated = await app.request('POST', '/customer-users', {
      token: custToken,
      body: { email: cuEmail, name: 'Customer User One', customerId },
    });
    ok('POST /customer-users succeeds for the customer admin', cuCreated.status === 201 || cuCreated.status === 200, cuCreated.raw.slice(0, 300));

    const cuRow = await ds.getRepository(User).findOne({
      where: { email: cuEmail },
      select: ['id', 'role', 'customerId', 'tenantId', 'setPasswordToken'],
    });
    ok('a User row was created', !!cuRow);
    ok('with role=customer_user', cuRow?.role === UserRole.CUSTOMER_USER, cuRow?.role);
    ok('under the same customer', cuRow?.customerId === customerId, cuRow?.customerId);
    ok('and an invitation token of its own', !!cuRow?.setPasswordToken);

    const cuActivate = await app.request('POST', '/auth/set-password', {
      body: { token: cuRow!.setPasswordToken as string, password: PASSWORD },
    });
    ok('POST /auth/set-password activates the customer user', cuActivate.status === 200, cuActivate.raw.slice(0, 250));

    const cuLogin = await login(app, cuEmail);
    ok('POST /auth/login answers 200 for the CUSTOMER USER', cuLogin.status === 200, cuLogin.raw.slice(0, 250));
    const cuToken = payload(cuLogin.body)?.accessToken;
    ok('and returns an accessToken', typeof cuToken === 'string' && cuToken.length > 20);

    const cuDevices = await app.request('GET', '/devices?limit=100', { token: cuToken });
    ok(
      'it can list devices even with no role assigned yet',
      cuDevices.status === 200,
      `status ${cuDevices.status}: ${cuDevices.body?.message ?? ''}`,
    );
    const cuVisible: string[] = ids(cuDevices.body);
    ok('seeing its customer\'s device', cuVisible.includes(fx.deviceOwn), cuVisible);
    ok('and not the sibling customer\'s', !cuVisible.includes(fx.deviceSibling));

    // ── 9. Role inheritance, and the ceiling above it ──────────────────────
    section('9. a custom role\'s permissions are inherited by assignment');

    // ── Choosing what to test inheritance WITH ─────────────────────────────
    //
    // `devices:create` on `POST /devices`, not `devices:control` on
    // `POST /gateway/devices/:key/command`. The gateway command route carries
    // `@TenantOrCustomerAdmin()`, so `RolesGuard` refuses a CUSTOMER_USER
    // before `PermissionGuard` is ever consulted — it answers a bare
    // "Insufficient permissions" and no grant can change that. Testing
    // inheritance there would have measured the role list and reported it as a
    // permission result.
    //
    // `POST /devices` lists CUSTOMER_USER in its own `@Roles`, so the
    // permission really is the deciding factor, and `devices:create` is absent
    // from the read-only defaults — which is what makes the before/after
    // meaningful.
    const createPerm = await ds.getRepository(Permission).findOne({
      where: { resource: 'devices', action: 'create' },
    });
    const roleCreated = await app.request('POST', '/roles', {
      token: adminToken,
      body: {
        name: `custlogin-role-${RUN}`,
        description: 'Device creator',
        permissionIds: [createPerm!.id],
      },
    });
    ok('POST /roles creates a custom role', roleCreated.status === 201 || roleCreated.status === 200, roleCreated.raw.slice(0, 300));
    const roleId = payload(roleCreated.body)?.id;
    ok('and returns its id', typeof roleId === 'string', payload(roleCreated.body));

    const roleRow = await ds.getRepository(Role).findOne({
      where: { id: roleId },
      relations: ['permissions'],
    });
    ok('the role holds the permission it was given', roleRow?.permissions?.some((p) => p.id === createPerm!.id) === true);
    ok('and is scoped to the tenant that made it', roleRow?.tenantId === fx.tenantA, roleRow?.tenantId);

    // Assign it to the customer user, through the route the UI actually calls.
    //
    // NOT `PATCH /users/:id` with `roleIds`: `UpdateUserDto` has no such field
    // and the global ValidationPipe runs `forbidNonWhitelisted: true`, so that
    // request is a 400 — which would look like a broken role assignment.
    // `PATCH /users/bulk/assign-role` with a single id is what
    // `UserRolePicker` sends; `POST /users/:id/roles` is the single-user
    // equivalent and is asserted to exist below.
    const assign = await app.request('PATCH', '/users/bulk/assign-role', {
      token: adminToken,
      body: { roleId, userIds: [cuRow!.id] },
    });
    ok('assigning the role to the customer user succeeds', assign.status === 200, assign.raw.slice(0, 250));

    const singleRoute = await app.request('POST', `/users/${cuRow!.id}/roles`, {
      token: adminToken,
      body: { roleId },
    });
    ok(
      'POST /users/:id/roles exists for the single-user case (not a 404)',
      singleRoute.status !== 404,
      `status ${singleRoute.status}`,
    );

    const assigned = await ds.getRepository(User).findOne({
      where: { id: cuRow!.id },
      relations: ['roles', 'roles.permissions'],
    });
    ok(
      'the user now holds the role',
      assigned?.roles?.some((r) => r.id === roleId) === true,
      assigned?.roles?.map((r) => r.name),
    );
    ok(
      'and inherits its permission through it',
      assigned?.roles?.some((r) => r.permissions?.some((p) => p.id === createPerm!.id)) === true,
    );

    const newDevice = (suffix: string) => ({
      name: `custlogin-made-${suffix}-${RUN}`,
      type: 'sensor',
      connectionType: 'wifi',
      protocol: 'generic_mqtt',
    });

    // The ceiling: the role grants devices:create, the customer's grants are
    // read/list, and the effective set is an INTERSECTION — so it must not
    // apply yet.
    const blocked = await app.request('POST', '/devices', {
      token: cuToken,
      body: newDevice('a'),
    });
    ok(
      'an inherited permission the CUSTOMER lacks is still refused (the ceiling holds)',
      blocked.status === 403,
      `status ${blocked.status}: ${blocked.body?.message ?? ''} — a role must not exceed its customer's grants`,
    );

    // Raise the ceiling, and the same request goes through.
    const raised = await app.request('PUT', `/customers/${customerId}/permissions`, {
      token: adminToken,
      body: { permissionIds: [...held.map((p) => p.id), createPerm!.id] },
    });
    ok('raising the customer\'s ceiling to include devices:create succeeds', raised.status === 200, raised.raw.slice(0, 200));

    const allowed = await app.request('POST', '/devices', {
      token: cuToken,
      body: newDevice('b'),
    });
    ok(
      'and the inherited permission then applies',
      allowed.status === 201 || allowed.status === 200,
      `status ${allowed.status}: ${allowed.body?.message ?? allowed.raw.slice(0, 160)}`,
    );

    // And the device it created belongs to its own customer. Before this,
    // `create()` set userId and tenantId from the caller but not customerId,
    // so the row landed unassigned: credential issuance then refused with
    // "Access denied to this device" AFTER saving it, leaving an orphan its
    // own creator could neither see nor delete.
    const madeId = payload(allowed.body)?.device?.id ?? payload(allowed.body)?.id;
    const made = madeId
      ? await ds.query('SELECT "customerId", "tenantId" FROM devices WHERE id = $1', [madeId])
      : [];
    ok(
      'and the device it created is attributed to its own customer',
      made[0]?.customerId === customerId,
      { madeId, row: made[0] },
    );

    // And the inheritance is what carries it: the account holds no DIRECT
    // permissions, so removing the role must take the ability away again.
    const removed = await app.request('PATCH', '/users/bulk/remove-role', {
      token: adminToken,
      body: { roleId, userIds: [cuRow!.id] },
    });
    ok('removing the role succeeds', removed.status === 200, removed.raw.slice(0, 200));

    const afterRemoval = await app.request('POST', '/devices', {
      token: cuToken,
      body: newDevice('c'),
    });
    ok(
      'and revoking the role revokes what it granted',
      afterRemoval.status === 403,
      `status ${afterRemoval.status} — the permission came from the role, so it must leave with it`,
    );

  } catch (error) {
    ok('the verification ran to completion', false, (error as Error).message);
  } finally {
    await app!.stop();
    await sweep(ds).catch(() => undefined);
    await ds.destroy();
  }

  console.log(
    failures === 0
      ? `\n\u001b[32mPASS\u001b[0m — ${checks} checks: customers and customer users can log in, see only their own things, and the permission matrix decides\n`
      : `\n\u001b[31mFAIL\u001b[0m — ${failures} of ${checks} checks failed\n`,
  );
  process.exit(failures === 0 ? 0 : 1);
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
