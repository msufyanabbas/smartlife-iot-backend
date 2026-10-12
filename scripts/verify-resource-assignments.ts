/**
 * Verifies the resource-assignment reads against a real PostgreSQL.
 *
 *   createdb asgncheck && npm run verify:assignments asgncheck
 *
 * The module shipped with assign and unassign and **no GET route**, so a
 * tenant admin could grant a device to a customer and then had no way to see
 * or revoke what they had granted. These are the reads that make an
 * assignment screen possible, and the things worth asserting are:
 *
 *   - names come back, not bare uuids (a uuid list is unusable)
 *   - the "assignable" picker excludes what is already assigned
 *   - a user's picker offers only what their CUSTOMER already holds, because
 *     the assign path enforces exactly that and a picker full of options the
 *     server refuses teaches people to distrust the UI
 *   - every read is pinned to the caller's tenant
 *   - a soft-deleted resource disappears from both lists
 */
import { DataSource } from 'typeorm';
import { randomUUID } from 'crypto';
import * as entities from '../src/modules/index.entities';
import { AssignmentService } from '../src/modules/assignments/assignment.service';

const database = process.argv[2] ?? 'asgncheck';

let failures = 0;
const ok = (label: string, condition: boolean, detail?: unknown) => {
  if (condition) console.log(`  ✓ ${label}`);
  else {
    failures++;
    console.error(`  ✗ ${label}`, detail ?? '');
  }
};
const section = (t: string) => console.log(`\n── ${t} ─────────────`);

const T_A = randomUUID();
const T_B = randomUUID();
const CUST_A = randomUUID();
const CUST_B = randomUUID();
const USER_A = randomUUID();
const ADMIN_A = randomUUID();

(async () => {
  const ds = new DataSource({
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
  await ds.initialize();
  const q = (sql: string, p: any[] = []) => ds.query(sql, p);

  for (const t of ['customer_devices', 'user_devices', 'devices', 'users', 'customers', 'tenants']) {
    await q(`DELETE FROM "${t}"`).catch(() => undefined);
  }

  for (const [i, id] of [T_A, T_B].entries()) {
    await q('INSERT INTO tenants (id, name, email) VALUES ($1,$2,$3)', [
      id, `Asgn tenant ${i}`, `asgn${i}-${id.slice(0, 8)}@example.invalid`,
    ]);
  }
  for (const [id, tenant] of [[CUST_A, T_A], [CUST_B, T_B]] as const) {
    // `customers.status` defaults to 'inactive', and the assign path refuses
    // an inactive customer. Leaving the default made every bulk assignment
    // fail with "Customer account is not active" — correct behaviour, useless
    // fixture.
    await q(
      `INSERT INTO customers (id, name, email, "tenantId", status)
       VALUES ($1,$2,$3,$4,'active')`,
      [id, `Cust ${id.slice(0, 8)}`, `c-${id.slice(0, 8)}@example.invalid`, tenant],
    );
  }
  const addUser = (id: string, role: string, tenantId: string, customerId: string | null) =>
    q(`INSERT INTO users (id,email,password,name,role,"tenantId","customerId")
       VALUES ($1,$2,'x',$3,$4,$5,$6)`,
      [id, `${id.slice(0, 8)}@example.invalid`, role, role, tenantId, customerId]);
  await addUser(ADMIN_A, 'tenant_admin', T_A, null);
  await addUser(USER_A, 'customer_user', T_A, CUST_A);

  // Three devices in tenant A, one in tenant B.
  const devices: Record<string, string> = {};
  for (const name of ['Alpha sensor', 'Beta sensor', 'Gamma sensor']) {
    const id = randomUUID();
    devices[name] = id;
    await q(`INSERT INTO devices (id,"tenantId","userId",name,"deviceKey")
             VALUES ($1,$2,$3,$4,$5)`,
      [id, T_A, ADMIN_A, name, `asgn-${id.slice(0, 8)}`]);
  }
  const foreignDevice = randomUUID();
  await q(`INSERT INTO devices (id,"tenantId","userId",name,"deviceKey")
           VALUES ($1,$2,$3,$4,$5)`,
    [foreignDevice, T_B, ADMIN_A, 'Tenant B sensor', `asgn-${foreignDevice.slice(0, 8)}`]);

  // Only the listing methods are exercised; they take dataSource + repos.
  const repo = (e: any) => ds.getRepository(e);
  const service = new AssignmentService(
    ds,
    repo(entities.Customer) as any,
    repo((entities as any).CustomerUserLimit) as any,
    repo(entities.Subscription) as any,
    repo((entities as any).CustomerDevice) as any,
    repo((entities as any).UserDevice) as any,
    repo((entities as any).CustomerDashboard) as any,
    repo((entities as any).UserDashboard) as any,
    repo((entities as any).CustomerAsset) as any,
    repo((entities as any).UserAsset) as any,
    repo((entities as any).CustomerFloorPlan) as any,
    repo((entities as any).UserFloorPlan) as any,
    repo((entities as any).CustomerAutomation) as any,
    repo((entities as any).UserAutomation) as any,
    repo(entities.User) as any,
  );

  section('1. Nothing assigned yet');
  let assigned = await service.listCustomerAssignments(CUST_A, T_A);
  ok('customer has no devices', assigned.devices.length === 0);
  ok('every resource type is present as an empty list', Object.keys(assigned).length === 5,
    Object.keys(assigned));

  let pickable = await service.listAssignableResources('devices', T_A, { customerId: CUST_A });
  ok('all 3 tenant devices are assignable', pickable.length === 3, pickable.map((r) => r.name));
  ok('the picker returns names, not just ids', pickable.every((r) => !!r.name));
  ok("another tenant's device is not offered",
    !pickable.some((r) => r.id === foreignDevice), pickable.map((r) => r.name));

  section('2. After assigning two to the customer');
  for (const name of ['Alpha sensor', 'Beta sensor']) {
    await q(`INSERT INTO customer_devices (id,"tenantId","customerId","deviceId","assignedBy")
             VALUES ($1,$2,$3,$4,$5)`,
      [randomUUID(), T_A, CUST_A, devices[name], ADMIN_A]);
  }
  assigned = await service.listCustomerAssignments(CUST_A, T_A);
  ok('both show up, ordered by name',
    assigned.devices.map((d) => d.name).join(',') === 'Alpha sensor,Beta sensor',
    assigned.devices.map((d) => d.name));
  ok('each carries assignedAt and assignedBy',
    assigned.devices.every((d) => !!d.assignedAt && d.assignedBy === ADMIN_A));

  pickable = await service.listAssignableResources('devices', T_A, { customerId: CUST_A });
  ok('the picker now offers only the unassigned one',
    pickable.length === 1 && pickable[0].name === 'Gamma sensor',
    pickable.map((r) => r.name));

  section("3. A user's picker is bounded by their customer");
  pickable = await service.listAssignableResources('devices', T_A, { userId: USER_A });
  ok('offers exactly what the customer holds',
    pickable.length === 2 &&
      pickable.map((r) => r.name).join(',') === 'Alpha sensor,Beta sensor',
    pickable.map((r) => r.name));
  ok('does NOT offer Gamma, which the customer does not hold',
    !pickable.some((r) => r.name === 'Gamma sensor'));

  await q(`INSERT INTO user_devices (id,"tenantId","customerId","userId","deviceId","assignedBy")
           VALUES ($1,$2,$3,$4,$5,$6)`,
    [randomUUID(), T_A, CUST_A, USER_A, devices['Alpha sensor'], ADMIN_A]);
  pickable = await service.listAssignableResources('devices', T_A, { userId: USER_A });
  ok('once held by the user it leaves their picker',
    pickable.length === 1 && pickable[0].name === 'Beta sensor',
    pickable.map((r) => r.name));
  const userAssigned = await service.listUserAssignments(USER_A, T_A);
  ok('and appears in the user’s assignment list',
    userAssigned.devices.length === 1 && userAssigned.devices[0].name === 'Alpha sensor');

  section('4. Search and bounds');
  pickable = await service.listAssignableResources('devices', T_A, { customerId: CUST_A }, 'gam');
  ok('search matches case-insensitively', pickable.length === 1, pickable.map((r) => r.name));
  pickable = await service.listAssignableResources('devices', T_A, { customerId: CUST_A }, 'nope');
  ok('a search with no hits returns empty, not everything', pickable.length === 0);

  section('5. Tenant isolation');
  let denied = false;
  try {
    await service.listCustomerAssignments(CUST_B, T_A);
  } catch {
    denied = true;
  }
  ok("tenant A cannot read tenant B's customer assignments", denied);

  denied = false;
  try {
    await service.listUserAssignments(USER_A, T_B);
  } catch {
    denied = true;
  }
  ok("tenant B cannot read tenant A's user assignments", denied);

  // ── The reverse direction: "who holds this device?" ───────────────────────
  //
  // This is where the question is actually asked — you are looking at a
  // device list and want to hand one over. The per-row lookup and the
  // batched one must agree, or an "Assigned to" column shows something
  // different from the dialog that opens next to it.
  section('7. Reverse lookup — who holds this resource');
  let holders = await service.listResourceHolders('devices', devices['Beta sensor'], T_A);
  ok('the holding customer comes back by name',
    holders.customers.length === 1 && holders.customers[0].name.startsWith('Cust'),
    holders.customers);
  ok('no user holds it yet', holders.users.length === 0, holders.users);

  holders = await service.listResourceHolders('devices', devices['Alpha sensor'], T_A);
  ok('a device held by a user reports that user',
    holders.users.length === 1 && holders.users[0].id === USER_A,
    holders.users);
  ok('and the user row carries their customer',
    holders.users[0]?.customerId === CUST_A);

  holders = await service.listResourceHolders('devices', devices['Gamma sensor'], T_A);
  ok('an unassigned device reports nobody',
    holders.customers.length === 0 && holders.users.length === 0);

  let crossTenant = false;
  try {
    await service.listResourceHolders('devices', foreignDevice, T_A);
  } catch {
    crossTenant = true;
  }
  ok("tenant A cannot ask who holds tenant B's device", crossTenant);

  let badType = false;
  try {
    await service.listResourceHolders('devices; DROP TABLE users' as any, devices['Beta sensor'], T_A);
  } catch {
    badType = true;
  }
  ok('an unknown resourceType is refused, not interpolated', badType);

  section('8. Batched reverse lookup matches the per-row one');
  const batched = await service.listHoldersForMany(
    'devices',
    [devices['Alpha sensor'], devices['Beta sensor'], devices['Gamma sensor']],
    T_A,
  );
  ok('every requested id is a key, even with no holders',
    Object.keys(batched).length === 3, Object.keys(batched).length);
  ok('Beta matches the per-row answer',
    batched[devices['Beta sensor']].customers.length === 1);
  ok('Gamma is present and empty, not absent',
    !!batched[devices['Gamma sensor']] &&
      batched[devices['Gamma sensor']].customers.length === 0);
  ok('Alpha reports its user',
    batched[devices['Alpha sensor']].users.length === 1);
  const foreignBatch = await service.listHoldersForMany('devices', [foreignDevice], T_A);
  ok("another tenant's device comes back with no holders, not theirs",
    foreignBatch[foreignDevice].customers.length === 0);

  section('9. Bulk assignment reports per-resource outcome');
  // A real assignment passes three gates, so the fixture has to satisfy all
  // three or every row fails for a reason that has nothing to do with bulk:
  //   1. an ACTIVE subscription whose plan includes the `devices` feature
  //   2. a customer with a granted `devices` permission
  //   3. headroom under both the subscription limit and the customer allocation
  await q(
    `INSERT INTO subscriptions ("tenantId", plan, status, limits, features, usage)
     VALUES ($1,'professional','active',$2,$3,$4)`,
    [
      T_A,
      JSON.stringify({ devices: 100, dashboards: 50, assets: 50, floorPlans: 25, automations: 50 }),
      JSON.stringify({ devices: true, dashboards: true, assets: true, floorPlans: true, automations: true }),
      JSON.stringify({ devices: 0, dashboards: 0, assets: 0, floorPlans: 0, automations: 0 }),
    ],
  );
  // `grantedPermissions` is a RELATION to customer_permissions, not a jsonb
  // column on customers — `loadAndVerifyCustomer` pulls it with
  // `relations: ['grantedPermissions']`.
  const permId = randomUUID();
  await q(
    `INSERT INTO permissions (id, resource, action, "isSystem") VALUES ($1,'devices','read',true)`,
    [permId],
  );
  await q(
    `INSERT INTO customer_permissions ("customerId","permissionId") VALUES ($1,$2)`,
    [CUST_A, permId],
  );

  const actor = { id: ADMIN_A, tenantId: T_A, role: 'tenant_admin' } as any;
  const bulk = await service.assignManyToCustomer(
    [devices['Gamma sensor'], randomUUID()],
    'devices',
    CUST_A,
    actor,
  );
  ok('the real device succeeded',
    bulk.succeeded.length === 1 && bulk.succeeded[0] === devices['Gamma sensor'],
    bulk);
  ok('the bogus id failed WITHOUT rolling back the good one',
    bulk.failed.length === 1, bulk.failed);
  ok('and the failure carries a reason, not just a flag',
    !!bulk.failed[0]?.reason && bulk.failed[0].reason.length > 3,
    bulk.failed[0]);
  ok('requested counts the de-duplicated input', bulk.requested === 2);
  const afterBulk = await service.listCustomerAssignments(CUST_A, T_A);
  ok('the successful one really landed',
    afterBulk.devices.some((d) => d.name === 'Gamma sensor'),
    afterBulk.devices.map((d) => d.name));

  let emptyRejected = false;
  try {
    await service.assignManyToCustomer([], 'devices', CUST_A, actor);
  } catch {
    emptyRejected = true;
  }
  ok('an empty bulk is refused rather than silently succeeding', emptyRejected);

  section('6. A soft-deleted resource disappears');
  await q('UPDATE devices SET deleted_at = now() WHERE id = $1', [devices['Alpha sensor']]);
  assigned = await service.listCustomerAssignments(CUST_A, T_A);
  ok('the deleted device is gone from the customer list',
    !assigned.devices.some((d) => d.name === 'Alpha sensor'),
    assigned.devices.map((d) => d.name));
  const after = await service.listUserAssignments(USER_A, T_A);
  ok('and from the user list', after.devices.length === 0, after.devices);

  await ds.destroy();
  console.log(
    failures
      ? `\nFAIL — ${failures} check(s) failed`
      : '\nPASS — assignment reads are scoped, named, and exclude what is already held',
  );
  process.exit(failures ? 1 : 0);
})().catch((e) => {
  console.error('\nFAILED:', e?.message);
  console.error(e?.stack);
  process.exit(1);
});
