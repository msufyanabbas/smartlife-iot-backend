/**
 * Verifies DURATION / REPEATING alarm specs and alarm propagation against a
 * real PostgreSQL database.
 *
 *   PGPASSWORD=123456 createdb -U postgres -h localhost alarmcheck
 *   npx ts-node -r tsconfig-paths/register \
 *     scripts/verify-profile-alarm-rules.ts alarmcheck
 *
 * Why this and not an HTTP e2e run: booting the application needs a reachable
 * Kafka broker (CLAUDE.md §11), so the services are wired by hand here.
 * Everything below the controller is the real thing — real TypeORM
 * repositories, real SQL, real recursive CTE, real EventEmitter2 listeners.
 *
 * What it proves, in order:
 *   1. The schema initialises with the new metadata shape.
 *   2. The asset ancestor walk finds room → floor → building, stays inside the
 *      tenant, and terminates on a deliberately created parent cycle.
 *   3. DURATION does NOT fire on the first matching sample; a sample that
 *      breaks the condition resets the window; the window is measured in the
 *      unit the spec declares.
 *   4. Duration progress survives a restart: the services and the DataSource
 *      are destroyed and rebuilt, and the rule fires on the next sample
 *      because the elapsed window was read back out of Postgres.
 *   5. A DURATION rule in SECONDS fires against the real wall clock.
 *   6. REPEATING fires on the Nth consecutive match and not the (N-1)th, and
 *      an interrupting sample sends the count back to zero.
 *   7. An alarm raised on a device reaches its asset, every ancestor asset and
 *      its tenant; a building-scoped query (the shape a building dashboard
 *      runs) sees it; GET /alarms/device/:id does not see the copies.
 *   8. The clearRule clears the device alarm and every propagated copy in the
 *      same pass.
 *   9. Acknowledging a propagated copy acknowledges the origin and its
 *      siblings, through the same event path AlarmsService drives.
 *  10. `predicate.value.dynamicValue` resolves from an attribute row instead
 *      of skipping the rule, and still skips when the attribute is absent.
 */
import { DataSource, Repository } from 'typeorm';
import { randomUUID } from 'crypto';
import { EventEmitter2 } from '@nestjs/event-emitter';
import * as entities from '../src/modules/index.entities';
import { Alarm } from '../src/modules/alarms/entities/alarm.entity';
import { Asset } from '../src/modules/assets/entities/asset.entity';
import { Attribute } from '../src/modules/attributes/entities/attribute.entity';
import { Device } from '../src/modules/devices/entities/device.entity';
import { DeviceProfile } from '../src/modules/profiles/entities/device-profile.entity';
import { ProfileAlarmService } from '../src/modules/profiles/profile-alarm.service';
import { AlarmPropagationService } from '../src/modules/profiles/alarm-propagation.service';
import {
  AlarmConditionSpecType,
  AlarmConditionTimeUnit,
  AlarmPredicateOperation,
  AlarmStatus,
} from '../src/common/enums/index.enum';
import type { DeviceProfileAlarmRule } from '../src/common/interfaces/index.interface';

const database = process.argv[2] ?? 'alarmcheck';

let failures = 0;
const check = (label: string, condition: boolean, detail?: unknown) => {
  if (condition) {
    console.log(`  ✓ ${label}`);
  } else {
    failures++;
    console.error(`  ✗ ${label}`, detail === undefined ? '' : detail);
  }
};
const section = (title: string) => console.log(`\n── ${title} ──────────────`);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const TENANT = randomUUID();
const OTHER_TENANT = randomUUID();
const USER = randomUUID();
const CUSTOMER = randomUUID();

const BUILDING = randomUUID();
const FLOOR = randomUUID();
const ROOM = randomUUID();
const FOREIGN_ASSET = randomUUID();

const PROFILE = randomUUID();
const DEVICE = randomUUID();

// ── Rules under test ────────────────────────────────────────────────────────

const RULE_DURATION_MINUTES: DeviceProfileAlarmRule = {
  id: 'rule-duration-10m',
  alarmType: 'Temperature high for 10 minutes',
  enabled: true,
  severity: 'critical',
  propagate: true,
  propagateToOwner: false,
  propagateToTenant: true,
  condition: {
    spec: {
      type: AlarmConditionSpecType.DURATION,
      unit: AlarmConditionTimeUnit.MINUTES,
      value: 10,
    },
    condition: [
      {
        key: 'temperature',
        type: 'TIME_SERIES',
        valueType: 'NUMERIC',
        predicate: {
          operation: AlarmPredicateOperation.GREATER,
          value: { defaultValue: 40 },
        },
      },
    ],
  },
  clearRule: {
    condition: [
      {
        key: 'temperature',
        type: 'TIME_SERIES',
        valueType: 'NUMERIC',
        predicate: {
          operation: AlarmPredicateOperation.LESS,
          value: { defaultValue: 30 },
        },
      },
    ],
  },
};

const RULE_DURATION_SECONDS: DeviceProfileAlarmRule = {
  id: 'rule-duration-2s',
  alarmType: 'Humidity high for 2 seconds',
  enabled: true,
  severity: 'warning',
  propagate: false,
  propagateToOwner: false,
  propagateToTenant: false,
  condition: {
    spec: {
      type: AlarmConditionSpecType.DURATION,
      unit: AlarmConditionTimeUnit.SECONDS,
      value: 2,
    },
    condition: [
      {
        key: 'humidity',
        type: 'TIME_SERIES',
        valueType: 'NUMERIC',
        predicate: {
          operation: AlarmPredicateOperation.GREATER,
          value: { defaultValue: 80 },
        },
      },
    ],
  },
};

const REPEAT_N = 3;

const RULE_REPEATING: DeviceProfileAlarmRule = {
  id: 'rule-repeating-3',
  alarmType: 'Door opened three times',
  enabled: true,
  severity: 'error',
  propagate: false,
  propagateToOwner: false,
  propagateToTenant: false,
  condition: {
    spec: { type: AlarmConditionSpecType.REPEATING, value: REPEAT_N },
    condition: [
      {
        key: 'door',
        type: 'TIME_SERIES',
        valueType: 'STRING',
        predicate: {
          operation: AlarmPredicateOperation.EQUAL,
          value: { defaultValue: 'open' },
        },
      },
    ],
  },
};

const RULE_DYNAMIC: DeviceProfileAlarmRule = {
  id: 'rule-dynamic-threshold',
  alarmType: 'Pressure over configured maximum',
  enabled: true,
  severity: 'warning',
  propagate: false,
  propagateToOwner: false,
  propagateToTenant: false,
  condition: {
    spec: { type: AlarmConditionSpecType.SIMPLE },
    condition: [
      {
        key: 'pressure',
        type: 'TIME_SERIES',
        valueType: 'NUMERIC',
        predicate: {
          operation: AlarmPredicateOperation.GREATER,
          value: {
            defaultValue: 0,
            dynamicValue: {
              sourceType: 'CURRENT_DEVICE',
              sourceAttribute: 'maxPressure',
            },
          },
        },
      },
    ],
  },
};

const ALL_RULES = [
  RULE_DURATION_MINUTES,
  RULE_DURATION_SECONDS,
  RULE_REPEATING,
  RULE_DYNAMIC,
];

// ── Wiring helpers ──────────────────────────────────────────────────────────

function makeDataSource() {
  return new DataSource({
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
}

/**
 * Build the two services the way ProfilesModule does. `@OnEvent` is a Nest DI
 * concern, so the three listeners are registered by hand against a real
 * EventEmitter2 — the handler bodies exercised are the production ones, and
 * this is the same emitter AlarmsService would publish on.
 */
function makeServices(dataSource: DataSource) {
  const emitter = new EventEmitter2();
  const alarmRepo = dataSource.getRepository(Alarm);
  const assetRepo = dataSource.getRepository(Asset);
  const deviceRepo = dataSource.getRepository(Device);
  const attributeRepo = dataSource.getRepository(Attribute);

  const propagation = new AlarmPropagationService(alarmRepo, assetRepo, emitter);
  const service = new ProfileAlarmService(
    deviceRepo,
    alarmRepo,
    attributeRepo,
    emitter,
    propagation,
  );

  emitter.on('alarm.cleared', (p) => void propagation.onAlarmCleared(p));
  emitter.on('alarm.acknowledged', (p) => void propagation.onAlarmAcknowledged(p));
  emitter.on('alarm.resolved', (p) => void propagation.onAlarmResolved(p));

  return { emitter, service, propagation, alarmRepo, assetRepo, attributeRepo };
}

/** The row a given profile rule owns on the device. */
async function originOf(
  alarmRepo: Repository<Alarm>,
  rule: DeviceProfileAlarmRule,
): Promise<Alarm | null> {
  return alarmRepo
    .createQueryBuilder('alarm')
    .where('alarm.deviceId = :deviceId', { deviceId: DEVICE })
    .andWhere("alarm.metadata->>'profileRuleId' = :ruleId", { ruleId: rule.id })
    .andWhere("alarm.metadata->>'source' = 'DEVICE_PROFILE'")
    .getOne();
}

function stateOf(alarm: Alarm | null) {
  return (alarm?.metadata?.conditionState ?? {}) as {
    specType?: string;
    firstMatchAt?: string | null;
    matchCount?: number;
    firedAt?: string | null;
    windowMs?: number;
    requiredCount?: number;
  };
}

(async () => {
  // ════════════════════════════════════════════════════════════════════════
  section('1. Schema');
  let dataSource = makeDataSource();
  await dataSource.initialize();
  check('DataSource initialises', dataSource.isInitialized);

  const q = (sql: string, params?: any[]) => dataSource.query(sql, params);

  // Clean slate for repeated runs. Children before parents.
  await q('DELETE FROM alarms WHERE "tenantId" = ANY($1)', [[TENANT, OTHER_TENANT]]);
  await q('DELETE FROM attributes WHERE "tenantId" = ANY($1)', [[TENANT, OTHER_TENANT]]);
  await q('DELETE FROM devices WHERE "tenantId" = ANY($1)', [[TENANT, OTHER_TENANT]]);
  await q('DELETE FROM assets WHERE "tenantId" = ANY($1)', [[TENANT, OTHER_TENANT]]);
  await q('DELETE FROM device_profiles WHERE "tenantId" = ANY($1)', [[TENANT, OTHER_TENANT]]);
  await q('DELETE FROM customers WHERE "tenantId" = ANY($1)', [[TENANT, OTHER_TENANT]]);
  await q('DELETE FROM users WHERE id = $1', [USER]);
  await q('DELETE FROM tenants WHERE id = ANY($1)', [[TENANT, OTHER_TENANT]]);

  // ════════════════════════════════════════════════════════════════════════
  section('2. Fixtures and the asset ancestor walk');

  // Real rows throughout: alarms.tenantId, alarms.assetId, devices.userId and
  // assets.parentAssetId all carry foreign keys, because the entities declare
  // @ManyToOne against them.
  for (const [i, id] of [TENANT, OTHER_TENANT].entries()) {
    await q('INSERT INTO tenants (id, name, email) VALUES ($1, $2, $3)', [
      id,
      `Alarm fixture tenant ${i} ${id.slice(0, 8)}`,
      `alarm-t${i}-${id.slice(0, 8)}@example.invalid`,
    ]);
  }
  await q(
    `INSERT INTO users (id, email, password, name, role, "tenantId")
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [
      USER,
      `alarm-fixture-${USER.slice(0, 8)}@example.invalid`,
      'not-a-real-hash',
      'Alarm fixture admin',
      'tenant_admin',
      TENANT,
    ],
  );
  await q(
    'INSERT INTO customers (id, name, email, "tenantId") VALUES ($1, $2, $3, $4)',
    [CUSTOMER, 'Fixture customer', `alarm-c-${CUSTOMER.slice(0, 8)}@example.invalid`, TENANT],
  );

  // building ← floor ← room, plus an asset in another tenant parented onto our
  // building, which the walk must refuse to climb into.
  const insertAsset = (id: string, name: string, parent: string | null, tenant = TENANT) =>
    q(
      `INSERT INTO assets (id, "tenantId", "customerId", name, type, "parentAssetId")
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [id, tenant, tenant === TENANT ? CUSTOMER : null, name, 'building', parent],
    );

  await insertAsset(BUILDING, 'HQ Building', null);
  await insertAsset(FLOOR, 'Floor 2', BUILDING);
  await insertAsset(ROOM, 'Server Room 203', FLOOR);
  await insertAsset(FOREIGN_ASSET, 'Another tenant parent', BUILDING, OTHER_TENANT);

  await q(
    `INSERT INTO device_profiles (id, "tenantId", name, "alarmRules")
     VALUES ($1, $2, $3, $4::jsonb)`,
    [PROFILE, TENANT, 'Fixture sensor profile', JSON.stringify(ALL_RULES)],
  );
  await q(
    `INSERT INTO devices (id, "tenantId", "customerId", "deviceKey", name, "userId",
                          "deviceProfileId", "assetId")
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [DEVICE, TENANT, CUSTOMER, `fixture-${DEVICE.slice(0, 8)}`, 'Room sensor', USER, PROFILE, ROOM],
  );

  let wiring = makeServices(dataSource);
  const deviceRow = await dataSource
    .getRepository(Device)
    .findOne({ where: { id: DEVICE }, relations: ['deviceProfile'] });

  // What POST /devices does: one dormant row per enabled rule.
  const materialised = await wiring.service.materialiseProfileAlarms(deviceRow!);
  check(
    `materialised one dormant row per rule (${materialised} of ${ALL_RULES.length})`,
    materialised === ALL_RULES.length,
  );

  const chain = await wiring.propagation.resolveTargets(deviceRow!, RULE_DURATION_MINUTES);
  const assetTargets = chain.filter((t) => t.scope === 'ASSET');

  check(
    `ancestor walk returns exactly 3 assets (got ${assetTargets.length})`,
    assetTargets.length === 3,
    assetTargets.map((t) => `${t.depth}:${t.label}`),
  );
  check(
    'walk is ordered room(0) → floor(1) → building(2)',
    assetTargets[0]?.assetId === ROOM &&
      assetTargets[0]?.depth === 0 &&
      assetTargets[1]?.assetId === FLOOR &&
      assetTargets[1]?.depth === 1 &&
      assetTargets[2]?.assetId === BUILDING &&
      assetTargets[2]?.depth === 2,
    assetTargets,
  );
  check(
    'another tenant\'s asset parented onto ours is not in the chain',
    !assetTargets.some((t) => t.assetId === FOREIGN_ASSET),
  );
  check(
    'propagateToTenant adds exactly one TENANT target',
    chain.filter((t) => t.scope === 'TENANT').length === 1,
    chain,
  );

  // propagateToOwner on its own resolves the owning customer…
  const ownerOnly = await wiring.propagation.resolveTargets(deviceRow!, {
    ...RULE_DURATION_MINUTES,
    propagate: false,
    propagateToTenant: false,
    propagateToOwner: true,
  });
  check(
    'propagateToOwner resolves exactly one CUSTOMER target',
    ownerOnly.length === 1 &&
      ownerOnly[0].scope === 'CUSTOMER' &&
      ownerOnly[0].scopeKey === CUSTOMER,
    ownerOnly,
  );

  // …and degrades to the tenant for a device nobody owns, rather than being
  // silently dropped.
  const unowned = { ...deviceRow!, customerId: undefined, assetId: undefined } as Device;
  const ownerlessTargets = await wiring.propagation.resolveTargets(unowned, {
    ...RULE_DURATION_MINUTES,
    propagate: false,
    propagateToTenant: false,
    propagateToOwner: true,
  });
  check(
    'propagateToOwner on an unowned device falls back to one TENANT target',
    ownerlessTargets.length === 1 && ownerlessTargets[0].scope === 'TENANT',
    ownerlessTargets,
  );

  // Cycle guard: make the building a child of the room.
  await q('UPDATE assets SET "parentAssetId" = $1 WHERE id = $2', [ROOM, BUILDING]);
  const cyclic = await wiring.propagation.resolveTargets(deviceRow!, RULE_DURATION_MINUTES);
  const cyclicAssets = cyclic.filter((t) => t.scope === 'ASSET');
  check(
    `a parentAssetId cycle terminates at 3 assets (got ${cyclicAssets.length})`,
    cyclicAssets.length === 3,
    cyclicAssets.map((t) => t.label),
  );
  check(
    'no asset appears twice in a cyclic chain',
    new Set(cyclicAssets.map((t) => t.assetId)).size === cyclicAssets.length,
  );
  await q('UPDATE assets SET "parentAssetId" = NULL WHERE id = $1', [BUILDING]);

  // ════════════════════════════════════════════════════════════════════════
  section('3. DURATION does not fire on the first sample');

  await wiring.service.evaluateProfileAlarmRules(DEVICE, {
    ts: Date.now(),
    values: { temperature: 55 },
  });

  let origin = await originOf(wiring.alarmRepo, RULE_DURATION_MINUTES);
  check('a row exists for the rule', !!origin);
  check(
    `first matching sample does NOT fire (status=${origin?.status})`,
    origin?.status !== AlarmStatus.ACTIVE,
  );
  check('triggerCount is still 0', origin?.triggerCount === 0, origin?.triggerCount);
  check(
    'firstMatchAt was recorded',
    typeof stateOf(origin).firstMatchAt === 'string',
    stateOf(origin),
  );
  check('matchCount is 1', stateOf(origin).matchCount === 1, stateOf(origin));
  check(
    `windowMs is 10 minutes (${stateOf(origin).windowMs})`,
    stateOf(origin).windowMs === 10 * 60 * 1000,
  );

  const firstWindowStart = stateOf(origin).firstMatchAt;

  // A second matching sample inside the window must not fire either.
  await wiring.service.evaluateProfileAlarmRules(DEVICE, { temperature: 60 });
  origin = await originOf(wiring.alarmRepo, RULE_DURATION_MINUTES);
  check(
    'a second sample inside the window still does not fire',
    origin?.status !== AlarmStatus.ACTIVE,
  );
  check('matchCount is 2', stateOf(origin).matchCount === 2, stateOf(origin));
  check(
    'firstMatchAt did not move',
    stateOf(origin).firstMatchAt === firstWindowStart,
  );

  section('3b. An interrupting sample resets the window');

  await wiring.service.evaluateProfileAlarmRules(DEVICE, { temperature: 35 });
  origin = await originOf(wiring.alarmRepo, RULE_DURATION_MINUTES);
  check(
    'firstMatchAt is cleared by a breaking sample',
    stateOf(origin).firstMatchAt === null,
    stateOf(origin),
  );
  check('matchCount is back to 0', stateOf(origin).matchCount === 0);
  check(
    'the breaking sample did not clear the (unraised) alarm',
    origin?.status === AlarmStatus.INACTIVE,
    origin?.status,
  );

  // Start a fresh window.
  await wiring.service.evaluateProfileAlarmRules(DEVICE, { temperature: 55 });
  origin = await originOf(wiring.alarmRepo, RULE_DURATION_MINUTES);
  const secondWindowStart = stateOf(origin).firstMatchAt;
  check(
    'a new window starts after the interruption',
    typeof secondWindowStart === 'string' && secondWindowStart !== firstWindowStart,
    { firstWindowStart, secondWindowStart },
  );
  check('and it still does not fire', origin?.status !== AlarmStatus.ACTIVE);

  // ════════════════════════════════════════════════════════════════════════
  section('4. Duration progress survives a restart');

  // Age the window by 11 minutes in the database — the same thing wall-clock
  // time would do while the process was down.
  const aged = new Date(Date.parse(secondWindowStart!) - 11 * 60 * 1000).toISOString();
  await q(
    `UPDATE alarms
        SET metadata = jsonb_set(metadata, '{conditionState,firstMatchAt}', to_jsonb($1::text))
      WHERE id = $2`,
    [aged, origin!.id],
  );

  // Hard restart: drop every service object and the connection pool with them.
  await dataSource.destroy();
  dataSource = makeDataSource();
  await dataSource.initialize();
  wiring = makeServices(dataSource);
  check('services rebuilt from scratch (no in-process state)', true);

  const afterRestart = await originOf(wiring.alarmRepo, RULE_DURATION_MINUTES);
  check(
    'progress was read back out of Postgres',
    stateOf(afterRestart).firstMatchAt === aged,
    stateOf(afterRestart),
  );

  await wiring.service.evaluateProfileAlarmRules(DEVICE, { temperature: 57 });
  origin = await originOf(wiring.alarmRepo, RULE_DURATION_MINUTES);
  const elapsed = Date.now() - Date.parse(aged);
  check(
    `window has elapsed (${elapsed}ms >= ${10 * 60 * 1000}ms)`,
    elapsed >= 10 * 60 * 1000,
  );
  check(
    `DURATION fires once the window has elapsed (status=${origin?.status})`,
    origin?.status === AlarmStatus.ACTIVE,
  );
  check('triggerCount is 1', origin?.triggerCount === 1, origin?.triggerCount);
  check('currentValue is the sample that fired', Number(origin?.currentValue) === 57);
  check('firedAt was recorded', typeof stateOf(origin).firedAt === 'string');

  // ════════════════════════════════════════════════════════════════════════
  section('5. DURATION in SECONDS against the real clock');

  await wiring.service.evaluateProfileAlarmRules(DEVICE, { humidity: 95 });
  let seconds = await originOf(wiring.alarmRepo, RULE_DURATION_SECONDS);
  check(
    'a 2s window does not fire on the first sample',
    seconds?.status !== AlarmStatus.ACTIVE,
  );
  check('windowMs is 2000', stateOf(seconds).windowMs === 2000, stateOf(seconds));

  const waitStart = Date.now();
  await sleep(2_100);

  await wiring.service.evaluateProfileAlarmRules(DEVICE, { humidity: 96 });
  seconds = await originOf(wiring.alarmRepo, RULE_DURATION_SECONDS);
  check(`waited ${Date.now() - waitStart}ms (> 2000ms)`, Date.now() - waitStart > 2000);
  check(
    `it fires after the real 2s elapsed (status=${seconds?.status})`,
    seconds?.status === AlarmStatus.ACTIVE,
  );

  // ════════════════════════════════════════════════════════════════════════
  section('6. REPEATING fires on the Nth match, not the (N-1)th');

  for (let i = 1; i < REPEAT_N; i++) {
    await wiring.service.evaluateProfileAlarmRules(DEVICE, { door: 'open' });
    const repeating = await originOf(wiring.alarmRepo, RULE_REPEATING);
    check(
      `match ${i} of ${REPEAT_N} does not fire (count=${stateOf(repeating).matchCount})`,
      repeating?.status !== AlarmStatus.ACTIVE && stateOf(repeating).matchCount === i,
      stateOf(repeating),
    );
  }

  await wiring.service.evaluateProfileAlarmRules(DEVICE, { door: 'open' });
  let repeating = await originOf(wiring.alarmRepo, RULE_REPEATING);
  check(
    `match ${REPEAT_N} of ${REPEAT_N} fires (status=${repeating?.status})`,
    repeating?.status === AlarmStatus.ACTIVE,
  );
  check(
    `matchCount is ${REPEAT_N}`,
    stateOf(repeating).matchCount === REPEAT_N,
    stateOf(repeating),
  );
  check(
    `requiredCount is recorded as ${REPEAT_N}`,
    stateOf(repeating).requiredCount === REPEAT_N,
  );

  // Interruption resets the counter even while the alarm stays raised (the
  // rule carries no clearRule, so nothing clears it).
  await wiring.service.evaluateProfileAlarmRules(DEVICE, { door: 'closed' });
  repeating = await originOf(wiring.alarmRepo, RULE_REPEATING);
  check(
    'a breaking sample resets matchCount to 0',
    stateOf(repeating).matchCount === 0,
    stateOf(repeating),
  );

  await wiring.service.evaluateProfileAlarmRules(DEVICE, { door: 'open' });
  repeating = await originOf(wiring.alarmRepo, RULE_REPEATING);
  check(
    'and one match after the reset is not enough to re-fire the count',
    stateOf(repeating).matchCount === 1,
    stateOf(repeating),
  );

  // ════════════════════════════════════════════════════════════════════════
  section('7. Propagation: device → asset chain → tenant');

  origin = await originOf(wiring.alarmRepo, RULE_DURATION_MINUTES);
  const mirrors = await wiring.propagation.findMirrors(origin!);

  check(
    `4 propagated copies written: 3 assets + 1 tenant (got ${mirrors.length})`,
    mirrors.length === 4,
    mirrors.map((m) => m.metadata?.propagation),
  );
  check(
    'every copy is ACTIVE',
    mirrors.length > 0 && mirrors.every((m) => m.status === AlarmStatus.ACTIVE),
    mirrors.map((m) => m.status),
  );
  check(
    'no copy carries a deviceId (so it cannot be re-evaluated)',
    mirrors.every((m) => !m.deviceId),
  );
  check(
    'the asset copies are on room, floor and building',
    [ROOM, FLOOR, BUILDING].every((id) => mirrors.some((m) => m.assetId === id)),
    mirrors.map((m) => m.assetId),
  );
  check(
    'the tenant copy carries neither asset nor customer',
    mirrors.filter((m) => !m.assetId && !m.customerId && !m.deviceId).length === 1,
  );

  // The query a building-level dashboard runs: tenant + asset, no new column,
  // no new index, no rewrite of AlarmsService.
  const buildingView = await wiring.alarmRepo.find({
    where: { tenantId: TENANT, assetId: BUILDING, status: AlarmStatus.ACTIVE },
  });
  check(
    `a building-scoped query sees 1 active alarm (got ${buildingView.length})`,
    buildingView.length === 1,
    buildingView.map((a) => a.name),
  );
  check(
    'and it is named after the device rule that raised it',
    buildingView[0]?.name === RULE_DURATION_MINUTES.alarmType,
    buildingView[0]?.name,
  );

  // GET /alarms/device/:id filters on deviceId, so the copies stay out of it.
  const deviceView = await wiring.alarmRepo.find({
    where: { tenantId: TENANT, deviceId: DEVICE },
  });
  check(
    `GET /alarms/device/:id still returns only the ${ALL_RULES.length} device rows ` +
      `(got ${deviceView.length})`,
    deviceView.length === ALL_RULES.length,
    deviceView.map((a) => a.name),
  );
  check(
    'and none of them is a propagated copy',
    deviceView.every((a) => !wiring.propagation.isMirror(a)),
  );

  // Re-raising must not duplicate the copies.
  await wiring.service.evaluateProfileAlarmRules(DEVICE, { temperature: 58 });
  const afterResample = await wiring.propagation.findMirrors(origin!);
  check(
    `re-sampling an already-raised alarm does not duplicate copies (${afterResample.length})`,
    afterResample.length === 4,
  );

  // ════════════════════════════════════════════════════════════════════════
  section('8. The clearRule clears every level together');

  await wiring.service.evaluateProfileAlarmRules(DEVICE, { temperature: 21 });
  // Give the emitter's async listeners a turn; the propagateClear() call on the
  // profile path is awaited, so this only covers the event-driven duplicate.
  await sleep(150);

  origin = await originOf(wiring.alarmRepo, RULE_DURATION_MINUTES);
  const clearedMirrors = await wiring.propagation.findMirrors(origin!);

  check(
    `the device alarm is cleared (status=${origin?.status})`,
    origin?.status === AlarmStatus.CLEARED,
  );
  check(
    `0 of ${clearedMirrors.length} copies are still active`,
    clearedMirrors.filter((m) => m.status !== AlarmStatus.CLEARED).length === 0,
    clearedMirrors.map((m) => `${m.metadata?.propagation?.label}=${m.status}`),
  );
  check(
    'the still-cleared copy count is unchanged (nothing was duplicated)',
    clearedMirrors.length === 4,
  );
  check(
    'a building-scoped active query is now empty',
    (
      await wiring.alarmRepo.find({
        where: { tenantId: TENANT, assetId: BUILDING, status: AlarmStatus.ACTIVE },
      })
    ).length === 0,
  );
  check(
    'progress was discarded with the clear',
    stateOf(origin).firstMatchAt === null && stateOf(origin).matchCount === 0,
    stateOf(origin),
  );

  // ════════════════════════════════════════════════════════════════════════
  section('9. Acknowledging a copy acknowledges the origin and its siblings');

  // Raise it again: a fresh window, aged in the database as before.
  await wiring.service.evaluateProfileAlarmRules(DEVICE, { temperature: 61 });
  origin = await originOf(wiring.alarmRepo, RULE_DURATION_MINUTES);
  await q(
    `UPDATE alarms
        SET metadata = jsonb_set(metadata, '{conditionState,firstMatchAt}', to_jsonb($1::text))
      WHERE id = $2`,
    [new Date(Date.now() - 11 * 60 * 1000).toISOString(), origin!.id],
  );
  await wiring.service.evaluateProfileAlarmRules(DEVICE, { temperature: 62 });
  origin = await originOf(wiring.alarmRepo, RULE_DURATION_MINUTES);
  check(`alarm re-raised (status=${origin?.status})`, origin?.status === AlarmStatus.ACTIVE);

  const buildingMirror = (await wiring.propagation.findMirrors(origin!)).find(
    (m) => m.assetId === BUILDING,
  );
  check('the building copy is active again', buildingMirror?.status === AlarmStatus.ACTIVE);

  // This is what AlarmsService.acknowledge() does, then emits.
  buildingMirror!.acknowledge(USER);
  const savedMirror = await wiring.alarmRepo.save(buildingMirror!);
  wiring.emitter.emit('alarm.acknowledged', { alarm: savedMirror, userId: USER });
  await sleep(300);

  origin = await originOf(wiring.alarmRepo, RULE_DURATION_MINUTES);
  const ackedMirrors = await wiring.propagation.findMirrors(origin!);

  check(
    `the origin is acknowledged (status=${origin?.status})`,
    !!origin?.acknowledgedAt && origin?.status === AlarmStatus.ACKNOWLEDGED,
  );
  check(
    `all ${ackedMirrors.length} copies are acknowledged`,
    ackedMirrors.length === 4 && ackedMirrors.every((m) => !!m.acknowledgedAt),
    ackedMirrors.map((m) => `${m.metadata?.propagation?.label}=${m.status}`),
  );

  // ════════════════════════════════════════════════════════════════════════
  section('10. dynamicValue thresholds');

  // No attribute yet → the rule is skipped rather than compared to the
  // literal 0, which would otherwise fire on every positive reading.
  await wiring.service.evaluateProfileAlarmRules(DEVICE, { pressure: 500 });
  let dynamic = await originOf(wiring.alarmRepo, RULE_DYNAMIC);
  check(
    'with the attribute absent the rule does not fire',
    !dynamic || dynamic.status !== AlarmStatus.ACTIVE,
    dynamic?.status,
  );

  await q(
    `INSERT INTO attributes (id, "tenantId", "entityType", "entityId", "attributeKey",
                             scope, "dataType", "numberValue", "lastUpdateTs", "userId")
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
    [
      randomUUID(),
      TENANT,
      'DEVICE',
      DEVICE,
      'maxPressure',
      'server',
      'number',
      1000,
      Date.now(),
      USER,
    ],
  );

  await wiring.service.evaluateProfileAlarmRules(DEVICE, { pressure: 900 });
  dynamic = await originOf(wiring.alarmRepo, RULE_DYNAMIC);
  check(
    '900 against a dynamic maximum of 1000 does not fire',
    dynamic?.status !== AlarmStatus.ACTIVE,
    dynamic?.status,
  );

  await wiring.service.evaluateProfileAlarmRules(DEVICE, { pressure: 1200 });
  dynamic = await originOf(wiring.alarmRepo, RULE_DYNAMIC);
  check(
    `1200 against a dynamic maximum of 1000 fires (status=${dynamic?.status})`,
    dynamic?.status === AlarmStatus.ACTIVE,
  );
  check(
    'the resolved threshold is stored on the flat rule, not the literal 0',
    Number(dynamic?.rule?.value) === 1000,
    dynamic?.rule,
  );

  // ════════════════════════════════════════════════════════════════════════
  console.log(
    failures === 0
      ? '\nAll checks passed.\n'
      : `\n${failures} check(s) FAILED.\n`,
  );

  await dataSource.destroy();
  process.exit(failures === 0 ? 0 : 1);
})().catch((err) => {
  console.error('\nVerification aborted:', err);
  process.exit(1);
});
