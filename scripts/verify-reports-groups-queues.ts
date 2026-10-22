/**
 * Verifies the reports, groups, queues and default-rule-chains modules against
 * a real PostgreSQL database.
 *
 *   createdb rgqcheck && npm run verify:reports-groups-queues rgqcheck
 *
 * Why this and not an HTTP e2e run: booting the application needs a reachable
 * Kafka broker (CLAUDE.md §11), so the services are wired by hand here.
 * Everything below the controller is the real thing — real TypeORM
 * repositories, real SQL, real transactions, real pdfkit, the real rule engine
 * over real nodes.
 *
 * What it proves, in order:
 *
 *  1. Schema — every new entity initialises. A nullable column whose property
 *     is a union takes the whole app down at `DataSource.initialize` if it has
 *     no explicit `type`; this catches that before a deploy does.
 *
 *  2. REPORTS — a generated CSV contains the right rows for a known fixture.
 *     The content is ASSERTED line by line against hand-computed expectations,
 *     not eyeballed: exact header, exact row count, exact values, correct
 *     ordering, and RFC 4180 quoting of a device name containing a comma.
 *     Also: PDF renders, a bad column is refused, and SCHEDULING ACTUALLY
 *     FIRES — the cron tick runs a due template and writes an execution row.
 *
 *  3. GROUPS — add/remove membership works, is idempotent, CROSS-TENANT IDS
 *     ARE REFUSED, "which groups is this entity in?" returns the right set,
 *     and the denormalised count tracks the join table.
 *
 *  4. QUEUES — the configuration is read by the real `RuleEngineConsumer`:
 *     a chain assigned to a queue with a 50 ms `packProcessingTimeout` and
 *     `RETRY_ALL`/`retries: 2` makes a deliberately slow node time out three
 *     times, and the queue's own counters record it.
 *
 *  5. DEFAULT RULE CHAINS — a message of a mapped type resolves to the mapped
 *     chain; an unmapped one still falls through to the pre-existing
 *     `RuleEngineService.execute()` fan-out; cross-tenant chain ids are
 *     refused; the cache is invalidated on write.
 */
import { DataSource, Repository } from 'typeorm';
import { randomUUID } from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as entities from '../src/modules/index.entities';

import { Device } from '../src/modules/devices/entities/device.entity';
import { Alarm } from '../src/modules/alarms/entities/alarm.entity';
import { User } from '../src/modules/users/entities/user.entity';
import { Customer } from '../src/modules/customers/entities/customers.entity';
import { Telemetry } from '../src/modules/telemetry/entities/telemetry.entity';
import { RuleChain } from '../src/modules/rules/entities/rule-chain.entity';
import { Node } from '../src/modules/nodes/entities/node.entity';
import { DeviceProfile } from '../src/modules/profiles/entities/device-profile.entity';

import { ReportTemplate } from '../src/modules/reports/entities/report-template.entity';
import { ReportExecution } from '../src/modules/reports/entities/report-execution.entity';
import { Group } from '../src/modules/groups/entities/group.entity';
import { GroupMember } from '../src/modules/groups/entities/group-member.entity';
import { Queue } from '../src/modules/queues/entities/queue.entity';
import { DefaultRuleChain } from '../src/modules/default-rule-chains/entities/default-rule-chain.entity';

import { ReportsService } from '../src/modules/reports/reports.service';
import { ReportGeneratorService } from '../src/modules/reports/report-generator.service';
import { ReportSchedulerService } from '../src/modules/reports/report-scheduler.service';
import {
  ReportDateRangeMode,
  ReportEntityKind,
  ReportExecutionStatus,
  ReportFormat,
  ReportTrigger,
} from '../src/modules/reports/report.enum';

import { GroupsService } from '../src/modules/groups/groups.service';
import { GroupEntityType } from '../src/modules/groups/group.enum';

import { QueuesService } from '../src/modules/queues/queues.service';
import { QueueExecutionService } from '../src/modules/queues/queue-execution.service';
import {
  QueueProcessingStrategy,
  QueueSubmitStrategy,
} from '../src/modules/queues/queue.enum';

import { DefaultRuleChainsService } from '../src/modules/default-rule-chains/default-rule-chains.service';
import { DefaultRuleChainResolverService } from '../src/modules/default-rule-chains/default-rule-chain-resolver.service';
import { DefaultRuleChainOriginatorType } from '../src/modules/default-rule-chains/default-rule-chain.enum';

import { TelemetryService } from '../src/modules/telemetry/telemetry.service';
import { RulesService } from '../src/modules/rules/rules.service';
import { RuleEngineService } from '../src/modules/rules/rule-engine.service';
import { RuleEngineConsumer } from '../src/modules/rules/rule-engine.consumer';
import { DistributedLockService } from '../src/lib/cluster/distributed-lock.service';
import { inMemoryRedis } from './support/in-memory-redis';

const database = process.argv[2] ?? 'rgqcheck';

let failures = 0;
const check = (label: string, condition: boolean, detail?: unknown) => {
  if (condition) {
    console.log(`  ✓ ${label}`);
  } else {
    failures++;
    console.error(`  ✗ ${label}`, detail === undefined ? '' : detail);
  }
};
const section = (title: string) =>
  console.log(`\n── ${title} ${'─'.repeat(Math.max(2, 58 - title.length))}`);

const TENANT_A = randomUUID();
const TENANT_B = randomUUID();
const USER_A = randomUUID();
const USER_B = randomUUID();

/**
 * Artefacts are written under UPLOAD_PATH. Point it at a scratch directory so
 * a verification run never touches the repository's uploads volume.
 */
const UPLOAD_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'rgqcheck-uploads-'));
process.env.UPLOAD_PATH = UPLOAD_ROOT;

/** A name with a comma AND a quote — the two things naive CSV joins destroy. */
const TRICKY_DEVICE_NAME = 'Lobby, "North"';

(async () => {
  const dataSource = new DataSource({
    type: 'postgres',
    host: process.env.DB_HOST ?? 'localhost',
    port: Number(process.env.DB_PORT ?? 5432),
    username: process.env.DB_USERNAME ?? 'postgres',
    password: process.env.DB_PASSWORD ?? '123456',
    database,
    // The four new modules' entities are passed explicitly: `index.entities.ts`
    // is owned by the coordinator and this branch does not edit it, so they are
    // not in the barrel yet. The INTEGRATION section of the report lists the
    // export lines to add.
    entities: [
      ...(Object.values(entities) as any[]),
      ReportTemplate,
      ReportExecution,
      Group,
      GroupMember,
      Queue,
      DefaultRuleChain,
    ],
    synchronize: true,
    logging: false,
  });

  section('1. Schema');
  await dataSource.initialize();
  check('DataSource initialises with all six new entities registered', true);

  const deviceRepo: Repository<Device> = dataSource.getRepository(Device);
  const alarmRepo: Repository<Alarm> = dataSource.getRepository(Alarm);
  const userRepo: Repository<User> = dataSource.getRepository(User);
  const customerRepo: Repository<Customer> = dataSource.getRepository(Customer);
  const telemetryRepo: Repository<Telemetry> = dataSource.getRepository(Telemetry);
  const chainRepo: Repository<RuleChain> = dataSource.getRepository(RuleChain);
  const nodeRepo: Repository<Node> = dataSource.getRepository(Node);
  const profileRepo: Repository<DeviceProfile> =
    dataSource.getRepository(DeviceProfile);
  const templateRepo: Repository<ReportTemplate> =
    dataSource.getRepository(ReportTemplate);
  const executionRepo: Repository<ReportExecution> =
    dataSource.getRepository(ReportExecution);
  const groupRepo: Repository<Group> = dataSource.getRepository(Group);
  const memberRepo: Repository<GroupMember> = dataSource.getRepository(GroupMember);
  const queueRepo: Repository<Queue> = dataSource.getRepository(Queue);
  const mappingRepo: Repository<DefaultRuleChain> =
    dataSource.getRepository(DefaultRuleChain);

  // ── Clean slate for repeated runs ────────────────────────────────────────
  for (const table of [
    'report_executions',
    'report_templates',
    'entity_group_members',
    'entity_groups',
    'default_rule_chains',
    'queues',
    'telemetry',
    'alarms',
    'nodes',
    'rule_chains',
    'devices',
    'device_profiles',
    'customers',
  ]) {
    await dataSource.query(`DELETE FROM "${table}"`);
  }
  await dataSource.query('DELETE FROM users WHERE id = ANY($1)', [
    [USER_A, USER_B],
  ]);
  await dataSource.query('DELETE FROM tenants WHERE id = ANY($1)', [
    [TENANT_A, TENANT_B],
  ]);

  // Real tenant and user rows: tenantId on most of these tables carries a real
  // FK, because the entity declares @ManyToOne against it. Fixtures with
  // invented uuids fail the insert.
  for (const [index, id] of [TENANT_A, TENANT_B].entries()) {
    await dataSource.query(
      `INSERT INTO tenants (id, name, email) VALUES ($1, $2, $3)`,
      [id, `RGQ tenant ${index + 1} ${id.slice(0, 8)}`, `rgq${index}-${id.slice(0, 8)}@example.invalid`],
    );
  }
  for (const [id, tenantId] of [
    [USER_A, TENANT_A],
    [USER_B, TENANT_B],
  ]) {
    await dataSource.query(
      `INSERT INTO users (id, email, password, name, role, "tenantId")
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [
        id,
        `rgq-${id.slice(0, 8)}@example.invalid`,
        'not-a-real-hash',
        `RGQ admin ${id.slice(0, 8)}`,
        'tenant_admin',
        tenantId,
      ],
    );
  }
  const userA = await userRepo.findOneByOrFail({ id: USER_A });
  const userB = await userRepo.findOneByOrFail({ id: USER_B });

  // ── Devices ─────────────────────────────────────────────────────────────
  const profileA = await profileRepo.save(
    profileRepo.create({
      tenantId: TENANT_A,
      name: 'RGQ sensor profile',
      type: 'temperature_sensor',
    }),
  );

  // Returns Promise<Device>, not Promise<Device[]>: spreading `extra` widens
  // the literal enough for TypeORM to pick its array overload, so the cast is
  // what keeps the fixture typed as a single row.
  const makeDevice = (
    tenantId: string,
    userId: string,
    name: string,
    extra: any = {},
  ): Promise<Device> =>
    deviceRepo.save(
      deviceRepo.create({
        tenantId,
        userId,
        name,
        deviceKey: `rgq-${randomUUID()}`,
        ...extra,
      } as Partial<Device>) as Device,
    );

  // Named so that an alphabetical sort is deterministic and known:
  //   "Alpha sensor" < "Lobby, \"North\"" < "Zulu sensor"
  const alpha = await makeDevice(TENANT_A, USER_A, 'Alpha sensor', {
    deviceProfileId: profileA.id,
  });
  const tricky = await makeDevice(TENANT_A, USER_A, TRICKY_DEVICE_NAME);
  const zulu = await makeDevice(TENANT_A, USER_A, 'Zulu sensor');
  const foreignDevice = await makeDevice(TENANT_B, USER_B, 'Tenant B sensor');

  // ── Telemetry: an exactly-known fixture ─────────────────────────────────
  // Three readings per device, one hour apart, inside the window; plus one
  // reading well outside it that MUST NOT appear in the report.
  const base = new Date('2026-03-01T00:00:00.000Z');
  const hour = 3_600_000;
  const fixture: Array<[Device, number, number]> = [
    [alpha, 0, 20.5],
    [alpha, 1, 21.5],
    [alpha, 2, 22.5],
    [tricky, 0, 30.5],
    [tricky, 1, 31.5],
    [tricky, 2, 32.5],
    [zulu, 0, 40.5],
    [zulu, 1, 41.5],
    [zulu, 2, 42.5],
  ];
  for (const [device, offset, temperature] of fixture) {
    await telemetryRepo.save(
      telemetryRepo.create({
        tenantId: device.tenantId,
        deviceId: device.id,
        deviceKey: device.deviceKey,
        timestamp: new Date(base.getTime() + offset * hour),
        data: { temperature, humidity: 40 + offset },
        temperature,
        humidity: 40 + offset,
      }),
    );
  }
  // Out of window by a year — the row that catches a missing date predicate.
  await telemetryRepo.save(
    telemetryRepo.create({
      tenantId: TENANT_A,
      deviceId: alpha.id,
      deviceKey: alpha.deviceKey,
      timestamp: new Date('2025-03-01T00:00:00.000Z'),
      data: { temperature: 999 },
      temperature: 999,
    }),
  );
  // Another tenant's reading for a device with the same shape — the row that
  // catches a missing tenant predicate.
  await telemetryRepo.save(
    telemetryRepo.create({
      tenantId: TENANT_B,
      deviceId: foreignDevice.id,
      deviceKey: foreignDevice.deviceKey,
      timestamp: new Date(base.getTime()),
      data: { temperature: -273 },
      temperature: -273,
    }),
  );

  // ══════════════════════════════════════════════════════════════════════════
  section('2. Reports');
  // ══════════════════════════════════════════════════════════════════════════

  // Stubs for the two services a telemetry read does not touch. TelemetryService
  // calls neither on its query path — the alarm, integration and automation
  // collaborators are only used by create()/createBatch().
  const noop: any = {
    evaluateProfileAlarmRules: async () => undefined,
    dispatchTelemetry: async () => undefined,
    evaluateTelemetryTriggers: async () => undefined,
  };
  const redisStub: any = {
    hmset: async () => undefined,
    expire: async () => undefined,
    hgetall: async () => ({}),
  };

  /**
   * TelemetryService now consults a rollup service on its read path and serves
   * pre-aggregated buckets for a wide enough window. `shouldUseRollups: false`
   * pins it to the RAW `telemetry` table, which is what makes the row-level
   * assertions below exact — the fixture is nine known readings, and a
   * rollup-derived answer would legitimately return bucket averages instead.
   *
   * Which path TelemetryService takes is its own decision and its own module's
   * to verify; what this script proves is that the report faithfully reports
   * whatever TelemetryService returns, and that the raw answer is right.
   */
  const rollupStub: any = {
    shouldUseRollups: () => false,
    pickGranularity: () => 'hour',
    readSeries: async () => [],
    readStatistics: async () => null,
    readAllKeys: async () => [],
    coverage: async () => ({}),
    settings: {},
  };

  /**
   * The latest-reading cache. It must be a real miss, not a `noop`: `read()`
   * is consulted on the `/latest` path and a stub returning `undefined` is
   * the honest "nothing cached", while `write()` has to be callable because
   * the create path calls it.
   */
  const latestCacheStub: any = {
    read: async () => null,
    write: async () => undefined,
    invalidate: async () => undefined,
  };

  // Positional construction, so this breaks loudly if TelemetryService gains a
  // dependency the query path DOES use. Everything after the two repositories
  // and Redis is only reached by create()/createBatch(), which a report never
  // calls.
  //
  // It DID break: `TelemetryLatestCacheService` was inserted as the fourth
  // parameter, which shifted every stub after it by one, so `rollupStub`
  // landed in the AutomationService slot and a `noop` landed in the rollup
  // slot — producing `this.rollupService.shouldUseRollups is not a function`
  // at run time.
  //
  // The `as any` on the class was why typecheck:scripts could not catch it:
  // casting the constructor away discards the arity check that found eleven
  // other instances of this exact drift. It is gone, and the stubs carry the
  // `any` instead — same convenience, without blinding the one check that
  // would have caught this.
  const telemetryService: any = new TelemetryService(
    telemetryRepo,
    deviceRepo,
    redisStub,
    latestCacheStub, // TelemetryLatestCacheService — a real miss, see above
    noop, // ProfileAlarmService
    noop, // IntegrationDispatchService
    noop, // AutomationService
    rollupStub, // TelemetryRollupService — pinned to the raw table, see above
    noop, // TelemetryRetentionService
  );

  // AnalyticsService and AuditService are constructed only for the sources
  // that use them; the CSV assertions below use the telemetry source, which
  // needs neither.
  const analyticsStub: any = {
    getDeviceAnalytics: async () => ({ devices: [], meta: { totalPages: 1 } }),
  };
  const auditStub: any = {
    findAll: async () => ({ data: [], meta: { totalPages: 1 } }),
  };

  const generator = new ReportGeneratorService(
    deviceRepo,
    alarmRepo,
    telemetryService,
    analyticsStub,
    auditStub,
  );
  const reportsService = new ReportsService(
    templateRepo,
    executionRepo,
    userRepo,
    generator,
    dataSource,
  );

  const rawTemplate = await reportsService.create(TENANT_A, USER_A, {
    name: 'March temperature export',
    definition: {
      entity: ReportEntityKind.DEVICE_TELEMETRY,
      dateRange: {
        mode: ReportDateRangeMode.ABSOLUTE,
        // Window deliberately ends inside hour 2 + a minute, so the three
        // in-window readings per device are included and nothing else.
        from: new Date(base.getTime() - 60_000).toISOString(),
        to: new Date(base.getTime() + 2 * hour + 60_000).toISOString(),
      },
      columns: ['deviceName', 'key', 'timestamp', 'value'],
      filters: { telemetryKeys: ['temperature'] },
    } as any,
    format: ReportFormat.CSV,
  });
  check('a report template saves', !!rawTemplate.id);

  const generated = await reportsService.generate(
    TENANT_A,
    rawTemplate.id,
    userA,
    {},
  );

  const csv = generated.content ?? '';
  const lines = csv.trim().split('\r\n');

  // ── The content assertions ──────────────────────────────────────────────
  check(
    'CSV header is exactly the requested columns, in order',
    lines[0] === '"Device","Telemetry key","Timestamp","Value"',
    lines[0],
  );
  check(
    '9 data rows — 3 devices × 3 in-window readings',
    lines.length === 10,
    { lines: lines.length, rowCount: generated.rowCount },
  );
  check(
    'the out-of-window reading (999) is absent',
    !csv.includes('999'),
  );
  check(
    'the other tenant’s reading (-273) is absent',
    !csv.includes('-273'),
  );
  check(
    'the other tenant’s device never appears',
    !csv.includes('Tenant B sensor'),
  );

  // Hand-computed expected body: rows are sorted chronologically across
  // devices, and within a timestamp by the order resolveDevices() returns
  // (name ASC: Alpha, Lobby, Zulu).
  const expectedBody = [
    [TRICKY_DEVICE_NAME, 0, 30.5],
    ['Alpha sensor', 0, 20.5],
    ['Zulu sensor', 0, 40.5],
    [TRICKY_DEVICE_NAME, 1, 31.5],
    ['Alpha sensor', 1, 21.5],
    ['Zulu sensor', 1, 41.5],
    [TRICKY_DEVICE_NAME, 2, 32.5],
    ['Alpha sensor', 2, 22.5],
    ['Zulu sensor', 2, 42.5],
  ] as Array<[string, number, number]>;

  // Timestamp ordering is the contract; the within-timestamp order is not, so
  // compare as a set per timestamp bucket rather than asserting an order the
  // implementation does not promise.
  const parsed = lines.slice(1).map((line) => {
    // Every field is quoted, so splitting on '","' after trimming the outer
    // quotes is exact for this fixture (no field contains '","'). Doubled
    // quotes are then collapsed back — which is also what makes this a real
    // round-trip test of the escaping rather than a check that some quotes
    // appear somewhere.
    const fields = line
      .slice(1, -1)
      .split('","')
      .map((field) => field.replace(/""/g, '"'));
    return { device: fields[0], key: fields[1], timestamp: fields[2], value: fields[3] };
  });

  check(
    'every row is the temperature key',
    parsed.every((r) => r.key === 'temperature'),
  );
  check(
    'timestamps are non-decreasing (chronological across devices)',
    parsed.every(
      (row, index) =>
        index === 0 ||
        new Date(row.timestamp).getTime() >=
          new Date(parsed[index - 1].timestamp).getTime(),
    ),
    parsed.map((r) => r.timestamp),
  );

  const actualTriples = new Set(
    parsed.map((r) => `${r.device}|${new Date(r.timestamp).toISOString()}|${r.value}`),
  );
  const expectedTriples = expectedBody.map(
    ([name, offset, value]) =>
      `${name}|${new Date(base.getTime() + offset * hour).toISOString()}|${value}`,
  );
  const missing = expectedTriples.filter((t) => !actualTriples.has(t));
  check(
    'all 9 expected (device, timestamp, value) rows are present and exact',
    missing.length === 0 && actualTriples.size === 9,
    { missing, actual: [...actualTriples] },
  );

  // The quoting assertion: the raw CSV must carry the comma and the doubled
  // quote inside one field, not spread across two columns.
  check(
    'a device name containing a comma and a quote survives RFC 4180 quoting',
    csv.includes('"Lobby, ""North"""'),
    parsed.map((r) => r.device).find((d) => d.includes('Lobby')),
  );

  // ── The stored artefact ─────────────────────────────────────────────────
  check('an execution row was written', !!generated.execution?.id);
  check(
    'the execution records the right row count and a byte size',
    generated.execution?.rowCount === 9 && (generated.execution?.byteSize ?? 0) > 0,
    { rowCount: generated.execution?.rowCount, byteSize: generated.execution?.byteSize },
  );
  // Takes the PRINCIPAL now, not a tenant id: a report template carries a
  // customerId, and only a role can say whether a missing customer means
  // "tenant-wide, by right" or "deny".
  const downloaded = await reportsService.readArtefact(
    userA,
    generated.execution!.id,
  );
  check(
    'the stored file on disk is byte-identical to the inline content',
    downloaded.content.toString('utf8') === csv,
  );
  check(
    'the download filename is derived from the template name',
    /^March_temperature_export_/.test(downloaded.fileName),
    downloaded.fileName,
  );

  // ── Cross-tenant read of an execution ───────────────────────────────────
  let executionCrossTenant = false;
  try {
    await reportsService.readArtefact(userB, generated.execution!.id);
  } catch {
    executionCrossTenant = true;
  }
  check('tenant B cannot download tenant A’s report', executionCrossTenant);

  // ── A foreign device id in the definition yields nothing, not their data ──
  const leakTemplate = await reportsService.create(TENANT_A, USER_A, {
    name: 'Cross-tenant attempt',
    definition: {
      entity: ReportEntityKind.DEVICE_TELEMETRY,
      dateRange: {
        mode: ReportDateRangeMode.ABSOLUTE,
        from: new Date(base.getTime() - hour).toISOString(),
        to: new Date(base.getTime() + hour).toISOString(),
      },
      filters: { deviceIds: [foreignDevice.id], telemetryKeys: ['temperature'] },
    } as any,
  });
  const leak = await reportsService.generate(TENANT_A, leakTemplate.id, userA, {});
  check(
    'a report naming another tenant’s device id returns zero rows',
    leak.rowCount === 0 && !(leak.content ?? '').includes('-273'),
    leak.rowCount,
  );

  // ── PDF ─────────────────────────────────────────────────────────────────
  const pdf = await reportsService.generate(TENANT_A, rawTemplate.id, userA, {
    format: ReportFormat.PDF,
  });
  const pdfBytes = await reportsService.readArtefact(
    userA,
    pdf.execution!.id,
  );
  check(
    'PDF renders through pdfkit and starts with %PDF',
    pdfBytes.content.subarray(0, 4).toString('latin1') === '%PDF' &&
      pdfBytes.content.byteLength > 1000,
    { bytes: pdfBytes.content.byteLength },
  );
  check(
    'PDF content is NOT inlined in the JSON response',
    pdf.content === null && !!pdf.contentOmittedReason,
    pdf.contentOmittedReason,
  );

  // ── Definition validation ───────────────────────────────────────────────
  let badColumn: any = null;
  try {
    await reportsService.create(TENANT_A, USER_A, {
      name: 'Bad column',
      definition: {
        entity: ReportEntityKind.DEVICE_INVENTORY,
        dateRange: { mode: ReportDateRangeMode.RELATIVE, lastHours: 24 },
        columns: ['name', 'notAColumn'],
      } as any,
    });
  } catch (error: any) {
    badColumn = error?.response ?? error?.message;
  }
  check(
    'a column the source cannot produce is refused with a per-problem errors array',
    Array.isArray(badColumn?.errors) &&
      badColumn.errors.some((e: string) => e.includes('notAColumn')),
    badColumn,
  );

  let badCron: any = null;
  try {
    await reportsService.create(TENANT_A, USER_A, {
      name: 'Bad cron',
      definition: {
        entity: ReportEntityKind.DEVICE_INVENTORY,
        dateRange: { mode: ReportDateRangeMode.RELATIVE, lastHours: 24 },
      } as any,
      schedule: { enabled: true, cron: 'not a cron', recipients: ['a@b.invalid'] } as any,
    });
  } catch (error: any) {
    badCron = error?.response ?? error?.message;
  }
  check(
    'an unparseable cron is refused at save time, not left silently never firing',
    Array.isArray(badCron?.errors) && badCron.errors.length > 0,
    badCron,
  );

  // ── Scheduling actually fires ───────────────────────────────────────────
  const scheduled = await reportsService.create(TENANT_A, USER_A, {
    name: 'Nightly inventory',
    definition: {
      entity: ReportEntityKind.DEVICE_INVENTORY,
      dateRange: { mode: ReportDateRangeMode.RELATIVE, lastHours: 24 * 365 },
      columns: ['name', 'deviceKey', 'status'],
    } as any,
    format: ReportFormat.CSV,
    schedule: {
      enabled: true,
      cron: '0 2 * * *',
      timezone: 'UTC',
      recipients: ['ops@example.invalid'],
    } as any,
  });
  check(
    'an enabled schedule computes a nextRunAt from its cron',
    !!scheduled.nextRunAt &&
      new Date(scheduled.nextRunAt).getTime() > Date.now(),
    scheduled.nextRunAt,
  );

  // SMTP is not configured in a verification run, so sendEmail() returns false
  // and logs; the delivery record must say so rather than claim a send.
  // The scheduler now decides attachment-vs-link BEFORE building the body, by
  // asking the mail service for its cap. A stub carrying only sendEmail threw
  // on `maxAttachmentBytes()` inside the delivery block, so no delivery record
  // was written at all and the assertion below read `null` — reported as
  // "delivery was glossed over" when delivery had never been reached.
  //
  // The cap mirrors MailService's own default (10 MB) rather than being
  // Infinity: a stub that accepts any size would never exercise the
  // over-cap branch, and that branch is the one that has to keep the email
  // text and the actual attachment in agreement.
  const mailStub: any = {
    sendEmail: async (_options: any) => false,
    maxAttachmentBytes: () => 10 * 1024 * 1024,
    attachmentBytes: (attachments: any[] = []) =>
      attachments.reduce(
        (sum, a) => sum + (a?.content?.byteLength ?? 0),
        0,
      ),
    canAttach: (attachments: any[] = []) =>
      attachments.reduce((sum, a) => sum + (a?.content?.byteLength ?? 0), 0) <=
      10 * 1024 * 1024,
  };
  // ── The scheduler tick is wrapped in @DistributedCron ────────────────────
  //
  // The decorator reads `DistributedLockService.instance`, a static holder
  // populated when ClusterModule constructs the service. This script never
  // registers ClusterModule, so the holder was null and the decorator skipped
  // the body outright — five assertions failed reporting that the scheduler
  // had not run the due template, when in fact it had never been called.
  //
  // Constructing the lock service populates the holder;
  // CLUSTER_LOCKS_ENABLED=false makes `withLock` run the work inline and
  // return its real result. What this script asserts is what the tick DOES.
  // Whether two replicas race for it is a different property, owned by
  // check:cluster-safety and verify:cluster-locks.
  process.env.CLUSTER_LOCKS_ENABLED = 'false';
  new DistributedLockService(inMemoryRedis());

  const scheduler = new ReportSchedulerService(
    templateRepo,
    executionRepo,
    reportsService,
    mailStub,
  );

  // Make it due, then run the real tick — not runOne() — so the due-time query
  // and the index behind it are exercised too.
  await templateRepo.update(
    { id: scheduled.id },
    { nextRunAt: new Date(Date.now() - 60_000) },
  );
  await scheduler.tick();

  const scheduledRuns = await executionRepo.find({
    where: { reportTemplateId: scheduled.id },
  });
  check(
    'the per-minute tick ran the due template and recorded an execution',
    scheduledRuns.length === 1 &&
      scheduledRuns[0].trigger === ReportTrigger.SCHEDULE &&
      scheduledRuns[0].status === ReportExecutionStatus.SUCCESS,
    scheduledRuns.map((r) => ({ trigger: r.trigger, status: r.status, rows: r.rowCount })),
  );
  check(
    'the scheduled run produced the 3 tenant-A devices',
    scheduledRuns[0]?.rowCount === 3,
    scheduledRuns[0]?.rowCount,
  );
  check(
    'delivery was attempted and the failure is recorded, not glossed over',
    scheduledRuns[0]?.delivery?.recipients.length === 1 &&
      scheduledRuns[0]?.delivery?.failed.length === 1 &&
      !!scheduledRuns[0]?.delivery?.note,
    scheduledRuns[0]?.delivery,
  );

  const rearmed = await templateRepo.findOneByOrFail({ id: scheduled.id });
  check(
    'the template was re-armed for its next run',
    !!rearmed.nextRunAt && new Date(rearmed.nextRunAt).getTime() > Date.now(),
    rearmed.nextRunAt,
  );
  check(
    'a second tick does not re-run it',
    (await (async () => {
      await scheduler.tick();
      return executionRepo.count({ where: { reportTemplateId: scheduled.id } });
    })()) === 1,
  );

  // ══════════════════════════════════════════════════════════════════════════
  section('3. Groups');
  // ══════════════════════════════════════════════════════════════════════════

  const groupsService = new GroupsService(
    groupRepo,
    memberRepo,
    customerRepo,
    dataSource,
  );

  const deviceGroup = await groupsService.create(TENANT_A, USER_A, {
    name: 'Floor 2 sensors',
    entityType: GroupEntityType.DEVICE,
    icon: 'thermometer',
    color: '#2563eb',
    entityIds: [alpha.id],
  });
  check(
    'a group is created with its initial members in one transaction',
    deviceGroup.memberCount === 1 &&
      (await memberRepo.count({ where: { groupId: deviceGroup.id } })) === 1,
    { memberCount: deviceGroup.memberCount },
  );

  // ── THE cross-tenant check ──────────────────────────────────────────────
  let crossTenantAdd: any = null;
  try {
    await groupsService.addMembers(TENANT_A, deviceGroup.id, USER_A, [
      zulu.id,
      foreignDevice.id,
    ]);
  } catch (error: any) {
    crossTenantAdd = error?.response ?? error?.message;
  }
  check(
    'adding another tenant’s device id is REFUSED, naming the offending id',
    Array.isArray(crossTenantAdd?.errors) &&
      crossTenantAdd.errors.some((e: string) => e.includes(foreignDevice.id)),
    crossTenantAdd,
  );
  check(
    'and nothing was written — the whole call failed, not half of it',
    (await memberRepo.count({ where: { groupId: deviceGroup.id } })) === 1,
  );

  let crossTenantCreate: any = null;
  try {
    await groupsService.create(TENANT_A, USER_A, {
      name: 'Seeded with a foreign id',
      entityType: GroupEntityType.DEVICE,
      entityIds: [foreignDevice.id],
    });
  } catch (error: any) {
    crossTenantCreate = error?.response ?? error?.message;
  }
  check(
    'seeding a NEW group with a foreign id is refused too',
    Array.isArray(crossTenantCreate?.errors),
    crossTenantCreate,
  );
  check(
    'and no orphan group row was left behind',
    (await groupRepo.count({ where: { tenantId: TENANT_A } })) === 1,
  );

  // ── Bulk add / idempotency / remove ─────────────────────────────────────
  const added = await groupsService.addMembers(TENANT_A, deviceGroup.id, USER_A, [
    alpha.id,
    tricky.id,
    zulu.id,
  ]);
  check(
    'bulk add is idempotent — alpha reported as already present',
    added.added === 2 && added.alreadyPresent === 1 && added.memberCount === 3,
    added,
  );

  const removed = await groupsService.removeMembers(
    TENANT_A,
    deviceGroup.id,
    USER_A,
    [zulu.id, foreignDevice.id],
  );
  check(
    'bulk remove drops the member and reports the one that was not present',
    removed.removed === 1 && removed.notPresent === 1 && removed.memberCount === 2,
    removed,
  );

  const afterRemove = await groupsService.findOne(TENANT_A, deviceGroup.id);
  check(
    'the denormalised count matches the live count from the join table',
    afterRemove.memberCount === 2 && afterRemove.countedMembers === 2,
    { memberCount: afterRemove.memberCount, countedMembers: afterRemove.countedMembers },
  );

  // ── "Which groups is this entity in?" ───────────────────────────────────
  const secondGroup = await groupsService.create(TENANT_A, USER_A, {
    name: 'Critical devices',
    entityType: GroupEntityType.DEVICE,
    entityIds: [alpha.id],
  });

  const forAlpha = await groupsService.groupsForEntity(
    TENANT_A,
    GroupEntityType.DEVICE,
    alpha.id,
  );
  check(
    'alpha is in exactly the two groups it was added to',
    forAlpha.groups.length === 2 &&
      new Set(forAlpha.groups.map((g) => g.id)).size === 2 &&
      forAlpha.groups.some((g) => g.id === deviceGroup.id) &&
      forAlpha.groups.some((g) => g.id === secondGroup.id),
    forAlpha.groups.map((g) => g.name),
  );

  const forZulu = await groupsService.groupsForEntity(
    TENANT_A,
    GroupEntityType.DEVICE,
    zulu.id,
  );
  check(
    'zulu, removed from its only group, is in none',
    forZulu.groups.length === 0,
    forZulu.groups,
  );

  const forForeign = await groupsService.groupsForEntity(
    TENANT_B,
    GroupEntityType.DEVICE,
    alpha.id,
  );
  check(
    'asking as tenant B about tenant A’s device returns nothing',
    forForeign.groups.length === 0,
  );

  // ── Member listing resolves names, and spots an orphan ──────────────────
  const page = await groupsService.listMembers(TENANT_A, deviceGroup.id, {
    page: 1,
    limit: 10,
  } as any);
  check(
    'members list resolves each entity’s current name',
    page.data.length === 2 &&
      page.data.some((m: any) => m.name === 'Alpha sensor') &&
      page.data.some((m: any) => m.name === TRICKY_DEVICE_NAME),
    page.data.map((m: any) => m.name),
  );
  check('member page meta uses totalItems', page.meta.totalItems === 2, page.meta);

  await deviceRepo.softRemove(tricky);
  const afterOrphan = await groupsService.listMembers(
    TENANT_A,
    deviceGroup.id,
    { page: 1, limit: 10 } as any,
  );
  check(
    'a deleted device’s membership is reported as missing, not silently dropped',
    afterOrphan.missingMembers === 1 && afterOrphan.data.length === 1,
    { missing: afterOrphan.missingMembers, listed: afterOrphan.data.length },
  );
  const pruned = await groupsService.pruneMissing(
    TENANT_A,
    deviceGroup.id,
    USER_A,
  );
  check(
    'pruning clears the orphan and resyncs the count',
    pruned.removed === 1 && pruned.memberCount === 1,
    pruned,
  );

  // ── Deleting a group clears its memberships ─────────────────────────────
  const deleted = await groupsService.remove(TENANT_A, secondGroup.id, USER_A);
  check(
    'deleting a group hard-deletes its membership rows',
    deleted.membershipsRemoved === 1 &&
      (await memberRepo.count({ where: { groupId: secondGroup.id } })) === 0,
    deleted,
  );
  const forAlphaAfter = await groupsService.groupsForEntity(
    TENANT_A,
    GroupEntityType.DEVICE,
    alpha.id,
  );
  check(
    'and the deleted group no longer shows up for its former member',
    forAlphaAfter.groups.length === 1 &&
      forAlphaAfter.groups[0].id === deviceGroup.id,
    forAlphaAfter.groups.map((g) => g.name),
  );

  // ══════════════════════════════════════════════════════════════════════════
  section('4. Queues — read by the real consumer');
  // ══════════════════════════════════════════════════════════════════════════

  const queueExecution = new QueueExecutionService(queueRepo);
  const queuesService = new QueuesService(queueRepo, chainRepo, queueExecution);

  const slowQueue = await queuesService.create(TENANT_A, USER_A, {
    name: 'Impatient',
    submitStrategy: QueueSubmitStrategy.SEQUENTIAL_BY_ORIGINATOR,
    processingStrategy: QueueProcessingStrategy.RETRY_ALL,
    packProcessingTimeout: 50,
    retries: 2,
    retryTimedOutBackoff: 1,
    retryFailedBackoff: 1,
  });
  check('a queue definition saves', !!slowQueue.id);

  // A chain whose single node sleeps far longer than the queue allows.
  const slowChain = await chainRepo.save(
    chainRepo.create({
      tenantId: TENANT_A,
      userId: USER_A,
      name: 'Deliberately slow chain',
      status: 'active' as any,
      enabled: true,
      configuration: { messageTypes: ['SLOW'] },
    }),
  );
  const slowNode = await nodeRepo.save(
    nodeRepo.create({
      tenantId: TENANT_A,
      userId: USER_A,
      ruleChainId: slowChain.id,
      name: 'Sleep 400ms',
      type: 'action' as any,
      enabled: true,
      configuration: {},
      connections: [],
    }),
  );
  slowChain.rootNodeId = slowNode.id;
  await chainRepo.save(slowChain);

  const assigned = await queuesService.assignRuleChain(
    TENANT_A,
    slowQueue.id,
    slowChain.id,
  );
  check(
    'assigning a chain writes configuration.queueName on the chain',
    assigned.queueName === 'Impatient' &&
      (await chainRepo.findOneByOrFail({ id: slowChain.id })).configuration
        ?.queueName === 'Impatient',
    assigned,
  );

  let crossTenantAssign = false;
  try {
    await queuesService.assignRuleChain(TENANT_B, slowQueue.id, slowChain.id);
  } catch {
    crossTenantAssign = true;
  }
  check('tenant B cannot assign a chain to tenant A’s queue', crossTenantAssign);

  let deleteBlocked: any = null;
  try {
    await queuesService.remove(TENANT_A, slowQueue.id);
  } catch (error: any) {
    deleteBlocked = error?.response ?? error?.message;
  }
  check(
    'deleting a queue a chain still names is refused, listing the chain',
    Array.isArray(deleteBlocked?.errors) &&
      deleteBlocked.errors.some((e: string) => e.includes(slowChain.id)),
    deleteBlocked,
  );

  // ── Wire the REAL consumer ──────────────────────────────────────────────
  const rulesService = new RulesService(chainRepo, nodeRepo, {
    canTenantPerformAction: async () => true,
    incrementTenantUsage: async () => undefined,
    decrementTenantUsage: async () => undefined,
  } as any, dataSource);

  let slowNodeRuns = 0;
  const slowProcessor = {
    process: async (input: any) => {
      slowNodeRuns += 1;
      await new Promise((resolve) => setTimeout(resolve, 400));
      return { success: true, route: 'success', output: input };
    },
  };
  let fastNodeRuns = 0;
  const fastProcessor = {
    process: async (input: any) => {
      fastNodeRuns += 1;
      return { success: true, route: 'success', output: input };
    },
  };
  // Keyed by the node currently executing is not available to a processor, so
  // the factory distinguishes by node type instead: the slow chain uses
  // `action`, every other fixture chain uses `filter`.
  const factoryStub: any = {
    getProcessor: (type: string) =>
      type === 'action' ? slowProcessor : fastProcessor,
  };
  const engine = new RuleEngineService(
    rulesService,
    factoryStub,
    nodeRepo,
    chainRepo,
  );
  const resolver = new DefaultRuleChainResolverService(
    mappingRepo,
    deviceRepo,
    chainRepo,
  );
  const mappingsService = new DefaultRuleChainsService(
    mappingRepo,
    chainRepo,
    profileRepo,
    resolver,
  );
  const kafkaStub: any = { createConsumer: async () => undefined };
  const consumer = new RuleEngineConsumer(
    kafkaStub,
    engine,
    rulesService,
    resolver,
    queueExecution,
  );

  // Route SLOW messages at the slow chain, so the consumer takes the
  // single-chain path and the queue's semantics apply.
  await mappingsService.create(TENANT_A, USER_A, {
    name: 'SLOW → slow chain',
    originatorType: DefaultRuleChainOriginatorType.DEVICE,
    messageType: 'SLOW',
    ruleChainId: slowChain.id,
  });

  const kafkaMessage = (payload: any) => ({
    message: { value: Buffer.from(JSON.stringify(payload)) },
  });

  slowNodeRuns = 0;
  const timedStart = Date.now();
  await consumer.handleMessage(
    kafkaMessage({
      tenantId: TENANT_A,
      entityId: alpha.id,
      entityType: 'DEVICE',
      eventType: 'SLOW',
      data: { temperature: 1 },
    }),
  );
  const timedElapsed = Date.now() - timedStart;

  check(
    'the consumer gave up on the 400ms node — it did not wait for it',
    timedElapsed < 350,
    `${timedElapsed}ms waited`,
  );
  check(
    'RETRY_ALL with retries: 2 produced 3 attempts, as the queue row says',
    slowNodeRuns === 3,
    slowNodeRuns,
  );

  await queueExecution.flushCounters();
  const slowAfter = await queueRepo.findOneByOrFail({ id: slowQueue.id });
  check(
    'the queue recorded one processed message and one timeout',
    Number(slowAfter.processedCount) === 1 &&
      Number(slowAfter.timedOutCount) === 1 &&
      !!slowAfter.lastUsedAt,
    {
      processed: slowAfter.processedCount,
      timedOut: slowAfter.timedOutCount,
      failed: slowAfter.failedCount,
    },
  );

  // Raise the timeout above the node's duration and the same message succeeds —
  // proving the number in the row is what decided the outcome, not chance.
  await queuesService.update(TENANT_A, slowQueue.id, USER_A, {
    packProcessingTimeout: 2000,
  });
  slowNodeRuns = 0;
  await consumer.handleMessage(
    kafkaMessage({
      tenantId: TENANT_A,
      entityId: alpha.id,
      entityType: 'DEVICE',
      eventType: 'SLOW',
      data: { temperature: 2 },
    }),
  );
  check(
    'raising packProcessingTimeout makes the same message succeed in one attempt',
    slowNodeRuns === 1,
    slowNodeRuns,
  );
  await queueExecution.flushCounters();
  const slowAfter2 = await queueRepo.findOneByOrFail({ id: slowQueue.id });
  check(
    'and the second message is counted as processed without a timeout',
    Number(slowAfter2.processedCount) === 2 &&
      Number(slowAfter2.timedOutCount) === 1,
    { processed: slowAfter2.processedCount, timedOut: slowAfter2.timedOutCount },
  );

  // SEQUENTIAL_BY_ORIGINATOR must serialise two concurrent messages for the
  // same originator.
  let concurrent = 0;
  let maxConcurrent = 0;
  const serialProbe = async () => {
    const run = queueExecution.run(TENANT_A, 'Impatient', alpha.id, async () => {
      concurrent += 1;
      maxConcurrent = Math.max(maxConcurrent, concurrent);
      await new Promise((resolve) => setTimeout(resolve, 30));
      concurrent -= 1;
      return 'ok';
    });
    return run;
  };
  await Promise.all([serialProbe(), serialProbe(), serialProbe()]);
  check(
    'SEQUENTIAL_BY_ORIGINATOR serialised three concurrent submissions',
    maxConcurrent === 1,
    `max concurrency observed: ${maxConcurrent}`,
  );

  const burstQueue = await queuesService.create(TENANT_A, USER_A, {
    name: 'Burst',
    submitStrategy: QueueSubmitStrategy.BURST,
    packProcessingTimeout: 2000,
  });
  concurrent = 0;
  maxConcurrent = 0;
  const burstProbe = () =>
    queueExecution.run(TENANT_A, 'Burst', alpha.id, async () => {
      concurrent += 1;
      maxConcurrent = Math.max(maxConcurrent, concurrent);
      await new Promise((resolve) => setTimeout(resolve, 30));
      concurrent -= 1;
      return 'ok';
    });
  await Promise.all([burstProbe(), burstProbe(), burstProbe()]);
  check(
    'BURST did NOT serialise them — the strategy is what makes the difference',
    maxConcurrent === 3,
    `max concurrency observed: ${maxConcurrent}`,
  );
  check('both queues exist for this tenant', !!burstQueue.id);

  // Three abandoned 400ms executions are still in flight from the timeout
  // test. They keep running — JavaScript cannot cancel a promise, which is
  // exactly what the queue's timeout semantics do and do not mean — and their
  // fire-and-forget node-stat writes would otherwise land after the DataSource
  // is destroyed. Let them drain.
  await new Promise((resolve) => setTimeout(resolve, 800));

  // A chain naming no queue runs unchanged.
  const unqueued = await queueExecution.run(
    TENANT_A,
    undefined,
    alpha.id,
    async () => 'ran',
  );
  check(
    'no queue named ⇒ no queue semantics applied, work still runs',
    unqueued.applied === false && unqueued.value === 'ran',
    unqueued,
  );
  const ghost = await queueExecution.run(
    TENANT_A,
    'DoesNotExist',
    alpha.id,
    async () => 'ran',
  );
  check(
    'an unresolvable queue name degrades to no semantics rather than dropping the message',
    ghost.applied === false && ghost.value === 'ran',
    ghost,
  );

  // ══════════════════════════════════════════════════════════════════════════
  section('5. Default rule chains — resolution on the engine path');
  // ══════════════════════════════════════════════════════════════════════════

  // Two more chains, both ACTIVE and both accepting TELEMETRY, so the
  // pre-existing fan-out is observable.
  const mappedChain = await chainRepo.save(
    chainRepo.create({
      tenantId: TENANT_A,
      userId: USER_A,
      name: 'Mapped telemetry chain',
      status: 'active' as any,
      enabled: true,
      configuration: { messageTypes: ['TELEMETRY'] },
    }),
  );
  const mappedNode = await nodeRepo.save(
    nodeRepo.create({
      tenantId: TENANT_A,
      userId: USER_A,
      ruleChainId: mappedChain.id,
      name: 'Mapped node',
      type: 'filter' as any,
      enabled: true,
      configuration: {},
      connections: [],
    }),
  );
  mappedChain.rootNodeId = mappedNode.id;
  await chainRepo.save(mappedChain);

  const rootChain = await chainRepo.save(
    chainRepo.create({
      tenantId: TENANT_A,
      userId: USER_A,
      name: 'Root telemetry chain',
      status: 'active' as any,
      enabled: true,
      isRoot: true,
      configuration: { messageTypes: ['TELEMETRY'] },
    }),
  );
  const rootNode = await nodeRepo.save(
    nodeRepo.create({
      tenantId: TENANT_A,
      userId: USER_A,
      ruleChainId: rootChain.id,
      name: 'Root node',
      type: 'filter' as any,
      enabled: true,
      configuration: {},
      connections: [],
    }),
  );
  rootChain.rootNodeId = rootNode.id;
  await chainRepo.save(rootChain);

  // ── Cross-tenant target refused ─────────────────────────────────────────
  let crossTenantMapping: any = null;
  try {
    await mappingsService.create(TENANT_B, USER_B, {
      name: 'Steal tenant A’s chain',
      originatorType: DefaultRuleChainOriginatorType.DEVICE,
      messageType: 'TELEMETRY',
      ruleChainId: mappedChain.id,
    });
  } catch (error: any) {
    crossTenantMapping = error?.response ?? error?.message;
  }
  check(
    'a mapping cannot point at another tenant’s rule chain',
    Array.isArray(crossTenantMapping?.errors) &&
      crossTenantMapping.errors.some((e: string) => e.includes(mappedChain.id)),
    crossTenantMapping,
  );

  // ── Before any TELEMETRY mapping: the fan-out, unchanged ────────────────
  const beforeMapping = await resolver.resolve(TENANT_A, {
    messageType: 'TELEMETRY',
    originatorType: 'DEVICE',
    originatorId: alpha.id,
  });
  check(
    'with no TELEMETRY mapping, resolve() returns null — it does not invent a root fallback',
    beforeMapping === null,
    beforeMapping,
  );

  fastNodeRuns = 0;
  await consumer.handleMessage(
    kafkaMessage({
      tenantId: TENANT_A,
      entityId: alpha.id,
      entityType: 'DEVICE',
      eventType: 'TELEMETRY',
      data: { temperature: 21 },
    }),
  );
  check(
    'an unmapped message still fans out to BOTH active TELEMETRY chains (pre-existing behaviour, preserved)',
    fastNodeRuns === 2,
    `${fastNodeRuns} node executions`,
  );

  // ── Add the mapping; the same message now goes to one chain ─────────────
  const telemetryMapping = await mappingsService.create(TENANT_A, USER_A, {
    name: 'TELEMETRY → mapped chain',
    originatorType: DefaultRuleChainOriginatorType.DEVICE,
    messageType: 'TELEMETRY',
    ruleChainId: mappedChain.id,
  });

  const afterMapping = await resolver.resolve(TENANT_A, {
    messageType: 'TELEMETRY',
    originatorType: 'DEVICE',
    originatorId: alpha.id,
  });
  check(
    'the write invalidated the cache — resolve() sees the new mapping immediately',
    afterMapping?.ruleChainId === mappedChain.id &&
      afterMapping?.matchedBy === 'messageType',
    afterMapping,
  );

  fastNodeRuns = 0;
  await consumer.handleMessage(
    kafkaMessage({
      tenantId: TENANT_A,
      entityId: alpha.id,
      entityType: 'DEVICE',
      eventType: 'TELEMETRY',
      data: { temperature: 21 },
    }),
  );
  check(
    'a mapped message runs exactly ONE chain — the mapped one, not the fan-out',
    fastNodeRuns === 1,
    `${fastNodeRuns} node executions`,
  );
  // `executeChain` saves the chain's counters fire-and-forget (it is on the
  // telemetry hot path), so give those writes a moment to land before reading
  // them back.
  await new Promise((resolve) => setTimeout(resolve, 300));
  const mappedAfter = await chainRepo.findOneByOrFail({ id: mappedChain.id });
  const rootAfter = await chainRepo.findOneByOrFail({ id: rootChain.id });
  check(
    'and it was the MAPPED chain that executed, not the root chain',
    mappedAfter.executionCount === 2 && rootAfter.executionCount === 1,
    {
      mapped: mappedAfter.executionCount,
      root: rootAfter.executionCount,
      note: 'both got 1 from the fan-out; only the mapped one got the second message',
    },
  );

  // ── An unmapped message type still falls back ───────────────────────────
  fastNodeRuns = 0;
  await consumer.handleMessage(
    kafkaMessage({
      tenantId: TENANT_A,
      entityId: alpha.id,
      entityType: 'DEVICE',
      eventType: 'ATTRIBUTES',
      data: {},
    }),
  );
  check(
    'an unmapped message type falls back exactly as before — no chain accepts ATTRIBUTES, so nothing runs',
    fastNodeRuns === 0,
    `${fastNodeRuns} node executions`,
  );

  // ── Specificity: a device-profile rule beats a message-type rule ────────
  const profileChain = await chainRepo.save(
    chainRepo.create({
      tenantId: TENANT_A,
      userId: USER_A,
      name: 'Profile-specific chain',
      status: 'active' as any,
      enabled: true,
      configuration: { messageTypes: ['TELEMETRY'] },
    }),
  );
  await mappingsService.create(TENANT_A, USER_A, {
    name: 'Sensor profile TELEMETRY → profile chain',
    originatorType: DefaultRuleChainOriginatorType.DEVICE,
    messageType: 'TELEMETRY',
    deviceProfileId: profileA.id,
    ruleChainId: profileChain.id,
  });

  const forProfiled = await resolver.resolve(TENANT_A, {
    messageType: 'TELEMETRY',
    originatorType: 'DEVICE',
    originatorId: alpha.id,
  });
  check(
    'a device carrying the profile resolves to the profile rule (more specific wins)',
    forProfiled?.ruleChainId === profileChain.id &&
      forProfiled?.matchedBy === 'deviceProfile',
    forProfiled,
  );

  const forUnprofiled = await resolver.resolve(TENANT_A, {
    messageType: 'TELEMETRY',
    originatorType: 'DEVICE',
    originatorId: zulu.id,
  });
  check(
    'a device with no profile falls to the message-type rule',
    forUnprofiled?.ruleChainId === mappedChain.id &&
      forUnprofiled?.matchedBy === 'messageType',
    forUnprofiled,
  );

  // ── Duplicate key refused ───────────────────────────────────────────────
  let duplicate = '';
  try {
    await mappingsService.create(TENANT_A, USER_A, {
      name: 'Duplicate TELEMETRY rule',
      originatorType: DefaultRuleChainOriginatorType.DEVICE,
      messageType: 'TELEMETRY',
      ruleChainId: rootChain.id,
    });
  } catch (error: any) {
    duplicate = String(error?.status);
  }
  check('a second mapping with the same key is a 409', duplicate === '409', duplicate);

  // ── The /type/:type shortcut the shipped client uses ────────────────────
  const setDefault = await mappingsService.setForOriginatorType(
    TENANT_A,
    USER_A,
    'DEVICE',
    { ruleChainId: rootChain.id },
  );
  check(
    'POST /default-rule-chains/type/DEVICE creates the catch-all mapping',
    setDefault.messageType === null && setDefault.ruleChainId === rootChain.id,
    { messageType: setDefault.messageType, ruleChainId: setDefault.ruleChainId },
  );
  const byType = await mappingsService.findByOriginatorType(TENANT_A, 'DEVICE');
  check('and GET type/DEVICE reads it back', byType.id === setDefault.id);

  const stillMessageType = await resolver.resolve(TENANT_A, {
    messageType: 'TELEMETRY',
    originatorType: 'DEVICE',
    originatorId: zulu.id,
  });
  check(
    'the catch-all does not shadow the narrower TELEMETRY rule',
    stillMessageType?.ruleChainId === mappedChain.id,
    stillMessageType,
  );
  const catchAllUsed = await resolver.resolve(TENANT_A, {
    messageType: 'SOMETHING_ELSE',
    originatorType: 'DEVICE',
    originatorId: zulu.id,
  });
  check(
    'but an otherwise unmatched message type now hits the catch-all',
    catchAllUsed?.ruleChainId === rootChain.id &&
      catchAllUsed?.matchedBy === 'originatorType',
    catchAllUsed,
  );

  // ── Deleting the mapping restores the fallback ──────────────────────────
  await mappingsService.remove(TENANT_A, telemetryMapping.id);
  const afterDelete = await resolver.resolve(TENANT_A, {
    messageType: 'TELEMETRY',
    originatorType: 'DEVICE',
    originatorId: zulu.id,
  });
  check(
    'deleting the message-type mapping falls through to the catch-all, immediately',
    afterDelete?.ruleChainId === rootChain.id,
    afterDelete,
  );

  // ── Match counters ──────────────────────────────────────────────────────
  await resolver.flushCounters();
  const countedMapping = await mappingRepo.findOne({
    where: { id: setDefault.id },
  });
  check(
    'match counters are flushed to the row',
    Number(countedMapping?.matchCount ?? 0) >= 1 && !!countedMapping?.lastMatchedAt,
    {
      matchCount: countedMapping?.matchCount,
      lastMatchedAt: countedMapping?.lastMatchedAt,
    },
  );

  // ── The diagnostic route tells the truth about the fallback ─────────────
  await mappingRepo.delete({ tenantId: TENANT_A });
  resolver.invalidate(TENANT_A);
  const diagnostic = await resolver.resolveWithRootFallback(TENANT_A, {
    messageType: 'TELEMETRY',
    originatorType: 'DEVICE',
    originatorId: alpha.id,
  });
  check(
    'GET /resolve reports the root chain but says the consumer fans out instead',
    diagnostic.matchedBy === 'rootFallback' &&
      diagnostic.ruleChainId === rootChain.id &&
      diagnostic.appliedByConsumer === false &&
      diagnostic.fanOut === true,
    diagnostic,
  );

  await queueExecution.onModuleDestroy();
  await resolver.onModuleDestroy();
  await dataSource.destroy();
  fs.rmSync(UPLOAD_ROOT, { recursive: true, force: true });

  console.log(
    failures
      ? `\nFAIL — ${failures} check(s) failed`
      : '\nPASS — report CSV content, scheduling, group membership and tenancy, ' +
          'queue semantics read by the consumer, and default-rule-chain resolution ' +
          'with an unchanged fallback',
  );
  process.exit(failures ? 1 : 0);
})().catch((error) => {
  console.error('\nFAILED:', error?.message);
  console.error(error?.stack);
  process.exit(1);
});
