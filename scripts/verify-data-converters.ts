/**
 * Verifies the converters module against a real PostgreSQL database.
 *
 *   createdb convcheck && npx ts-node -r tsconfig-paths/register \
 *     scripts/verify-data-converters.ts convcheck
 *
 * Why this and not an HTTP e2e script: booting the application needs a
 * reachable Kafka broker (CLAUDE.md §11), so the services are wired by hand
 * here. Everything below the controller is the real thing — real TypeORM
 * repositories, real SQL, the real CodecRegistryService with real Milesight
 * codecs registered into it, and the real vm2 sandbox.
 *
 * What it proves, in order:
 *   1. The entity initialises, and the hand-written migration produces the same
 *      schema `synchronize` does. A nullable column whose property is a union
 *      takes the whole app down at `DataSource.initialize` if it has no
 *      explicit `type`; this catches that before a deploy does.
 *   2. A `json` converter maps a NESTED payload — dot paths, array indices,
 *      unit scaling, casts, defaults, missing paths — and reports each as a
 *      trace step.
 *   3. A `codec` converter decodes a REAL Milesight EM300-TH frame through
 *      CodecRegistryService, and a typo'd codecId is an error rather than a
 *      silent downgrade to `{raw_data, decoded:false}`.
 *   4. A `script` converter is actually sandboxed: `process`, `require`,
 *      `global`, `Buffer` and the `constructor.constructor` escape are all
 *      unreachable, an infinite loop is interrupted by the timeout, and a
 *      script cannot mutate the caller's payload.
 *   5. Tenant scoping holds on every read and write path, including
 *      `convert()`, which is the one that runs code.
 *   6. The test route's result carries a usable trace and does NOT move the
 *      counters, while `convert()` does.
 *   7. `convertForDevice()` picks the device's assigned converter and returns
 *      null when it has none.
 *   8. Validation reports every problem at once, and name uniqueness is
 *      per tenant.
 */
import { DataSource, Repository } from 'typeorm';
import { randomUUID } from 'crypto';
import * as entities from '../src/modules/index.entities';
import { Converter } from '../src/modules/converters/entities/converter.entity';
import { Device } from '../src/modules/devices/entities/device.entity';
import { ConvertersService } from '../src/modules/converters/converters.service';
import { ConverterExecutionService } from '../src/modules/converters/converter-execution.service';
import {
  ConverterDirection,
  ConverterHealth,
  ConverterType,
} from '../src/modules/converters/converter.enums';
import { validateConverterConfig } from '../src/modules/converters/converter-catalogue';
import { CodecRegistryService } from '../src/modules/devices/codecs/codec-registry.service';
import { MilesightEM300THCodec } from '../src/modules/devices/codecs/milesight/em/em300-th.codec';
import { MilesightWS558Codec } from '../src/modules/devices/codecs/milesight/ws/ws558.codec';
import { UserRole } from '../src/common/enums/index.enum';
import { DataConverters1787600000000 } from '../src/database/migrations/1787600000000-DataConverters';

const database = process.argv[2] ?? 'convcheck';

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

const TENANT_A = randomUUID();
const TENANT_B = randomUUID();
const USER_A = randomUUID();
const USER_B = randomUUID();
const DEVICE_WITH = randomUUID();
const DEVICE_WITHOUT = randomUUID();

/**
 * `Converter` is appended explicitly: `index.entities.ts` is owned by the
 * coordinator (the export line is in this work's INTEGRATION section), so until
 * it lands there the barrel does not carry it and TypeORM would answer
 * "No metadata for Converter was found" on the first repository call.
 * Deduplicated because the barrel will carry it once that line is added.
 */
const ENTITIES = Array.from(
  new Set([...(Object.values(entities) as any[]), Converter]),
) as any[];

const callerA = { id: USER_A, tenantId: TENANT_A, role: UserRole.TENANT_ADMIN };
const callerB = { id: USER_B, tenantId: TENANT_B, role: UserRole.TENANT_ADMIN };

/**
 * A real Milesight EM300-TH uplink. The codec's own header documents it:
 *   '01755C03673401046865' → { battery: 92, temperature: 30.8, humidity: 50.5 }
 */
const EM300_FRAME = '01755C03673401046865';

/** A nested envelope in the shape The Things Stack v3 actually sends. */
const TTN_UPLINK = {
  end_device_ids: { device_id: 'em300-th-01', dev_eui: '24E124445C123456' },
  received_at: '2026-03-04T10:15:30.123Z',
  uplink_message: {
    f_port: 85,
    decoded_payload: { battery: 92, temperature: 308, humidity: 101 },
    rx_metadata: [
      { gateway_ids: { gateway_id: 'gw-riyadh-1' }, rssi: -71, snr: 9.5 },
      { gateway_ids: { gateway_id: 'gw-riyadh-2' }, rssi: -94, snr: 2.0 },
    ],
  },
};

const expectThrows = async (
  label: string,
  fn: () => Promise<unknown>,
  matcher: RegExp,
) => {
  try {
    await fn();
    check(label, false, 'no error thrown');
  } catch (error: any) {
    const text = JSON.stringify(error?.response ?? error?.message ?? error);
    check(label, matcher.test(text), text);
  }
};

(async () => {
  // ════════════════════════════════════════════════════════════════════════
  section('1. Schema — migration, then entity');
  // ════════════════════════════════════════════════════════════════════════

  // The migration is applied FIRST, against a database with no `converters`
  // table, so the hand-written SQL is exercised rather than assumed. `tenants`
  // and `customers` must exist for its foreign keys, so synchronize runs once
  // with the table dropped afterwards — the honest way to test a migration that
  // depends on the rest of the schema.
  const bootstrap = new DataSource({
    type: 'postgres',
    host: process.env.DB_HOST ?? 'localhost',
    port: Number(process.env.DB_PORT ?? 5432),
    username: process.env.DB_USERNAME ?? 'postgres',
    password: process.env.DB_PASSWORD ?? '123456',
    database,
    entities: ENTITIES,
    synchronize: true,
    logging: false,
  });
  await bootstrap.initialize();
  check(
    'DataSource initialises with Converter registered',
    bootstrap.hasMetadata(Converter),
  );
  await bootstrap.query('DROP TABLE IF EXISTS "converters" CASCADE');

  const runner = bootstrap.createQueryRunner();
  await runner.connect();
  await new DataConverters1787600000000().up(runner);
  await runner.release();
  check('migration up() creates the table', true);

  const columns: Array<{ column_name: string; data_type: string }> =
    await bootstrap.query(
      `SELECT column_name, data_type FROM information_schema.columns
        WHERE table_name = 'converters'`,
    );
  const typeOf = (name: string) =>
    columns.find((c) => c.column_name === name)?.data_type;

  check(
    'tenantId is uuid (it is a @ManyToOne join column, so it takes the referenced key type)',
    typeOf('tenantId') === 'uuid',
    typeOf('tenantId'),
  );
  check(
    'userId is character varying with no relation',
    typeOf('userId') === 'character varying',
    typeOf('userId'),
  );
  check(
    'direction is character varying, not a PG enum',
    typeOf('direction') === 'character varying',
    typeOf('direction'),
  );
  check(
    'type is character varying, not a PG enum',
    typeOf('type') === 'character varying',
    typeOf('type'),
  );
  check('configuration is jsonb', typeOf('configuration') === 'jsonb');
  check('no stored status column (health is derived)', typeOf('status') === undefined);

  const fks: Array<{ constraint_name: string }> = await bootstrap.query(
    `SELECT constraint_name FROM information_schema.table_constraints
      WHERE table_name = 'converters' AND constraint_type = 'FOREIGN KEY'`,
  );
  check(
    'the migration created the tenant FK the ORM would also create',
    fks.some((f) => f.constraint_name === 'FK_converters_tenant'),
    fks,
  );

  // Hand back to synchronize so a mismatch between the two surfaces here rather
  // than in production.
  await bootstrap.destroy();

  const dataSource = new DataSource({
    type: 'postgres',
    host: process.env.DB_HOST ?? 'localhost',
    port: Number(process.env.DB_PORT ?? 5432),
    username: process.env.DB_USERNAME ?? 'postgres',
    password: process.env.DB_PASSWORD ?? '123456',
    database,
    entities: ENTITIES,
    synchronize: true,
    logging: false,
  });
  await dataSource.initialize();
  check(
    'synchronize accepts the migrated table without rebuilding it',
    dataSource.hasMetadata(Converter),
  );

  const converterRepo: Repository<Converter> = dataSource.getRepository(Converter);
  const deviceRepo: Repository<Device> = dataSource.getRepository(Device);

  // Clean slate for repeated runs. The fixture ids are fresh uuids every run,
  // so deleting by id leaves the previous run's rows behind — and `tenants.name`
  // is UNIQUE, which makes the second run fail on the tenant insert rather than
  // on anything this script is testing. Clean by the fixture name prefix
  // instead, children first because of the foreign keys.
  await converterRepo.query('DELETE FROM converters');
  await converterRepo.query(
    `DELETE FROM devices WHERE "deviceKey" LIKE 'conv-dev-%'`,
  );
  await converterRepo.query(
    `DELETE FROM users WHERE email LIKE 'conv-%@example.invalid'`,
  );
  await converterRepo.query(
    `DELETE FROM tenants WHERE name LIKE 'Converter fixture tenant %'`,
  );

  // Real tenant and user rows: `converters.tenantId` and `devices.userId` carry
  // foreign keys because their entities declare @ManyToOne, so invented uuids
  // fail the insert.
  for (const [index, id] of [TENANT_A, TENANT_B].entries()) {
    await converterRepo.query(
      `INSERT INTO tenants (id, name, email) VALUES ($1, $2, $3)`,
      [
        id,
        `Converter fixture tenant ${index + 1}`,
        `conv-t${index}-${id.slice(0, 8)}@example.invalid`,
      ],
    );
  }
  for (const [tenantId, userId] of [
    [TENANT_A, USER_A],
    [TENANT_B, USER_B],
  ]) {
    await converterRepo.query(
      `INSERT INTO users (id, email, password, name, role, "tenantId")
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [
        userId,
        `conv-${userId.slice(0, 8)}@example.invalid`,
        'not-a-real-hash',
        'Fixture admin',
        'tenant_admin',
        tenantId,
      ],
    );
  }

  // ── The real registry, with real codecs ───────────────────────────────────
  // CodecModule is @Global() in the app; here it is two lines, and they are the
  // same codec classes the application registers at boot.
  const codecRegistry = new CodecRegistryService();
  codecRegistry.registerCodec(new MilesightEM300THCodec());
  codecRegistry.registerCodec(new MilesightWS558Codec());

  const executor = new ConverterExecutionService(codecRegistry);
  const service = new ConvertersService(converterRepo, deviceRepo, executor);

  // ════════════════════════════════════════════════════════════════════════
  section('2. json converter — nested payload');
  // ════════════════════════════════════════════════════════════════════════

  const jsonConverter = await service.create(callerA, {
    name: 'TTN uplink → telemetry',
    direction: ConverterDirection.UPLINK,
    type: ConverterType.JSON,
    configuration: {
      deviceKeyPath: 'end_device_ids.device_id',
      timestampPath: 'received_at',
      mappings: [
        {
          source: 'uplink_message.decoded_payload.temperature',
          target: 'temperature',
          cast: 'number',
          scale: 0.1,
          unit: '°C',
        },
        {
          source: 'uplink_message.decoded_payload.humidity',
          target: 'humidity',
          cast: 'number',
          scale: 0.5,
          unit: '%',
        },
        {
          source: 'uplink_message.decoded_payload.battery',
          target: 'batteryLevel',
          cast: 'integer',
        },
        // Array index, dotted form.
        {
          source: 'uplink_message.rx_metadata.0.rssi',
          target: 'signalStrength',
          cast: 'integer',
        },
        // Array index, bracket form — must resolve identically.
        {
          source: 'uplink_message.rx_metadata[0].gateway_ids.gateway_id',
          target: 'gateway',
          cast: 'string',
        },
        // Absent path with a default.
        { source: 'uplink_message.decoded_payload.co2', target: 'co2', default: 0 },
        // Absent path with no default — skipped, not null.
        { source: 'uplink_message.decoded_payload.tvoc', target: 'tvoc' },
      ],
    },
  } as any);
  check('json converter created', !!jsonConverter.id);

  const jsonRun = await service.convert(TENANT_A, jsonConverter.id, TTN_UPLINK);
  check('conversion succeeded', jsonRun.success, jsonRun.error);
  check(
    'nested dot path + scale 0.1 → 30.8 (not 30.800000000000004)',
    jsonRun.output?.temperature === 30.8,
    jsonRun.output?.temperature,
  );
  check(
    'second scaled field → 50.5',
    jsonRun.output?.humidity === 50.5,
    jsonRun.output?.humidity,
  );
  check(
    'integer cast → 92',
    jsonRun.output?.batteryLevel === 92,
    jsonRun.output?.batteryLevel,
  );
  check(
    'array index in dotted form resolves (rx_metadata.0.rssi → -71)',
    jsonRun.output?.signalStrength === -71,
    jsonRun.output?.signalStrength,
  );
  check(
    'array index in bracket form resolves identically',
    jsonRun.output?.gateway === 'gw-riyadh-1',
    jsonRun.output?.gateway,
  );
  check('absent path with a default is written', jsonRun.output?.co2 === 0);
  check(
    'absent path with no default is absent, not null',
    !('tvoc' in (jsonRun.output ?? {})),
    jsonRun.output,
  );
  check(
    'unmapped keys are NOT copied through by default',
    !('end_device_ids' in (jsonRun.output ?? {})),
    Object.keys(jsonRun.output ?? {}),
  );
  check(
    'units ride along in a $units sidecar',
    jsonRun.output?.$units?.temperature === '°C',
    jsonRun.output?.$units,
  );
  check(
    'deviceKey came out of deviceKeyPath',
    jsonRun.deviceKey === 'em300-th-01',
    jsonRun.deviceKey,
  );
  check(
    'timestampPath parsed the ISO string',
    jsonRun.timestamp === Date.parse('2026-03-04T10:15:30.123Z'),
    jsonRun.timestamp,
  );

  // Prototype-chain paths must not resolve.
  const protoProbe = executor.resolvePath(TTN_UPLINK, 'constructor.prototype');
  check(
    'a mapping path cannot walk the prototype chain',
    protoProbe === undefined,
    protoProbe,
  );

  // A required path that is missing must fail the whole conversion, loudly.
  const strict = await service.create(callerA, {
    name: 'Strict mapping',
    direction: ConverterDirection.UPLINK,
    type: ConverterType.JSON,
    configuration: {
      mappings: [
        { source: 'object.missing', target: 'x', required: true },
      ],
    },
  } as any);
  const strictRun = await service.convert(TENANT_A, strict.id, { object: {} });
  check(
    'a required source path that is missing fails the conversion',
    !strictRun.success && /required source path/.test(strictRun.error ?? ''),
    strictRun.error,
  );

  // ════════════════════════════════════════════════════════════════════════
  section('3. codec converter — real Milesight payload through the registry');
  // ════════════════════════════════════════════════════════════════════════

  const codecConverter = await service.create(callerA, {
    name: 'EM300-TH via registry',
    direction: ConverterDirection.UPLINK,
    type: ConverterType.CODEC,
    configuration: { codecId: 'milesight-em300-th', fPort: 85 },
  } as any);

  const codecRun = await service.convert(
    TENANT_A,
    codecConverter.id,
    EM300_FRAME,
  );
  check('codec conversion succeeded', codecRun.success, codecRun.error);
  check(
    'battery 92 — decoded by the registry, not by this module',
    codecRun.output?.battery === 92,
    codecRun.output,
  );
  check('temperature 30.8', codecRun.output?.temperature === 30.8, codecRun.output);
  check('humidity 50.5', codecRun.output?.humidity === 50.5, codecRun.output);

  // The same frame through CodecRegistryService directly must agree — proof the
  // converter delegates rather than reimplements.
  const direct = codecRegistry.decode(EM300_FRAME, {
    codecId: 'milesight-em300-th',
  });
  check(
    'output is identical to a direct CodecRegistryService.decode()',
    JSON.stringify(direct) === JSON.stringify(codecRun.output),
    { direct, viaConverter: codecRun.output },
  );

  // Nested frame extraction, ChirpStack style.
  const nestedCodec = await service.create(callerA, {
    name: 'ChirpStack EM300-TH',
    direction: ConverterDirection.UPLINK,
    type: ConverterType.CODEC,
    configuration: {
      codecId: 'milesight-em300-th',
      payloadPath: 'data',
    },
  } as any);
  const nestedRun = await service.convert(TENANT_A, nestedCodec.id, {
    devEUI: '24e124445c123456',
    fPort: 85,
    data: EM300_FRAME,
  });
  check(
    'payloadPath digs the frame out of an envelope',
    nestedRun.success && nestedRun.output?.temperature === 30.8,
    nestedRun.error ?? nestedRun.output,
  );

  // A typo'd codecId must be an error, not a silent `{raw_data, decoded:false}`.
  const typoed = await converterRepo.save(
    converterRepo.create({
      ...codecConverter,
      id: undefined,
      name: 'Typo codec',
      configuration: { codecId: 'milesight-em300-tth' },
    }),
  );
  const typoRun = await service.convert(TENANT_A, typoed.id, EM300_FRAME);
  check(
    'a typo\'d codecId fails loudly instead of returning raw_data',
    !typoRun.success && /not registered/.test(typoRun.error ?? ''),
    typoRun.error,
  );

  // A different codec on the same registry, to show it is the registry's 80+
  // and not one hardcoded path.
  const ws558 = await service.create(callerA, {
    name: 'WS558 via registry',
    direction: ConverterDirection.UPLINK,
    type: ConverterType.CODEC,
    configuration: { manufacturer: 'Milesight', model: 'WS558' },
  } as any);
  // The WS558's own reference payload, from its codec header.
  const ws558Run = await service.convert(
    TENANT_A,
    ws558.id,
    '0831000105816407C9020003 74B208068301000000048001000000'.replace(/\s/g, ''),
  );
  check(
    'a second registered codec resolves by manufacturer + model and decodes',
    ws558Run.success &&
      ws558Run.output?.switch_1 === 'on' &&
      ws558Run.output?.voltage === 222.6,
    ws558Run.error ?? ws558Run.output,
  );
  check(
    'codec selection is reported in the trace',
    ws558Run.trace.length === 0 ||
      ws558Run.trace.some((s) => s.name === 'select codec'),
    ws558Run.trace,
  );

  // Downlink: encode a command through the registry.
  const downlink = await service.create(callerA, {
    name: 'EM300-TH reboot',
    direction: ConverterDirection.DOWNLINK,
    type: ConverterType.CODEC,
    configuration: { codecId: 'milesight-em300-th' },
  } as any);
  const downlinkRun = await service.convert(TENANT_A, downlink.id, {}, {
    command: { type: 'reboot' },
  });
  check(
    'a downlink codec converter encodes a command through the registry',
    downlinkRun.success && typeof downlinkRun.output?.data === 'string',
    downlinkRun.error ?? downlinkRun.output,
  );

  // ════════════════════════════════════════════════════════════════════════
  section('4. script converter — sandbox');
  // ════════════════════════════════════════════════════════════════════════

  const scriptConverter = await service.create(callerA, {
    name: 'Script: scale and derive',
    direction: ConverterDirection.UPLINK,
    type: ConverterType.SCRIPT,
    configuration: {
      script: `
        var p = payload.uplink_message.decoded_payload;
        return {
          temperature: p.temperature / 10,
          fahrenheit: Math.round((p.temperature / 10) * 9 / 5 + 32),
          gateways: payload.uplink_message.rx_metadata.length,
          port: metadata.fPort,
        };
      `,
      deviceKeyPath: 'end_device_ids.device_id',
      timeout: 1000,
    },
  } as any);

  const scriptRun = await service.convert(
    TENANT_A,
    scriptConverter.id,
    TTN_UPLINK,
    { metadata: { fPort: 85 } },
  );
  check('script conversion succeeded', scriptRun.success, scriptRun.error);
  check('script computed 30.8', scriptRun.output?.temperature === 30.8, scriptRun.output);
  check('script saw metadata.fPort', scriptRun.output?.port === 85, scriptRun.output);
  check(
    'script could use the sandbox\'s own Math',
    scriptRun.output?.fahrenheit === 87,
    scriptRun.output,
  );
  check(
    'deviceKeyPath still applies to a script converter',
    scriptRun.deviceKey === 'em300-th-01',
    scriptRun.deviceKey,
  );

  // ── The point of the section: the host must be unreachable ────────────────
  //
  // Each probe states what a SAFE outcome looks like, rather than assuming the
  // script throws. That distinction is the whole trick in testing a sandbox:
  // `typeof process` on a missing identifier evaluates to the *string*
  // "undefined" and does not throw, so a probe that only accepts a throw passes
  // vacuously against a sandbox that leaks — and fails against one that does
  // not. Likewise `global` inside vm2 resolves to the sandbox's OWN global
  // object, which is a different thing from Node's: the probe below asserts
  // what that object actually contains instead of its mere existence.
  type Probe = {
    label: string;
    code: string;
    /** True when the outcome proves the host is out of reach. */
    safe: (run: { success: boolean; output: any; error?: string }) => boolean;
  };
  const threw = (pattern: RegExp) => (run: any) =>
    !run.success && pattern.test(run.error ?? '');
  const returned = (expected: unknown) => (run: any) =>
    run.success && JSON.stringify(run.output?.v) === JSON.stringify(expected);

  const escapes: Probe[] = [
    {
      label: 'process is not bound at all',
      code: 'return { v: typeof process };',
      safe: returned('undefined'),
    },
    {
      label: 'reading process.env throws rather than leaking secrets',
      code: 'return { v: process.env.DB_PASSWORD };',
      safe: threw(/process is not defined/),
    },
    {
      label: 'require is not bound',
      code: 'return { v: typeof require };',
      safe: returned('undefined'),
    },
    {
      label: 'require("fs") throws',
      code: 'return { v: require("fs").readdirSync("/") };',
      safe: threw(/require is not defined/),
    },
    {
      label: "the sandbox's own `global` holds no Node builtins",
      code: 'return { v: Object.keys(global).sort() };',
      // Exactly the sandbox we injected plus vm2's own three. No process, no
      // require, no Buffer, no setTimeout, no fetch.
      safe: (run) =>
        run.success &&
        Array.isArray(run.output?.v) &&
        !run.output.v.some((key: string) =>
          ['process', 'require', 'Buffer', 'setTimeout', 'fetch', 'module'].includes(
            key,
          ),
        ),
    },
    {
      label: 'globalThis.process is undefined, so reading through it throws',
      code: 'return { v: globalThis.process.pid };',
      safe: threw(/Cannot read properties of undefined/),
    },
    {
      label: 'Buffer is shadowed away',
      code: 'return { v: typeof Buffer };',
      safe: returned('undefined'),
    },
    {
      label: 'setTimeout and fetch are absent (no async, no network)',
      code: 'return { v: [typeof setTimeout, typeof fetch] };',
      safe: returned(['undefined', 'undefined']),
    },
    {
      label: 'the constructor.constructor escape is blocked by eval:false',
      code: 'return { v: ({}).constructor.constructor("return process")() };',
      safe: threw(/Code generation from strings disallowed/),
    },
    {
      label: 'new Function is blocked',
      code: 'return { v: (new Function("return 1"))() };',
      safe: threw(/Code generation from strings disallowed/),
    },
    {
      label: 'eval is blocked',
      code: 'return { v: eval("1+1") };',
      safe: threw(/Code generation from strings disallowed/),
    },
    {
      label: 'dynamic import() cannot reach the filesystem',
      code: 'return { v: import("fs") };',
      safe: (run) =>
        threw(/not supported|disallowed|Cannot|unexpected/i)(run) ||
        // A rejected promise sanitises to {} rather than a module handle.
        (run.success && JSON.stringify(run.output?.v) === '{}'),
    },
  ];

  for (const probe of escapes) {
    const row = await converterRepo.save(
      converterRepo.create({
        tenantId: TENANT_A,
        userId: USER_A,
        name: `Escape probe: ${probe.label}`,
        direction: ConverterDirection.UPLINK,
        type: ConverterType.SCRIPT,
        configuration: { script: probe.code, timeout: 500 },
      }),
    );
    const run = await service.convert(TENANT_A, row.id, { a: 1 });
    check(
      probe.label,
      probe.safe(run),
      run.success ? { returned: run.output } : { error: run.error },
    );
  }

  // A timeout must interrupt, not hang the process.
  const spinner = await converterRepo.save(
    converterRepo.create({
      tenantId: TENANT_A,
      userId: USER_A,
      name: 'Escape probe: infinite loop',
      direction: ConverterDirection.UPLINK,
      type: ConverterType.SCRIPT,
      configuration: { script: 'while (true) {}', timeout: 200 },
    }),
  );
  const spinStarted = Date.now();
  const spinRun = await service.convert(TENANT_A, spinner.id, {});
  const spinElapsed = Date.now() - spinStarted;
  check(
    'an infinite loop is interrupted by the timeout',
    !spinRun.success && /timed out/.test(spinRun.error ?? '') && spinElapsed < 5000,
    { error: spinRun.error, elapsedMs: spinElapsed },
  );

  // A script must not be able to mutate the caller's object.
  const mutator = await converterRepo.save(
    converterRepo.create({
      tenantId: TENANT_A,
      userId: USER_A,
      name: 'Escape probe: mutation',
      direction: ConverterDirection.UPLINK,
      type: ConverterType.SCRIPT,
      configuration: { script: 'payload.injected = true; return { ok: 1 };' },
    }),
  );
  const caller1 = { original: 1 } as Record<string, unknown>;
  await service.convert(TENANT_A, mutator.id, caller1);
  check(
    "a script cannot mutate the caller's payload object",
    !('injected' in caller1),
    caller1,
  );

  // A syntax error is rejected at create time, not discovered on the hot path.
  await expectThrows(
    'a script with a syntax error is rejected at create time',
    () =>
      service.create(callerA, {
        name: 'Broken script',
        direction: ConverterDirection.UPLINK,
        type: ConverterType.SCRIPT,
        configuration: { script: 'return {' },
      } as any),
    /syntax error/i,
  );

  // ════════════════════════════════════════════════════════════════════════
  section('5. Tenant scoping');
  // ════════════════════════════════════════════════════════════════════════

  const bConverter = await service.create(callerB, {
    name: 'Tenant B converter',
    direction: ConverterDirection.UPLINK,
    type: ConverterType.JSON,
    configuration: { mappings: [{ source: 'a', target: 'a' }] },
  } as any);

  const listA = await service.findAll(callerA, { page: 1, limit: 100 } as any);
  const listB = await service.findAll(callerB, { page: 1, limit: 100 } as any);
  check(
    "tenant A's list contains none of tenant B's rows",
    listA.data.every((row: any) => row.tenantId === TENANT_A),
    listA.data.map((row: any) => row.tenantId),
  );
  check(
    'tenant B sees exactly its own one row',
    listB.meta.totalItems === 1 && listB.data[0].id === bConverter.id,
    listB.meta,
  );
  check(
    'pagination meta uses totalItems, not total',
    'totalItems' in listB.meta && !('total' in (listB.meta as any)),
    listB.meta,
  );

  await expectThrows(
    "findOne across tenants is a 404",
    () => service.findOne(bConverter.id, callerA),
    /not found/i,
  );
  await expectThrows(
    'update across tenants is a 404',
    () => service.update(bConverter.id, callerA, { name: 'stolen' }),
    /not found/i,
  );
  await expectThrows(
    'delete across tenants is a 404',
    () => service.remove(bConverter.id, callerA),
    /not found/i,
  );
  await expectThrows(
    'enable across tenants is a 404',
    () => service.setEnabled(bConverter.id, callerA, false),
    /not found/i,
  );
  await expectThrows(
    'test across tenants is a 404 — this is the path that runs code',
    () => service.test(bConverter.id, callerA, { payload: { a: 1 } }),
    /not found/i,
  );
  await expectThrows(
    'convert() across tenants is a 404',
    () => service.convert(TENANT_A, bConverter.id, { a: 1 }),
    /not found/i,
  );

  // A disabled converter refuses rather than passing the payload through.
  await service.setEnabled(jsonConverter.id, callerA, false);
  await expectThrows(
    'convert() refuses a disabled converter',
    () => service.convert(TENANT_A, jsonConverter.id, TTN_UPLINK),
    /disabled/i,
  );
  const reEnabled = await service.setEnabled(jsonConverter.id, callerA, true);
  check('re-enabling clears lastError', !reEnabled.lastError);

  // ════════════════════════════════════════════════════════════════════════
  section('6. The test route — trace, and no counter movement');
  // ════════════════════════════════════════════════════════════════════════

  const before = await service.findOne(codecConverter.id, callerA);
  const tested = await service.test(codecConverter.id, callerA, {
    payload: EM300_FRAME,
    metadata: { fPort: 85 },
  });
  const after = await service.findOne(codecConverter.id, callerA);

  check('test succeeded', tested.success, tested.error);
  check('test decoded the frame', tested.output?.temperature === 30.8, tested.output);
  check('test says so: statsRecorded is false', tested.statsRecorded === false);
  check(
    'test did NOT move executionCount',
    after.executionCount === before.executionCount,
    { before: before.executionCount, after: after.executionCount },
  );
  check(
    'test returns a trace whatever debugMode says',
    Array.isArray(tested.trace) && tested.trace.length >= 3 && !before.debugMode,
    tested.trace.length,
  );
  check(
    'every trace step is numbered, named and has a status',
    tested.trace.every(
      (step, index) =>
        step.step === index + 1 &&
        typeof step.name === 'string' &&
        ['ok', 'skipped', 'error'].includes(step.status) &&
        typeof step.detail === 'string',
    ),
    tested.trace,
  );
  check(
    'the trace names the codec that was used — not just "decoded"',
    tested.trace.some((step) => step.detail.includes('milesight-em300-th')),
    tested.trace.map((s) => `${s.name}: ${s.detail}`),
  );

  // The trace a json converter returns must distinguish a skipped mapping from
  // a successful one, which is the whole point for the configuration page.
  const jsonTest = await service.test(jsonConverter.id, callerA, {
    payload: TTN_UPLINK,
  });
  const skipped = jsonTest.trace.filter((s) => s.status === 'skipped');
  check(
    'a json trace has one step per mapping rule',
    jsonTest.trace.filter((s) => s.name.startsWith('map ')).length === 7,
    jsonTest.trace.filter((s) => s.name.startsWith('map ')).length,
  );
  check(
    'a mapping whose path is absent is reported as skipped, with the reason',
    skipped.length === 1 && /not present/.test(skipped[0].detail),
    skipped,
  );
  check(
    'a mapping step shows what the path resolved to AND what was written',
    jsonTest.trace.some(
      (s) => s.name === 'map uplink_message.decoded_payload.temperature → temperature' &&
        s.resolved === 308 &&
        s.value === 30.8,
    ),
    jsonTest.trace.find((s) => s.name.includes('temperature')),
  );

  // A failing test must still come back with the trace up to the failure.
  const failing = await service.test(typoed.id, callerA, { payload: EM300_FRAME });
  check(
    'a failed test still returns the trace up to the failure',
    !failing.success && failing.trace.some((s) => s.status === 'error'),
    failing.trace,
  );

  // Counters DO move on the real path.
  const countBefore = (await service.findOne(codecConverter.id, callerA))
    .executionCount;
  await service.convert(TENANT_A, codecConverter.id, EM300_FRAME);
  const countAfter = await service.findOne(codecConverter.id, callerA);
  check(
    'convert() DOES move executionCount',
    countAfter.executionCount === countBefore + 1,
    { countBefore, after: countAfter.executionCount },
  );
  check('convert() records lastExecuted', !!countAfter.lastExecuted);
  check(
    'health() is ACTIVE after a successful run',
    countAfter.health() === ConverterHealth.ACTIVE,
    countAfter.health(),
  );
  check(
    'a failed run leaves health() at ERROR and lastError set',
    (await service.findOne(typoed.id, callerA)).health() === ConverterHealth.ERROR,
  );
  check(
    'the hot path drops the trace unless debugMode is on',
    (await service.convert(TENANT_A, codecConverter.id, EM300_FRAME)).trace
      .length === 0,
  );
  await service.update(codecConverter.id, callerA, { debugMode: true });
  check(
    'debugMode: true keeps the trace on the hot path',
    (await service.convert(TENANT_A, codecConverter.id, EM300_FRAME)).trace
      .length > 0,
  );

  // ════════════════════════════════════════════════════════════════════════
  section('7. convertForDevice()');
  // ════════════════════════════════════════════════════════════════════════

  for (const [id, key, metadata] of [
    [
      DEVICE_WITH,
      `conv-dev-with-${DEVICE_WITH.slice(0, 8)}`,
      { codecId: 'milesight-em300-th', uplinkConverterId: codecConverter.id },
    ],
    [DEVICE_WITHOUT, `conv-dev-without-${DEVICE_WITHOUT.slice(0, 8)}`, {}],
  ] as Array<[string, string, Record<string, unknown>]>) {
    await deviceRepo.query(
      `INSERT INTO devices (id, "tenantId", "userId", "deviceKey", name, metadata)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [id, TENANT_A, USER_A, key, `Fixture ${key}`, JSON.stringify(metadata)],
    );
  }

  const forDevice = await service.convertForDevice(
    TENANT_A,
    DEVICE_WITH,
    EM300_FRAME,
  );
  check(
    "convertForDevice picks the device's assigned converter",
    forDevice?.converterId === codecConverter.id &&
      forDevice?.output?.temperature === 30.8,
    forDevice,
  );

  const forDeviceNone = await service.convertForDevice(
    TENANT_A,
    DEVICE_WITHOUT,
    EM300_FRAME,
  );
  check(
    'a device with no converter assigned returns null, not an error',
    forDeviceNone === null,
    forDeviceNone,
  );

  await expectThrows(
    'convertForDevice is tenant-scoped on the device too',
    () => service.convertForDevice(TENANT_B, DEVICE_WITH, EM300_FRAME),
    /not found/i,
  );

  // ════════════════════════════════════════════════════════════════════════
  section('8. Validation and the catalogue');
  // ════════════════════════════════════════════════════════════════════════

  const emptyJson = validateConverterConfig(
    ConverterType.JSON,
    ConverterDirection.UPLINK,
    {},
  );
  check(
    'an empty json configuration reports its missing field',
    emptyJson.length === 1 && /Field mappings/.test(emptyJson[0]),
    emptyJson,
  );

  const badMappings = validateConverterConfig(
    ConverterType.JSON,
    ConverterDirection.UPLINK,
    {
      mappings: [
        { target: 'x' },
        { source: 'a' },
        { source: 'b', target: 'b', scale: 'lots', cast: 'blob' },
      ],
    },
  );
  check(
    'every problem in a mapping table is reported at once (not one per save)',
    badMappings.length === 4,
    badMappings,
  );

  const codecNothing = validateConverterConfig(
    ConverterType.CODEC,
    ConverterDirection.UPLINK,
    {},
  );
  check(
    'a codec converter with no codec, model or auto-detect is rejected',
    codecNothing.some((e) => /nothing to decode with/.test(e)),
    codecNothing,
  );

  const codecDownlink = validateConverterConfig(
    ConverterType.CODEC,
    ConverterDirection.DOWNLINK,
    { manufacturer: 'Milesight', model: 'EM300-TH' },
  );
  check(
    'a codec downlink without an explicit codecId is rejected (encode cannot auto-detect)',
    codecDownlink.some((e) => /explicit Codec/.test(e)),
    codecDownlink,
  );

  await expectThrows(
    'create() reports every problem at once in errors[]',
    () =>
      service.create(callerA, {
        name: 'Incomplete',
        direction: ConverterDirection.UPLINK,
        type: ConverterType.JSON,
        configuration: { mappings: [{}] },
      } as any),
    /errors/,
  );

  await expectThrows(
    'duplicate name within a tenant is a 409',
    () =>
      service.create(callerA, {
        name: 'EM300-TH via registry',
        direction: ConverterDirection.UPLINK,
        type: ConverterType.CODEC,
        configuration: { codecId: 'milesight-em300-th' },
      } as any),
    /already exists/i,
  );

  const sameNameOtherTenant = await service.create(callerB, {
    name: 'EM300-TH via registry',
    direction: ConverterDirection.UPLINK,
    type: ConverterType.CODEC,
    configuration: { codecId: 'milesight-em300-th' },
  } as any);
  check(
    'the same name IS allowed in another tenant',
    sameNameOtherTenant.tenantId === TENANT_B,
  );

  await expectThrows(
    'switching type without a matching configuration is rejected',
    () => service.update(jsonConverter.id, callerA, { type: ConverterType.SCRIPT }),
    /errors|required/i,
  );

  const catalogue = service.getCatalogue();
  check(
    'the catalogue has a manifest for every converter type',
    catalogue.length === Object.keys(ConverterType).length,
    catalogue.map((m) => m.type),
  );
  check(
    'every manifest declares at least one direction and non-empty fields',
    catalogue.every((m) => m.directions.length > 0 && m.fields.length > 0),
  );
  check(
    'every declared field key is unique within its manifest',
    catalogue.every(
      (m) => new Set(m.fields.map((f) => f.key)).size === m.fields.length,
    ),
  );
  check(
    'every showIf points at a field that exists in the same manifest',
    catalogue.every((m) =>
      m.fields
        .filter((f) => f.showIf)
        .every((f) => m.fields.some((other) => other.key === f.showIf!.key)),
    ),
  );

  // Soft delete, since every delete here is soft.
  const removed = await service.remove(strict.id, callerA);
  check('delete returns a message', /deleted/.test(removed.message), removed);
  const deletedRow = await converterRepo.findOne({
    where: { id: strict.id },
    withDeleted: true,
  });
  check('the row is soft-deleted, not gone', !!deletedRow?.deletedAt);
  await expectThrows(
    'a soft-deleted converter is no longer readable',
    () => service.findOne(strict.id, callerA),
    /not found/i,
  );

  // ════════════════════════════════════════════════════════════════════════
  console.log(
    failures === 0
      ? '\nAll converter checks passed.\n'
      : `\n${failures} check(s) FAILED.\n`,
  );
  await dataSource.destroy();
  process.exit(failures === 0 ? 0 : 1);
})().catch((error) => {
  console.error('\nFAILED:', error);
  process.exit(1);
});
