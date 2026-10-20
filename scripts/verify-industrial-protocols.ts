/**
 * Verifies OPC-UA, BACnet/IP and NB-IoT against real servers and a real
 * PostgreSQL database.
 *
 *   createdb industrialcheck
 *   npm run verify:industrial-protocols industrialcheck
 *
 * Why this and not booting the app: an unreachable Kafka broker stops the app
 * at startup (CLAUDE.md §11), so the services are wired by hand. Everything
 * below the Kafka publish is the real thing — real TypeORM repositories, the
 * real `DeviceListenerService`, the real `CodecRegistryService`, a real
 * in-process OPC-UA server (`node-opcua`'s own `OPCUAServer`) and a real
 * in-process BACnet/IP responder (a second `node-bacnet` client answering
 * Who-Is, ReadProperty and ReadPropertyMultiple over UDP). Only `KafkaService`
 * is a stub, and it records what would have been published so the assertions
 * can read it.
 *
 * What it proves, in order:
 *   1. OPC-UA: a real SUBSCRIPTION with monitored items delivers a value
 *      change, coalesced into ONE reading, through
 *      DeviceListenerService.handleTelemetry() — i.e. with the codec decode,
 *      the device-activity update and the Kafka publish that drive alarm
 *      evaluation and WebSocket broadcast. Plus polling mode, browse, the
 *      connection test, per-node status handling and the skip paths.
 *   2. BACnet: Who-Is/I-Am discovery finds a device and reads its name;
 *      ReadPropertyMultiple produces telemetry; and a controller that REJECTS
 *      ReadPropertyMultiple falls back to single ReadProperty requests and
 *      remembers that it had to.
 *   3. NB-IoT: a carrier HTTP push resolves the device by IMEI, normalises the
 *      carrier's own spelling of RSRP/RSRQ/ECL, stores them as ordinary
 *      telemetry keys, and is refused for a bad routing key, an unknown SIM
 *      and a SIM belonging to another tenant.
 *   4. Static invariants: every controller handler carries @Roles, each
 *      adapter really ends at handleTelemetry, and the two NB-IoT catalogue
 *      manifests are declared non-dispatchable.
 *
 * The BACnet fixture binds a NON-LOOPBACK local address on purpose:
 * `node-bacnet` silently DROPS any service request whose sender is 127.0.0.1
 * (`_processServiceRequest` returns early), so a pure-loopback test would look
 * like a total failure of the library.
 */
import { DataSource, Repository } from 'typeorm';
import { randomUUID } from 'crypto';
import { readFileSync } from 'fs';
import { join } from 'path';
import { networkInterfaces } from 'os';
import * as entities from '../src/modules/index.entities';
import { Device } from '../src/modules/devices/entities/device.entity';
import { DeviceProtocol } from '../src/modules/devices/entities/device.entity';
import { Integration } from '../src/modules/integrations/entities/integration.entity';
import { DeviceListenerService } from '../src/modules/protocols/device-listener.service';
import { CodecRegistryService } from '../src/modules/devices/codecs/codec-registry.service';
import { OpcuaAdapter } from '../src/modules/protocols/adapters/opcua.adapter';
import { BacnetAdapter } from '../src/modules/protocols/adapters/bacnet.adapter';
import { OpcuaServer as OpcuaServerRow } from '../src/modules/protocols/opcua/entities/opcua-server.entity';
import { BacnetDevice } from '../src/modules/protocols/bacnet/entities/bacnet-device.entity';
import { NbIotDevice } from '../src/modules/protocols/nbiot/entities/nbiot-device.entity';
import { NbIotService } from '../src/modules/protocols/nbiot/nbiot.service';
import { DeviceStatus, DeviceType } from '../src/common/enums/device.enum';
import { DeviceTransportType } from '../src/common/enums/device-profile.enum';
import {
  IntegrationStatus,
  IntegrationType,
} from '../src/common/enums/integration.enum';
import {
  INTEGRATION_CATALOGUE,
  isDispatchableType,
} from '../src/modules/integrations/integration-catalogue';
// Imported statically, not with a dynamic import(): under `ts-node -T` a
// dynamic import of an extension-less relative path is resolved by Node's ESM
// loader, which does not apply ts-node's TypeScript resolution and fails with
// ERR_MODULE_NOT_FOUND.
import { IndustrialProtocols1788100000000 } from '../src/database/migrations/1788100000000-IndustrialProtocols';

const database = process.argv[2] ?? 'industrialcheck';

const OPCUA_PORT = 14840;
const BACNET_LOCAL_PORT = 47808;
const BACNET_FIXTURE_PORT = 47809;
const BACNET_RPM_REJECT_PORT = 47810;

let failures = 0;
const check = (label: string, condition: boolean, detail?: unknown) => {
  if (condition) console.log(`  ✓ ${label}`);
  else {
    failures++;
    console.error(`  ✗ ${label}`, detail === undefined ? '' : detail);
  }
};
const section = (title: string) =>
  console.log(`\n── ${title} ─────────────────────────────`);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const TENANT = randomUUID();
const OTHER_TENANT = randomUUID();
const USER = randomUUID();

/** The host's non-loopback IPv4 — see the file header for why this matters. */
function lanAddress(): string | null {
  for (const addresses of Object.values(networkInterfaces())) {
    for (const address of addresses ?? []) {
      if (address.family === 'IPv4' && !address.internal) return address.address;
    }
  }
  return null;
}

const configStub = (overrides: Record<string, string> = {}): any => ({
  get: (key: string) => overrides[key],
});

(async () => {
  let dataSource: DataSource | null = null;
  let opcuaServer: any = null;
  let bacnetFixture: any = null;
  let bacnetRejecter: any = null;
  let opcuaAdapter: OpcuaAdapter | null = null;
  let bacnetAdapter: BacnetAdapter | null = null;

  try {
    // ══════════════════════════════════════════════════════════════════════
    section('0. Schema + fixtures');
    // ══════════════════════════════════════════════════════════════════════
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
    await dataSource.initialize();
    check('DataSource initialises with the three new entities', true);

    const deviceRepo: Repository<Device> = dataSource.getRepository(Device);
    const opcuaRepo: Repository<OpcuaServerRow> =
      dataSource.getRepository(OpcuaServerRow);
    const bacnetRepo: Repository<BacnetDevice> =
      dataSource.getRepository(BacnetDevice);
    const nbiotRepo: Repository<NbIotDevice> =
      dataSource.getRepository(NbIotDevice);
    const integrationRepo: Repository<Integration> =
      dataSource.getRepository(Integration);

    // Clean slate for repeated runs.
    await deviceRepo.query(`DELETE FROM opcua_servers WHERE name LIKE 'fixture%'`);
    await deviceRepo.query(`DELETE FROM bacnet_devices WHERE name LIKE 'fixture%'`);
    await deviceRepo.query(
      `DELETE FROM nbiot_devices WHERE "deviceId" IN (SELECT id FROM devices WHERE "deviceKey" LIKE 'indfix-%')`,
    );
    await deviceRepo.query(`DELETE FROM integrations WHERE name LIKE 'fixture%'`);
    await deviceRepo.query(`DELETE FROM devices WHERE "deviceKey" LIKE 'indfix-%'`);
    await deviceRepo.query(`DELETE FROM users WHERE id = $1`, [USER]);
    await deviceRepo.query(`DELETE FROM tenants WHERE id = ANY($1)`, [
      [TENANT, OTHER_TENANT],
    ]);

    for (const [id, label] of [
      [TENANT, 'primary'],
      [OTHER_TENANT, 'other'],
    ] as const) {
      await deviceRepo.query(
        `INSERT INTO tenants (id, name, email) VALUES ($1, $2, $3)`,
        [
          id,
          `Industrial fixture tenant (${label}) ${id.slice(0, 8)}`,
          `ind-${id.slice(0, 8)}@example.invalid`,
        ],
      );
    }
    await deviceRepo.query(
      `INSERT INTO users (id, email, password, name, role, "tenantId")
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [
        USER,
        `ind-${USER.slice(0, 8)}@example.invalid`,
        'not-a-real-hash',
        'Industrial fixture admin',
        'tenant_admin',
        TENANT,
      ],
    );

    const makeDevice = async (
      key: string,
      tenantId = TENANT,
      protocol: DeviceProtocol = DeviceProtocol.GENERIC_MQTT,
    ) =>
      deviceRepo.save(
        deviceRepo.create({
          deviceKey: key,
          name: key,
          type: DeviceType.SENSOR,
          status: DeviceStatus.INACTIVE,
          protocol,
          tenantId,
          userId: USER,
          messageCount: 0,
          errorCount: 0,
        }),
      );

    const opcuaDevice = await makeDevice('indfix-opcua');
    const opcuaPollDevice = await makeDevice('indfix-opcua-poll');
    const bacnetDevice = await makeDevice('indfix-bacnet');
    const bacnetRejectDevice = await makeDevice('indfix-bacnet-reject');
    // DeviceProtocol.NB_IOT is a PG enum value — this INSERT is what proves
    // the migration's ALTER TYPE is actually needed and actually works.
    const nbiotDevice = await makeDevice(
      'indfix-nbiot',
      TENANT,
      DeviceProtocol.NB_IOT,
    );
    const otherTenantDevice = await makeDevice(
      'indfix-other',
      OTHER_TENANT,
      DeviceProtocol.NB_IOT,
    );
    check(
      'devices insert, including protocol = nb_iot (the new PG enum label)',
      nbiotDevice.protocol === DeviceProtocol.NB_IOT,
      nbiotDevice.protocol,
    );
    check(
      'DeviceTransportType gained OPCUA / BACNET / NB_IOT',
      DeviceTransportType.OPCUA === 'OPCUA' &&
        DeviceTransportType.BACNET === 'BACNET' &&
        DeviceTransportType.NB_IOT === 'NB_IOT',
    );

    // ── The real listener, with a recording Kafka stub ─────────────────────
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

    // ══════════════════════════════════════════════════════════════════════
    section('1. OPC-UA against a real OPC-UA server');
    // ══════════════════════════════════════════════════════════════════════
    const opcua: any = await import('node-opcua');
    const lib = opcua?.OPCUAServer ? opcua : opcua?.default;

    opcuaServer = new lib.OPCUAServer({
      port: OPCUA_PORT,
      resourcePath: '/UA/Fixture',
      buildInfo: { productName: 'IndustrialFixtureServer' },
    });
    await opcuaServer.initialize();
    const addressSpace = opcuaServer.engine.addressSpace;
    const ownNamespace = addressSpace.getOwnNamespace();
    const boiler = ownNamespace.addObject({
      organizedBy: addressSpace.rootFolder.objects,
      browseName: 'Boiler1',
    });

    let temperature = 21.5;
    let pumpRunning = false;
    let rawTenths = 235;
    ownNamespace.addVariable({
      componentOf: boiler,
      browseName: 'Temperature',
      nodeId: 's=Boiler1.Temperature',
      dataType: 'Double',
      minimumSamplingInterval: 100,
      value: {
        get: () =>
          new lib.Variant({ dataType: lib.DataType.Double, value: temperature }),
      },
    });
    ownNamespace.addVariable({
      componentOf: boiler,
      browseName: 'PumpRunning',
      nodeId: 's=Boiler1.PumpRunning',
      dataType: 'Boolean',
      minimumSamplingInterval: 100,
      value: {
        get: () =>
          new lib.Variant({
            dataType: lib.DataType.Boolean,
            value: pumpRunning,
          }),
      },
    });
    ownNamespace.addVariable({
      componentOf: boiler,
      browseName: 'RawTenths',
      nodeId: 's=Boiler1.RawTenths',
      dataType: 'Int32',
      minimumSamplingInterval: 100,
      value: {
        get: () =>
          new lib.Variant({ dataType: lib.DataType.Int32, value: rawTenths }),
      },
    });
    await opcuaServer.start();
    const endpointUrl: string = opcuaServer.getEndpointUrl();
    check(`fixture OPC-UA server listening (${endpointUrl})`, !!endpointUrl);

    const subRow = await opcuaRepo.save(
      opcuaRepo.create({
        tenantId: TENANT,
        name: 'fixture subscription server',
        deviceId: opcuaDevice.id,
        endpointUrl,
        securityMode: 'None',
        securityPolicy: 'None',
        useSubscription: true,
        publishingIntervalMs: 200,
        samplingIntervalMs: 100,
        flushWindowMs: 400,
        nodes: [
          {
            nodeId: 'ns=1;s=Boiler1.Temperature',
            key: 'temperature',
            dataType: 'number',
          },
          {
            nodeId: 'ns=1;s=Boiler1.PumpRunning',
            key: 'pumpRunning',
            dataType: 'boolean',
          },
          {
            nodeId: 'ns=1;s=Boiler1.RawTenths',
            key: 'scaledTemp',
            dataType: 'number',
            scale: 0.1,
          },
        ],
        readingCount: '0',
      }),
    );

    const pollRow = await opcuaRepo.save(
      opcuaRepo.create({
        tenantId: TENANT,
        name: 'fixture polling server',
        deviceId: opcuaPollDevice.id,
        endpointUrl,
        useSubscription: false,
        pollIntervalMs: 1000,
        flushWindowMs: 100,
        nodes: [
          {
            nodeId: 'ns=1;s=Boiler1.Temperature',
            key: 'temperature',
            dataType: 'number',
          },
        ],
        readingCount: '0',
      }),
    );

    // Two skip paths: no device, and no nodes.
    await opcuaRepo.save(
      opcuaRepo.create({
        tenantId: TENANT,
        name: 'fixture no device',
        endpointUrl,
        nodes: [{ nodeId: 'ns=1;s=Boiler1.Temperature', key: 'temperature' }],
        readingCount: '0',
      }),
    );
    await opcuaRepo.save(
      opcuaRepo.create({
        tenantId: TENANT,
        name: 'fixture no nodes',
        deviceId: opcuaDevice.id,
        endpointUrl,
        nodes: [],
        readingCount: '0',
      }),
    );

    opcuaAdapter = new OpcuaAdapter(
      listener,
      opcuaRepo,
      deviceRepo,
      configStub(),
    );

    const opcuaTargets = await opcuaAdapter.refreshTargets();
    const opcuaByName = new Map(opcuaTargets.map((t) => [t.name, t]));
    check(
      'a row with a device and nodes becomes a target',
      opcuaByName.has('fixture subscription server'),
    );
    check(
      'a row with NO device is skipped, not guessed at',
      !opcuaByName.has('fixture no device'),
    );
    check(
      'a row with an EMPTY node map is skipped rather than holding a session open',
      !opcuaByName.has('fixture no nodes'),
    );

    // Both rows point at the same endpoint with the same security and user, so
    // they must SHARE one session — an OPC-UA server's session limit is often
    // ten, and one per row is how you exhaust it.
    check(
      'two rows on one endpoint share a single session',
      opcuaAdapter.getOpenSessionCount() === 1,
      opcuaAdapter.getOpenSessionCount(),
    );

    const connected = opcuaAdapter.getConnectedServers();
    const subLive = connected.find((c) => c.rowId === subRow.id);
    const pollLive = connected.find((c) => c.rowId === pollRow.id);
    check(
      'the subscription row runs as a SUBSCRIPTION with one monitored item per node',
      subLive?.mode === 'subscription' && subLive?.monitoredItems === 3,
      subLive,
    );
    check(
      'the useSubscription=false row runs as a POLL',
      pollLive?.mode === 'poll' && pollLive?.monitoredItems === 0,
      pollLive,
    );

    // Initial notifications land first; clear them, then change the plant.
    await sleep(1200);
    published.length = 0;
    temperature = 33.75;
    pumpRunning = true;
    rawTenths = 310;
    await sleep(1800);

    const opcuaReadings = published.filter(
      (p) => p.message?.deviceKey === 'indfix-opcua',
    );
    check(
      'a value change reaches DeviceListenerService.handleTelemetry (so codec, Kafka, alarms and WS all run)',
      opcuaReadings.length > 0,
      published.map((p) => p.message?.deviceKey),
    );

    const latest = opcuaReadings[opcuaReadings.length - 1]?.message?.data ?? {};
    check(
      'the changed Double arrives as a number',
      latest.temperature === 33.75,
      latest,
    );
    check(
      'the Boolean node arrives as a real boolean, not 0/1',
      latest.pumpRunning === true,
      latest,
    );
    check(
      '`scale` is applied (raw 310 → 31 with scale 0.1)',
      Math.abs(Number(latest.scaledTemp) - 31) < 1e-9,
      latest,
    );
    check(
      'three nodes changing at once are COALESCED into one reading, not three',
      Object.keys(latest).length >= 3 && opcuaReadings.length <= 2,
      { readings: opcuaReadings.length, keys: Object.keys(latest) },
    );
    check(
      'metadata records that this came from a subscription',
      opcuaReadings[opcuaReadings.length - 1]?.message?.metadata?.opcuaMode ===
        'subscription' ||
        opcuaReadings[0]?.message?.metadata?.opcuaMode === 'subscription',
      opcuaReadings[0]?.message?.metadata,
    );

    const polled = published.filter(
      (p) => p.message?.deviceKey === 'indfix-opcua-poll',
    );
    check(
      'the polling row also produces readings, through the same entry point',
      polled.length > 0 && polled[0].message?.data?.temperature === 33.75,
      polled[0]?.message?.data,
    );

    // ── The connection test, and browse ───────────────────────────────────
    const withSecret = await opcuaRepo
      .createQueryBuilder('s')
      .addSelect('s.passwordEncrypted')
      .where('s.id = :id', { id: subRow.id })
      .getOne();
    const testResult = await opcuaAdapter.testConnection(withSecret!);
    check('connection test really connects', testResult.success, testResult);
    check(
      'the test reports that the server accepted a real subscription',
      testResult.subscriptionSupported === true,
      testResult.subscriptionSupported,
    );
    check(
      'the test names the server it reached',
      testResult.serverProductName === 'IndustrialFixtureServer',
      testResult.serverProductName,
    );
    check(
      'the test reports every mapped node individually',
      testResult.nodes?.length === 3 && testResult.nodes.every((n) => n.ok),
      testResult.nodes,
    );

    // A bad NodeId must be NAMED, not swallowed, and must not fail the others.
    const badRow = { ...withSecret!, nodes: [
      { nodeId: 'ns=1;s=Boiler1.Temperature', key: 'temperature' },
      { nodeId: 'ns=1;s=Does.Not.Exist', key: 'ghost' },
    ] } as OpcuaServerRow;
    const badTest = await opcuaAdapter.testConnection(badRow);
    check(
      'a non-existent NodeId is reported as failing, by name',
      badTest.success === false &&
        badTest.nodes?.some((n) => n.nodeId.includes('Does.Not.Exist') && !n.ok) &&
        badTest.nodes?.some((n) => n.key === 'temperature' && n.ok),
      badTest.nodes,
    );

    const browsed = await opcuaAdapter.browse(withSecret!);
    check(
      'browse returns the address space so NodeIds can be found from the UI',
      browsed.entries.some((e) => e.browseName === 'Boiler1'),
      browsed.entries.map((e) => e.browseName),
    );
    const boilerEntry = browsed.entries.find((e) => e.browseName === 'Boiler1');
    const inside = await opcuaAdapter.browse(withSecret!, boilerEntry!.nodeId);
    check(
      'browsing into an object marks its Variables as mappable',
      inside.entries.some(
        (e) => e.browseName === 'Temperature' && e.isVariable,
      ),
      inside.entries,
    );

    const refreshedRow = await opcuaRepo.findOne({ where: { id: subRow.id } });
    check(
      'the row records that it is connected and producing readings',
      refreshedRow?.lastStatus === 'connected' && !!refreshedRow?.lastConnectedAt,
      { status: refreshedRow?.lastStatus, at: refreshedRow?.lastConnectedAt },
    );

    await opcuaAdapter.stop();
    check(
      'stop() closes every session',
      opcuaAdapter.getOpenSessionCount() === 0,
      opcuaAdapter.getOpenSessionCount(),
    );

    const disabledAdapter = new OpcuaAdapter(
      listener,
      opcuaRepo,
      deviceRepo,
      configStub({ OPCUA_ENABLED: 'false' }),
    );
    await disabledAdapter.onModuleInit();
    check(
      'OPCUA_ENABLED=false means nothing is connected at all',
      disabledAdapter.getConnectedServers().length === 0 &&
        disabledAdapter.isEnabled() === false,
    );

    // ══════════════════════════════════════════════════════════════════════
    section('2. BACnet/IP against a real BACnet responder');
    // ══════════════════════════════════════════════════════════════════════
    const lan = lanAddress();
    if (!lan) {
      console.log(
        '  ! skipped — no non-loopback IPv4 interface. node-bacnet DROPS any ' +
          'service request whose sender is 127.0.0.1, so a loopback-only host ' +
          'cannot run this fixture.',
      );
    } else {
      const bacnetMod: any = await import('node-bacnet');
      const BacnetCtor =
        typeof bacnetMod === 'function'
          ? bacnetMod
          : (bacnetMod?.default ?? bacnetMod);
      const E = BacnetCtor.enum ?? bacnetMod.enum;

      // ── A real controller: analogInput 1 = 22.5 °C, binaryInput 2 = active,
      //    analogValue 3 = 1850 (raw, scaled by 0.01 in the mapping).
      const pointValue = (type: number, instance: number) => {
        if (type === E.ObjectType.ANALOG_INPUT && instance === 1) {
          return { type: E.ApplicationTag.REAL, value: 22.5 };
        }
        if (type === E.ObjectType.BINARY_INPUT && instance === 2) {
          return { type: E.ApplicationTag.ENUMERATED, value: 1 };
        }
        if (type === E.ObjectType.ANALOG_VALUE && instance === 3) {
          return { type: E.ApplicationTag.REAL, value: 1850 };
        }
        return null;
      };

      bacnetFixture = new BacnetCtor({
        port: BACNET_FIXTURE_PORT,
        interface: '0.0.0.0',
      });
      bacnetFixture.on('error', () => undefined);
      bacnetFixture.on('whoIs', (message: any) => {
        bacnetFixture.iAmResponse(
          message.header.sender,
          2001,
          E.Segmentation.SEGMENTED_BOTH,
          260,
        );
      });
      bacnetFixture.on('readProperty', (message: any) => {
        const { objectId, property } = message.payload;
        if (
          objectId.type === E.ObjectType.DEVICE &&
          property.id === E.PropertyIdentifier.OBJECT_NAME
        ) {
          return bacnetFixture.readPropertyResponse(
            message.header.sender,
            message.invokeId,
            objectId,
            property,
            [{ type: E.ApplicationTag.CHARACTER_STRING, value: 'AHU-3' }],
          );
        }
        if (
          objectId.type === E.ObjectType.DEVICE &&
          property.id === E.PropertyIdentifier.MODEL_NAME
        ) {
          return bacnetFixture.readPropertyResponse(
            message.header.sender,
            message.invokeId,
            objectId,
            property,
            [{ type: E.ApplicationTag.CHARACTER_STRING, value: 'VAV-X' }],
          );
        }
        const value = pointValue(objectId.type, objectId.instance);
        if (!value) {
          return bacnetFixture.errorResponse(
            message.header.sender,
            E.ConfirmedServiceChoice.READ_PROPERTY,
            message.invokeId,
            E.ErrorClass.OBJECT,
            E.ErrorCode.UNKNOWN_OBJECT,
          );
        }
        bacnetFixture.readPropertyResponse(
          message.header.sender,
          message.invokeId,
          objectId,
          property,
          [value],
        );
      });
      bacnetFixture.on('readPropertyMultiple', (message: any) => {
        const values = message.payload.properties.map((entry: any) => ({
          objectId: entry.objectId,
          values: entry.properties.map((property: any) => {
            const value = pointValue(
              entry.objectId.type,
              entry.objectId.instance,
            );
            return {
              property,
              value: value ? [value] : [{ type: E.ApplicationTag.NULL, value: null }],
            };
          }),
        }));
        bacnetFixture.readPropertyMultipleResponse(
          message.header.sender,
          message.invokeId,
          values,
        );
      });

      // ── A controller that advertises RPM and then rejects it. This is a
      //    real and common behaviour in field controllers, and the fallback is
      //    the only way through it.
      bacnetRejecter = new BacnetCtor({
        port: BACNET_RPM_REJECT_PORT,
        interface: '0.0.0.0',
      });
      bacnetRejecter.on('error', () => undefined);
      bacnetRejecter.on('readPropertyMultiple', (message: any) => {
        bacnetRejecter.errorResponse(
          message.header.sender,
          E.ConfirmedServiceChoice.READ_PROPERTY_MULTIPLE,
          message.invokeId,
          E.ErrorClass.SERVICES,
          E.ErrorCode.SERVICE_REQUEST_DENIED,
        );
      });
      bacnetRejecter.on('readProperty', (message: any) => {
        const { objectId, property } = message.payload;
        bacnetRejecter.readPropertyResponse(
          message.header.sender,
          message.invokeId,
          objectId,
          property,
          [{ type: E.ApplicationTag.REAL, value: 17.25 }],
        );
      });

      await sleep(400);

      const bacnetRow = await bacnetRepo.save(
        bacnetRepo.create({
          tenantId: TENANT,
          name: 'fixture AHU',
          deviceId: bacnetDevice.id,
          address: lan,
          port: BACNET_FIXTURE_PORT,
          deviceInstance: 2001,
          pollIntervalMs: 5000,
          apduTimeoutMs: 3000,
          useReadPropertyMultiple: true,
          objects: [
            {
              objectType: 'analogInput',
              objectInstance: 1,
              property: 'presentValue',
              telemetryKey: 'supplyAirTemperature',
              dataType: 'number',
            },
            {
              objectType: 'binaryInput',
              objectInstance: 2,
              property: 'presentValue',
              telemetryKey: 'fanRunning',
              dataType: 'boolean',
            },
            {
              objectType: 'analogValue',
              objectInstance: 3,
              property: 'presentValue',
              telemetryKey: 'staticPressure',
              dataType: 'number',
              scale: 0.01,
            },
          ],
          readingCount: '0',
        }),
      );

      const rejectRow = await bacnetRepo.save(
        bacnetRepo.create({
          tenantId: TENANT,
          name: 'fixture RPM rejecter',
          deviceId: bacnetRejectDevice.id,
          address: lan,
          port: BACNET_RPM_REJECT_PORT,
          deviceInstance: 2002,
          pollIntervalMs: 5000,
          apduTimeoutMs: 3000,
          useReadPropertyMultiple: true,
          objects: [
            {
              objectType: 'analogInput',
              objectInstance: 1,
              property: 'presentValue',
              telemetryKey: 'zoneTemperature',
              dataType: 'number',
            },
          ],
          readingCount: '0',
        }),
      );

      bacnetAdapter = new BacnetAdapter(
        listener,
        bacnetRepo,
        deviceRepo,
        configStub({
          BACNET_ENABLED: 'true',
          BACNET_PORT: String(BACNET_LOCAL_PORT),
          BACNET_INTERFACE: '0.0.0.0',
        }),
      );

      const bacnetTargets = await bacnetAdapter.refreshTargets();
      const bacnetByName = new Map(bacnetTargets.map((t) => [t.name, t]));
      check(
        'both BACnet rows resolve to targets',
        bacnetByName.has('fixture AHU') && bacnetByName.has('fixture RPM rejecter'),
        [...bacnetByName.keys()],
      );
      check(
        'camelCase object types are resolved to the library’s enum values',
        bacnetByName.get('fixture AHU')?.objects[0].objectTypeId ===
          E.ObjectType.ANALOG_INPUT,
        bacnetByName.get('fixture AHU')?.objects,
      );

      published.length = 0;
      const ahuResult = await bacnetAdapter.pollTarget(
        bacnetByName.get('fixture AHU')!,
      );
      check(
        'ReadPropertyMultiple poll succeeds in one request',
        ahuResult.ok && ahuResult.method === 'readPropertyMultiple',
        ahuResult,
      );
      check(
        'analogInput presentValue arrives as a number',
        ahuResult.values.supplyAirTemperature === 22.5,
        ahuResult.values,
      );
      check(
        'binaryInput presentValue arrives as a boolean, not 1',
        ahuResult.values.fanRunning === true,
        ahuResult.values,
      );
      check(
        '`scale` is applied (1850 × 0.01 = 18.5)',
        Math.abs(Number(ahuResult.values.staticPressure) - 18.5) < 1e-9,
        ahuResult.values,
      );

      const bacnetPublished = published.filter(
        (p) => p.message?.deviceKey === 'indfix-bacnet',
      );
      check(
        'the reading reaches DeviceListenerService.handleTelemetry',
        bacnetPublished.length === 1,
        published.map((p) => p.message?.deviceKey),
      );
      check(
        'metadata records the controller’s instance number',
        bacnetPublished[0]?.message?.metadata?.bacnetInstance === 2001,
        bacnetPublished[0]?.message?.metadata,
      );

      // ── The RPM fallback ─────────────────────────────────────────────────
      const rejectEntry = bacnetAdapter
        .getScheduledTargets()
        .find((t) => t.rowId === rejectRow.id);
      check(
        'the rejecter starts out believing RPM works',
        rejectEntry?.rpmUnsupported === false,
        rejectEntry,
      );

      // Drive it through the scheduler's own entry so the learned verdict is
      // the one the scheduler keeps, not a throwaway.
      const scheduledInternals: any = (bacnetAdapter as any).scheduled;
      const rejectState = scheduledInternals.get(rejectRow.id);
      const rejectResult = await bacnetAdapter.pollTarget(
        rejectState.target,
        rejectState,
      );
      check(
        'a controller that rejects ReadPropertyMultiple still produces readings, via single ReadProperty',
        rejectResult.ok && rejectResult.method === 'readProperty',
        rejectResult,
      );
      check(
        'the single-read value is correct',
        rejectResult.values.zoneTemperature === 17.25,
        rejectResult.values,
      );
      check(
        'the "RPM does not work here" verdict is REMEMBERED, so later polls do not re-fail',
        rejectState.rpmUnsupported === true,
      );

      // ── Discovery ────────────────────────────────────────────────────────
      const discovery = await bacnetAdapter.discover({
        windowMs: 2500,
        address: `${lan}:${BACNET_FIXTURE_PORT}`,
        describe: true,
        tenantId: TENANT,
      });
      const found = discovery.devices.find((d) => d.deviceInstance === 2001);
      check(
        'Who-Is finds the controller and returns its instance number',
        !!found,
        discovery,
      );
      check(
        'the I-Am carries the vendor id',
        found?.vendorId === 260,
        found,
      );
      check(
        'discovery reads the controller’s own name, so the list is readable',
        found?.objectName === 'AHU-3' && found?.modelName === 'VAV-X',
        found,
      );
      check(
        'a controller already registered in this tenant is flagged',
        found?.alreadyRegistered === true,
        found,
      );

      const bacnetRowAfter = await bacnetRepo.findOne({
        where: { id: bacnetRow.id },
      });
      check(
        'the row records that it is reading successfully',
        bacnetRowAfter?.lastStatus === 'ok' && !!bacnetRowAfter?.lastReadingAt,
        { status: bacnetRowAfter?.lastStatus },
      );

      await bacnetAdapter.stop();
      bacnetAdapter = null;

      const disabledBacnet = new BacnetAdapter(
        listener,
        bacnetRepo,
        deviceRepo,
        configStub(),
      );
      await disabledBacnet.onModuleInit();
      check(
        'BACnet is OFF by default (it binds a host UDP port), so nothing is scheduled',
        disabledBacnet.isEnabled() === false &&
          disabledBacnet.getScheduledTargets().length === 0,
      );
    }

    // ══════════════════════════════════════════════════════════════════════
    section('3. NB-IoT carrier uplink, end to end');
    // ══════════════════════════════════════════════════════════════════════
    const nbiot = new NbIotService(
      nbiotRepo,
      deviceRepo,
      integrationRepo,
      listener,
    );

    const ROUTING_KEY = 'fixture-routing-key-0001';
    const integration = await integrationRepo.save(
      integrationRepo.create({
        tenantId: TENANT,
        userId: USER,
        name: 'fixture NB-IoT carrier push',
        // This save is what proves the migration's
        // `ALTER TYPE integrations_type_enum ADD VALUE 'nbiot_http'` is needed:
        // without it the INSERT fails with `invalid input value for enum`.
        type: IntegrationType.NBIOT_HTTP,
        protocol: 'HTTPS',
        status: IntegrationStatus.ACTIVE,
        enabled: true,
        configuration: { routingKey: ROUTING_KEY } as any,
      }),
    );
    check(
      'an integration of type nbiot_http inserts (the new PG enum label works)',
      integration.type === IntegrationType.NBIOT_HTTP,
    );

    const sim = await nbiotRepo.save(
      nbiotRepo.create({
        tenantId: TENANT,
        deviceId: nbiotDevice.id,
        imei: '860123456789012',
        imsi: '420011234567890',
        iccid: '8996001234567890123',
        carrier: 'Zain KSA',
        apn: 'nbiot.zain.sa',
        appProtocol: 'coap',
        expectedReportIntervalSeconds: 3600,
        uplinkCount: '0',
      }),
    );
    // Same IMEI in ANOTHER tenant: the uplink must not cross to it.
    await nbiotRepo.save(
      nbiotRepo.create({
        tenantId: OTHER_TENANT,
        deviceId: otherTenantDevice.id,
        imei: '860999999999999',
        uplinkCount: '0',
      }),
    );

    published.length = 0;
    // A realistic carrier envelope: nested payload, the carrier's OWN spelling
    // of each radio metric, and a positive RSRP with the sign dropped — all
    // three are things real platforms do.
    const uplinkResult = await nbiot.handleUplink(
      integration.id,
      {
        imei: '860123456789012',
        eventTime: '2026-10-20T09:15:00Z',
        signalPower: 95, // RSRP, sign dropped
        signal_quality: -11.5, // RSRQ
        SNR: 7.25, // SINR
        ce_level: 1, // ECL
        coverage_class: 1,
        cell_id: '0A1B2C',
        tac: '1234',
        services: [{ data: { temperature: 21.4, humidity: 48, battery: 92 } }],
      },
      ROUTING_KEY,
    );

    check('the carrier uplink is accepted', uplinkResult.success, uplinkResult);
    check(
      'the device is resolved by IMEI, not by a device key the carrier has never heard of',
      uplinkResult.matchedBy === 'imei' &&
        uplinkResult.deviceKey === 'indfix-nbiot',
      uplinkResult,
    );

    const nbPublished = published.filter(
      (p) => p.message?.deviceKey === 'indfix-nbiot',
    );
    check(
      'the uplink reaches DeviceListenerService.handleTelemetry',
      nbPublished.length === 1,
      published.length,
    );

    const nbData = nbPublished[0]?.message?.data ?? {};
    check(
      'the nested sensor payload is extracted',
      nbData.temperature === 21.4 && nbData.humidity === 48,
      nbData,
    );
    check(
      'a dropped RSRP sign is corrected (95 → -95 dBm)',
      nbData.nbiotRsrp === -95,
      nbData.nbiotRsrp,
    );
    check(
      'RSRQ / SINR / ECL / coverage class are stored under canonical keys, so they chart like any other series',
      nbData.nbiotRsrq === -11.5 &&
        nbData.nbiotSinr === 7.25 &&
        nbData.nbiotEcl === 1 &&
        nbData.nbiotCoverageClass === 1,
      nbData,
    );
    check(
      'the carrier’s own metric spellings are NOT also stored as junk keys',
      !('signalPower' in nbData) &&
        !('signal_quality' in nbData) &&
        !('ce_level' in nbData),
      Object.keys(nbData),
    );
    check(
      'the envelope’s identifiers are not stored as telemetry',
      !('imei' in nbData) && !('eventTime' in nbData),
      Object.keys(nbData),
    );
    // `DeviceListenerService` merges the StandardTelemetry's first-class
    // fields INTO `data` before publishing, so `signalStrength` lands as a key
    // rather than at the top of the Kafka message.
    check(
      'RSRP is also promoted to the standard signalStrength field, so existing widgets work',
      nbData.signalStrength === -95,
      nbData,
    );
    check(
      'the carrier’s own timestamp is honoured',
      new Date(nbPublished[0]?.message?.timestamp).toISOString() ===
        '2026-10-20T09:15:00.000Z',
      nbPublished[0]?.message?.timestamp,
    );
    check(
      'cell id and TAC are carried in metadata for diagnosis',
      nbPublished[0]?.message?.metadata?.nbiotCellId === '0A1B2C' &&
        nbPublished[0]?.message?.metadata?.nbiotTac === '1234',
      nbPublished[0]?.message?.metadata,
    );

    const simAfter = await nbiotRepo.findOne({ where: { id: sim.id } });
    check(
      'last-known signal is cached on the row for the list screen',
      simAfter?.lastRsrp === -95 &&
        simAfter?.lastEcl === 1 &&
        Number(simAfter?.uplinkCount) === 1 &&
        !!simAfter?.lastUplinkAt,
      simAfter,
    );

    // ── Refusals ──────────────────────────────────────────────────────────
    published.length = 0;
    const badKey = await nbiot.handleUplink(
      integration.id,
      { imei: '860123456789012', rsrp: -100 },
      'wrong-key-wrong-key-0001',
    );
    check(
      'a wrong routing key is refused, and vaguely — this route is public',
      badKey.success === false && badKey.message === 'Integration not available',
      badKey,
    );
    check('nothing was ingested for the refused uplink', published.length === 0);

    const noKey = await nbiot.handleUplink(integration.id, {
      imei: '860123456789012',
    });
    check(
      'a missing routing key is refused (not treated as "no key configured")',
      noKey.success === false,
      noKey,
    );

    const unknownSim = await nbiot.handleUplink(
      integration.id,
      { imei: '111111111111111', rsrp: -100 },
      ROUTING_KEY,
    );
    check(
      'an unknown IMEI is refused, NOT auto-provisioned (an HTTP source can send any string)',
      unknownSim.success === false &&
        unknownSim.message.includes('No NB-IoT device registered'),
      unknownSim,
    );
    check(
      'no device was created for the unknown IMEI',
      (await deviceRepo.count({ where: { tenantId: TENANT } })) === 5,
      await deviceRepo.count({ where: { tenantId: TENANT } }),
    );

    const crossTenant = await nbiot.handleUplink(
      integration.id,
      { imei: '860999999999999', rsrp: -100 },
      ROUTING_KEY,
    );
    check(
      'an IMEI belonging to ANOTHER tenant is refused — the lookup is tenant-scoped',
      crossTenant.success === false,
      crossTenant,
    );

    const noIdentity = await nbiot.handleUplink(
      integration.id,
      { temperature: 20 },
      ROUTING_KEY,
    );
    check(
      'a body with no identifier is refused with an explanation of what was expected',
      noIdentity.success === false &&
        noIdentity.message.includes('No device identifier found'),
      noIdentity,
    );

    // ── Range sanity checks on the normaliser ─────────────────────────────
    const nonsense = nbiot.normaliseSignalMetrics({
      rsrp: -400, // outside -160 … -20
      ecl: 255, // the modules' "unknown", not a level
      sinr: 'not-a-number',
      coverageClass: 99,
      cellId: 'ABCDEF',
    });
    check(
      'an out-of-range RSRP is dropped rather than charted',
      nonsense.rsrp === undefined,
      nonsense,
    );
    check(
      'ECL 255 ("unknown") is dropped rather than stored as a coverage level',
      nonsense.ecl === undefined,
      nonsense,
    );
    check(
      'a non-numeric metric is dropped rather than stored as NaN',
      nonsense.sinr === undefined,
      nonsense,
    );
    check(
      'an identifier that is in range is still kept',
      nonsense.cellId === 'ABCDEF',
      nonsense,
    );

    // ── Report health, judged per device ──────────────────────────────────
    const status = await nbiot.getStatus(TENANT);
    const simStatus = status.devices.find((d) => d.deviceId === nbiotDevice.id);
    check(
      'a device that just reported is "ok" against its OWN expected interval, not the generic 5-minute window',
      simStatus?.reportHealth === 'ok',
      simStatus,
    );
    check(
      'RSRP is described in the words a field engineer uses',
      simStatus?.signalQuality === 'good',
      simStatus?.signalQuality,
    );

    // ══════════════════════════════════════════════════════════════════════
    section('4. Static invariants');
    // ══════════════════════════════════════════════════════════════════════
    const ROOT = join(__dirname, '..');
    const readSrc = (relative: string) =>
      readFileSync(join(ROOT, relative), 'utf8');

    for (const controller of [
      'src/modules/protocols/opcua/opcua.controller.ts',
      'src/modules/protocols/bacnet/bacnet.controller.ts',
      'src/modules/protocols/nbiot/nbiot.controller.ts',
    ]) {
      const source = readSrc(controller);
      // Every HTTP handler must carry @Roles or @Public. RolesGuard returns
      // TRUE for a handler with no @Roles metadata, so an undecorated route is
      // open to every authenticated account on the platform (§4g).
      const handlers = [
        ...source.matchAll(
          /@(Get|Post|Put|Patch|Delete)\([^)]*\)([\s\S]{0,400}?)\n  [a-zA-Z]+\(/g,
        ),
      ];
      const undecorated = handlers.filter(
        (match) =>
          !match[2].includes('@Roles(') && !match[2].includes('@Public()'),
      );
      check(
        `${controller.split('/').pop()}: all ${handlers.length} handler(s) carry @Roles or @Public`,
        handlers.length > 0 && undecorated.length === 0,
        undecorated.map((m) => m[0].slice(0, 80)),
      );
      check(
        `${controller.split('/').pop()}: SUPER_ADMIN is listed explicitly (RolesGuard gives it no bypass)`,
        source.includes('UserRole.SUPER_ADMIN'),
      );
    }

    for (const adapter of [
      'src/modules/protocols/adapters/opcua.adapter.ts',
      'src/modules/protocols/adapters/bacnet.adapter.ts',
    ]) {
      const source = readSrc(adapter);
      check(
        `${adapter.split('/').pop()}: ends at deviceListener.handleTelemetry()`,
        source.includes('deviceListener.handleTelemetry('),
      );
      check(
        `${adapter.split('/').pop()}: never writes telemetry rows itself`,
        !/getRepository\(\s*Telemetry|telemetryRepository/.test(source),
      );
      check(
        `${adapter.split('/').pop()}: loads its SDK with a dynamic import`,
        /await import\(/.test(source),
      );
    }

    const nbiotSource = readSrc(
      'src/modules/protocols/nbiot/nbiot.service.ts',
    );
    check(
      'nbiot.service.ts: ends at deviceListener.handleTelemetry()',
      nbiotSource.includes('deviceListener.handleTelemetry('),
    );

    for (const type of [
      IntegrationType.NBIOT_HTTP,
      IntegrationType.NBIOT_COAP,
    ]) {
      const manifest = INTEGRATION_CATALOGUE[type];
      check(`catalogue declares ${type}`, !!manifest, manifest);
      check(
        `${type} is honestly hasAdapter:false — a non-dispatchable row in the fan-out is what quarantined working Tuya rows`,
        manifest.hasAdapter === false && isDispatchableType(type) === false,
      );
      check(
        `${type} explains what DOES work, via adapterNote`,
        !!manifest.adapterNote && manifest.adapterNote.length > 40,
      );
    }
    check(
      'nbiot_http declares the inbound path operators must register with the carrier',
      INTEGRATION_CATALOGUE[IntegrationType.NBIOT_HTTP].inboundPath ===
        '/nbiot/uplink/:id',
    );
    check(
      'nbiot_coap declares NO inboundPath — its CoAP server is a raw UDP socket, not an HTTP route',
      INTEGRATION_CATALOGUE[IntegrationType.NBIOT_COAP].inboundPath ===
        undefined,
    );

    // ══════════════════════════════════════════════════════════════════════
    section('5. Migration SQL');
    // ══════════════════════════════════════════════════════════════════════
    // `synchronize: true` built the schema above, so the migration's
    // CREATE TABLE IF NOT EXISTS would be a no-op here. Run it against its own
    // scratch database with only the parent tables it references, which is what
    // proves the SQL itself parses and that every FK target exists.
    const scratch = `${database}_migcheck`;
    const admin = new DataSource({
      type: 'postgres',
      host: process.env.DB_HOST ?? 'localhost',
      port: Number(process.env.DB_PORT ?? 5432),
      username: process.env.DB_USERNAME ?? 'postgres',
      password: process.env.DB_PASSWORD ?? '123456',
      database,
      entities: [],
      synchronize: false,
    });
    await admin.initialize();
    await admin.query(`DROP DATABASE IF EXISTS "${scratch}"`);
    await admin.query(`CREATE DATABASE "${scratch}"`);
    await admin.destroy();

    const scratchSource = new DataSource({
      type: 'postgres',
      host: process.env.DB_HOST ?? 'localhost',
      port: Number(process.env.DB_PORT ?? 5432),
      username: process.env.DB_USERNAME ?? 'postgres',
      password: process.env.DB_PASSWORD ?? '123456',
      database: scratch,
      entities: [],
      synchronize: false,
    });
    await scratchSource.initialize();
    const runner = scratchSource.createQueryRunner();
    await runner.connect();
    await runner.query(`CREATE EXTENSION IF NOT EXISTS "uuid-ossp"`);
    await runner.query(
      `CREATE TABLE "tenants" (id uuid PRIMARY KEY DEFAULT uuid_generate_v4())`,
    );
    await runner.query(
      `CREATE TABLE "assets" (id uuid PRIMARY KEY DEFAULT uuid_generate_v4())`,
    );
    await runner.query(
      `CREATE TABLE "devices" (id uuid PRIMARY KEY DEFAULT uuid_generate_v4())`,
    );
    await runner.query(
      `CREATE TYPE "integrations_type_enum" AS ENUM ('webhook')`,
    );
    await runner.query(
      `CREATE TYPE "devices_protocol_enum" AS ENUM ('generic_mqtt')`,
    );

    const migration = new IndustrialProtocols1788100000000();
    await migration.up(runner);
    check('migration up() applies cleanly', true);

    const tables = await runner.query(
      `SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' ORDER BY table_name`,
    );
    const tableNames = tables.map((t: any) => t.table_name);
    check(
      'all three tables are created',
      ['opcua_servers', 'bacnet_devices', 'nbiot_devices'].every((name) =>
        tableNames.includes(name),
      ),
      tableNames,
    );

    const labels = await runner.query(
      `SELECT enumlabel FROM pg_enum e JOIN pg_type t ON t.oid = e.enumtypid WHERE t.typname = 'integrations_type_enum'`,
    );
    check(
      'integrations_type_enum gains nbiot_http and nbiot_coap',
      ['nbiot_http', 'nbiot_coap'].every((label) =>
        labels.some((row: any) => row.enumlabel === label),
      ),
      labels,
    );
    const protocolLabels = await runner.query(
      `SELECT enumlabel FROM pg_enum e JOIN pg_type t ON t.oid = e.enumtypid WHERE t.typname = 'devices_protocol_enum'`,
    );
    check(
      'devices_protocol_enum gains nb_iot',
      protocolLabels.some((row: any) => row.enumlabel === 'nb_iot'),
      protocolLabels,
    );

    // The partial unique indexes are the point: a soft-deleted row must not
    // hold its identifier hostage.
    const indexes = await runner.query(
      `SELECT indexname, indexdef FROM pg_indexes WHERE schemaname = 'public'`,
    );
    const partial = indexes.filter(
      (i: any) =>
        /UQ_(opcua_servers|bacnet_devices|nbiot_devices)/.test(i.indexname) &&
        /deleted_at IS NULL/.test(i.indexdef),
    );
    // Six: opcua name, bacnet instance, nbiot device, nbiot imei/imsi/iccid.
    check(
      'every uniqueness rule is PARTIAL on deleted_at IS NULL, so a deleted row frees its identifier',
      partial.length === 6,
      indexes
        .filter((i: any) => /^UQ_/.test(i.indexname))
        .map((i: any) => i.indexname),
    );

    // The ECL check constraint: 255 is the modules' "unknown".
    let eclRejected = false;
    const tenantId = (
      await runner.query(`INSERT INTO tenants DEFAULT VALUES RETURNING id`)
    )[0].id;
    const deviceId = (
      await runner.query(`INSERT INTO devices DEFAULT VALUES RETURNING id`)
    )[0].id;
    try {
      await runner.query(
        `INSERT INTO nbiot_devices ("tenantId", "deviceId", "lastEcl") VALUES ($1, $2, 255)`,
        [tenantId, deviceId],
      );
    } catch {
      eclRejected = true;
    }
    check('the database refuses an ECL outside 0–2', eclRejected);

    let instanceRejected = false;
    try {
      await runner.query(
        `INSERT INTO bacnet_devices ("tenantId", name, address, "deviceInstance") VALUES ($1, 'x', '1.2.3.4', 4194303)`,
        [tenantId],
      );
    } catch {
      instanceRejected = true;
    }
    check(
      'the database refuses device instance 4194303 (the BACnet "unknown" wildcard)',
      instanceRejected,
    );

    await migration.down(runner);
    const afterDown = await runner.query(
      `SELECT table_name FROM information_schema.tables WHERE table_schema = 'public'`,
    );
    check(
      'migration down() drops all three tables',
      !afterDown
        .map((t: any) => t.table_name)
        .some((name: string) =>
          ['opcua_servers', 'bacnet_devices', 'nbiot_devices'].includes(name),
        ),
      afterDown.map((t: any) => t.table_name),
    );
    await runner.release();
    await scratchSource.destroy();
  } catch (error) {
    failures++;
    console.error('\nFATAL:', error);
  } finally {
    try {
      await opcuaAdapter?.stop();
    } catch {
      /* already stopped */
    }
    try {
      await bacnetAdapter?.stop();
    } catch {
      /* already stopped */
    }
    try {
      bacnetFixture?.close();
    } catch {
      /* already closed */
    }
    try {
      bacnetRejecter?.close();
    } catch {
      /* already closed */
    }
    try {
      await opcuaServer?.shutdown();
    } catch {
      /* already down */
    }
    try {
      await dataSource?.destroy();
    } catch {
      /* already closed */
    }
  }

  console.log(
    failures === 0
      ? '\nAll checks passed.'
      : `\n${failures} check(s) FAILED.`,
  );
  process.exit(failures === 0 ? 0 : 1);
})();
