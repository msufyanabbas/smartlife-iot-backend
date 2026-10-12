/**
 * Verifies the SNMP poller against a real PostgreSQL database and two real
 * in-process SNMP agents.
 *
 *   createdb transportcheck
 *   npx ts-node --transpile-only -r tsconfig-paths/register \
 *     scripts/verify-snmp-poller.ts transportcheck
 *
 * Why this and not booting the app: an unreachable Kafka broker stops the app
 * at startup (CLAUDE.md §11), so services are wired by hand. Everything below
 * the Kafka publish is the real thing — real TypeORM repositories, the real
 * DeviceListenerService, the real CodecRegistryService and two real net-snmp
 * agents answering real UDP GET requests. Only KafkaService is a stub, and it
 * records what would have been published so the assertions can read it.
 *
 * What it proves, in order:
 *   1. The poller finds its targets: devices on a profile with
 *      transportType=SNMP, merging profile config with per-device overrides,
 *      and skips (rather than silently polls garbage) a device with no agent
 *      address and a profile with no oidMappings.
 *   2. A poll of a live agent produces the EXPECTED telemetry values, and they
 *      arrive through DeviceListenerService.handleTelemetry() — i.e. they get
 *      the codec decode, the device-activity update and the Kafka publish that
 *      drive alarm evaluation and WebSocket broadcast. Re-implementing
 *      persistence here is what made the Tuya path skip alarms (CLAUDE.md §4d);
 *      this asserts that path is actually used.
 *   3. Declared data types are honoured (OctetString → string, TimeTicks →
 *      number, integer → boolean).
 *   4. ONE DEAD AGENT DOES NOT BLOCK THE OTHERS: a poll of an address with
 *      nothing listening and a poll of a live agent run concurrently, and the
 *      live one completes while the dead one is still waiting. Then the whole
 *      scheduler is started and the live device keeps producing readings while
 *      the dead one keeps failing.
 *   5. SNMP_ENABLED=false means nothing is scheduled at all.
 *   6. An OID the agent does not have is dropped with a log line, not stored
 *      as NaN, and the rest of the poll still lands.
 */
import { DataSource, Repository } from 'typeorm';
import { randomUUID } from 'crypto';
import * as snmp from 'net-snmp';
import * as entities from '../src/modules/index.entities';
import { Device } from '../src/modules/devices/entities/device.entity';
import { DeviceProfile } from '../src/modules/profiles/entities/device-profile.entity';
import { DeviceListenerService } from '../src/modules/protocols/device-listener.service';
import { SnmpAdapter } from '../src/modules/protocols/adapters/snmp.adapter';
import { CodecRegistryService } from '../src/modules/devices/codecs/codec-registry.service';
import { DeviceTransportType } from '../src/common/enums/device-profile.enum';
import { DeviceStatus, DeviceType } from '../src/common/enums/device.enum';

const database = process.argv[2] ?? 'transportcheck';

const LIVE_AGENT_PORT = 16161;
/** Nothing is ever started here — this is the "dead agent". */
const DEAD_AGENT_PORT = 16199;

let failures = 0;
const check = (label: string, condition: boolean, detail?: unknown) => {
  if (condition) {
    console.log(`  ✓ ${label}`);
  } else {
    failures++;
    console.error(`  ✗ ${label}`, detail === undefined ? '' : detail);
  }
};
const section = (title: string) => console.log(`\n── ${title} ─────────────`);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const TENANT = randomUUID();
const USER = randomUUID();

// ── OIDs the fixture agent serves ─────────────────────────────────────────
const OID_SYS_NAME = '1.3.6.1.2.1.1.5.0'; // OctetString
const OID_UPTIME = '1.3.6.1.2.1.1.3.0'; // TimeTicks
const OID_TEMP = '1.3.6.1.4.1.9999.1.1.0'; // Integer (tenths of a degree)
const OID_IF_UP = '1.3.6.1.4.1.9999.1.2.0'; // Integer used as a boolean
const OID_ABSENT = '1.3.6.1.4.1.9999.9.9.0'; // never registered

/** A real SNMPv2c agent, in this process, answering real UDP requests. */
function startFixtureAgent(port: number, community: string): snmp.Agent {
  const agent = snmp.createAgent({ port }, (error) => {
    if (error) console.error(`  [agent] ${error.message}`);
  });
  agent.getAuthorizer().addCommunity(community);

  const mib = agent.getMib();
  const scalar = (name: string, oid: string, type: number, value: any) => {
    mib.registerProvider({
      name,
      type: snmp.MibProviderType.Scalar,
      oid,
      scalarType: type,
      // Without an explicit MAX-ACCESS the agent answers NoAccess to every
      // GET, which looks exactly like a credential problem. Worth knowing.
      maxAccess: snmp.MaxAccess['read-only'],
    });
    mib.setScalarValue(name, value);
  };

  // Providers are registered on the object OID; the agent serves the .0 instance.
  scalar('sysName', OID_SYS_NAME.replace(/\.0$/, ''), snmp.ObjectType.OctetString, 'fixture-switch-01');
  scalar('sysUpTime', OID_UPTIME.replace(/\.0$/, ''), snmp.ObjectType.TimeTicks, 987654);
  scalar('tempTenths', OID_TEMP.replace(/\.0$/, ''), snmp.ObjectType.Integer, 235);
  scalar('ifUp', OID_IF_UP.replace(/\.0$/, ''), snmp.ObjectType.Integer, 1);

  return agent;
}

(async () => {
  const agent = startFixtureAgent(LIVE_AGENT_PORT, 'fixture-community');
  let dataSource: DataSource | null = null;

  try {
    dataSource = new DataSource({
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

    section('0. Schema + fixtures');
    await dataSource.initialize();
    check('DataSource initialises', true);

    const deviceRepo: Repository<Device> = dataSource.getRepository(Device);
    const profileRepo: Repository<DeviceProfile> =
      dataSource.getRepository(DeviceProfile);

    // Clean slate for repeated runs.
    await deviceRepo.query(`DELETE FROM devices WHERE "deviceKey" LIKE 'snmpfix-%'`);
    await deviceRepo.query(`DELETE FROM device_profiles WHERE name LIKE 'SNMP fixture%'`);
    await deviceRepo.query(`DELETE FROM users WHERE id = $1`, [USER]);
    await deviceRepo.query(`DELETE FROM tenants WHERE id = $1`, [TENANT]);

    // Real tenant/user rows: devices.tenantId and devices.userId carry real
    // foreign keys because the entity declares @ManyToOne against them.
    await deviceRepo.query(
      `INSERT INTO tenants (id, name, email) VALUES ($1, $2, $3)`,
      [TENANT, `SNMP fixture tenant ${TENANT.slice(0, 8)}`, `snmp-${TENANT.slice(0, 8)}@example.invalid`],
    );
    await deviceRepo.query(
      `INSERT INTO users (id, email, password, name, role, "tenantId")
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [USER, `snmp-${USER.slice(0, 8)}@example.invalid`, 'not-a-real-hash', 'SNMP fixture admin', 'tenant_admin', TENANT],
    );

    const profile = await profileRepo.save(
      profileRepo.create({
        tenantId: TENANT,
        name: 'SNMP fixture profile',
        transportType: DeviceTransportType.SNMP,
        transportConfiguration: {
          snmp: {
            port: LIVE_AGENT_PORT,
            version: 'v2c',
            community: 'fixture-community',
            pollPeriodSeconds: 5,
            timeoutMs: 800,
            retries: 0,
            oidMappings: [
              { oid: OID_SYS_NAME, key: 'sysName', dataType: 'string' },
              { oid: OID_UPTIME, key: 'uptime', dataType: 'number' },
              { oid: OID_TEMP, key: 'temperature', dataType: 'number' },
              { oid: OID_IF_UP, key: 'linkUp', dataType: 'boolean' },
            ],
          },
        } as any,
      }),
    );

    // A second profile with no oidMappings, to prove the skip path.
    const emptyProfile = await profileRepo.save(
      profileRepo.create({
        tenantId: TENANT,
        name: 'SNMP fixture profile (no OIDs)',
        transportType: DeviceTransportType.SNMP,
        transportConfiguration: { snmp: { port: 161, version: 'v2c' } } as any,
      }),
    );

    const makeDevice = async (
      key: string,
      ipAddress: string | undefined,
      deviceProfileId: string,
      configuration?: Record<string, any>,
    ) =>
      deviceRepo.save(
        deviceRepo.create({
          deviceKey: key,
          name: key,
          type: DeviceType.SENSOR,
          status: DeviceStatus.INACTIVE,
          tenantId: TENANT,
          userId: USER,
          deviceProfileId,
          ipAddress,
          configuration,
          messageCount: 0,
          errorCount: 0,
        }),
      );

    const liveDevice = await makeDevice('snmpfix-live', '127.0.0.1', profile.id);
    const deadDevice = await makeDevice('snmpfix-dead', '127.0.0.1', profile.id, {
      // Same host, a port nothing is listening on → a dead agent.
      snmp: { port: DEAD_AGENT_PORT, pollPeriodSeconds: 5 },
    });
    const noAddressDevice = await makeDevice('snmpfix-noaddr', undefined, profile.id);
    const noOidsDevice = await makeDevice('snmpfix-nooids', '127.0.0.1', emptyProfile.id);
    check(
      'fixtures created (live / dead / no-address / no-OIDs devices)',
      Boolean(liveDevice.id && deadDevice.id && noAddressDevice.id && noOidsDevice.id),
    );

    // ── Wire the real listener with a recording Kafka stub ─────────────────
    const published: any[] = [];
    const kafkaStub: any = {
      sendMessage: async (topic: string, message: any, key?: string) => {
        published.push({ topic, message, key });
      },
    };
    const listener = new DeviceListenerService(
      deviceRepo,
      new CodecRegistryService(),
      kafkaStub,
    );

    const configStub = (overrides: Record<string, string> = {}): any => ({
      get: (key: string) => overrides[key],
    });

    const adapter = new SnmpAdapter(
      listener,
      deviceRepo,
      profileRepo,
      configStub(),
    );

    // ── 1. Target discovery ────────────────────────────────────────────────
    section('1. Target discovery');
    const targets = await adapter.refreshTargets();
    const byKey = new Map(targets.map((t) => [t.deviceKey, t]));

    check('live device is a target', byKey.has('snmpfix-live'));
    check('dead device is a target', byKey.has('snmpfix-dead'));
    check(
      'device with no ipAddress is skipped, not guessed at',
      !byKey.has('snmpfix-noaddr'),
    );
    check(
      'device whose profile declares no oidMappings is skipped',
      !byKey.has('snmpfix-nooids'),
    );
    check(
      'per-device port override beats the profile port',
      byKey.get('snmpfix-dead')?.port === DEAD_AGENT_PORT,
      byKey.get('snmpfix-dead')?.port,
    );
    check(
      'profile community/version/OIDs are inherited',
      byKey.get('snmpfix-live')?.community === 'fixture-community' &&
        byKey.get('snmpfix-live')?.version === 'v2c' &&
        byKey.get('snmpfix-live')?.oidMappings.length === 4,
      byKey.get('snmpfix-live'),
    );

    // ── 2+3. A real poll produces the expected telemetry ───────────────────
    section('2. A poll of a live agent, through DeviceListenerService');
    published.length = 0;
    const liveTarget = byKey.get('snmpfix-live')!;
    const result = await adapter.pollTarget(liveTarget);

    check('poll succeeded', result.ok, result.error);
    check(
      'sysName decoded as a string (OctetString → utf8)',
      result.values.sysName === 'fixture-switch-01',
      result.values.sysName,
    );
    check(
      'uptime decoded as a number (TimeTicks)',
      result.values.uptime === 987654,
      result.values.uptime,
    );
    check(
      'temperature decoded as a number (Integer)',
      result.values.temperature === 235,
      result.values.temperature,
    );
    check(
      'linkUp coerced to a boolean from Integer 1',
      result.values.linkUp === true,
      result.values.linkUp,
    );

    check(
      'exactly one message reached the unified Kafka path',
      published.length === 1,
      published.length,
    );
    const message = published[0]?.message;
    check(
      'it went to the same topic MQTT/HTTP/CoAP telemetry uses',
      published[0]?.topic === 'telemetry.device.raw',
      published[0]?.topic,
    );
    check(
      'it is partitioned by deviceKey',
      published[0]?.key === 'snmpfix-live',
      published[0]?.key,
    );
    check(
      'protocol is reported as snmp',
      message?.protocol === 'snmp',
      message?.protocol,
    );
    check(
      'all four values survived the codec decode',
      message?.data?.sysName === 'fixture-switch-01' &&
        message?.data?.uptime === 987654 &&
        message?.data?.temperature === 235 &&
        message?.data?.linkUp === true,
      message?.data,
    );
    check(
      'tenant scoping is carried through',
      message?.tenantId === TENANT,
      message?.tenantId,
    );

    const afterPoll = await deviceRepo.findOne({ where: { id: liveDevice.id } });
    check(
      'device activity was updated by the unified path (lastSeenAt set)',
      Boolean(afterPoll?.lastSeenAt),
      afterPoll?.lastSeenAt,
    );
    check(
      'messageCount incremented',
      (afterPoll?.messageCount ?? 0) === 1,
      afterPoll?.messageCount,
    );
    check(
      'INACTIVE device was activated',
      afterPoll?.status === DeviceStatus.ACTIVE,
      afterPoll?.status,
    );

    // ── 4. A dead agent must not block anyone else ─────────────────────────
    section('4. A dead agent does not block the other devices');
    const deadTarget = byKey.get('snmpfix-dead')!;

    // Both polls launched on the same tick. The dead one cannot answer, so it
    // burns its full timeout budget; the live one must not have to wait for it.
    const startedAt = Date.now();
    let liveFinishedAt = 0;
    let deadFinishedAt = 0;

    const deadPromise = adapter.pollTarget(deadTarget).then((r) => {
      deadFinishedAt = Date.now();
      return r;
    });
    const livePromise = adapter.pollTarget(liveTarget).then((r) => {
      liveFinishedAt = Date.now();
      return r;
    });

    const liveResult = await livePromise;
    const liveElapsed = liveFinishedAt - startedAt;
    check(
      'the live poll succeeded while the dead one was still outstanding',
      liveResult.ok && deadFinishedAt === 0,
      { liveOk: liveResult.ok, deadAlreadyFinished: deadFinishedAt !== 0 },
    );
    check(
      `the live poll was not slowed by the dead agent (${liveElapsed}ms, dead budget ~${deadTarget.timeoutMs * (deadTarget.retries + 1)}ms)`,
      liveElapsed < deadTarget.timeoutMs,
      liveElapsed,
    );

    const deadResult = await deadPromise;
    check(
      'the dead poll failed cleanly rather than throwing or hanging',
      !deadResult.ok && Boolean(deadResult.error),
      deadResult,
    );
    check(
      'the dead poll settled within its own bounded budget',
      deadResult.durationMs < deadTarget.timeoutMs * (deadTarget.retries + 1) + 4000,
      deadResult.durationMs,
    );

    // Now the real scheduler, with both devices on a 5s period.
    section('4b. The scheduler keeps the live device reporting');
    published.length = 0;
    await adapter.start();
    check(
      'both devices are scheduled',
      adapter.getScheduledTargets().length === 2,
      adapter.getScheduledTargets(),
    );

    // Two poll periods' worth of wall clock. If a dead agent could stall the
    // loop, the live device would produce nothing here.
    await sleep(7000);
    const liveMessages = published.filter(
      (p) => p.message?.deviceKey === 'snmpfix-live',
    );
    check(
      `the live device produced readings while the dead one kept failing (${liveMessages.length} message(s))`,
      liveMessages.length >= 1,
      published.map((p) => p.message?.deviceKey),
    );
    const deadState = adapter
      .getScheduledTargets()
      .find((t) => t.deviceKey === 'snmpfix-dead');
    check(
      'the dead device records its failures and stays scheduled',
      (deadState?.consecutiveFailures ?? 0) >= 1,
      deadState,
    );
    await adapter.stop();
    check('stop() clears every scheduled target', adapter.getScheduledTargets().length === 0);

    // ── 5. Disabled by env ─────────────────────────────────────────────────
    section('5. SNMP_ENABLED=false');
    const disabled = new SnmpAdapter(
      listener,
      deviceRepo,
      profileRepo,
      configStub({ SNMP_ENABLED: 'false' }),
    );
    await disabled.onModuleInit();
    check('isEnabled() is false', disabled.isEnabled() === false);
    check(
      'nothing is scheduled — the poller does not run at all',
      disabled.getScheduledTargets().length === 0,
    );
    await disabled.stop();

    // ── 6. A missing OID is dropped, not stored as NaN ─────────────────────
    section('6. An OID the agent does not have');
    await profileRepo.update(profile.id, {
      transportConfiguration: {
        snmp: {
          port: LIVE_AGENT_PORT,
          version: 'v2c',
          community: 'fixture-community',
          pollPeriodSeconds: 5,
          timeoutMs: 800,
          retries: 0,
          oidMappings: [
            { oid: OID_TEMP, key: 'temperature', dataType: 'number' },
            { oid: OID_ABSENT, key: 'phantom', dataType: 'number' },
          ],
        },
      } as any,
    });
    const refreshed = await adapter.refreshTargets();
    const refreshedLive = refreshed.find((t) => t.deviceKey === 'snmpfix-live')!;
    const partial = await adapter.pollTarget(refreshedLive);
    check('the poll still succeeded', partial.ok, partial.error);
    check(
      'the present OID landed',
      partial.values.temperature === 235,
      partial.values,
    );
    check(
      'the absent OID was dropped, not stored as NaN or null',
      !('phantom' in partial.values),
      partial.values,
    );
    await adapter.stop();
  } finally {
    try {
      agent.close();
    } catch {
      /* already closed */
    }
    if (dataSource?.isInitialized) await dataSource.destroy();
  }

  console.log(
    `\n${failures === 0 ? '✅ SNMP POLLER VERIFIED' : `❌ ${failures} CHECK(S) FAILED`}`,
  );
  process.exit(failures === 0 ? 0 : 1);
})().catch((error) => {
  console.error('\n❌ SNMP verification crashed:', error);
  process.exit(1);
});
