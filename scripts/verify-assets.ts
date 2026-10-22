/**
 * ─────────────────────────────────────────────────────────────────────────────
 * Runtime proof: the ten Assets-module defects a throwaway probe found stay
 * fixed
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * `scripts/probe-assets.ts` drove every route on the assets controller as the
 * browser does and found ten defects. Each of them was accepted and fixed —
 * and **nothing guards any of them**, so every one can silently come back: not
 * one is visible to `tsc`, and most are a missing or wrong *decorator*, which
 * is an absence rather than an error.
 *
 * What is pinned here, in the order the fixes were made:
 *
 *   1.  `GET /assets/search/location` answers at all. Three `number` fields
 *       were decorated `@IsString()`, and `enableImplicitConversion` made that
 *       unsatisfiable in BOTH directions — the route 400'd on every possible
 *       input.
 *   2.  `?active=false` / `?untyped=false` / `includeDevices=false` mean FALSE.
 *       class-transformer's implicit boolean conversion is `Boolean(value)`,
 *       and `Boolean('false')` is true, so passing false did what passing true
 *       did.
 *   3.  `?tags=` works in both the single and the repeated form. `Asset.tags`
 *       is `simple-array` — a comma-joined TEXT column — and the query used
 *       the PG array-overlap operator, which has no `text` form:
 *       `operator does not exist: text && unknown`.
 *   4.  `PATCH /assets/:id/attributes` accepts `attributes`. The property
 *       carried only `@ApiProperty()`, which class-validator does not see, so
 *       `whitelist` stripped it and `forbidNonWhitelisted` turned that into
 *       `["property attributes should not exist"]`.
 *   5.  `POST /assets/:id/unassign-customer` really clears the column. It
 *       assigned `undefined`, which TypeORM omits from the UPDATE: 200
 *       "unassigned successfully", row unchanged.
 *   6.  `GET /assets/:id/floors` on a SINGLE-floor asset returns one floor,
 *       not an empty list that left the floor-plan wizard with nowhere to put
 *       a drawing.
 *   7.  `GET /assets/customer/:customerId` materialises `assetType` (§4a: the
 *       profile is the single source). It came back undefined there while
 *       `GET /assets/:id` reported it correctly for the same row.
 *   8.  **Cross-tenant device assignment.** `POST /assets/:id/devices` and
 *       `/devices/bulk` resolved the device by id alone, with no tenant
 *       predicate, so a tenant admin could adopt another tenant's device into
 *       their own asset tree. This is the one that was a security hole rather
 *       than a broken feature, and it is asserted against the DATABASE.
 *   9.  Every `@Param` goes through `ParseIdPipe`, so a malformed id is a
 *       clean 400 about the id format — not a 500 and not a 400
 *       "Database Error" from Postgres' uuid parser.
 *   10. `?parentAssetId=` is accepted (the frontend was sending `parentId`,
 *       which `forbidNonWhitelisted` rejects).
 *
 * ── Why this boots the real application ───────────────────────────────────
 *
 * Every one of the ten lives in the interaction between the global
 * `ValidationPipe` (`whitelist` + `forbidNonWhitelisted` +
 * `enableImplicitConversion`), nine global guards, a DTO's decorator
 * metadata, a pipe on a route parameter, and SQL. A hand-constructed service
 * has none of that: calling `AssetsService.findAll()` with
 * `{ active: false }` in TypeScript proves nothing about what the pipe hands
 * it from a query string, which is where seven of these defects were. So this
 * runs `node dist/main.js` and talks HTTP, exactly as `verify-customer-login`
 * does and for the same reason.
 *
 * ── Negative controls ─────────────────────────────────────────────────────
 *
 * Every positive assertion that can be is paired with the measurement that
 * fails if the fix were a *deletion* rather than a correction (§4r): the
 * location DTO still rejects a non-number and an out-of-range latitude, the
 * attributes route still refuses an unknown property, `?parentId=` is still
 * rejected, and a valid-but-unknown uuid still answers 404 rather than the
 * 400 the id pipe produces. A check that only ever sees the fixed code cannot
 * tell "this works" from "this cannot fail".
 *
 *   npm run verify:assets [db] [port]
 */
import { randomUUID } from 'crypto';
import { join } from 'path';
import type { DataSource } from 'typeorm';

import { User } from '../src/modules/users/entities/user.entity';
import {
  CustomerStatus,
  SubscriptionPlan,
  UserRole,
  UserStatus,
} from '../src/common/enums/index.enum';
import { getPlanFeatures } from '../src/modules/subscriptions/plan-features';
import {
  bootApp,
  build,
  dataSource,
  prepareSchema,
  type BootedApp,
  type Json,
} from './support/boot-app';

const database = process.argv[2] ?? 'vassets';
const PORT = Number(process.argv[3] ?? 5093);
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
  console.log(`\n── ${title} ${'─'.repeat(Math.max(0, 62 - title.length))}`);

/**
 * Unwrap the response envelope.
 *
 * `TransformInterceptor` wraps every success as `{success, data, timestamp}`,
 * and most handlers on this controller ALSO return their own
 * `{message, data}` — so the real payload sits two levels deep there and one
 * level deep on the paginated routes. Unwrapping a fixed single level reads
 * `{message, data}` as the asset, finds no `id`, and looks exactly like a
 * handler that returned nothing.
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

/**
 * The rows of a list response, or [] for any shape that is not a list.
 *
 * A refusal body is `{success:false, …}` and calling `.map` on it throws,
 * which would abort the run and take every REMAINING check with it — so one
 * failure would report as a collapse. A list read must degrade to "saw
 * nothing".
 */
const rows = (body: any): any[] => {
  const value = payload(body);
  if (Array.isArray(value)) return value;
  if (Array.isArray(value?.data)) return value.data;
  return [];
};
const ids = (body: any): string[] => rows(body).map((r: any) => r?.id);

/** `meta` off a paginated body — one level of envelope, not all of them. */
const listMeta = (body: any): any => {
  const once = body && typeof body === 'object' && 'data' in body ? body.data : body;
  return once?.meta;
};

/** A run-unique suffix: `tenants.name` is UNIQUE and a crashed run must not
 *  make every later run fail on a duplicate key that says nothing (§4r). */
const RUN = randomUUID().slice(0, 8);
const mail = (local: string) => `${local}-${RUN}@example.test`;

/**
 * Remove this script's fixtures, including residue from a run that crashed.
 *
 * The sweep is by NAME PREFIX, never by this run's ids: `tenants.name` is
 * UNIQUE, so one run that dies before cleanup would otherwise make the script
 * permanently unrunnable with a duplicate-key error that says nothing about
 * assets (§4r).
 *
 * The dependent-table pass is driven by the FOREIGN KEY CATALOGUE rather than
 * a hand-written list. A real boot serving real requests writes rows this
 * script never mentions — `api_logs` from middleware on every request,
 * `audit_logs` from an interceptor on every write — so a hand-written list is
 * guaranteed to be incomplete, and incomplete here means the SECOND run fails
 * on a foreign key while the first passed.
 *
 * `assets` and `asset_profiles` are in the parent list as well as the
 * explicit tail: `devices.assetId` and `floor_plans.assetId` both reference an
 * asset, and an asset references its parent asset and its profile.
 */
async function sweep(ds: DataSource): Promise<void> {
  const q = (sql: string, p: any[] = []) => ds.query(sql, p).catch(() => undefined);
  const stale = `SELECT id FROM tenants WHERE name LIKE 'vassets-%'`;

  for (const parent of [
    'users',
    'tenants',
    'customers',
    'devices',
    'assets',
    'asset_profiles',
  ]) {
    const refs: Array<{ table: string; column: string }> =
      (await ds
        .query(
          `SELECT c.conrelid::regclass::text AS table,
                  a.attname               AS column
             FROM pg_constraint c
             JOIN pg_attribute a
               ON a.attrelid = c.conrelid AND a.attnum = c.conkey[1]
            WHERE c.contype = 'f'
              AND c.confrelid = $1::regclass
              AND array_length(c.conkey, 1) = 1`,
          [parent],
        )
        .catch(() => [])) ?? [];

    const doomed =
      parent === 'tenants'
        ? stale
        : `SELECT id FROM ${parent} WHERE "tenantId" IN (${stale})`;

    for (const ref of refs) {
      // A self-reference (assets.parentAssetId) is handled by the parent
      // delete below; deleting through it here would be a no-op at best.
      if (ref.table === parent) continue;
      await q(`DELETE FROM ${ref.table} WHERE "${ref.column}" IN (${doomed})`);
    }
  }

  await q(`UPDATE devices SET "assetId" = NULL WHERE "tenantId" IN (${stale})`);
  await q(
    `DELETE FROM floor_plan_devices WHERE "floorPlanId" IN (SELECT id FROM floor_plans WHERE "tenantId" IN (${stale}))`,
  );
  await q(`DELETE FROM floor_plans WHERE "tenantId" IN (${stale})`);
  await q(`DELETE FROM telemetry WHERE "tenantId" IN (${stale})`);
  await q(`DELETE FROM alarms WHERE "tenantId" IN (${stale})`);
  await q(`DELETE FROM devices WHERE "tenantId" IN (${stale})`);
  await q(`UPDATE assets SET "parentAssetId" = NULL WHERE "tenantId" IN (${stale})`);
  await q(`DELETE FROM assets WHERE "tenantId" IN (${stale})`);
  await q(`DELETE FROM asset_profiles WHERE "tenantId" IN (${stale})`);
  await q(`DELETE FROM subscriptions WHERE "tenantId" IN (${stale})`);
  await q(`DELETE FROM customers WHERE "tenantId" IN (${stale})`);
  await q(`DELETE FROM users WHERE "tenantId" IN (${stale})`);
  await q(`DELETE FROM tenants WHERE name LIKE 'vassets-%'`);
}

/**
 * The multi-floor profile of §4a: a `floors_array` field is what makes a
 * profile multi-floor. `building`, `hospital` and `hotel` declare one.
 *
 * Nothing here is `required`, deliberately. §4c's create-time schema
 * validation is a different subject with its own coverage, and a required
 * field would mean every asset in this fixture had to satisfy it — which
 * would make a 400 from a *validation* change look like one of the ten
 * defects returning.
 */
const MULTI_FLOOR_SCHEMA = {
  fields: [
    {
      key: 'totalFloors',
      label: 'Total Floors',
      labelAr: 'إجمالي الطوابق',
      type: 'number',
      required: false,
      min: 1,
      max: 200,
    },
    {
      key: 'floorsData',
      label: 'Floors',
      labelAr: 'الطوابق',
      type: 'floors_array',
      required: false,
    },
  ],
};

/** A single-floor profile — shop, farm, warehouse and factory declare no
 *  `floors_array` at all, which is the case defect 6 lived in. */
const SINGLE_FLOOR_SCHEMA = {
  fields: [
    {
      key: 'totalArea',
      label: 'Total Area',
      labelAr: 'المساحة',
      type: 'number',
      required: false,
    },
  ],
};

interface Fixture {
  tenantA: string;
  tenantB: string;
  adminA: string;
  adminB: string;
  customerId: string;
  devA1: string;
  devA2: string;
  devA3: string;
  devForeign: string;
}

async function seed(ds: DataSource): Promise<Fixture> {
  const q = (sql: string, p: any[] = []) => ds.query(sql, p);
  const tenantA = randomUUID();
  const tenantB = randomUUID();

  for (const [id, label] of [[tenantA, 'a'], [tenantB, 'b']] as const) {
    await q('INSERT INTO tenants (id, name, email) VALUES ($1, $2, $3)', [
      id,
      `vassets-${label}-${RUN}`,
      mail(`tenant-${label}`),
    ]);
  }

  // Both admins go through the REPOSITORY, not raw SQL: the password is hashed
  // by an @BeforeInsert hook on the entity, and a raw INSERT would store the
  // plaintext and then fail every login for a reason that looks like a broken
  // auth service.
  const users = ds.getRepository(User);
  const mkAdmin = async (tenantId: string, label: string) =>
    users.save(
      users.create({
        name: `Assets Admin ${label.toUpperCase()}`,
        email: mail(`admin-${label}`),
        password: PASSWORD,
        role: UserRole.TENANT_ADMIN,
        status: UserStatus.ACTIVE,
        emailVerified: true,
        tenantId,
      }),
    );
  const adminA = await mkAdmin(tenantA, 'a');
  // Tenant B needs an owner of its own: `devices.userId` is NOT NULL, so the
  // foreign device cannot be owned by tenant A's admin without making the
  // fixture lie about who owns what — which is the very thing defect 8 is
  // about.
  const adminB = await mkAdmin(tenantB, 'b');

  // ── A subscription per tenant ───────────────────────────────────────────
  //
  // `SubscriptionGuard` is global and answers 403 "No subscription found for
  // this tenant" for a tenant with no row, so without this every write here
  // fails before any assets code is reached. ENTERPRISE with everything
  // unlimited, so neither FeatureLimitGuard nor SubscriptionLimitGuard can
  // mask a result: a 4xx in this script must mean the assets module, not a
  // quota.
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
      [
        randomUUID(),
        tenantId,
        SubscriptionPlan.ENTERPRISE,
        JSON.stringify(limits),
        JSON.stringify(features),
      ],
    );
  }

  const customerId = randomUUID();
  await q(
    `INSERT INTO customers (id, name, email, "tenantId", status)
     VALUES ($1, $2, $3, $4, $5)`,
    [customerId, `vassets-cust-${RUN}`, mail('cust'), tenantA, CustomerStatus.ACTIVE],
  );

  const mkDevice = async (tenantId: string, userId: string, label: string) => {
    const id = randomUUID();
    await q(
      `INSERT INTO devices (id, name, "deviceKey", "tenantId", "userId", status, type, protocol)
       VALUES ($1, $2, $3, $4, $5, 'active', 'sensor', 'generic_mqtt')`,
      [id, `vassets-${label}-${RUN}`, `vk-${label}-${RUN}`, tenantId, userId],
    );
    return id;
  };

  return {
    tenantA,
    tenantB,
    adminA: adminA.email,
    adminB: adminB.email,
    customerId,
    devA1: await mkDevice(tenantA, adminA.id, 'dev1'),
    devA2: await mkDevice(tenantA, adminA.id, 'dev2'),
    devA3: await mkDevice(tenantA, adminA.id, 'dev3'),
    devForeign: await mkDevice(tenantB, adminB.id, 'devB'),
  };
}

(async () => {
  console.log(
    `\n── Assets module: the ten fixes (database "${database}", port ${PORT}) ──\n`,
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
    const loginA = await app.request('POST', '/auth/login', {
      body: { email: fx.adminA, password: PASSWORD },
    });
    const tokenA: string | undefined = payload(loginA.body)?.accessToken;
    ok('tenant admin A logs in', typeof tokenA === 'string', loginA.raw.slice(0, 200));

    const loginB = await app.request('POST', '/auth/login', {
      body: { email: fx.adminB, password: PASSWORD },
    });
    const tokenB: string | undefined = payload(loginB.body)?.accessToken;
    ok('tenant admin B logs in', typeof tokenB === 'string', loginB.raw.slice(0, 200));
    if (!tokenA || !tokenB) {
      throw new Error('no token — nothing further can be asserted');
    }

    const GET = (path: string, token: string = tokenA): Promise<Json> =>
      app.request('GET', path, { token });
    const POST = (path: string, body: unknown, token: string = tokenA): Promise<Json> =>
      app.request('POST', path, { token, body });
    const PATCH = (path: string, body: unknown, token: string = tokenA): Promise<Json> =>
      app.request('PATCH', path, { token, body });
    const DELETE = (path: string, token: string = tokenA): Promise<Json> =>
      app.request('DELETE', path, { token });

    // Database reads. Defects 5 and 8 are about rows, not responses: both
    // answered with a success the database did not agree with.
    const assetRow = async (id: string): Promise<any> =>
      (
        await ds.query(
          'SELECT id, "customerId", "tenantId", attributes, active FROM assets WHERE id = $1',
          [id],
        )
      )[0];
    const deviceRow = async (id: string): Promise<any> =>
      (
        await ds.query('SELECT id, "assetId", "tenantId" FROM devices WHERE id = $1', [id])
      )[0];

    // ════════════════════════════════════════════════════════════════════════
    section('fixture: two profiles and seven assets, created over HTTP');

    // Created through the API rather than by INSERT, so every value this
    // script later asserts on has round-tripped through the DTO, the pipe, the
    // service and the column — the rule that stops a fixture from agreeing
    // with a constant that the API never actually stores.
    const mkMulti = await POST('/profiles/asset', {
      name: `vassets-building-${RUN}`,
      type: 'building',
      schema: MULTI_FLOOR_SCHEMA,
    });
    const multiProfileId: string | undefined = payload(mkMulti.body)?.id;
    ok(
      'a MULTI-floor asset profile is created (declares floors_array)',
      typeof multiProfileId === 'string',
      mkMulti.raw.slice(0, 300),
    );

    const mkSingle = await POST('/profiles/asset', {
      name: `vassets-warehouse-${RUN}`,
      type: 'warehouse',
      schema: SINGLE_FLOOR_SCHEMA,
    });
    const singleProfileId: string | undefined = payload(mkSingle.body)?.id;
    ok(
      'a SINGLE-floor asset profile is created (declares none)',
      typeof singleProfileId === 'string',
      mkSingle.raw.slice(0, 300),
    );
    if (!multiProfileId || !singleProfileId) {
      throw new Error('no asset profiles — the floor and type checks cannot run');
    }

    // Which profile is multi-floor is read back from the API, not assumed:
    // "single-floor" means "its schema declares no floors_array", and that is
    // the property defect 6 depends on.
    const multiRead = await GET(`/profiles/asset/${multiProfileId}`);
    const singleRead = await GET(`/profiles/asset/${singleProfileId}`);
    const fieldTypes = (body: any): string[] =>
      (payload(body)?.schema?.fields ?? []).map((f: any) => f?.type);
    ok(
      'the multi-floor profile really declares a floors_array field',
      fieldTypes(multiRead.body).includes('floors_array'),
      fieldTypes(multiRead.body),
    );
    ok(
      'and the single-floor profile really declares none',
      fieldTypes(singleRead.body).length > 0 &&
        !fieldTypes(singleRead.body).includes('floors_array'),
      fieldTypes(singleRead.body),
    );

    const TAG_A = `vassets-alpha-${RUN}`;
    const TAG_B = `vassets-beta-${RUN}`;
    const TAG_C = `vassets-gamma-${RUN}`;

    const mkAsset = async (body: Record<string, unknown>, token = tokenA) => {
      const response = await POST('/assets', body, token);
      return { response, asset: payload(response.body) };
    };

    const building = await mkAsset({
      name: `vassets-building-asset-${RUN}`,
      label: 'HQ',
      assetProfileId: multiProfileId,
      configuration: {
        totalFloors: 3,
        floorsData: [
          { floorNumber: 1, name: 'Ground Floor', rooms: 12, area: 450 },
          { floorNumber: 2, name: 'First Floor', rooms: 10, area: 400 },
          { floorNumber: 3, name: 'Second Floor', rooms: 8, area: 350 },
        ],
      },
      location: { address: 'King Fahd Rd', city: 'Riyadh', latitude: 24.7136, longitude: 46.6753 },
      tags: [TAG_A, TAG_B],
    });
    ok(
      'the multi-floor building asset is created',
      typeof building.asset?.id === 'string',
      building.response.raw.slice(0, 400),
    );

    const warehouse = await mkAsset({
      name: `vassets-warehouse-asset-${RUN}`,
      assetProfileId: singleProfileId,
      configuration: { totalArea: 900 },
      tags: [TAG_C],
    });
    ok(
      'the single-floor warehouse asset is created',
      typeof warehouse.asset?.id === 'string',
      warehouse.response.raw.slice(0, 400),
    );

    if (!building.asset?.id || !warehouse.asset?.id) {
      throw new Error('no assets — nothing further can be asserted');
    }
    const buildingId: string = building.asset.id;
    const warehouseId: string = warehouse.asset.id;

    const child = await mkAsset({
      name: `vassets-child-${RUN}`,
      parentAssetId: buildingId,
    });
    const childId: string | undefined = child.asset?.id;
    ok('a child asset under the building is created', typeof childId === 'string', child.response.raw.slice(0, 300));

    const inactive = await mkAsset({ name: `vassets-inactive-${RUN}`, active: false });
    const inactiveId: string | undefined = inactive.asset?.id;
    ok('an INACTIVE asset is created', typeof inactiveId === 'string', inactive.response.raw.slice(0, 300));
    ok(
      'and the API reports it inactive, so ?active= has something to find',
      inactive.asset?.active === false,
      inactive.asset?.active,
    );

    const untyped = await mkAsset({ name: `vassets-untyped-${RUN}` });
    const untypedId: string | undefined = untyped.asset?.id;
    ok('an asset with NO profile is created', typeof untypedId === 'string', untyped.response.raw.slice(0, 300));
    ok(
      'and reports assetType: null rather than a guessed default (§4a)',
      untyped.asset?.assetType === null,
      untyped.asset?.assetType,
    );

    const far = await mkAsset({
      name: `vassets-far-${RUN}`,
      location: { address: 'Far away', city: 'Nowhere', latitude: 30.0, longitude: 46.6753 },
    });
    const farId: string | undefined = far.asset?.id;
    ok('a far-away located asset is created', typeof farId === 'string', far.response.raw.slice(0, 300));

    const foreign = await mkAsset({ name: `vassets-foreign-${RUN}` }, tokenB);
    const foreignAssetId: string | undefined = foreign.asset?.id;
    ok("tenant B gets an asset of its own", typeof foreignAssetId === 'string', foreign.response.raw.slice(0, 300));

    // The coordinates every location assertion below uses come from what the
    // API stored, not from the literals above.
    const nearLat: number | undefined = building.asset?.location?.latitude;
    const nearLng: number | undefined = building.asset?.location?.longitude;
    ok(
      'the building asset round-tripped its coordinates',
      typeof nearLat === 'number' && typeof nearLng === 'number',
      building.asset?.location,
    );
    ok(
      'and the far asset round-tripped a DIFFERENT latitude',
      typeof far.asset?.location?.latitude === 'number' &&
        far.asset.location.latitude !== nearLat,
      { near: nearLat, far: far.asset?.location?.latitude },
    );

    // The tags the filter is driven by are read back from the API too.
    const storedTags: string[] = Array.isArray(building.asset?.tags) ? building.asset.tags : [];
    ok(
      'and the building asset round-tripped its two tags as an ARRAY',
      storedTags.length === 2 && storedTags.includes(TAG_A),
      building.asset?.tags,
    );

    // ════════════════════════════════════════════════════════════════════════
    section('1. GET /assets/search/location answers at all');

    const near = await GET(
      `/assets/search/location?latitude=${nearLat}&longitude=${nearLng}&radius=50`,
    );
    ok(
      'the documented spelling answers 200 — it used to 400 on EVERY input',
      near.status === 200,
      `status ${near.status}: ${near.raw.slice(0, 250)}`,
    );
    const nearIds = ids(near.body);
    ok('the asset at those coordinates is returned', nearIds.includes(buildingId), nearIds);
    ok('and the far asset is not, so the radius is applied', !nearIds.includes(farId!), nearIds);
    ok(
      'an asset with no coordinates is not returned either',
      !nearIds.includes(warehouseId) && !nearIds.includes(untypedId!),
      nearIds,
    );

    // The radius is a NUMBER by the time the Haversine filter sees it. If it
    // were still a string the comparison would not narrow like this.
    const tight = await GET(
      `/assets/search/location?latitude=${nearLat}&longitude=${nearLng}&radius=1`,
    );
    ok('a 1 km radius still answers 200', tight.status === 200, tight.raw.slice(0, 200));
    ok(
      'and still finds the asset at the search point',
      ids(tight.body).includes(buildingId),
      ids(tight.body),
    );
    const wide = await GET(
      `/assets/search/location?latitude=${nearLat}&longitude=${nearLng}&radius=20000`,
    );
    ok('a 20000 km radius answers 200', wide.status === 200, wide.raw.slice(0, 200));
    ok(
      'and widening the radius ADDS the far asset — the number is really used',
      ids(wide.body).includes(farId!) && ids(wide.body).includes(buildingId),
      ids(wide.body),
    );

    // NEGATIVE CONTROL. The fix corrected the decorators; it did not delete
    // them. If validation had simply been removed, all three of these would
    // answer 200.
    const oldSpelling = await GET(
      `/assets/search/location?lat=${nearLat}&lng=${nearLng}&radius=50`,
    );
    ok(
      'NEGATIVE CONTROL: the old ?lat=/?lng= spelling is still REJECTED (the frontend was fixed to send the long names)',
      oldSpelling.status === 400,
      `status ${oldSpelling.status}: ${oldSpelling.raw.slice(0, 250)}`,
    );
    ok(
      'and the refusal names the unknown properties rather than being a generic error',
      /lat should not exist/.test(oldSpelling.raw) && /lng should not exist/.test(oldSpelling.raw),
      oldSpelling.raw.slice(0, 300),
    );

    const notANumber = await GET(
      `/assets/search/location?latitude=abc&longitude=${nearLng}&radius=50`,
    );
    ok(
      'NEGATIVE CONTROL: a non-numeric latitude is still a 400',
      notANumber.status === 400,
      `status ${notANumber.status}: ${notANumber.raw.slice(0, 200)}`,
    );
    const outOfRange = await GET(
      `/assets/search/location?latitude=91&longitude=${nearLng}&radius=50`,
    );
    ok(
      'NEGATIVE CONTROL: a latitude of 91 is still a 400 — @Min/@Max survived',
      outOfRange.status === 400,
      `status ${outOfRange.status}: ${outOfRange.raw.slice(0, 200)}`,
    );

    // ════════════════════════════════════════════════════════════════════════
    section('2. a query-string "false" means FALSE, not Boolean("false")');

    // ── READ THIS BEFORE "FIXING" THIS SECTION ─────────────────────────────
    //
    // These assertions FAIL at the time of writing, and the fix is in `src`,
    // not here. Measured, not inferred — `plainToInstance` against the real
    // DTOs with the real pipe options (main.ts: `enableImplicitConversion:
    // true`):
    //
    //   QueryAssetsDto      active/untyped:  "false" → true, "0" → true
    //   AssetHierarchyDto   includeDevices:  "false" → true, "0" → true
    //
    // class-transformer applies the IMPLICIT CONVERSION first and hands the
    // already-converted value to `@Transform`. Its boolean rule is `!!value`,
    // so by the time
    //
    //   @Transform(({ value }) => … value === 'true' …)
    //
    // runs, `value` is the boolean `true` and the string it is comparing
    // against is gone. Every input is therefore true, which is the original
    // defect with an extra step.
    //
    // The house pattern that does work is written down, with this exact
    // warning, in `src/modules/images/dto/create-image.dto.ts`: read the
    // untouched value off `obj[key]`. (`api-monitoring`'s `toBoolean` reads
    // `value` and is broken the same way — `?isError=false` is equally
    // ineffective there.)
    const BOOLEAN_CAUSE =
      'enableImplicitConversion runs BEFORE @Transform, so the transform is handed ' +
      'Boolean("false") === true and never sees the string. The working pattern reads ' +
      'obj[key] — see src/modules/images/dto/create-image.dto.ts.';

    const activeFalse = await GET('/assets?active=false&limit=100');
    ok('?active=false answers 200', activeFalse.status === 200, activeFalse.raw.slice(0, 200));
    const inactiveIds = ids(activeFalse.body);
    ok('it returns the INACTIVE asset', inactiveIds.includes(inactiveId!), {
      returned: inactiveIds,
      expected: inactiveId,
      cause: BOOLEAN_CAUSE,
    });
    ok(
      'and NOT the active ones — this is the assertion Boolean("false") broke',
      !inactiveIds.includes(buildingId) && !inactiveIds.includes(warehouseId),
      { returned: inactiveIds, cause: BOOLEAN_CAUSE },
    );
    ok(
      'and every row it returns really is inactive',
      rows(activeFalse.body).length > 0 &&
        rows(activeFalse.body).every((r: any) => r?.active === false),
      {
        activeFlags: rows(activeFalse.body).map((r: any) => r?.active),
        cause: BOOLEAN_CAUSE,
      },
    );

    const activeTrue = await GET('/assets?active=true&limit=100');
    ok('?active=true answers 200', activeTrue.status === 200, activeTrue.raw.slice(0, 200));
    const activeIds = ids(activeTrue.body);
    ok('it returns the active assets', activeIds.includes(buildingId), activeIds);
    ok('and not the inactive one', !activeIds.includes(inactiveId!), activeIds);
    ok(
      'so the two filters partition the list rather than answering alike',
      !inactiveIds.some((id) => activeIds.includes(id)) &&
        inactiveIds.length > 0 &&
        activeIds.length > 0,
      {
        'active=false': inactiveIds.length,
        'active=true': activeIds.length,
        identical: inactiveIds.slice().sort().join(',') === activeIds.slice().sort().join(','),
        cause: BOOLEAN_CAUSE,
      },
    );

    const allAssets = await GET('/assets?limit=100');
    const allIds = ids(allAssets.body);
    ok(
      'omitting ?active returns both kinds',
      allIds.includes(buildingId) && allIds.includes(inactiveId!),
      allIds.length,
    );
    const totalAll = listMeta(allAssets.body)?.totalItems;
    ok(
      'and the paginated total agrees with the rows returned',
      typeof totalAll === 'number' && totalAll === allIds.length,
      { totalItems: totalAll, rows: allIds.length, meta: listMeta(allAssets.body) },
    );

    const untypedTrue = await GET('/assets?untyped=true&limit=100');
    ok('?untyped=true answers 200', untypedTrue.status === 200, untypedTrue.raw.slice(0, 200));
    const untypedIds = ids(untypedTrue.body);
    ok(
      'it returns the asset with no profile',
      untypedIds.includes(untypedId!),
      untypedIds,
    );
    ok(
      'and excludes the two assets that DO resolve a type',
      !untypedIds.includes(buildingId) && !untypedIds.includes(warehouseId),
      untypedIds,
    );
    ok(
      'and every row it returns reports assetType: null',
      rows(untypedTrue.body).length > 0 &&
        rows(untypedTrue.body).every((r: any) => r?.assetType === null),
      rows(untypedTrue.body).map((r: any) => r?.assetType),
    );

    const untypedFalse = await GET('/assets?untyped=false&limit=100');
    ok('?untyped=false answers 200', untypedFalse.status === 200, untypedFalse.raw.slice(0, 200));
    ok(
      'and INCLUDES the typed assets — before the fix it returned only the untyped ones',
      ids(untypedFalse.body).includes(buildingId) &&
        ids(untypedFalse.body).includes(warehouseId),
      {
        returned: ids(untypedFalse.body),
        'untyped=true returned': untypedIds,
        cause: BOOLEAN_CAUSE,
      },
    );
    ok(
      'so ?untyped=false is indistinguishable from omitting it, as "false" should be',
      ids(untypedFalse.body).sort().join(',') === allIds.slice().sort().join(','),
      {
        withFalse: ids(untypedFalse.body).length,
        omitted: allIds.length,
        cause: BOOLEAN_CAUSE,
      },
    );

    // ── AssetHierarchyDto.includeDevices, the third boolean ─────────────────
    //
    // One device is attached first so "included" has something to include.
    // The cross-tenant behaviour of this route is section 8's subject; here it
    // is only a fixture step, and it is asserted against the database so a
    // silent failure cannot make the booleans below vacuous.
    const attach = await POST(`/assets/${buildingId}/devices`, { deviceId: fx.devA1 });
    ok('a device is attached to the building', attach.status < 300, attach.raw.slice(0, 250));
    ok(
      'and the database agrees',
      (await deviceRow(fx.devA1))?.assetId === buildingId,
      await deviceRow(fx.devA1),
    );

    const withDevices = await GET(`/assets/${buildingId}/hierarchy?includeDevices=true`);
    ok('?includeDevices=true answers 200', withDevices.status === 200, withDevices.raw.slice(0, 200));
    const withBody = payload(withDevices.body);
    ok(
      'and the hierarchy carries the devices',
      Array.isArray(withBody?.devices) &&
        withBody.devices.some((d: any) => d?.id === fx.devA1),
      withBody?.devices?.map?.((d: any) => d?.id),
    );

    const withoutDevices = await GET(`/assets/${buildingId}/hierarchy?includeDevices=false`);
    ok('?includeDevices=false answers 200', withoutDevices.status === 200, withoutDevices.raw.slice(0, 200));
    const withoutBody = payload(withoutDevices.body);
    ok(
      'and carries NO devices — the same Boolean("false") bug, one DTO over',
      withoutBody && !('devices' in withoutBody),
      {
        devices: withoutBody?.devices?.map?.((d: any) => d?.id),
        cause: BOOLEAN_CAUSE,
      },
    );
    const omittedDevices = await GET(`/assets/${buildingId}/hierarchy`);
    ok(
      'omitting it behaves like false',
      omittedDevices.status === 200 && !('devices' in (payload(omittedDevices.body) ?? {})),
      Object.keys(payload(omittedDevices.body) ?? {}),
    );
    ok(
      'and the hierarchy finds the child asset either way',
      (payload(withDevices.body)?.children ?? []).some((c: any) => c?.id === childId) &&
        (withoutBody?.children ?? []).some((c: any) => c?.id === childId),
      { with: payload(withDevices.body)?.children?.length, without: withoutBody?.children?.length },
    );

    // ════════════════════════════════════════════════════════════════════════
    section('3. ?tags= in both shapes, against a simple-array column');

    const oneTag = await GET(`/assets?tags=${encodeURIComponent(TAG_A)}&limit=100`);
    ok(
      'a SINGLE ?tags= answers 200 — it used to 400 ["tags must be an array"]',
      oneTag.status === 200,
      `status ${oneTag.status}: ${oneTag.raw.slice(0, 250)}`,
    );
    ok('and finds the asset carrying that tag', ids(oneTag.body).includes(buildingId), ids(oneTag.body));
    ok(
      'and does NOT return the asset carrying a different tag',
      !ids(oneTag.body).includes(warehouseId),
      ids(oneTag.body),
    );
    ok(
      'and an UNTAGGED asset does not match a tag filter',
      !ids(oneTag.body).includes(untypedId!) && !ids(oneTag.body).includes(inactiveId!),
      ids(oneTag.body),
    );

    const twoTags = await GET(
      `/assets?tags=${encodeURIComponent(TAG_A)}&tags=${encodeURIComponent(TAG_C)}&limit=100`,
    );
    ok(
      'a REPEATED ?tags= answers 200 — it used to raise "operator does not exist: text && unknown"',
      twoTags.status === 200,
      `status ${twoTags.status}: ${twoTags.raw.slice(0, 250)}`,
    );
    ok(
      'and the refusal it used to give was reported as a 400 "Database Error", so assert that string is gone',
      !/Database Error/.test(twoTags.raw),
      twoTags.raw.slice(0, 250),
    );
    ok(
      'it matches ANY of the tags — both assets come back',
      ids(twoTags.body).includes(buildingId) && ids(twoTags.body).includes(warehouseId),
      ids(twoTags.body),
    );
    ok(
      'and the untagged assets still do not',
      !ids(twoTags.body).includes(untypedId!),
      ids(twoTags.body),
    );

    const otherTag = await GET(`/assets?tags=${encodeURIComponent(TAG_C)}&limit=100`);
    ok(
      'and the filter really discriminates: the other tag returns only its own asset',
      otherTag.status === 200 &&
        ids(otherTag.body).includes(warehouseId) &&
        !ids(otherTag.body).includes(buildingId),
      ids(otherTag.body),
    );

    const missingTag = await GET(`/assets?tags=vassets-nonexistent-${RUN}&limit=100`);
    ok(
      'a tag nothing carries returns an empty list, not an error',
      missingTag.status === 200 && ids(missingTag.body).length === 0,
      `status ${missingTag.status}: ${ids(missingTag.body).length} rows`,
    );

    // ════════════════════════════════════════════════════════════════════════
    section('4. PATCH /assets/:id/attributes stores the attributes');

    const hvacZone = `Zone-${RUN}`;
    const patched = await PATCH(`/assets/${buildingId}/attributes`, {
      attributes: { hvacZone, assetTag: `HQ-${RUN}` },
    });
    ok(
      'the route answers 200 — it used to 400 ["property attributes should not exist"]',
      patched.status === 200,
      `status ${patched.status}: ${patched.raw.slice(0, 250)}`,
    );
    ok(
      'and the response carries the stored attributes',
      payload(patched.body)?.attributes?.hvacZone === hvacZone,
      payload(patched.body)?.attributes,
    );

    const reread = await GET(`/assets/${buildingId}`);
    ok(
      'a later read returns them, so they were not just echoed back',
      payload(reread.body)?.attributes?.hvacZone === hvacZone,
      payload(reread.body)?.attributes,
    );
    const storedAttributes = (await assetRow(buildingId))?.attributes;
    ok(
      'and the DATABASE row holds them',
      storedAttributes?.hvacZone === hvacZone && storedAttributes?.assetTag === `HQ-${RUN}`,
      storedAttributes,
    );

    // NEGATIVE CONTROL. `attributes` passes because it now carries validation
    // metadata — not because the whitelist was switched off. If
    // `forbidNonWhitelisted` had been disabled instead, this would be a 200.
    const bogus = await PATCH(`/assets/${buildingId}/attributes`, {
      attributes: { hvacZone },
      somethingUnknown: 1,
    });
    ok(
      'NEGATIVE CONTROL: an unknown property on the same body is still refused',
      bogus.status === 400 && /somethingUnknown should not exist/.test(bogus.raw),
      `status ${bogus.status}: ${bogus.raw.slice(0, 250)}`,
    );
    const empty = await PATCH(`/assets/${buildingId}/attributes`, {});
    ok(
      'NEGATIVE CONTROL: a body with no attributes at all is a 400, so the property is really validated',
      empty.status === 400,
      `status ${empty.status}: ${empty.raw.slice(0, 250)}`,
    );

    // ════════════════════════════════════════════════════════════════════════
    section('7. GET /assets/customer/:customerId materialises assetType');

    // Section 7 runs before 5 because 5 is the UNassignment: the customer list
    // has to be populated before it can be emptied.
    for (const [id, label] of [
      [warehouseId, 'the typed (warehouse) asset'],
      [untypedId!, 'the asset with no profile'],
    ] as const) {
      const assigned = await POST(`/assets/${id}/assign-customer`, {
        customerId: fx.customerId,
      });
      ok(`${label} is assigned to the customer`, assigned.status === 200, assigned.raw.slice(0, 250));
      ok(
        `and the database row carries the customerId for ${label}`,
        (await assetRow(id))?.customerId === fx.customerId,
        await assetRow(id),
      );
    }

    const byCustomer = await GET(`/assets/customer/${fx.customerId}`);
    ok('GET /assets/customer/:customerId answers 200', byCustomer.status === 200, byCustomer.raw.slice(0, 250));
    const customerRows = rows(byCustomer.body);
    ok('it returns the assigned assets', customerRows.length === 2, customerRows.map((r: any) => r?.id));
    ok(
      'and an asset NOT assigned to that customer is absent',
      !customerRows.some((r: any) => r?.id === buildingId),
      customerRows.map((r: any) => r?.id),
    );

    const typedRow = customerRows.find((r: any) => r?.id === warehouseId);
    const untypedRow = customerRows.find((r: any) => r?.id === untypedId);
    ok(
      'EVERY row carries the assetType key — it used to be absent here entirely',
      customerRows.length > 0 && customerRows.every((r: any) => r && 'assetType' in r),
      customerRows.map((r: any) => Object.prototype.hasOwnProperty.call(r ?? {}, 'assetType')),
    );

    // The value is compared with what GET /assets/:id answers for the SAME
    // row — which is the exact discrepancy that was reported.
    const typedDetail = await GET(`/assets/${warehouseId}`);
    const detailType = payload(typedDetail.body)?.assetType;
    ok(
      'the profile-typed row reports a type',
      typeof typedRow?.assetType === 'string',
      typedRow?.assetType,
    );
    ok(
      'and it is the SAME type GET /assets/:id reports for that row',
      typedRow?.assetType === detailType && typeof detailType === 'string',
      { list: typedRow?.assetType, detail: detailType },
    );
    ok(
      'which is the type its asset profile declares (§4a: the profile is the single source)',
      typedRow?.assetType === payload(singleRead.body)?.type,
      { row: typedRow?.assetType, profile: payload(singleRead.body)?.type },
    );
    ok(
      'and the profile-less row reports null, NOT undefined — the proof that it was materialised',
      untypedRow?.assetType === null,
      untypedRow?.assetType,
    );

    // ════════════════════════════════════════════════════════════════════════
    section('5. POST /assets/:id/unassign-customer clears the column');

    const before = await assetRow(warehouseId);
    ok(
      'the row starts with a customerId (so the clear has something to do)',
      before?.customerId === fx.customerId,
      before,
    );

    const unassigned = await POST(`/assets/${warehouseId}/unassign-customer`, {});
    ok('the route answers 200', unassigned.status === 200, unassigned.raw.slice(0, 250));

    const after = await assetRow(warehouseId);
    ok(
      'and the DATABASE row no longer has a customer — it used to answer 200 and keep it',
      after?.customerId === null,
      after,
    );
    ok(
      'the response body agrees with the row',
      !payload(unassigned.body)?.customerId,
      payload(unassigned.body)?.customerId,
    );
    const afterRead = await GET(`/assets/${warehouseId}`);
    ok(
      'a later read agrees too',
      !payload(afterRead.body)?.customerId,
      payload(afterRead.body)?.customerId,
    );
    const customerAfter = await GET(`/assets/customer/${fx.customerId}`);
    ok(
      'and the customer list drops it while keeping the other assignment',
      !ids(customerAfter.body).includes(warehouseId) &&
        ids(customerAfter.body).includes(untypedId!),
      ids(customerAfter.body),
    );

    // ════════════════════════════════════════════════════════════════════════
    section('6. GET /assets/:id/floors on a SINGLE-floor asset');

    const singleFloors = await GET(`/assets/${warehouseId}/floors`);
    ok('the route answers 200', singleFloors.status === 200, singleFloors.raw.slice(0, 250));
    const sf = payload(singleFloors.body);
    ok(
      'a single-floor asset reports ONE floor, not an empty list',
      Array.isArray(sf?.floors) && sf.floors.length === 1,
      sf?.floors,
    );
    ok('and that floor is floor 1', sf?.floors?.[0]?.floorNumber === 1, sf?.floors?.[0]);
    ok('and totalFloors says 1', sf?.totalFloors === 1, sf?.totalFloors);
    ok(
      'the floor has no plan yet, which is what the wizard needs somewhere to put',
      sf?.floors?.[0]?.hasFloorPlan === false && sf?.floors?.[0]?.floorPlanId === null,
      sf?.floors?.[0],
    );
    ok(
      'and the payload carries the inherited assetType (§4a)',
      sf?.assetType === payload(singleRead.body)?.type &&
        sf?.assetProfileType === sf?.assetType,
      { assetType: sf?.assetType, assetProfileType: sf?.assetProfileType },
    );

    // CONTROL: the single-floor answer is not a constant 1 for every asset —
    // the multi-floor asset still reports the floors its configuration
    // declares, read back from the API rather than from the literal above.
    const multiFloors = await GET(`/assets/${buildingId}/floors`);
    const mf = payload(multiFloors.body);
    const declaredFloors = payload(reread.body)?.configuration?.floorsData;
    ok('the multi-floor asset answers 200', multiFloors.status === 200, multiFloors.raw.slice(0, 200));
    ok(
      'CONTROL: it reports as many floors as its configuration declares, not 1',
      Array.isArray(declaredFloors) &&
        declaredFloors.length > 1 &&
        mf?.floors?.length === declaredFloors.length,
      { declared: declaredFloors?.length, reported: mf?.floors?.length },
    );
    ok(
      'and names them from floorsData',
      mf?.floors?.[0]?.floorName === declaredFloors?.[0]?.name,
      { reported: mf?.floors?.[0]?.floorName, declared: declaredFloors?.[0]?.name },
    );

    // The untyped asset has no profile and no configuration at all — the
    // weakest case, and the one the old `|| 0` fallback also emptied.
    const untypedFloors = await GET(`/assets/${untypedId}/floors`);
    ok(
      'an asset with no profile AND no configuration still reports one floor',
      untypedFloors.status === 200 && payload(untypedFloors.body)?.floors?.length === 1,
      payload(untypedFloors.body)?.floors,
    );

    // ════════════════════════════════════════════════════════════════════════
    section("8. a device from ANOTHER tenant cannot be adopted");

    const foreignBefore = await deviceRow(fx.devForeign);
    ok(
      "the foreign device starts unattached, in tenant B",
      foreignBefore?.assetId === null && foreignBefore?.tenantId === fx.tenantB,
      foreignBefore,
    );

    const singleForeign = await POST(`/assets/${buildingId}/devices`, {
      deviceId: fx.devForeign,
    });
    ok(
      "POST /assets/:id/devices with another tenant's deviceId answers 404 (not 403 — §4g)",
      singleForeign.status === 404,
      `status ${singleForeign.status}: ${singleForeign.raw.slice(0, 250)}`,
    );
    ok(
      "and the foreign device's assetId is UNCHANGED in the database",
      (await deviceRow(fx.devForeign))?.assetId === null,
      await deviceRow(fx.devForeign),
    );

    // CONTROL: the refusal is about the tenant, not about the route being
    // broken. The same request with the caller's OWN device succeeds.
    const ownSingle = await POST(`/assets/${buildingId}/devices`, { deviceId: fx.devA2 });
    ok(
      'CONTROL: the same route accepts the caller\'s OWN device',
      ownSingle.status < 300,
      `status ${ownSingle.status}: ${ownSingle.raw.slice(0, 250)}`,
    );
    ok(
      'and the database shows that one moved',
      (await deviceRow(fx.devA2))?.assetId === buildingId,
      await deviceRow(fx.devA2),
    );

    // ── The bulk route refuses the WHOLE batch ────────────────────────────
    const mixedBatch = await POST(`/assets/${buildingId}/devices/bulk`, {
      deviceIds: [fx.devA3, fx.devForeign],
    });
    ok(
      'POST /assets/:id/devices/bulk with one foreign id answers 404',
      mixedBatch.status === 404,
      `status ${mixedBatch.status}: ${mixedBatch.raw.slice(0, 250)}`,
    );
    ok(
      'and assigns NOTHING — the in-scope device in the same batch is untouched',
      (await deviceRow(fx.devA3))?.assetId === null,
      await deviceRow(fx.devA3),
    );
    ok(
      "and the foreign device is still unattached",
      (await deviceRow(fx.devForeign))?.assetId === null,
      await deviceRow(fx.devForeign),
    );
    ok(
      'and the refusal says nothing was assigned, rather than reporting a partial success',
      /nothing was assigned/i.test(mixedBatch.raw),
      mixedBatch.raw.slice(0, 250),
    );

    // CONTROL: the batch of one in-scope device goes through, so the refusal
    // above was the foreign id and not the route.
    const cleanBatch = await POST(`/assets/${buildingId}/devices/bulk`, {
      deviceIds: [fx.devA3],
    });
    ok(
      'CONTROL: a batch of only in-scope devices succeeds',
      cleanBatch.status < 300,
      `status ${cleanBatch.status}: ${cleanBatch.raw.slice(0, 250)}`,
    );
    ok(
      'and the database shows it assigned',
      (await deviceRow(fx.devA3))?.assetId === buildingId,
      await deviceRow(fx.devA3),
    );

    // And the other direction: tenant B cannot reach into tenant A either,
    // which is the same predicate seen from the other side.
    const reverse = await POST(
      `/assets/${foreignAssetId}/devices`,
      { deviceId: fx.devA1 },
      tokenB,
    );
    ok(
      "the other direction is refused too: tenant B cannot take tenant A's device",
      reverse.status === 404,
      `status ${reverse.status}: ${reverse.raw.slice(0, 250)}`,
    );
    ok(
      "and tenant A's device is still on tenant A's asset",
      (await deviceRow(fx.devA1))?.assetId === buildingId,
      await deviceRow(fx.devA1),
    );

    // ════════════════════════════════════════════════════════════════════════
    section('9. every @Param goes through ParseIdPipe');

    // One malformed id per parameter on the controller. Before the pipe, a
    // non-uuid reached Postgres' uuid parser and came back as a 500 or as a
    // 400 whose `error` was "Database Error" — a database message on a route
    // the caller mis-spelled.
    const badIdRoutes: Array<[string, () => Promise<Json>]> = [
      ['GET /assets/not-a-uuid', () => GET('/assets/not-a-uuid')],
      ['GET /assets/not-a-uuid/hierarchy', () => GET('/assets/not-a-uuid/hierarchy')],
      ['GET /assets/not-a-uuid/floors', () => GET('/assets/not-a-uuid/floors')],
      ['GET /assets/not-a-uuid/path', () => GET('/assets/not-a-uuid/path')],
      ['GET /assets/not-a-uuid/children', () => GET('/assets/not-a-uuid/children')],
      ['GET /assets/not-a-uuid/telemetry', () => GET('/assets/not-a-uuid/telemetry')],
      ['GET /assets/not-a-uuid/alarms', () => GET('/assets/not-a-uuid/alarms')],
      ['GET /assets/not-a-uuid/devices', () => GET('/assets/not-a-uuid/devices')],
      ['GET /assets/customer/not-a-uuid', () => GET('/assets/customer/not-a-uuid')],
      [
        'POST /assets/not-a-uuid/devices',
        () => POST('/assets/not-a-uuid/devices', { deviceId: fx.devA1 }),
      ],
      [
        'POST /assets/not-a-uuid/devices/bulk',
        () => POST('/assets/not-a-uuid/devices/bulk', { deviceIds: [fx.devA1] }),
      ],
      [
        'POST /assets/not-a-uuid/assign-customer',
        () => POST('/assets/not-a-uuid/assign-customer', { customerId: fx.customerId }),
      ],
      [
        'POST /assets/not-a-uuid/unassign-customer',
        () => POST('/assets/not-a-uuid/unassign-customer', {}),
      ],
      [
        'PATCH /assets/not-a-uuid',
        () => PATCH('/assets/not-a-uuid', { label: 'x' }),
      ],
      [
        'PATCH /assets/not-a-uuid/attributes',
        () => PATCH('/assets/not-a-uuid/attributes', { attributes: { a: 1 } }),
      ],
      ['DELETE /assets/not-a-uuid', () => DELETE('/assets/not-a-uuid')],
      [
        'DELETE /assets/:id/devices/not-a-uuid (the deviceId param)',
        () => DELETE(`/assets/${buildingId}/devices/not-a-uuid`),
      ],
    ];

    for (const [label, call] of badIdRoutes) {
      const response = await call();
      ok(
        `${label} → a clean 400 about the id`,
        response.status === 400 &&
          /Invalid ID format/i.test(response.raw) &&
          !/Database Error/.test(response.raw),
        `status ${response.status}: ${response.raw.slice(0, 200)}`,
      );
    }

    // NEGATIVE CONTROL. The pipe must reject the SHAPE, not the existence —
    // a well-formed uuid that happens to name nothing is a 404, and one that
    // names another tenant's row is a 404 too, never a 400 and never a 500.
    const unknownUuid = randomUUID();
    const missing = await GET(`/assets/${unknownUuid}`);
    ok(
      'NEGATIVE CONTROL: a well-formed but unknown uuid answers 404, not 400',
      missing.status === 404,
      `status ${missing.status}: ${missing.raw.slice(0, 200)}`,
    );
    const crossTenant = await GET(`/assets/${buildingId}`, tokenB);
    ok(
      "NEGATIVE CONTROL: another tenant's asset answers 404 rather than 403 (§4g)",
      crossTenant.status === 404,
      `status ${crossTenant.status}: ${crossTenant.raw.slice(0, 200)}`,
    );
    const missingFloors = await GET(`/assets/${unknownUuid}/floors`);
    ok(
      'and the same on a sub-route',
      missingFloors.status === 404,
      `status ${missingFloors.status}: ${missingFloors.raw.slice(0, 200)}`,
    );

    // ════════════════════════════════════════════════════════════════════════
    section('10. ?parentAssetId= is the accepted spelling');

    const byParent = await GET(`/assets?parentAssetId=${buildingId}&limit=100`);
    ok('?parentAssetId= answers 200', byParent.status === 200, byParent.raw.slice(0, 250));
    ok(
      'and returns the child of that asset',
      ids(byParent.body).includes(childId!),
      ids(byParent.body),
    );
    ok(
      'and nothing else — not the parent, not the unrelated assets',
      ids(byParent.body).length === 1,
      ids(byParent.body),
    );
    ok(
      'and the row it returns really names that parent',
      rows(byParent.body)[0]?.parentAssetId === buildingId,
      rows(byParent.body)[0]?.parentAssetId,
    );

    // NEGATIVE CONTROL: the frontend's old spelling. `forbidNonWhitelisted`
    // is what rejected it, and that is still on — so this fix really was on
    // the client, and nothing here loosened the pipe to accommodate it.
    const oldParent = await GET(`/assets?parentId=${buildingId}&limit=100`);
    ok(
      'NEGATIVE CONTROL: the old ?parentId= spelling is still a 400',
      oldParent.status === 400 && /parentId should not exist/.test(oldParent.raw),
      `status ${oldParent.status}: ${oldParent.raw.slice(0, 250)}`,
    );

    // ════════════════════════════════════════════════════════════════════════
    section('11. nothing above quietly destroyed the fixture');

    // Several of the sections send requests that MUST be refused, three of
    // them to destructive routes (DELETE /assets/not-a-uuid among them). A
    // refusal that happened after the work would pass every assertion above
    // and still have deleted a row, so the fixture is counted again at the
    // end.
    const finalList = await GET('/assets?limit=100');
    const finalIds = ids(finalList.body);
    for (const [id, label] of [
      [buildingId, 'building'],
      [warehouseId, 'warehouse'],
      [childId!, 'child'],
      [inactiveId!, 'inactive'],
      [untypedId!, 'untyped'],
      [farId!, 'far'],
    ] as const) {
      ok(`the ${label} asset still exists`, finalIds.includes(id), finalIds.length);
    }
    ok(
      'and tenant B still owns its own asset and its own device',
      (await assetRow(foreignAssetId!))?.tenantId === fx.tenantB &&
        (await deviceRow(fx.devForeign))?.tenantId === fx.tenantB,
      {
        asset: await assetRow(foreignAssetId!),
        device: await deviceRow(fx.devForeign),
      },
    );
  } catch (error) {
    ok('the verification ran to completion', false, (error as Error).stack ?? (error as Error).message);
  } finally {
    await app!.stop();
    await sweep(ds).catch(() => undefined);
    await ds.destroy();
  }

  console.log(
    failures === 0
      ? `\n\u001b[32mPASS\u001b[0m — ${checks} checks: all ten Assets fixes hold, each with its negative control\n`
      : `\n\u001b[31mFAIL\u001b[0m — ${failures} of ${checks} checks failed\n`,
  );
  process.exit(failures === 0 ? 0 : 1);
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
