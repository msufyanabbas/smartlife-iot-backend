/**
 * Proves telemetry reads and deletes are confined to the caller's tenant.
 *
 *   createdb tscope && npm run verify:telemetry-scoping tscope
 *
 * ── The hole this closes ───────────────────────────────────────────────────
 * Every read on `TelemetryService` resolved its device with
 * `deviceRepository.findOne({ where: { id: deviceId } })` — by id alone — and
 * accepted a `userId` argument it then ignored. A comment above one of them
 * claimed it "uses tenantId from the device record for access control"; no
 * such predicate existed in the file.
 *
 * So `GET /telemetry/devices/:deviceId/timeseries` served ANY authenticated
 * user ANY tenant's telemetry if they knew a device id, and
 * `DELETE /telemetry/devices/:deviceId` destroyed it. On this platform the
 * telemetry is the product.
 *
 * Reads are asserted through the service, not the controller, because that is
 * where the check now lives and where a future refactor would most plausibly
 * drop it.
 */
import { DataSource } from 'typeorm';
import { randomUUID } from 'crypto';
import * as entities from '../src/modules/index.entities';
import { Telemetry } from '../src/modules/telemetry/entities/telemetry.entity';
import { Device } from '../src/modules/devices/entities/device.entity';
import { TelemetryService } from '../src/modules/telemetry/telemetry.service';

const database = process.argv[2] ?? 'tscope';

let failures = 0;
const ok = (label: string, condition: boolean, detail?: unknown) => {
  if (condition) console.log(`  ✓ ${label}`);
  else {
    failures++;
    console.error(`  ✗ ${label}`, detail ?? '');
  }
};

/** A read that must be refused. Anything other than a throw is a leak. */
const mustDeny = async (label: string, run: () => Promise<unknown>) => {
  let leaked: unknown = '__THREW__';
  try {
    leaked = await run();
  } catch {
    /* expected */
  }
  ok(label, leaked === '__THREW__', leaked);
};

const TENANT_A = randomUUID();
const TENANT_B = randomUUID();
const ADMIN_A = randomUUID();
const ADMIN_B = randomUUID();
const SUPER = randomUUID();
const CUSTOMER_A = randomUUID();
const CUST_USER_A = randomUUID();
const OTHER_CUSTOMER_A = randomUUID();

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

  const telemetryRepo = dataSource.getRepository(Telemetry);
  const deviceRepo = dataSource.getRepository(Device);
  const q = (sql: string, params: any[] = []) => deviceRepo.query(sql, params);

  await q('DELETE FROM telemetry');
  await q('DELETE FROM devices');
  await q('DELETE FROM users WHERE id = ANY($1)', [
    [ADMIN_A, ADMIN_B, SUPER, CUST_USER_A],
  ]);
  await q('DELETE FROM customers WHERE id = ANY($1)', [
    [CUSTOMER_A, OTHER_CUSTOMER_A],
  ]);
  await q('DELETE FROM tenants WHERE id = ANY($1)', [[TENANT_A, TENANT_B]]);

  for (const [i, id] of [TENANT_A, TENANT_B].entries()) {
    await q('INSERT INTO tenants (id, name, email) VALUES ($1, $2, $3)', [
      id,
      `Scope tenant ${i} ${id.slice(0, 8)}`,
      `scope${i}-${id.slice(0, 8)}@example.invalid`,
    ]);
  }
  for (const [id, tenant] of [
    [CUSTOMER_A, TENANT_A],
    [OTHER_CUSTOMER_A, TENANT_A],
  ] as const) {
    await q(
      'INSERT INTO customers (id, name, email, "tenantId") VALUES ($1, $2, $3, $4)',
      [id, `Cust ${id.slice(0, 8)}`, `c-${id.slice(0, 8)}@example.invalid`, tenant],
    );
  }
  const addUser = (id: string, role: string, tenantId: string | null, customerId: string | null) =>
    q(
      `INSERT INTO users (id, email, password, name, role, "tenantId", "customerId")
       VALUES ($1, $2, 'x', $3, $4, $5, $6)`,
      [id, `${id.slice(0, 8)}@example.invalid`, role, role, tenantId, customerId],
    );
  await addUser(ADMIN_A, 'tenant_admin', TENANT_A, null);
  await addUser(ADMIN_B, 'tenant_admin', TENANT_B, null);
  await addUser(SUPER, 'super_admin', null, null);
  await addUser(CUST_USER_A, 'customer_user', TENANT_A, CUSTOMER_A);

  // One device per tenant, plus one belonging to another customer of tenant A.
  const mkDevice = async (tenantId: string, customerId: string | null, key: string) => {
    const device = await deviceRepo.save(
      deviceRepo.create({
        tenantId,
        customerId: customerId ?? undefined,
        userId: tenantId === TENANT_A ? ADMIN_A : ADMIN_B,
        name: key,
        deviceKey: key,
      } as any),
    );
    const saved = Array.isArray(device) ? device[0] : device;
    await telemetryRepo.save(
      telemetryRepo.create({
        tenantId,
        deviceId: saved.id,
        // Denormalised on the telemetry row and NOT NULL — the ingest path
        // writes it from the device, so a fixture must too.
        deviceKey: key,
        timestamp: new Date(),
        data: { temperature: 21 },
      } as any),
    );
    return saved;
  };

  const deviceA = await mkDevice(TENANT_A, CUSTOMER_A, `scope-a-${Date.now()}`);
  const deviceB = await mkDevice(TENANT_B, null, `scope-b-${Date.now()}`);
  const deviceOtherCustomer = await mkDevice(
    TENANT_A,
    OTHER_CUSTOMER_A,
    `scope-a2-${Date.now()}`,
  );

  // Only the device lookup matters here; the collaborators are never reached
  // because every denied call throws before touching them.
  const noop: any = new Proxy(
    {},
    { get: () => async () => undefined },
  );
  const service = new TelemetryService(
    telemetryRepo,
    deviceRepo,
    noop, // redis
    // TelemetryLatestCacheService — a permanent miss here is what this script
    // wants: it asserts tenant scoping of reads from Postgres, not what a
    // cache replays.
    noop, // latest-reading cache
    noop, // profile alarms
    noop, // integration dispatch
    noop, // automation
    noop, // rollups
    noop, // retention
  );

  const since = new Date(Date.now() - 3_600_000).toISOString();
  const until = new Date(Date.now() + 3_600_000).toISOString();

  console.log('\n── Tenant A admin reading tenant B’s device ───');
  await mustDeny('findByDevice', () =>
    service.findByDevice(deviceB.id, ADMIN_A, {} as any),
  );
  await mustDeny('getLatest', () => service.getLatest(deviceB.id, ADMIN_A));
  await mustDeny('getStatistics', () =>
    service.getStatistics(deviceB.id, ADMIN_A, since, until),
  );
  await mustDeny('getTimeSeries', () =>
    (service as any).getTimeSeries(deviceB.id, ADMIN_A, 'temperature', since, until, 10),
  );
  await mustDeny('getAggregated', () =>
    (service as any).getAggregated(deviceB.id, ADMIN_A, 'temperature', 'hour', since, until),
  );
  await mustDeny('getCountByDevice', () =>
    (service as any).getCountByDevice(deviceB.id, ADMIN_A),
  );
  await mustDeny('exportToCSV', () =>
    (service as any).exportToCSV(deviceB.id, ADMIN_A, since, until),
  );

  console.log('\n── The destructive one ────────────────────────');
  await mustDeny('deleteByDevice is refused', () =>
    service.deleteByDevice(deviceB.id, ADMIN_A),
  );
  const survived = await telemetryRepo.count({ where: { deviceId: deviceB.id } });
  ok('tenant B’s telemetry is still there', survived === 1, survived);

  console.log('\n── Customer scoping inside one tenant ─────────');
  await mustDeny('a CUSTOMER_USER cannot read another customer’s device', () =>
    service.getLatest(deviceOtherCustomer.id, CUST_USER_A),
  );
  ok(
    'a CUSTOMER_USER can read their own customer’s device',
    !!(await service.getLatest(deviceA.id, CUST_USER_A)),
  );

  console.log('\n── Legitimate access still works ──────────────');
  ok(
    'tenant A admin reads tenant A’s device',
    !!(await service.getLatest(deviceA.id, ADMIN_A)),
  );
  ok(
    'SUPER_ADMIN reads any tenant’s device',
    !!(await service.getLatest(deviceB.id, SUPER)),
  );
  const page = await service.findByDevice(deviceA.id, ADMIN_A, {} as any);
  ok('and gets real rows back', page.total === 1, page.total);

  console.log('\n── Unknown / absent caller ────────────────────');
  await mustDeny('an unknown user id is refused', () =>
    service.getLatest(deviceA.id, randomUUID()),
  );
  await mustDeny('an empty user id is refused', () =>
    service.getLatest(deviceA.id, ''),
  );
  await mustDeny('a soft-deleted user is refused', async () => {
    await q('UPDATE users SET deleted_at = now() WHERE id = $1', [ADMIN_B]);
    try {
      return await service.getLatest(deviceB.id, ADMIN_B);
    } finally {
      await q('UPDATE users SET deleted_at = NULL WHERE id = $1', [ADMIN_B]);
    }
  });

  await dataSource.destroy();
  console.log(
    failures
      ? `\nFAIL — ${failures} check(s) failed; telemetry is not tenant-scoped`
      : '\nPASS — telemetry reads and deletes are confined to the caller',
  );
  process.exit(failures ? 1 : 0);
})().catch((error) => {
  console.error('\nFAILED:', error?.message);
  console.error(error?.stack);
  process.exit(1);
});
