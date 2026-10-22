/**
 * ─────────────────────────────────────────────────────────────────────────────
 * Runtime proof: floor-plan control widgets, over the real HTTP API
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * *"Add the widgets to the floor plan so I can turn on and off the lights, Air
 * conditioner, even the scenes and scenarios from the 3D model."*
 *
 * Boots the REAL `node dist/main.js` and drives the routes as a browser would,
 * because every interesting property of this feature lives in the interaction
 * between the nine global guards, a `ModuleRef` lookup resolved at
 * `onModuleInit`, and a jsonb column the action route reads verbatim. None of
 * that is visible from the source.
 *
 * The three properties worth the cost of a boot:
 *
 *  1. **The gateway lookup actually resolved.** `FloorPlanWidgetsService` gets
 *     `GatewayService` by STRING TOKEN through `ModuleRef`, because importing
 *     `GatewayModule` into `FloorPlansModule` would close a module load cycle
 *     and crash `bootstrap()`. Providers are registered under the CLASS by
 *     default, so that lookup typechecks perfectly and throws at init — the
 *     exact trap §4l documents for `'TelemetryService'`. The failure is caught
 *     and logged as a warning so a floor plan cannot stop the application
 *     booting, which means a broken lookup is SILENT. §1 is what makes it
 *     loud.
 *
 *  2. **The command cannot come from the request.** The action route names a
 *     widget and a stored action id. `method`, `params` and `deviceId` are
 *     read from the database. §4 proves a request that tries to supply its own
 *     is refused rather than honoured — otherwise a light switch is a
 *     general-purpose "send any command to any device" endpoint, reachable by
 *     every role the route admits (§4n).
 *
 *  3. **Scope holds on both the plan and the device.** A widget is a binding
 *     between a floor plan and a device, so it is two scope checks, and a
 *     scene's actions can each name a different device — which makes a scene
 *     the one shape that can reach past a single device. §5 covers all of it.
 *
 *   npx ts-node -T -r tsconfig-paths/register scripts/verify-floor-plan-widgets.ts [db] [port]
 */
import { randomUUID } from 'crypto';
import { execFileSync } from 'child_process';
import { mkdtempSync, readFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import type { DataSource } from 'typeorm';

import { DxfFloorPlanParser } from '../src/modules/floor-plans/parsers/dxf-floor-plan.parser';
import { Device } from '../src/modules/devices/entities/device.entity';
import { User } from '../src/modules/users/entities/user.entity';
import {
  SubscriptionPlan,
  UserRole,
  UserStatus,
} from '../src/common/enums/index.enum';
import { getPlanFeatures } from '../src/modules/subscriptions/plan-features';
import { bootApp, build, dataSource, prepareSchema, type BootedApp } from './support/boot-app';

const database = process.argv[2] ?? 'fpwidgetverify';
const PORT = Number(process.argv[3] ?? 5098);
const root = join(__dirname, '..');
const PASSWORD = 'Str0ng!Passw0rd';
const RUN = randomUUID().slice(0, 8);

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

const payload = (body: any): any => {
  let value = body;
  for (let depth = 0; depth < 3; depth++) {
    if (value && typeof value === 'object' && !Array.isArray(value) && 'data' in value) {
      value = value.data;
    } else break;
  }
  return value;
};

const mail = (local: string) => `${local}-${RUN}@example.test`;

async function sweep(ds: DataSource): Promise<void> {
  const q = (sql: string, p: any[] = []) => ds.query(sql, p);
  const stale = `SELECT id FROM tenants WHERE name LIKE 'fpw-%'`;
  for (const parent of ['users', 'tenants', 'floor_plans', 'devices', 'assets']) {
    const refs: Array<{ table: string; column: string }> = await q(
      `SELECT c.conrelid::regclass::text AS table, a.attname AS column
         FROM pg_constraint c
         JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = c.conkey[1]
        WHERE c.contype = 'f' AND c.confrelid = $1::regclass
          AND array_length(c.conkey, 1) = 1`,
      [parent],
    );
    const doomed =
      parent === 'tenants' ? stale : `SELECT id FROM ${parent} WHERE "tenantId" IN (${stale})`;
    for (const ref of refs) {
      if (ref.table === parent) continue;
      await q(`DELETE FROM ${ref.table} WHERE "${ref.column}" IN (${doomed})`).catch(
        () => undefined,
      );
    }
  }
  for (const table of ['floor_plan_widgets', 'floor_plans', 'devices', 'assets', 'subscriptions']) {
    await q(`DELETE FROM ${table} WHERE "tenantId" IN (${stale})`).catch(() => undefined);
  }
  await q(`DELETE FROM users WHERE "tenantId" IN (${stale})`).catch(() => undefined);
  await q(`DELETE FROM tenants WHERE name LIKE 'fpw-%'`);
}

const LIMITS = {
  devices: -1, users: -1, customers: -1, assets: -1, dashboards: -1, floorPlans: -1,
  automations: -1, ruleChains: -1, webhooks: -1, customIntegrations: -1,
  apiCallsPerMonth: -1, smsNotificationsPerMonth: -1, trainingSessions: -1,
  maxFloorPlans: -1, maxDevicesPerFloorPlan: -1, maxTemplateInstalls: -1,
  maxCustomTemplates: -1, templateInstallsLifetime: -1, storageGB: 1024,
  dataRetentionDays: 3650, historicalDataQueryDays: 3650, apiRateLimitPerMin: 100000,
  concurrentConnections: 10000, dashboardTemplates: -1, customDashboards: -1,
};

interface Fixture {
  tenantA: string;
  tenantB: string;
  adminEmail: string;
  planId: string;
  foreignPlanId: string;
  lampId: string;
  acId: string;
  foreignDeviceId: string;
  zoneId: string;
}

async function seed(ds: DataSource, dxf: string): Promise<Fixture> {
  const q = (sql: string, p: any[] = []) => ds.query(sql, p);
  const tenantA = randomUUID();
  const tenantB = randomUUID();

  for (const [id, label] of [[tenantA, 'a'], [tenantB, 'b']] as const) {
    await q('INSERT INTO tenants (id, name, email) VALUES ($1,$2,$3)', [
      id,
      `fpw-${label}-${RUN}`,
      mail(`tenant-${label}`),
    ]);
    await q(
      `INSERT INTO subscriptions (id,"tenantId",plan,status,limits,features)
       VALUES ($1,$2,$3,'active',$4,$5)`,
      [
        randomUUID(),
        id,
        SubscriptionPlan.ENTERPRISE,
        JSON.stringify(LIMITS),
        JSON.stringify(getPlanFeatures(SubscriptionPlan.ENTERPRISE)),
      ],
    );
  }

  const users = ds.getRepository(User);
  const admin = await users.save(
    users.create({
      name: 'Tenant Admin A',
      email: mail('admin-a'),
      password: PASSWORD,
      role: UserRole.TENANT_ADMIN,
      status: UserStatus.ACTIVE,
      emailVerified: true,
      tenantId: tenantA,
    }),
  );
  const adminB = await users.save(
    users.create({
      name: 'Tenant Admin B',
      email: mail('admin-b'),
      password: PASSWORD,
      role: UserRole.TENANT_ADMIN,
      status: UserStatus.ACTIVE,
      emailVerified: true,
      tenantId: tenantB,
    }),
  );

  const devices = ds.getRepository(Device);
  const mkDevice = async (tenantId: string, userId: string, label: string) => {
    const entity = devices.create({
      name: `fpw-${label}-${RUN}`,
      deviceKey: `fpw-${label}-${RUN}`,
      tenantId,
      userId,
      status: 'active' as any,
      type: 'actuator' as any,
      protocol: 'generic_mqtt' as any,
    } as any) as unknown as Device;
    const saved = await devices.save(entity);
    return saved.id;
  };

  const lampId = await mkDevice(tenantA, admin.id, 'lamp');
  const acId = await mkDevice(tenantA, admin.id, 'ac');
  const foreignDeviceId = await mkDevice(tenantB, adminB.id, 'foreign');

  // The plan carries the REAL parsed geometry of the test drawing, so the
  // import-from-drawing path is exercised against actual markers on actual
  // standard layers rather than a hand-written stub.
  const parsedDrawing = DxfFloorPlanParser.parse(readFileSync(dxf, 'latin1'));

  // ── The plan is stored as a LEGACY row, on purpose ────────────────────────
  //
  // The parser strips the X-mark strokes now, so storing its output verbatim
  // would make the read-path assertion in §1b vacuous: the strokes would
  // already be absent whether `FloorPlansService.withoutXStrokes` ran or not.
  // That is exactly the shape §4r warns about — a check that passes because
  // there was nothing to catch, counted as evidence that the fix works.
  //
  // So the strokes are put back and `voids` removed, reproducing a drawing
  // imported before the parser learned the convention. That is also the row
  // the client actually has, which is the whole reason the read path exists:
  // his plans are already uploaded, and "re-import everything" is not a fix.
  const xStroke = (n: number, a: [number, number], b: [number, number]) => ({
    start: { x: a[0], y: a[1], z: 0 },
    end: { x: b[0], y: b[1], z: 0 },
    layer: 'A-AREA-IDEN',
  });
  const legacyStrokes: Array<[number, [number, number], [number, number]]> = [
    [9001, [4, 4], [7, 7]],
    [9003, [7, 4], [4, 7]],
  ];
  const geometry = {
    ...parsedDrawing,
    walls: [
      ...parsedDrawing.walls,
      ...legacyStrokes.map(([n, a, b]) => ({
        id: `wall-${n}`,
        ...xStroke(n, a, b),
        points: [
          { x: a[0], y: a[1], z: 0 },
          { x: b[0], y: b[1], z: 0 },
        ],
        thickness: 0.1,
        height: 3,
        material: 'A-AREA-IDEN',
      })),
    ],
    lines: [
      ...(parsedDrawing.lines ?? []),
      ...legacyStrokes.map(([n, a, b]) => ({ id: `line-${n}`, ...xStroke(n, a, b) })),
    ],
    voids: undefined,
  };

  // One zone covering the left-hand room, so the zone-containment test has a
  // real polygon to resolve against. Coordinates are metres, matching the
  // drawing: the room runs x 0.2→8, y 0.2→7.8.
  const zoneId = `zone-${RUN}`;
  const zones = [
    {
      id: zoneId,
      name: 'Office 01',
      color: '#3b82f6',
      boundaries: [
        { x: 0.2, y: 0.2 },
        { x: 8, y: 0.2 },
        { x: 8, y: 7.8 },
        { x: 0.2, y: 7.8 },
      ],
    },
  ];

  // `floor_plans.assetId` is NOT NULL — a plan is a floor OF something
  // (§4a) — so each tenant gets an asset for its plan to belong to.
  const mkAsset = async (tenantId: string) => {
    const id = randomUUID();
    await q(
      `INSERT INTO assets (id, name, "tenantId", type) VALUES ($1,$2,$3,'building')`,
      [id, `fpw-asset-${tenantId.slice(0, 8)}-${RUN}`, tenantId],
    );
    return id;
  };

  const mkPlan = async (tenantId: string, userId: string, label: string) => {
    const id = randomUUID();
    const assetId = await mkAsset(tenantId);
    await q(
      `INSERT INTO floor_plans
         (id, name, "tenantId", "userId", "assetId", building, floor,
          dimensions, "parsedGeometry", zones, "floorNumber")
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,1)`,
      [
        id,
        `fpw-plan-${label}-${RUN}`,
        tenantId,
        userId,
        assetId,
        'HQ',
        'Ground',
        JSON.stringify({ width: 12, height: 8, unit: 'm' }),
        JSON.stringify(geometry),
        JSON.stringify(zones),
      ],
    );
    return id;
  };

  return {
    tenantA,
    tenantB,
    adminEmail: admin.email,
    planId: await mkPlan(tenantA, admin.id, 'a'),
    foreignPlanId: await mkPlan(tenantB, adminB.id, 'b'),
    lampId,
    acId,
    foreignDeviceId,
    zoneId,
  };
}

(async () => {
  console.log(`\n── Floor-plan widgets (database "${database}", port ${PORT}) ──\n`);

  const built = await build(root);
  ok('the project builds', built.ok, built.stderr);
  if (!built.ok) process.exit(1);

  // A temp directory, not the repo root: an early run that throws before the
  // `finally` block would otherwise leave fpw-fixture-*.dxf in the project,
  // which is exactly what happened while this script was being written.
  const work = mkdtempSync(join(tmpdir(), 'verify-fp-widgets-'));
  const dxf = join(work, `fpw-fixture-${RUN}.dxf`);
  execFileSync(
    'npx',
    ['ts-node', '-T', '-r', 'tsconfig-paths/register', 'scripts/support/make-test-plan.ts', dxf],
    { cwd: root, encoding: 'utf8' },
  );

  await prepareSchema(database);
  const ds = dataSource(database);
  await ds.initialize();
  await sweep(ds);
  const fx = await seed(ds, dxf);

  let app: BootedApp;
  try {
    app = await bootApp(root, database, PORT);
    ok('the application boots and serves', true);
  } catch (error) {
    ok('the application boots and serves', false, (error as Error).message);
    await ds.destroy();
    process.exit(1);
  }

  try {
    const login = await app.request('POST', '/auth/login', {
      body: { email: fx.adminEmail, password: PASSWORD },
    });
    const token = payload(login.body)?.accessToken;
    ok('the tenant admin logs in', typeof token === 'string', login.raw.slice(0, 200));
    if (!token) throw new Error('no token');

    const W = (path = '') => `/floor-plans/${fx.planId}/widgets${path}`;

    // ── 1. The gateway lookup resolved ───────────────────────────────────
    section('1. the ModuleRef string-token lookup resolved');

    ok(
      'the boot log does NOT say GatewayService could not be resolved',
      !/GatewayService could not be resolved/.test(app.output()),
      app
        .output()
        .split('\n')
        .filter((l) => /GatewayService/.test(l))
        .slice(0, 3),
    );

    // ── 1b. The display-geometry ENDPOINT ────────────────────────────────
    section('1b. GET /display-geometry answers over HTTP');

    // `verify:display-geometry` exercises `buildDisplayGeometry` as a
    // function. Nothing had called the ROUTE — so a shadowed path, a bad DTO
    // or a 500 in the controller would have gone unnoticed while 62 checks
    // passed. The plan here carries the same fixture drawing, so the expected
    // numbers are known.
    const dg = await app.request(
      'GET',
      `/floor-plans/${fx.planId}/display-geometry`,
      { token },
    );
    ok('the route answers 200', dg.status === 200, `status ${dg.status}: ${dg.raw.slice(0, 200)}`);
    const display = payload(dg.body)?.display;
    ok('with draw-ready geometry', !!display, Object.keys(payload(dg.body) ?? {}));
    ok(
      'the standard has been applied — 19 candidates down to 10 built',
      display?.stats?.wallCandidates === 19 && display?.stats?.wallsAfterStandard === 10,
      display?.stats,
    );
    // 19, not the 21 lines the fixture draws: the two X strokes are removed
    // before this, so the crossed-out box renders as a box with nothing in
    // it. That is the client's standard, and suppressing the region's
    // CONTENTS while leaving the cross standing was the complaint.
    //
    // The two assertions below are the ones that matter, because they are the
    // only place the READ path is proven. A plan imported before the parser
    // learned this has the strokes in its stored `parsedGeometry` jsonb, and
    // re-importing every drawing is not a reasonable migration — so
    // `FloorPlansService.withoutXStrokes` strips them on the way out instead.
    // Asserting it here, over HTTP, is what distinguishes that from a fix that
    // only ever helps the next upload.
    const diagonalSpansRegion = (seg: any) => {
      const pts = [seg?.start, seg?.end].map((pt: any) => [pt?.x, pt?.y]);
      const at = (x: number, y: number) =>
        pts.some(([px, py]) => Math.abs(px - x) < 0.02 && Math.abs(py - y) < 0.02);
      return (at(4, 4) && at(7, 7)) || (at(7, 4) && at(4, 7));
    };
    ok(
      'no X stroke survives into the drawn walls',
      Array.isArray(display?.walls) && !display.walls.some(diagonalSpansRegion),
      (display?.walls ?? []).filter(diagonalSpansRegion).length,
    );

    const geom = await app.request('GET', `/floor-plans/${fx.planId}/geometry`, { token });
    const rawGeometry = payload(geom.body)?.geometry;
    ok(
      'and none survives on the raw geometry route either — the strip is on the READ path, not only the importer',
      geom.status === 200 &&
        !(rawGeometry?.walls ?? []).some(diagonalSpansRegion) &&
        !(rawGeometry?.lines ?? []).some(diagonalSpansRegion),
      `status ${geom.status}, walls ` +
        `${(rawGeometry?.walls ?? []).filter(diagonalSpansRegion).length}, lines ` +
        `${(rawGeometry?.lines ?? []).filter(diagonalSpansRegion).length}`,
    );
    ok('wall faces are paired into five walls', display?.stats?.wallsPaired === 5, display?.stats);
    ok('the X-marked space is reported', display?.stats?.voids === 1, display?.stats);
    ok('and lengths are in metres', display?.units === 'm', display?.units);

    // The bisect flag has to actually bisect — it did not, in the first
    // version, because a second filter ran unconditionally.
    const unfiltered = await app.request(
      'GET',
      `/floor-plans/${fx.planId}/display-geometry?enforceStandard=false`,
      { token },
    );
    const rawDisplay = payload(unfiltered.body)?.display;
    ok(
      '?enforceStandard=false really returns the unfiltered drawing',
      unfiltered.status === 200 &&
        rawDisplay?.walls?.some((w: any) => w.layer === 'G-GRID'),
      {
        status: unfiltered.status,
        layers: [...new Set((rawDisplay?.walls ?? []).map((w: any) => w.layer))],
      },
    );

    // ── 2. Import the drawing's own equipment ────────────────────────────
    section('2. widgets are created from the drawing\'s symbols');

    const imported = await app.request('POST', W('/import-from-drawing'), {
      token,
      body: {},
    });
    ok('POST /import-from-drawing succeeds', imported.status === 200, imported.raw.slice(0, 300));
    const importResult = payload(imported.body);
    ok(
      'the four E-LITE light fittings become light widgets',
      importResult?.byKind?.light === 4,
      importResult,
    );
    ok(
      'and the M-HVAC-EQPM unit becomes an hvac widget',
      importResult?.byKind?.hvac === 1,
      importResult,
    );

    const listed = await app.request('GET', W(), { token });
    ok('GET /widgets answers 200', listed.status === 200, listed.raw.slice(0, 200));
    const widgets: any[] = payload(listed.body) ?? [];
    ok('five widgets are on the plan', widgets.length === 5, widgets.length);

    const lights = widgets.filter((w) => w.kind === 'light');
    // `E-LITE` is `mount: 'ceiling', mountMm: 60`, and the catalogue's formula
    // for the ceiling plane is `ceilingHeight - mountMm` — so with the test
    // drawing's 3 m storey a luminaire sits at 2.94 m, NOT at 0.06.
    ok(
      'each light hangs just below the 3 m ceiling, per the standard\'s mounting plane',
      lights.length > 0 && lights.every((w) => w.z > 2.8 && w.z < 3),
      lights.map((w) => w.z),
    );
    ok(
      'they land UNBOUND — a drawing says where a light is, not which device runs it',
      widgets.every((w) => w.deviceId === null),
      widgets.map((w) => w.deviceId),
    );
    ok(
      'and DISABLED, so an unbound control cannot be pressed',
      widgets.every((w) => w.enabled === false),
      widgets.map((w) => w.enabled),
    );
    ok(
      'a light inside the zone polygon is attached to that zone',
      lights.some((w) => w.zoneId === fx.zoneId),
      lights.map((w) => ({ x: w.x, y: w.y, zoneId: w.zoneId })),
    );
    ok(
      'and one outside it is not',
      lights.some((w) => w.zoneId === null),
      lights.map((w) => ({ x: w.x, zoneId: w.zoneId })),
    );

    const reimported = await app.request('POST', W('/import-from-drawing'), { token, body: {} });
    ok(
      're-importing creates nothing — it is idempotent on the drawing marker',
      payload(reimported.body)?.created === 0,
      payload(reimported.body),
    );
    const afterReimport = payload((await app.request('GET', W(), { token })).body) ?? [];
    ok('so the plan still has five widgets, not ten', afterReimport.length === 5, afterReimport.length);

    // ── 3. A bound, working light ────────────────────────────────────────
    section('3. a light bound to a device and a zone');

    const created = await app.request('POST', W(), {
      token,
      body: {
        kind: 'light',
        label: 'Office downlights',
        deviceId: fx.lampId,
        zoneId: fx.zoneId,
        x: 3,
        y: 4,
        z: 2.8,
        stateKey: 'switch_1',
        stateTransform: { type: 'boolean', staleAfterSeconds: 300 },
        visual: { color: '#fde68a', intensity: 0.6, radiusM: 3 },
        actions: [
          { id: 'on', label: 'Turn on', method: 'setState', params: { on: true }, optimisticState: true },
          { id: 'off', label: 'Turn off', method: 'setState', params: { on: false }, optimisticState: false },
        ],
      },
    });
    ok('POST /widgets creates it', created.status === 201 || created.status === 200, created.raw.slice(0, 400));
    const light = payload(created.body);
    ok('bound to the device', light?.deviceId === fx.lampId, light?.deviceId);
    ok('and to the zone whose area it lights', light?.zoneId === fx.zoneId, light?.zoneId);
    ok('carrying both of its actions', light?.actions?.length === 2, light?.actions);

    // ── 4. The command comes from the STORED widget ──────────────────────
    section('4. the command cannot be supplied by the request');

    // ── No broker in this harness, and that is the point ─────────────────
    //
    // MQTT is disabled (`bootEnv`), so the command cannot actually leave the
    // host. What this feature OWNS is the resolution: reading the method, the
    // params and the device from the stored widget rather than from the
    // request. So both outcomes are accepted — a dispatch, or a
    // `DISPATCH_FAILED` — and the assertions below check the RESOLVED values
    // in either case.
    //
    // That distinction is a product requirement, not a test convenience: an
    // operator pressing a switch has to be able to tell "this widget is
    // misconfigured" from "the broker is down", and before this the second
    // one surfaced as a bare 500 "MQTT client is not connected".
    const pressed = await app.request('POST', W(`/${light.id}/action`), {
      token,
      body: { actionId: 'on' },
    });
    const dispatched = pressed.status === 200;
    const resolvedOk = dispatched || pressed.body?.details?.code === 'DISPATCH_FAILED' ||
      pressed.body?.code === 'DISPATCH_FAILED';

    ok(
      'pressing "on" resolves the widget (dispatched, or failed at the transport)',
      dispatched || resolvedOk,
      `status ${pressed.status}: ${pressed.body?.message ?? pressed.raw.slice(0, 200)}`,
    );

    const outcome = dispatched ? payload(pressed.body) : pressed.body?.details;
    ok(
      'and resolves to the method stored on the widget, not one from the request',
      outcome?.method === 'setState',
      outcome,
    );
    ok(
      'and to the device stored on the widget',
      outcome?.deviceId === fx.lampId,
      outcome?.deviceId,
    );
    if (dispatched) {
      ok(
        'returning the optimistic state so the lamp responds before the device confirms',
        outcome?.optimisticState === true,
        outcome?.optimisticState,
      );
    } else {
      ok(
        'and a transport failure says the widget itself resolved correctly',
        outcome?.resolved === true && outcome?.dispatched === false,
        outcome,
      );
    }

    // The load-bearing one. `forbidNonWhitelisted: true` is what refuses it,
    // which is why the DTO deliberately declares no `method`/`deviceId`.
    const injected = await app.request('POST', W(`/${light.id}/action`), {
      token,
      body: { actionId: 'on', method: 'factoryReset', deviceId: fx.foreignDeviceId },
    });
    ok(
      'a request naming its OWN method and device is REFUSED, not honoured',
      injected.status === 400,
      `status ${injected.status}: ${injected.body?.message ?? injected.raw.slice(0, 200)}`,
    );

    const unknown = await app.request('POST', W(`/${light.id}/action`), {
      token,
      body: { actionId: 'selfDestruct' },
    });
    ok('an action the widget does not have is refused', unknown.status === 400, `status ${unknown.status}`);
    ok(
      'and the refusal lists the actions it DOES have',
      Array.isArray(unknown.body?.details?.available),
      unknown.body?.details,
    );

    const disabledWidget = afterReimport[0];
    const disabledPress = await app.request('POST', W(`/${disabledWidget.id}/action`), {
      token,
      body: { actionId: 'on' },
    });
    ok(
      'a disabled widget refuses its controls',
      disabledPress.status === 400,
      `status ${disabledPress.status}`,
    );

    // ── 5. Scope, on the plan and on every device ────────────────────────
    section('5. scope holds on the plan and on every device');

    const foreignBind = await app.request('POST', W(), {
      token,
      body: {
        kind: 'switch',
        label: 'Someone else\'s device',
        deviceId: fx.foreignDeviceId,
        x: 1,
        y: 1,
        actions: [{ id: 'on', method: 'setState', params: { on: true } }],
      },
    });
    ok(
      'binding another tenant\'s device answers 404, not 403 (§4g)',
      foreignBind.status === 404,
      `status ${foreignBind.status}`,
    );

    const foreignPlan = await app.request(
      'GET',
      `/floor-plans/${fx.foreignPlanId}/widgets`,
      { token },
    );
    ok(
      'another tenant\'s floor plan answers 404',
      foreignPlan.status === 404,
      `status ${foreignPlan.status}`,
    );

    const badZone = await app.request('POST', W(), {
      token,
      body: {
        kind: 'light',
        label: 'Wrong zone',
        deviceId: fx.lampId,
        zoneId: 'no-such-zone',
        x: 1,
        y: 1,
        actions: [{ id: 'on', method: 'setState' }],
      },
    });
    ok('an unknown zone is refused', badZone.status === 400, `status ${badZone.status}`);
    ok(
      'and the refusal names the zones that DO exist',
      Array.isArray(badZone.body?.details?.available),
      badZone.body?.details,
    );

    // ── 6. Scenes ────────────────────────────────────────────────────────
    section('6. a scene commands several devices');

    const scene = await app.request('POST', W(), {
      token,
      body: {
        kind: 'scene',
        label: 'Evening',
        x: 6,
        y: 1,
        actions: [
          { id: 'apply', label: 'Apply', deviceId: fx.lampId, method: 'setState', params: { on: true } },
          { id: 'apply-ac', label: 'Apply AC', deviceId: fx.acId, method: 'setState', params: { setpoint: 22 } },
        ],
      },
    });
    ok('a scene needs no device of its own', scene.status === 201 || scene.status === 200, scene.raw.slice(0, 300));
    const sceneBody = payload(scene.body);
    ok('and has none', sceneBody?.deviceId === null || sceneBody?.deviceId === undefined, sceneBody?.deviceId);

    const sceneForeign = await app.request('POST', W(), {
      token,
      body: {
        kind: 'scene',
        label: 'Reach out of tenant',
        x: 6,
        y: 2,
        actions: [
          { id: 'a', deviceId: fx.lampId, method: 'setState' },
          { id: 'b', deviceId: fx.foreignDeviceId, method: 'setState' },
        ],
      },
    });
    ok(
      'a scene action naming another tenant\'s device is refused — the one shape that can reach past one device',
      sceneForeign.status === 404,
      `status ${sceneForeign.status}`,
    );

    const scenePress = await app.request('POST', W(`/${sceneBody.id}/action`), {
      token,
      body: { actionId: 'apply-ac' },
    });
    const sceneOutcome =
      scenePress.status === 200 ? payload(scenePress.body) : scenePress.body?.details;
    ok(
      'pressing one of a scene\'s actions targets that action\'s own device',
      sceneOutcome?.deviceId === fx.acId,
      sceneOutcome,
    );

    // ── 7. One subscription call for the whole plan ──────────────────────
    section('7. the plan reports every device its widgets touch');

    const deviceIds = await app.request('GET', W('/devices'), { token });
    ok('GET /widgets/devices answers 200', deviceIds.status === 200, deviceIds.raw.slice(0, 200));
    const ids: string[] = payload(deviceIds.body) ?? [];
    ok('including the light\'s device', ids.includes(fx.lampId), ids);
    ok(
      'and the AC named only inside a scene\'s actions',
      ids.includes(fx.acId),
      ids,
    );
    ok('and nothing from another tenant', !ids.includes(fx.foreignDeviceId), ids);

    // ── 7b. "What breaks if I delete this device?" ────────────────────────
    section('7b. widgets are findable by the device they command');

    // Also a ROUTE-ORDERING check. `widgets/by-device/:deviceId` has a literal
    // first segment while every neighbour is `:id/...`, and Nest matches in
    // declaration order (§4o). If the ordering were wrong this would answer
    // 404 or be captured by another handler — which is the kind of thing that
    // typechecks perfectly and is only visible from a request.
    const byDevice = await app.request(
      'GET',
      `/floor-plans/widgets/by-device/${fx.acId}`,
      { token },
    );
    ok(
      'GET /floor-plans/widgets/by-device/:deviceId resolves to its own handler',
      byDevice.status === 200,
      `status ${byDevice.status}: ${byDevice.raw.slice(0, 160)}`,
    );
    const touching: any[] = payload(byDevice.body) ?? [];
    ok(
      'and finds the AC through a SCENE action, where no column points at it',
      touching.some((w) => w.kind === 'scene'),
      touching.map((w) => ({ kind: w.kind, deviceId: w.deviceId })),
    );

    // ── 8. Unbinding ─────────────────────────────────────────────────────
    section('8. a widget can be unbound');

    const unbound = await app.request('PATCH', W(`/${light.id}`), {
      token,
      body: { zoneId: null },
    });
    ok('PATCH accepts a null zone', unbound.status === 200, unbound.raw.slice(0, 250));
    const reread = payload((await app.request('GET', W(), { token })).body) ?? [];
    const afterUnbind = reread.find((w: any) => w.id === light.id);
    ok(
      'and the zone is really cleared — TypeORM reads undefined as "leave alone"',
      afterUnbind?.zoneId === null,
      afterUnbind?.zoneId,
    );

    const deleted = await app.request('DELETE', W(`/${light.id}`), { token });
    ok('DELETE removes the widget', deleted.status === 204, `status ${deleted.status}`);
    const finalList = payload((await app.request('GET', W(), { token })).body) ?? [];
    ok('and it is gone', !finalList.some((w: any) => w.id === light.id), finalList.length);
  } catch (error) {
    ok('the verification ran to completion', false, (error as Error).message);
  } finally {
    await app!.stop();
    await sweep(ds).catch(() => undefined);
    await ds.destroy();
    rmSync(work, { recursive: true, force: true });
  }

  console.log(
    failures === 0
      ? `\n\u001b[32mPASS\u001b[0m — ${checks} checks: widgets read the drawing, control their devices, and cannot be made to send an arbitrary command\n`
      : `\n\u001b[31mFAIL\u001b[0m — ${failures} of ${checks} checks failed\n`,
  );
  process.exit(failures === 0 ? 0 : 1);
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
