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
    await q('INSERT INTO customers (id, name, email, "tenantId") VALUES ($1,$2,$3,$4)', [
      id, `Cust ${id.slice(0, 8)}`, `c-${id.slice(0, 8)}@example.invalid`, tenant,
    ]);
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
