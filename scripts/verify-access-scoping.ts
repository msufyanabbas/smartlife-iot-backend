/**
 * ─────────────────────────────────────────────────────────────────────────────
 * Runtime proof: tenant and customer read-scoping, against a real Postgres
 * ─────────────────────────────────────────────────────────────────────────────
 *
 *   createdb scopecheck && npm run verify:access-scoping [database]
 *
 * WHAT THIS COVERS
 * ----------------
 * The same twelve lines of tenant/customer scoping had been hand-written five
 * times — `DevicesService.applyAccessFilter()`, `AssetsService` (several
 * reads), `DashboardsService`, `AlarmsService` and, by omission,
 * `ReportsService` — and the copies had drifted into real leaks:
 *
 *   1. `AssetsService.findOne()` gave a CUSTOMER_USER a customer predicate and
 *      NO tenant predicate, and gave `CUSTOMER` and plain `USER` no predicate
 *      at all: either role could read ANY asset on the platform by uuid.
 *   2. `DashboardsService.findAll()` matched `visibility = PUBLIC` with no
 *      tenant predicate, so every tenant's public dashboards were listed to
 *      every customer user — and `UserRole.CUSTOMER` could not see its own
 *      customer's dashboards at all.
 *   3. `AlarmsService.findOne()` was tenant-only, so a customer user with
 *      `alerts:read` read a SIBLING customer's alarms; and `findAll()`
 *      applied the customer predicate only `if (customerId)`, so a falsy
 *      customerId silently widened to tenant-wide.
 *   4. `ReportsService` had no customer dimension anywhere.
 *
 * All five call sites now go through ONE helper,
 * `@common/scoping/apply-access-scope`, whose two rules are asserted here:
 *
 *   · a falsy scope value DENIES — it never widens;
 *   · a row outside the scope is ABSENT (404), not forbidden (403).
 *
 * Every assertion below runs the real service against real rows. Reading the
 * code proves nothing — the recurring failure in this codebase is scoping
 * that compiles and does nothing.
 *
 * The fixtures are swept by NAME PREFIX before they are built: `tenants.name`
 * is UNIQUE, so a crashed run would otherwise poison every later one.
 */
import { randomUUID } from 'crypto';
import { DataSource, Repository } from 'typeorm';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { Reflector } from '@nestjs/core';
import type { ExecutionContext } from '@nestjs/common';

import * as entities from '../src/modules/index.entities';
import {
  Alarm,
  Asset,
  AssetProfile,
  Customer,
  Dashboard,
  Device,
  FloorPlan,
  FloorPlanDevice,
  ReportExecution,
  ReportTemplate,
  Telemetry,
  User,
} from '../src/modules/index.entities';
import { WidgetType } from '../src/modules/widgets/entities/widget-type.entity';
import { AssetsService } from '../src/modules/assets/assets.service';
import { DashboardsService } from '../src/modules/dashboards/dashboards.service';
import { AlarmsService } from '../src/modules/alarms/alarms.service';
import { ReportsService } from '../src/modules/reports/reports.service';
import { CustomerAccessGuard } from '../src/common/guards/customer-access.guard';
import {
  applyAccessScope,
  isWithinAccessScope,
} from '../src/common/scoping/apply-access-scope';
import { UserRole } from '../src/common/enums/user.enum';
import {
  AlarmSeverity,
  AlarmStatus,
  DashboardVisibility,
} from '../src/common/enums/index.enum';
import { ReportDateRangeMode, ReportEntityKind } from '../src/modules/reports/report.enum';

const database = process.argv[2] ?? 'scopecheck';

/** Everything this script creates is named with it, and swept by it. */
const PREFIX = 'accessscope';

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
  console.log(`\n── ${title} ${'─'.repeat(Math.max(2, 58 - title.length))}`);

/** Resolves to 'found' | 'notfound' | 'forbidden' | 'other:<name>'. */
const attempt = async (read: () => Promise<unknown>) => {
  try {
    const row = await read();
    return row ? 'found' : 'empty';
  } catch (error: any) {
    const name = error?.constructor?.name ?? 'Error';
    if (name === 'NotFoundException') return 'notfound';
    if (name === 'ForbiddenException') return 'forbidden';
    return `other:${name}:${error?.message ?? ''}`;
  }
};

const sameSet = (actual: string[], expected: string[]) =>
  actual.length === expected.length &&
  [...actual].sort().join() === [...expected].sort().join();

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

  const q = (sql: string, params: any[] = []) => dataSource.query(sql, params);

  const assetRepo: Repository<Asset> = dataSource.getRepository(Asset);
  const deviceRepo: Repository<Device> = dataSource.getRepository(Device);
  const alarmRepo: Repository<Alarm> = dataSource.getRepository(Alarm);
  const userRepo: Repository<User> = dataSource.getRepository(User);
  const dashboardRepo: Repository<Dashboard> = dataSource.getRepository(Dashboard);
  const templateRepo: Repository<ReportTemplate> =
    dataSource.getRepository(ReportTemplate);
  const executionRepo: Repository<ReportExecution> =
    dataSource.getRepository(ReportExecution);

  // ── Sweep by name prefix, not by id ─────────────────────────────────────
  // The ids are fresh uuids on every run, so deleting by id cleans up nothing
  // a crashed run left behind — and `tenants.name` is UNIQUE, so one crashed
  // run would make every later run fail on the tenant insert instead of on an
  // assertion. Children first: these tables carry real FKs.
  section('0. Sweep and fixtures');
  const sweep = async () => {
    const tenantIds = `(SELECT id FROM tenants WHERE name LIKE '${PREFIX}-%')`;
    for (const table of [
      'report_executions',
      'report_templates',
      'alarms',
      'dashboards',
      'telemetry',
      'devices',
      'assets',
    ]) {
      await q(`DELETE FROM "${table}" WHERE "tenantId" IN ${tenantIds}`).catch(
        () => undefined,
      );
    }
    await q(`DELETE FROM users WHERE email LIKE '${PREFIX}-%'`);
    await q(`DELETE FROM customers WHERE email LIKE '${PREFIX}-%'`);
    await q(`DELETE FROM tenants WHERE name LIKE '${PREFIX}-%'`);
  };
  await sweep();

  // ── The graph ───────────────────────────────────────────────────────────
  const TENANT_A = randomUUID();
  const TENANT_B = randomUUID();
  const CUST_A1 = randomUUID();
  const CUST_A2 = randomUUID();
  const CUST_B1 = randomUUID();

  for (const [id, label] of [
    [TENANT_A, 'a'],
    [TENANT_B, 'b'],
  ] as const) {
    await q('INSERT INTO tenants (id, name, email) VALUES ($1, $2, $3)', [
      id,
      `${PREFIX}-tenant-${label}`,
      `${PREFIX}-tenant-${label}-${id.slice(0, 8)}@example.invalid`,
    ]);
  }

  for (const [id, tenantId, label] of [
    [CUST_A1, TENANT_A, 'a1'],
    [CUST_A2, TENANT_A, 'a2'],
    [CUST_B1, TENANT_B, 'b1'],
  ] as const) {
    await q(
      'INSERT INTO customers (id, "tenantId", name, email) VALUES ($1, $2, $3, $4)',
      [
        id,
        tenantId,
        `${PREFIX}-customer-${label}`,
        `${PREFIX}-customer-${label}-${id.slice(0, 8)}@example.invalid`,
      ],
    );
  }

  const makeUser = async (
    role: UserRole,
    tenantId: string | null,
    customerId: string | null,
    label: string,
  ): Promise<User> => {
    const id = randomUUID();
    await q(
      `INSERT INTO users (id, name, email, password, role, "tenantId", "customerId")
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [
        id,
        `${PREFIX}-${label}`,
        `${PREFIX}-${label}-${id.slice(0, 8)}@example.invalid`,
        'not-a-real-hash',
        role,
        tenantId,
        customerId,
      ],
    );
    return userRepo.findOneByOrFail({ id });
  };

  const tenantAdminA = await makeUser(UserRole.TENANT_ADMIN, TENANT_A, null, 'tadmin-a');
  const plainUserA = await makeUser(UserRole.USER, TENANT_A, null, 'plain-a');
  const customerA1 = await makeUser(UserRole.CUSTOMER, TENANT_A, CUST_A1, 'cust-a1');
  const customerUserA1 = await makeUser(
    UserRole.CUSTOMER_USER,
    TENANT_A,
    CUST_A1,
    'custuser-a1',
  );
  const customerUserA2 = await makeUser(
    UserRole.CUSTOMER_USER,
    TENANT_A,
    CUST_A2,
    'custuser-a2',
  );
  // The falsy case: a customer-scoped role with NO customer assignment.
  const unassignedCustomerUser = await makeUser(
    UserRole.CUSTOMER_USER,
    TENANT_A,
    null,
    'custuser-none',
  );
  const tenantAdminB = await makeUser(UserRole.TENANT_ADMIN, TENANT_B, null, 'tadmin-b');
  const superAdmin = await makeUser(UserRole.SUPER_ADMIN, null, null, 'super');

  // Assets: one per customer of tenant A, one tenant-level, one in tenant B.
  const insertAsset = async (
    tenantId: string,
    customerId: string | null,
    label: string,
  ) => {
    const id = randomUUID();
    await q(
      'INSERT INTO assets (id, "tenantId", "customerId", name) VALUES ($1, $2, $3, $4)',
      [id, tenantId, customerId, `${PREFIX}-asset-${label}`],
    );
    return id;
  };
  const ASSET_A_C1 = await insertAsset(TENANT_A, CUST_A1, 'a-c1');
  const ASSET_A_C2 = await insertAsset(TENANT_A, CUST_A2, 'a-c2');
  const ASSET_A_NONE = await insertAsset(TENANT_A, null, 'a-none');
  const ASSET_B = await insertAsset(TENANT_B, CUST_B1, 'b');

  // Devices, so the per-device alarm reads have something real to resolve.
  const insertDevice = async (
    tenantId: string,
    customerId: string | null,
    owner: string,
    label: string,
  ) => {
    const id = randomUUID();
    await q(
      `INSERT INTO devices (id, name, "deviceKey", "tenantId", "customerId", "userId")
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [id, `${PREFIX}-device-${label}`, `${PREFIX}-key-${id.slice(0, 8)}`, tenantId, customerId, owner],
    );
    return id;
  };
  const DEV_A_C1 = await insertDevice(TENANT_A, CUST_A1, tenantAdminA.id, 'a-c1');
  const DEV_A_C2 = await insertDevice(TENANT_A, CUST_A2, tenantAdminA.id, 'a-c2');
  const DEV_B = await insertDevice(TENANT_B, CUST_B1, tenantAdminB.id, 'b');

  // Alarms. `rule` is NOT NULL.
  const insertAlarm = async (
    tenantId: string,
    customerId: string | null,
    deviceId: string | null,
    label: string,
  ) => {
    const id = randomUUID();
    await q(
      `INSERT INTO alarms (id, "tenantId", "customerId", "deviceId", name, rule, severity, status, "triggeredAt")
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, now())`,
      [
        id,
        tenantId,
        customerId,
        deviceId,
        `${PREFIX}-alarm-${label}`,
        JSON.stringify({ key: 'temperature', condition: 'gt', threshold: 1 }),
        AlarmSeverity.CRITICAL,
        AlarmStatus.ACTIVE,
      ],
    );
    return id;
  };
  const ALARM_A_C1 = await insertAlarm(TENANT_A, CUST_A1, DEV_A_C1, 'a-c1');
  const ALARM_A_C2 = await insertAlarm(TENANT_A, CUST_A2, DEV_A_C2, 'a-c2');
  const ALARM_A_NONE = await insertAlarm(TENANT_A, null, null, 'a-none');
  const ALARM_B = await insertAlarm(TENANT_B, CUST_B1, DEV_B, 'b');

  // Dashboards, including the two that made the leak visible: a PUBLIC one in
  // EACH tenant.
  const insertDashboard = async (
    tenantId: string,
    customerId: string | null,
    userId: string,
    visibility: DashboardVisibility,
    label: string,
  ) => {
    const id = randomUUID();
    await q(
      `INSERT INTO dashboards (id, "tenantId", "customerId", "userId", name, visibility)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [id, tenantId, customerId, userId, `${PREFIX}-dash-${label}`, visibility],
    );
    return id;
  };
  const DASH_A_C1 = await insertDashboard(
    TENANT_A, CUST_A1, tenantAdminA.id, DashboardVisibility.PRIVATE, 'a-c1',
  );
  const DASH_A_C2 = await insertDashboard(
    TENANT_A, CUST_A2, tenantAdminA.id, DashboardVisibility.PRIVATE, 'a-c2',
  );
  const DASH_A_PUBLIC = await insertDashboard(
    TENANT_A, null, tenantAdminA.id, DashboardVisibility.PUBLIC, 'a-public',
  );
  const DASH_A_PLAIN_OWN = await insertDashboard(
    TENANT_A, null, plainUserA.id, DashboardVisibility.PRIVATE, 'a-plain-own',
  );
  const DASH_B_PUBLIC = await insertDashboard(
    TENANT_B, null, tenantAdminB.id, DashboardVisibility.PUBLIC, 'b-public',
  );

  ok('fixtures built as a real graph (FKs satisfied)', true);

  // ── Services, with the collaborators the read paths do not use stubbed ──
  const eventEmitter = new EventEmitter2();
  const subscriptionsStub: any = {
    incrementTenantUsage: async () => undefined,
    decrementTenantUsage: async () => undefined,
  };
  const queueStub: any = { add: async () => undefined, removeJobs: async () => undefined };

  const assetsService = new AssetsService(
    assetRepo,
    deviceRepo,
    dataSource.getRepository(FloorPlan),
    dataSource.getRepository(FloorPlanDevice),
    dataSource.getRepository(AssetProfile),
    dataSource.getRepository(Telemetry),
    alarmRepo,
    eventEmitter,
    subscriptionsStub,
  );
  const dashboardsService = new DashboardsService(
    dashboardRepo,
    dataSource.getRepository(WidgetType),
    deviceRepo,
    {} as any, // WebsocketGateway — untouched by any read path
    subscriptionsStub,
  );
  const alarmsService = new AlarmsService(
    alarmRepo,
    deviceRepo,
    assetRepo,
    userRepo,
    eventEmitter,
    queueStub,
  );
  // Nothing here GENERATES a report, but `validateDefinition()` resolves the
  // window through the generator on every write, so that one method is stubbed.
  const generatorStub: any = {
    resolvePeriod: () => ({
      from: new Date(Date.now() - 3_600_000),
      to: new Date(),
    }),
  };
  const reportsService = new ReportsService(
    templateRepo,
    executionRepo,
    userRepo,
    generatorStub,
    dataSource,
  );

  // Report templates: one per customer, one TENANT-WIDE (customerId NULL,
  // which every customer of the tenant may run), one in tenant B.
  const definition = {
    entity: ReportEntityKind.DEVICE_INVENTORY,
    dateRange: { mode: ReportDateRangeMode.RELATIVE, lastHours: 24 },
  } as any;
  const tplA_C1 = await reportsService.create(TENANT_A, tenantAdminA.id, {
    name: `${PREFIX}-tpl-a-c1`,
    customerId: CUST_A1,
    definition,
  });
  const tplA_C2 = await reportsService.create(TENANT_A, tenantAdminA.id, {
    name: `${PREFIX}-tpl-a-c2`,
    customerId: CUST_A2,
    definition,
  });
  const tplA_WIDE = await reportsService.create(TENANT_A, tenantAdminA.id, {
    name: `${PREFIX}-tpl-a-tenantwide`,
    definition,
  });
  const tplB = await reportsService.create(TENANT_B, tenantAdminB.id, {
    name: `${PREFIX}-tpl-b`,
    definition,
  });
  ok(
    'a report template stores a customerId, and NULL means tenant-wide',
    tplA_C1.customerId === CUST_A1 && tplA_WIDE.customerId === null,
    { c1: tplA_C1.customerId, wide: tplA_WIDE.customerId },
  );
  ok(
    'a template cannot be assigned to another tenant’s customer',
    (await attempt(() =>
      reportsService.create(TENANT_A, tenantAdminA.id, {
        name: `${PREFIX}-tpl-a-foreign`,
        customerId: CUST_B1,
        definition,
      }),
    )) === 'other:BadRequestException:' + `Customer ${CUST_B1} is not a customer of this tenant`,
  );

  const execOf = async (template: ReportTemplate, label: string) => {
    const id = randomUUID();
    await q(
      `INSERT INTO report_executions
         (id, "tenantId", "reportTemplateId", "reportName", trigger, format, status)
       VALUES ($1, $2, $3, $4, 'MANUAL', 'CSV', 'SUCCESS')`,
      [id, template.tenantId, template.id, `${PREFIX}-exec-${label}`],
    );
    return id;
  };
  const EXEC_A_C1 = await execOf(tplA_C1, 'a-c1');
  const EXEC_A_C2 = await execOf(tplA_C2, 'a-c2');
  const EXEC_A_WIDE = await execOf(tplA_WIDE, 'a-wide');
  const EXEC_B = await execOf(tplB, 'b');

  // ═══════════════════════════════════════════════════════════════════════
  section('1. LEAK 1 — AssetsService.findOne read any asset by uuid');

  ok(
    'a CUSTOMER_USER of tenant A cannot read tenant B’s asset by uuid',
    (await attempt(() => assetsService.findOne(ASSET_B, customerUserA1))) === 'notfound',
    'this role had a customer predicate and NO tenant predicate',
  );
  ok(
    'a CUSTOMER (customer admin) cannot read tenant B’s asset by uuid',
    (await attempt(() => assetsService.findOne(ASSET_B, customerA1))) === 'notfound',
    'this role had NO predicate at all — `where(asset.id = :id)` and nothing else',
  );
  ok(
    'a plain USER cannot read tenant B’s asset by uuid',
    (await attempt(() => assetsService.findOne(ASSET_B, plainUserA))) === 'notfound',
    'the other role that had NO predicate at all',
  );
  ok(
    'a tenant admin of A cannot read tenant B’s asset by uuid',
    (await attempt(() => assetsService.findOne(ASSET_B, tenantAdminA))) === 'notfound',
  );
  ok(
    'a CUSTOMER_USER cannot read a SIBLING customer’s asset in its own tenant',
    (await attempt(() => assetsService.findOne(ASSET_A_C2, customerUserA1))) === 'notfound',
  );
  ok(
    'a CUSTOMER cannot read a sibling customer’s asset either',
    (await attempt(() => assetsService.findOne(ASSET_A_C2, customerA1))) === 'notfound',
  );
  ok(
    'a CUSTOMER_USER cannot read a tenant-level asset with no customer',
    (await attempt(() => assetsService.findOne(ASSET_A_NONE, customerUserA1))) === 'notfound',
  );
  ok(
    'out of scope answers 404, never 403 — a 403 confirms the uuid exists',
    (await attempt(() => assetsService.findOne(ASSET_B, customerA1))) !== 'forbidden',
  );
  // Denying everything would also pass a security check and break the product.
  ok(
    'the same customer user CAN read its own customer’s asset',
    (await attempt(() => assetsService.findOne(ASSET_A_C1, customerUserA1))) === 'found',
  );
  ok(
    'a tenant admin CAN read any asset of its own tenant',
    (await attempt(() => assetsService.findOne(ASSET_A_C2, tenantAdminA))) === 'found' &&
      (await attempt(() => assetsService.findOne(ASSET_A_NONE, tenantAdminA))) === 'found',
  );
  ok(
    'a SUPER_ADMIN reads across tenants, by design',
    (await attempt(() => assetsService.findOne(ASSET_B, superAdmin))) === 'found',
  );
  ok(
    'a customer-scoped caller with a FALSY customerId is denied, not widened',
    (await attempt(() => assetsService.findOne(ASSET_A_NONE, unassignedCustomerUser))) ===
      'notfound' &&
      (await attempt(() => assetsService.findOne(ASSET_A_C1, unassignedCustomerUser))) ===
        'notfound',
    'the predicate must become 1=0, not "tenant-wide"',
  );

  section('1b. The asset LIST and the other asset read paths');

  const assetNames = async (user: User) => {
    const page = await assetsService.findAll(user, user.customerId, {
      page: 1,
      limit: 50,
      skip: 0,
      take: 50,
    } as any);
    return page.data.map((a) => a.name);
  };

  ok(
    'a tenant admin lists exactly its own tenant’s three assets',
    sameSet(await assetNames(tenantAdminA), [
      `${PREFIX}-asset-a-c1`,
      `${PREFIX}-asset-a-c2`,
      `${PREFIX}-asset-a-none`,
    ]),
    await assetNames(tenantAdminA),
  );
  ok(
    'a customer user lists exactly its own customer’s asset',
    sameSet(await assetNames(customerUserA1), [`${PREFIX}-asset-a-c1`]),
    await assetNames(customerUserA1),
  );
  ok(
    'a CUSTOMER lists its own customer’s asset too',
    sameSet(await assetNames(customerA1), [`${PREFIX}-asset-a-c1`]),
    await assetNames(customerA1),
  );
  ok(
    'a customer user with no customer lists NOTHING',
    sameSet(await assetNames(unassignedCustomerUser), []),
    await assetNames(unassignedCustomerUser),
  );
  ok(
    'statistics are scoped the same way as the list',
    (await assetsService.getStatistics(customerUserA1)).total === 1 &&
      (await assetsService.getStatistics(tenantAdminA)).total === 3 &&
      (await assetsService.getStatistics(unassignedCustomerUser)).total === 0,
    {
      custUser: (await assetsService.getStatistics(customerUserA1)).total,
      tenantAdmin: (await assetsService.getStatistics(tenantAdminA)).total,
      unassigned: (await assetsService.getStatistics(unassignedCustomerUser)).total,
    },
  );
  ok(
    'getRootAssets is scoped — it used to give CUSTOMER and USER no predicate',
    (await assetsService.getRootAssets(customerUserA1)).length === 1 &&
      (await assetsService.getRootAssets(tenantAdminA)).length === 3 &&
      (await assetsService.getRootAssets(unassignedCustomerUser)).length === 0,
  );
  ok(
    'findByCustomer refuses another tenant’s customer instead of listing it',
    (await assetsService.findByCustomer(CUST_A1, tenantAdminB)).length === 0,
    'it used to be find({ where: { customerId } }) — no tenant predicate at all',
  );
  ok(
    'findByCustomer refuses a sibling customer for a CUSTOMER role',
    (await attempt(() => assetsService.findByCustomer(CUST_A2, customerA1))) === 'forbidden',
  );

  // ═══════════════════════════════════════════════════════════════════════
  section('2. LEAK 2 — every tenant’s PUBLIC dashboards were listed');

  const dashNames = async (user: User) => {
    const page = await dashboardsService.findAll(user, { page: 1, limit: 50 } as any);
    return page.data.map((d) => d.name);
  };

  const custUserDashboards = await dashNames(customerUserA1);
  ok(
    'a customer user does NOT see another tenant’s PUBLIC dashboard',
    !custUserDashboards.includes(`${PREFIX}-dash-b-public`),
    custUserDashboards,
  );
  ok(
    'it sees its own customer’s dashboard and its own tenant’s public one',
    custUserDashboards.includes(`${PREFIX}-dash-a-c1`) &&
      custUserDashboards.includes(`${PREFIX}-dash-a-public`),
    custUserDashboards,
  );
  ok(
    'it does NOT see a sibling customer’s dashboard',
    !custUserDashboards.includes(`${PREFIX}-dash-a-c2`),
    custUserDashboards,
  );

  const customerAdminDashboards = await dashNames(customerA1);
  ok(
    'a CUSTOMER (customer admin) now sees dashboards assigned to ITS customer',
    customerAdminDashboards.includes(`${PREFIX}-dash-a-c1`),
    'it used to fall through to `userId = me` and see none of them',
  );
  ok(
    'and still not a sibling customer’s, nor another tenant’s public one',
    !customerAdminDashboards.includes(`${PREFIX}-dash-a-c2`) &&
      !customerAdminDashboards.includes(`${PREFIX}-dash-b-public`),
    customerAdminDashboards,
  );
  ok(
    'a customer user with NO customer lists nothing',
    sameSet(await dashNames(unassignedCustomerUser), []),
    await dashNames(unassignedCustomerUser),
  );
  const plainDashboards = await dashNames(plainUserA);
  ok(
    'a plain tenant USER lists its own dashboards only, and nothing of tenant B',
    sameSet(plainDashboards, [`${PREFIX}-dash-a-plain-own`]),
    plainDashboards,
  );
  const adminDashboards = await dashNames(tenantAdminA);
  ok(
    'a tenant admin lists its whole tenant and nothing of tenant B',
    sameSet(adminDashboards, [
      `${PREFIX}-dash-a-c1`,
      `${PREFIX}-dash-a-c2`,
      `${PREFIX}-dash-a-public`,
      `${PREFIX}-dash-a-plain-own`,
    ]),
    adminDashboards,
  );
  ok(
    'the dashboard DETAIL read refuses another tenant’s public dashboard',
    (await attempt(() => dashboardsService.findOne(DASH_B_PUBLIC, customerUserA1))) ===
      'notfound',
  );
  ok(
    'and a sibling customer’s dashboard',
    (await attempt(() => dashboardsService.findOne(DASH_A_C2, customerUserA1))) ===
      'notfound',
  );
  ok(
    'while its own customer’s dashboard still opens',
    (await attempt(() => dashboardsService.findOne(DASH_A_C1, customerUserA1))) === 'found',
  );
  // getShared answered 500 for every caller before this round — `:id =
  // ANY(<varchar>)` against a `simple-array` column is SQLSTATE 42809 — so
  // this asserts both that it runs and that it is scoped.
  const sharedForCustomerUser = await dashboardsService.getShared(customerUserA1);
  ok(
    'getShared runs at all (it raised 42809 for every caller before)',
    Array.isArray(sharedForCustomerUser),
  );
  ok(
    'getShared no longer offers another tenant’s public dashboard',
    !sharedForCustomerUser.some((d) => d.name === `${PREFIX}-dash-b-public`) &&
      sharedForCustomerUser.some((d) => d.name === `${PREFIX}-dash-a-public`),
    sharedForCustomerUser.map((d) => d.name),
  );
  ok(
    'dashboard statistics are scoped too',
    (await dashboardsService.getStatistics(unassignedCustomerUser)).total === 0 &&
      (await dashboardsService.getStatistics(tenantAdminA)).total === 4,
    {
      unassigned: (await dashboardsService.getStatistics(unassignedCustomerUser)).total,
      admin: (await dashboardsService.getStatistics(tenantAdminA)).total,
    },
  );
  ok(
    'findByCustomer is tenant-scoped',
    (await dashboardsService.findByCustomer(CUST_A1, tenantAdminB)).length === 0,
  );

  // ═══════════════════════════════════════════════════════════════════════
  section('3. LEAK 3 — a customer user read a sibling customer’s alarm');

  ok(
    'a CUSTOMER_USER cannot read a sibling customer’s alarm by uuid',
    (await attempt(() => alarmsService.findOne(ALARM_A_C2, customerUserA1))) === 'notfound',
    'findOne was tenant-only: `alerts:read` reached every alarm in the tenant',
  );
  ok(
    'the answer is 404, not 403 — matching how telemetry answers',
    (await attempt(() => alarmsService.findOne(ALARM_A_C2, customerUserA1))) !== 'forbidden',
  );
  ok(
    'nor a tenant-level alarm with no customer',
    (await attempt(() => alarmsService.findOne(ALARM_A_NONE, customerUserA1))) === 'notfound',
  );
  ok(
    'nor another tenant’s alarm',
    (await attempt(() => alarmsService.findOne(ALARM_B, customerUserA1))) === 'notfound',
  );
  ok(
    'its own customer’s alarm still reads',
    (await attempt(() => alarmsService.findOne(ALARM_A_C1, customerUserA1))) === 'found',
  );
  ok(
    'a tenant admin reads any alarm of its tenant, and none of tenant B',
    (await attempt(() => alarmsService.findOne(ALARM_A_C2, tenantAdminA))) === 'found' &&
      (await attempt(() => alarmsService.findOne(ALARM_B, tenantAdminA))) === 'notfound',
  );

  const alarmNames = async (user: User) => {
    const page = await alarmsService.findAll(user, { page: 1, limit: 50 } as any);
    return page.data.map((a) => a.name);
  };

  ok(
    'the alarm LIST is customer-scoped',
    sameSet(await alarmNames(customerUserA1), [`${PREFIX}-alarm-a-c1`]),
    await alarmNames(customerUserA1),
  );
  ok(
    'A FALSY customerId DENIES rather than widening to the whole tenant',
    sameSet(await alarmNames(unassignedCustomerUser), []),
    'this is the exact `if (customerId)` bug: no customer meant no filter',
  );
  ok(
    'a tenant admin lists its tenant’s three alarms',
    sameSet(await alarmNames(tenantAdminA), [
      `${PREFIX}-alarm-a-c1`,
      `${PREFIX}-alarm-a-c2`,
      `${PREFIX}-alarm-a-none`,
    ]),
    await alarmNames(tenantAdminA),
  );
  ok(
    'getActive / getCritical are scoped the same way',
    (await alarmsService.getActive(customerUserA1)).length === 1 &&
      (await alarmsService.getActive(unassignedCustomerUser)).length === 0 &&
      (await alarmsService.getCritical(customerUserA1)).length === 1 &&
      (await alarmsService.getCritical(unassignedCustomerUser)).length === 0 &&
      (await alarmsService.getActive(tenantAdminA)).length === 3,
  );
  ok(
    'the alarm counts and statistics are scoped',
    (await alarmsService.getCounts(customerUserA1)).total === 1 &&
      (await alarmsService.getCounts(unassignedCustomerUser)).total === 0 &&
      (await alarmsService.getStatistics(customerUserA1)).total === 1 &&
      (await alarmsService.getStatistics(unassignedCustomerUser)).total === 0 &&
      (await alarmsService.getCounts(tenantAdminA)).total === 3,
  );
  ok(
    'per-device alarm reads cannot be used to name a sibling’s device',
    (await alarmsService.getDeviceAlarms(customerUserA1, DEV_A_C2)).length === 0 &&
      (await alarmsService.getDeviceAlarms(customerUserA1, DEV_B)).length === 0 &&
      (await alarmsService.getDeviceAlarms(customerUserA1, DEV_A_C1)).length === 1,
  );
  ok(
    'and neither can the device alarm HISTORY',
    (await alarmsService.getDeviceHistory(customerUserA1, DEV_A_C2, 30)).length === 0 &&
      (await alarmsService.getDeviceHistory(customerUserA1, DEV_A_C1, 30)).length === 1,
  );

  // ═══════════════════════════════════════════════════════════════════════
  section('4. LEAK 4 — reports had no customer dimension at all');

  const tplNames = async (user: User) => {
    const page = await reportsService.findAll(user, { page: 1, limit: 50 } as any);
    return page.data.map((t) => t.name);
  };

  ok(
    'a customer user sees its own templates AND the tenant-wide one',
    sameSet(await tplNames(customerUserA1), [
      `${PREFIX}-tpl-a-c1`,
      `${PREFIX}-tpl-a-tenantwide`,
    ]),
    await tplNames(customerUserA1),
  );
  ok(
    'it does NOT see a sibling customer’s template',
    !(await tplNames(customerUserA1)).includes(`${PREFIX}-tpl-a-c2`),
    await tplNames(customerUserA1),
  );
  ok(
    'a CUSTOMER role is scoped identically',
    sameSet(await tplNames(customerA1), [
      `${PREFIX}-tpl-a-c1`,
      `${PREFIX}-tpl-a-tenantwide`,
    ]),
    await tplNames(customerA1),
  );
  ok(
    'a customer user of the OTHER customer sees its own plus the tenant-wide one',
    sameSet(await tplNames(customerUserA2), [
      `${PREFIX}-tpl-a-c2`,
      `${PREFIX}-tpl-a-tenantwide`,
    ]),
    await tplNames(customerUserA2),
  );
  ok(
    'a tenant admin sees all three of its tenant’s templates, and none of tenant B’s',
    sameSet(await tplNames(tenantAdminA), [
      `${PREFIX}-tpl-a-c1`,
      `${PREFIX}-tpl-a-c2`,
      `${PREFIX}-tpl-a-tenantwide`,
    ]),
    await tplNames(tenantAdminA),
  );
  ok(
    'a falsy customerId denies, including the tenant-wide templates',
    sameSet(await tplNames(unassignedCustomerUser), []),
    await tplNames(unassignedCustomerUser),
  );
  ok(
    'the template DETAIL read refuses a sibling’s and another tenant’s',
    (await attempt(() => reportsService.findOne(customerUserA1, tplA_C2.id))) ===
      'notfound' &&
      (await attempt(() => reportsService.findOne(customerUserA1, tplB.id))) === 'notfound',
  );
  ok(
    'while its own and the tenant-wide one open',
    (await attempt(() => reportsService.findOne(customerUserA1, tplA_C1.id))) === 'found' &&
      (await attempt(() => reportsService.findOne(customerUserA1, tplA_WIDE.id))) === 'found',
  );
  ok(
    'an unassigned customer user cannot open even the tenant-wide template',
    (await attempt(() =>
      reportsService.findOne(unassignedCustomerUser, tplA_WIDE.id),
    )) === 'notfound',
  );

  const execNames = async (user: User) => {
    const page = await reportsService.findExecutions(user, {
      page: 1,
      limit: 50,
    } as any);
    return page.data.map((e) => e.reportName);
  };
  ok(
    'EXECUTIONS are scoped through their template',
    sameSet(await execNames(customerUserA1), [
      `${PREFIX}-exec-a-c1`,
      `${PREFIX}-exec-a-wide`,
    ]),
    await execNames(customerUserA1),
  );
  ok(
    'a sibling customer’s run is not in the list, and cannot be read by id',
    !(await execNames(customerUserA1)).includes(`${PREFIX}-exec-a-c2`) &&
      (await attempt(() => reportsService.findExecution(customerUserA1, EXEC_A_C2))) ===
        'notfound' &&
      (await attempt(() => reportsService.findExecution(customerUserA1, EXEC_B))) ===
        'notfound',
  );
  ok(
    'its own run still reads',
    (await attempt(() => reportsService.findExecution(customerUserA1, EXEC_A_C1))) ===
      'found',
  );
  ok(
    'report statistics count only what the caller may see',
    (await reportsService.getStatistics(customerUserA1)).templates === 2 &&
      (await reportsService.getStatistics(tenantAdminA)).templates === 3 &&
      (await reportsService.getStatistics(unassignedCustomerUser)).templates === 0,
    {
      custUser: (await reportsService.getStatistics(customerUserA1)).templates,
      admin: (await reportsService.getStatistics(tenantAdminA)).templates,
      unassigned: (await reportsService.getStatistics(unassignedCustomerUser)).templates,
    },
  );

  // ═══════════════════════════════════════════════════════════════════════
  section('5. The shared helper itself');

  const countAssets = async (user: any, options?: any) => {
    const qb = assetRepo.createQueryBuilder('asset');
    applyAccessScope(qb, 'asset', user, options);
    return qb.getCount();
  };

  ok(
    'a null principal matches nothing',
    (await countAssets(null)) === 0,
  );
  ok(
    'a principal with no role and no tenant matches nothing',
    (await countAssets({})) === 0,
  );
  ok(
    'a non-super-admin with no tenantId matches nothing',
    (await countAssets({ role: UserRole.TENANT_ADMIN, tenantId: null })) === 0,
    'the falsy-tenant case, which `if (user.tenantId)` left UNSCOPED',
  );
  ok(
    'a customer-scoped role with no customerId matches nothing',
    (await countAssets({
      role: UserRole.CUSTOMER_USER,
      tenantId: TENANT_A,
      customerId: null,
    })) === 0,
  );
  ok(
    'includeUnassigned adds the rows with NO customer — and nothing else',
    (await countAssets({
      role: UserRole.CUSTOMER_USER,
      tenantId: TENANT_A,
      customerId: CUST_A1,
    })) === 1 &&
      (await countAssets(
        { role: UserRole.CUSTOMER_USER, tenantId: TENANT_A, customerId: CUST_A1 },
        { includeUnassigned: true },
      )) === 2,
    'reports need it (a tenant-wide template); devices and assets must not',
  );
  ok(
    'includeUnassigned still denies a falsy customerId',
    (await countAssets(
      { role: UserRole.CUSTOMER_USER, tenantId: TENANT_A, customerId: null },
      { includeUnassigned: true },
    )) === 0,
  );
  ok(
    'the row-level form agrees with the predicate form',
    isWithinAccessScope({ tenantId: TENANT_A, customerId: CUST_A1 }, customerUserA1) &&
      !isWithinAccessScope({ tenantId: TENANT_A, customerId: CUST_A2 }, customerUserA1) &&
      !isWithinAccessScope({ tenantId: TENANT_B, customerId: null }, tenantAdminA) &&
      isWithinAccessScope({ tenantId: TENANT_B, customerId: null }, superAdmin) &&
      !isWithinAccessScope(
        { tenantId: TENANT_A, customerId: CUST_A1 },
        unassignedCustomerUser,
      ),
  );

  // ═══════════════════════════════════════════════════════════════════════
  section('6. The guards that computed a filter nobody read');

  const guard = new CustomerAccessGuard(new Reflector());
  const contextFor = (user: any, params: Record<string, string> = {}) => {
    const request: any = { user, params };
    return {
      request,
      context: {
        getHandler: () => ({}),
        getClass: () => ({}),
        switchToHttp: () => ({ getRequest: () => request }),
      } as unknown as ExecutionContext,
    };
  };

  const plainCtx = contextFor(plainUserA);
  let plainAllowed = false;
  let plainError: unknown = null;
  try {
    plainAllowed = guard.canActivate(plainCtx.context);
  } catch (error) {
    plainError = error;
  }
  ok(
    'a plain tenant USER is no longer refused the entire API',
    plainAllowed === true && plainError === null,
    plainError ?? 'it used to throw "Access denied: insufficient role"',
  );

  const adminCtx = contextFor(tenantAdminA);
  guard.canActivate(adminCtx.context);
  ok(
    'the guard writes NO request.customerFilter any more',
    adminCtx.request.customerFilter === undefined &&
      plainCtx.request.customerFilter === undefined,
    'it was read by exactly nothing, while reading like a scoping mechanism',
  );

  const custCtx = contextFor(customerUserA1, { customerId: CUST_A2 });
  let siblingRefused = false;
  try {
    guard.canActivate(custCtx.context);
  } catch {
    siblingRefused = true;
  }
  ok(
    'the check it does make is intact: a named sibling customer is refused',
    siblingRefused,
  );

  const ownCtx = contextFor(customerUserA1, { customerId: CUST_A1 });
  ok(
    'and its own customer in the URL is allowed',
    guard.canActivate(ownCtx.context) === true,
  );

  let unassignedRefused = false;
  try {
    guard.canActivate(contextFor(unassignedCustomerUser).context);
  } catch {
    unassignedRefused = true;
  }
  ok(
    'a customer-scoped caller with no customer is still refused outright',
    unassignedRefused,
  );

  await sweep();
  await dataSource.destroy();

  console.log(
    failures === 0
      ? `\n\u001b[32mPASS\u001b[0m — ${checks} checks: tenant and customer read scoping hold against a real database\n`
      : `\n\u001b[31mFAIL\u001b[0m — ${failures} of ${checks} checks failed\n`,
  );
  process.exit(failures === 0 ? 0 : 1);
})().catch((error) => {
  console.error('\n\u001b[31mFAIL\u001b[0m — the verifier itself crashed:', error);
  process.exit(1);
});
