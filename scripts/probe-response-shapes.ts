/**
 * Diagnostic: boot the app and print the SHAPE of what each read endpoint
 * actually answers.
 *
 * Written after `(availableDevices ?? []) is not iterable` took down the
 * floor-plan detail route. The cause was a hook unwrapping one `.data` level
 * and getting the summary OBJECT rather than the array inside it — and `??`
 * only guards null and undefined, so a non-null object sailed through into a
 * `for…of`.
 *
 * That class of bug is invisible to `tsc` (the client types say `unknown` or
 * `any` at the unwrap) and invisible to a backend test (the server is correct).
 * It is only visible by looking at the two together, which is what this does:
 * for each route it prints the envelope depth and whether the payload is an
 * array or an object, so a frontend `select` can be checked against the truth
 * instead of against a guess.
 *
 *   npx ts-node -T -r tsconfig-paths/register scripts/probe-response-shapes.ts [db] [port]
 */
import { randomUUID } from 'crypto';
import { join } from 'path';

import { Device } from '../src/modules/devices/entities/device.entity';
import { User } from '../src/modules/users/entities/user.entity';
import { SubscriptionPlan, UserRole, UserStatus } from '../src/common/enums/index.enum';
import { getPlanFeatures } from '../src/modules/subscriptions/plan-features';
import { bootApp, build, dataSource, prepareSchema, type BootedApp } from './support/boot-app';

const database = process.argv[2] ?? 'shapeprobe';
const PORT = Number(process.argv[3] ?? 5101);
const root = join(__dirname, '..');
const PASSWORD = 'Str0ng!Passw0rd';
const RUN = randomUUID().slice(0, 8);
const mail = (l: string) => `${l}-${RUN}@example.test`;

const LIMITS = {
  devices: -1, users: -1, customers: -1, assets: -1, dashboards: -1, floorPlans: -1,
  automations: -1, ruleChains: -1, maxFloorPlans: -1, maxDevicesPerFloorPlan: -1,
  storageGB: 1024, apiCallsPerMonth: -1,
};

/** A one-line description of a value's shape. */
function shapeOf(value: unknown, depth = 0): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) {
    return `Array(${value.length})` + (value.length && depth < 2 ? ` of ${shapeOf(value[0], depth + 1)}` : '');
  }
  if (typeof value === 'object') {
    const keys = Object.keys(value as object);
    return `{ ${keys.slice(0, 8).join(', ')}${keys.length > 8 ? ', …' : ''} }`;
  }
  return typeof value;
}

/**
 * Walk the envelope and report where the useful payload actually sits.
 *
 * `TransformInterceptor` wraps everything as `{success, data, timestamp}`, and
 * several handlers ALSO return their own `{message, data}` — so the depth is
 * one on some routes and two on others, which is the whole trap.
 */
function describe(body: any): string {
  const lines: string[] = [];
  let value = body;
  for (let depth = 0; depth <= 3; depth++) {
    lines.push(`      depth ${depth}: ${shapeOf(value)}`);
    if (value && typeof value === 'object' && !Array.isArray(value) && 'data' in value) {
      value = value.data;
    } else break;
  }
  return lines.join('\n');
}

(async () => {
  const built = await build(root);
  if (!built.ok) {
    console.error('build failed\n', built.stderr);
    process.exit(1);
  }

  await prepareSchema(database);
  const ds = dataSource(database);
  await ds.initialize();

  const q = (sql: string, p: any[] = []) => ds.query(sql, p);
  await q(`DELETE FROM floor_plans WHERE name LIKE 'shape-%'`).catch(() => undefined);
  await q(`DELETE FROM tenants WHERE name LIKE 'shape-%'`).catch(() => undefined);

  const tenantId = randomUUID();
  await q('INSERT INTO tenants (id, name, email) VALUES ($1,$2,$3)', [
    tenantId, `shape-${RUN}`, mail('tenant'),
  ]);
  await q(
    `INSERT INTO subscriptions (id,"tenantId",plan,status,limits,features)
     VALUES ($1,$2,$3,'active',$4,$5)`,
    [randomUUID(), tenantId, SubscriptionPlan.ENTERPRISE, JSON.stringify(LIMITS),
     JSON.stringify(getPlanFeatures(SubscriptionPlan.ENTERPRISE))],
  );

  const users = ds.getRepository(User);
  const admin = await users.save(users.create({
    name: 'Admin', email: mail('admin'), password: PASSWORD,
    role: UserRole.TENANT_ADMIN, status: UserStatus.ACTIVE,
    emailVerified: true, tenantId,
  }));

  const assetId = randomUUID();
  await q(`INSERT INTO assets (id, name, "tenantId", type) VALUES ($1,$2,$3,'building')`,
    [assetId, `shape-asset-${RUN}`, tenantId]);

  const devices = ds.getRepository(Device);
  const device = await devices.save(devices.create({
    name: `shape-dev-${RUN}`, deviceKey: `shape-dev-${RUN}`, tenantId,
    userId: admin.id, assetId, status: 'active' as any,
    type: 'sensor' as any, protocol: 'generic_mqtt' as any,
  } as any) as unknown as Device);

  const planId = randomUUID();
  await q(
    `INSERT INTO floor_plans (id, name, "tenantId", "userId", "assetId", building, floor,
       dimensions, zones, "floorNumber")
     VALUES ($1,$2,$3,$4,$5,'HQ','Ground',$6,'[]'::jsonb,1)`,
    [planId, `shape-plan-${RUN}`, tenantId, admin.id, assetId,
     JSON.stringify({ width: 12, height: 8, unit: 'm' })],
  );

  let app: BootedApp;
  try {
    app = await bootApp(root, database, PORT);
  } catch (error) {
    console.error('boot failed:', (error as Error).message);
    await ds.destroy();
    process.exit(1);
  }

  const login = await app.request('POST', '/auth/login', {
    body: { email: admin.email, password: PASSWORD },
  });
  const token = (login.body?.data ?? login.body)?.accessToken;
  if (!token) {
    console.error('login failed:', login.raw.slice(0, 300));
    await app.stop();
    await ds.destroy();
    process.exit(1);
  }

  const routes: Array<[string, string]> = [
    ['GET', '/floor-plans?limit=5'],
    ['GET', `/floor-plans/${planId}`],
    ['GET', `/floor-plans/${planId}/devices`],
    ['GET', `/floor-plans/${planId}/available-devices`],
    ['GET', `/floor-plans/${planId}/settings`],
    ['GET', `/floor-plans/${planId}/zones`],
    ['GET', `/floor-plans/${planId}/widgets`],
    ['GET', `/floor-plans/${planId}/widgets/devices`],
    ['GET', `/floor-plans/asset/${assetId}`],
    ['GET', '/floor-plans/statistics'],
    ['GET', `/assets/${assetId}/floors`],
    ['GET', `/assets/${assetId}/devices`],
    ['GET', `/assets/${assetId}/hierarchy`],
    ['GET', '/assets?limit=5'],
  ];

  console.log(`\n── Response shapes (what a frontend select must unwrap) ───────\n`);
  console.log(`   device ${device.id} on asset ${assetId}\n`);

  for (const [method, path] of routes) {
    const res = await app.request(method, path, { token });
    console.log(`   ${method} ${path}`);
    console.log(`      status ${res.status}`);
    if (res.status === 200) console.log(describe(res.body));
    else console.log(`      ${res.raw.slice(0, 160)}`);
    console.log('');
  }

  await app.stop();
  await q(`DELETE FROM tenants WHERE name LIKE 'shape-%'`).catch(() => undefined);
  await ds.destroy();
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
