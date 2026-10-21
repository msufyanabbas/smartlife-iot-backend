/**
 * Verifies two-way device RPC: correlation, timeout, persistence, and the
 * CoAP response path — against a real PostgreSQL database.
 *
 *   createdb transportcheck
 *   npx ts-node --transpile-only -r tsconfig-paths/register \
 *     scripts/verify-device-rpc.ts transportcheck
 *
 * What is real here: RpcCorrelatorService, GatewayService, the real
 * DeviceCommandsService writing real `device_commands` rows, and — for the
 * CoAP leg — a real CoAPAdapter answering a real UDP request.
 *
 * What is stubbed, and why: MQTTService.publish (there is no broker in this
 * environment; the stub plays the device, publishing a response or staying
 * silent) and DevicesService.findByDeviceKey (an access check, not the thing
 * under test). RpcResponseListener's own MQTT client cannot connect either, so
 * its message handler is invoked directly with the exact (topic, Buffer) pair
 * the broker would deliver — that exercises the real topic parsing and the
 * real correlation call, which is the part that can be wrong.
 *
 * What it proves, in order:
 *   1. A device response RESOLVES the pending request, and the pending map is
 *      EMPTY afterwards.
 *   2. A missing response TIMES OUT cleanly, and the map is EMPTY afterwards.
 *   3. TWO CONCURRENT REQUESTS TO THE SAME DEVICE DO NOT CROSS their
 *      responses — the thing `id: Date.now().toString()` could not guarantee.
 *   4. Correlation ids are unique even when issued in the same millisecond.
 *   5. The outcome is PERSISTED: a device_commands row goes SENDING →
 *      DELIVERED → COMPLETED (with the device payload) or → FAILED (with the
 *      timeout reason), so command history reflects what happened rather than
 *      only what was sent.
 *   6. The map does not leak on reconnect: a broker disconnect fails every
 *      pending request instead of stranding it.
 *   7. A late or mis-addressed response is dropped, not matched to something
 *      else.
 *   8. A device answering over CoAP (POST /api/v1/{token}/rpc) resolves the
 *      pending request through the SAME correlator.
 */
import { DataSource, Repository } from 'typeorm';
import { randomUUID } from 'crypto';
import * as coap from 'coap';
import * as entities from '../src/modules/index.entities';
import { Device } from '../src/modules/devices/entities/device.entity';
import { DeviceCommand } from '../src/modules/device-commands/entities/device-commands.entity';
import { GatewayService } from '../src/modules/gateway/gateway.service';
import { RpcResponseListener } from '../src/modules/gateway/rpc-response.listener';
import { RpcCorrelatorService } from '../src/modules/protocols/rpc-correlator.service';
import { DeviceCommandsService } from '../src/modules/device-commands/device-commands.service';
import { CoAPAdapter } from '../src/modules/protocols/adapters/coap.adapter';
import { Lwm2mService } from '../src/modules/protocols/lwm2m/lwm2m.service';
import { DeviceListenerService } from '../src/modules/protocols/device-listener.service';
import { CodecRegistryService } from '../src/modules/devices/codecs/codec-registry.service';
import { DeviceStatus, DeviceType } from '../src/common/enums/device.enum';
import { DeviceAuthService } from '../src/modules/device-auth/device-auth.service';
import {
  CredentialsType,
  DeviceCredentials,
} from '../src/modules/devices/entities/device-credentials.entity';
import { Edge } from '../src/modules/edge/entities/edge.entity';

const database = process.argv[2] ?? 'transportcheck';
const COAP_PORT = Number(process.env.RPC_TEST_COAP_PORT ?? 15783);

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
const DEVICE_KEY = 'rpcfix-relay-01';
/**
 * The access token the CoAP leg presents. CoAP carries no headers for a
 * credential, so the adapter treats the path segment as the token — which
 * means this value, not DEVICE_KEY, is what section 8 puts in the URL.
 */
const COAP_TOKEN = 'rpcfix-coap-token-2f8c41d9b60e4a37';
const OTHER_KEY = 'rpcfix-relay-02';

/** A CoAP POST, same client pattern as scripts/test-coap.ts. */
function coapPost(pathname: string, payload: unknown): Promise<{ code: string; body: string }> {
  return new Promise((resolve, reject) => {
    const req = coap.request({
      host: '127.0.0.1',
      port: COAP_PORT,
      method: 'POST',
      pathname,
      confirmable: true,
    });
    const timer = setTimeout(() => reject(new Error(`CoAP POST ${pathname} timed out`)), 8000);
    req.on('response', (res: any) => {
      clearTimeout(timer);
      resolve({ code: res.code, body: res.payload ? res.payload.toString() : '' });
    });
    req.on('error', (err: Error) => {
      clearTimeout(timer);
      reject(err);
    });
    req.write(Buffer.from(JSON.stringify(payload)));
    req.end();
  });
}

(async () => {
  let dataSource: DataSource | null = null;
  let coapAdapter: CoAPAdapter | null = null;
  let correlator: RpcCorrelatorService | null = null;

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
    const deviceRepo: Repository<Device> = dataSource.getRepository(Device);
    const commandRepo: Repository<DeviceCommand> =
      dataSource.getRepository(DeviceCommand);

    await deviceRepo.query(
      `DELETE FROM device_commands WHERE "deviceId" IN (SELECT id FROM devices WHERE "deviceKey" LIKE 'rpcfix-%')`,
    );
    // Credentials first: device_credentials.deviceId has an FK to devices(id),
    // so deleting the devices while a credential row survives from a previous
    // run fails on the constraint.
    await deviceRepo.query(
      `DELETE FROM device_credentials WHERE "deviceId" IN (
         SELECT id FROM devices WHERE "deviceKey" LIKE 'rpcfix-%'
       )`,
    );
    await deviceRepo.query(`DELETE FROM devices WHERE "deviceKey" LIKE 'rpcfix-%'`);
    await deviceRepo.query(`DELETE FROM users WHERE id = $1`, [USER]);
    await deviceRepo.query(`DELETE FROM tenants WHERE id = $1`, [TENANT]);

    await deviceRepo.query(
      `INSERT INTO tenants (id, name, email) VALUES ($1, $2, $3)`,
      [TENANT, `RPC fixture tenant ${TENANT.slice(0, 8)}`, `rpc-${TENANT.slice(0, 8)}@example.invalid`],
    );
    await deviceRepo.query(
      `INSERT INTO users (id, email, password, name, role, "tenantId")
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [USER, `rpc-${USER.slice(0, 8)}@example.invalid`, 'not-a-real-hash', 'RPC fixture admin', 'tenant_admin', TENANT],
    );

    const makeDevice = (key: string) =>
      deviceRepo.save(
        deviceRepo.create({
          deviceKey: key,
          name: key,
          type: DeviceType.ACTUATOR,
          status: DeviceStatus.ACTIVE,
          tenantId: TENANT,
          userId: USER,
          messageCount: 0,
          errorCount: 0,
        }),
      );
    const device = await makeDevice(DEVICE_KEY);
    const otherDevice = await makeDevice(OTHER_KEY);
    check('fixtures created', Boolean(device.id && otherDevice.id));

    // Device authentication is enforced by default, so a device with no
    // credential row is correctly refused — including over CoAP, where the
    // path segment IS the presented token. The fixture therefore has to be
    // issued a real access token, and section 8 presents that token rather
    // than the deviceKey (a public identifier, which no longer authenticates
    // anything unless DEVICE_AUTH_ENFORCED=false).
    await dataSource.getRepository(DeviceCredentials).save(
      dataSource.getRepository(DeviceCredentials).create({
        deviceId: device.id,
        credentialsType: CredentialsType.ACCESS_TOKEN,
        credentialsId: COAP_TOKEN,
        isActive: true,
      }),
    );

    // ── Wire the real services ─────────────────────────────────────────────
    const kafkaStub: any = { sendMessage: async () => undefined };
    correlator = new RpcCorrelatorService();
    const commandsService = new DeviceCommandsService(
      commandRepo,
      deviceRepo,
      kafkaStub,
    );

    const mqttConfigStub: any = {
      brokerUrl: 'mqtt://127.0.0.1:1883',
      clientId: 'rpc-fixture',
      qos: 1,
      keepAlive: 60,
      connectTimeout: 1000,
      reconnectPeriod: 0,
      rejectUnauthorized: true,
    };

    // The real listener, but never connected — only its message handler is
    // exercised (see the header). isListening() is forced true so
    // GatewayService does not log a false alarm about an absent broker.
    const responseListener = new RpcResponseListener(mqttConfigStub, correlator);
    (responseListener as any).client = { connected: true };

    /** Deliver a message the way the broker would. */
    const deliverFromDevice = (deviceKey: string, body: unknown) =>
      (responseListener as any).handleResponse(
        `devices/${deviceKey}/rpc/response`,
        Buffer.from(JSON.stringify(body)),
      );

    // The device, played by the publish stub. `script` decides, per publish,
    // whether the device answers and with what.
    const publishes: Array<{ topic: string; message: any }> = [];
    let deviceBehaviour: (topic: string, message: any) => void = () => {};
    const mqttStub: any = {
      isClientConnected: () => true,
      publish: async (topic: string, message: any) => {
        publishes.push({ topic, message });
        deviceBehaviour(topic, message);
      },
    };

    const devicesServiceStub: any = {
      findByDeviceKey: async (key: string) => {
        const found = await deviceRepo.findOne({ where: { deviceKey: key } });
        if (!found) throw new Error(`Device not found: ${key}`);
        return found;
      },
      findAll: async () => ({ data: [] }),
    };

    const gateway = new GatewayService(
      mqttConfigStub,
      { emit: () => true } as any,
      devicesServiceStub,
      mqttStub,
      new CodecRegistryService(),
      correlator,
      responseListener,
      commandsService,
      // ModuleRef — GatewayService resolves LoRaWAN downlink lazily through
      // it to avoid a module cycle. Returning undefined keeps this script on
      // the MQTT/CoAP paths it is actually asserting; a LoRaWAN device would
      // need the real module graph.
      { get: () => undefined } as any,
    );

    // ── 1. A response resolves the pending request ─────────────────────────
    section('1. A device response resolves the pending request');
    deviceBehaviour = (_topic, message) => {
      // A well-behaved device: echo the id, report a result.
      setTimeout(
        () => deliverFromDevice(DEVICE_KEY, { id: message.id, result: { relay1: 'on' } }),
        30,
      );
    };

    const ok = await gateway.sendRpcRequest(
      DEVICE_KEY,
      'setRelay',
      { relay: 1, state: 'on' },
      { timeoutMs: 3000, userId: USER, tenantId: TENANT },
    );

    check('status is "response"', ok.status === 'response', ok);
    check(
      'the device payload came back',
      ok.response?.result?.relay1 === 'on',
      ok.response,
    );
    check('it is reported as arriving via mqtt', ok.via === 'mqtt', ok.via);
    check(
      'the request went to devices/{deviceKey}/rpc/request',
      publishes[0]?.topic === `devices/${DEVICE_KEY}/rpc/request`,
      publishes[0]?.topic,
    );
    check(
      'the published id is the correlation id (a UUID, not a timestamp)',
      publishes[0]?.message?.id === ok.requestId &&
        /^[0-9a-f]{8}-[0-9a-f]{4}-/.test(ok.requestId),
      { published: publishes[0]?.message?.id, returned: ok.requestId },
    );
    check(
      'THE PENDING MAP IS EMPTY AFTERWARDS',
      correlator.pendingCount() === 0,
      correlator.pendingIds(),
    );

    // ── Persistence of the success ─────────────────────────────────────────
    section('1b. The outcome is persisted in command history');
    check('a commandId was returned', Boolean(ok.commandId), ok.commandId);
    const okRow = await commandRepo.findOne({ where: { id: ok.commandId! } });
    check('the history row is COMPLETED', okRow?.status === 'COMPLETED', okRow?.status);
    check(
      'the device payload is stored under metadata.response',
      okRow?.metadata?.response?.result?.relay1 === 'on',
      okRow?.metadata,
    );
    check(
      'the correlation id is stored, so a response can be traced to the row',
      okRow?.metadata?.rpcRequestId === ok.requestId,
      okRow?.metadata,
    );
    check('deliveredAt and completedAt are both set', Boolean(okRow?.deliveredAt && okRow?.completedAt), {
      deliveredAt: okRow?.deliveredAt,
      completedAt: okRow?.completedAt,
    });
    check(
      'commandType is the RPC method, so history reads naturally',
      okRow?.commandType === 'setRelay',
      okRow?.commandType,
    );
    check('tenant scoping is on the row', okRow?.tenantId === TENANT, okRow?.tenantId);

    // ── 2. A missing response times out ────────────────────────────────────
    section('2. A device that never answers times out');
    deviceBehaviour = () => {
      /* the device is unplugged */
    };
    publishes.length = 0;

    const startedAt = Date.now();
    const timedOut = await gateway.sendRpcRequest(
      DEVICE_KEY,
      'reboot',
      undefined,
      { timeoutMs: 1000, userId: USER, tenantId: TENANT },
    );
    const elapsed = Date.now() - startedAt;

    check('status is "timeout"', timedOut.status === 'timeout', timedOut);
    check('an error message explains it', Boolean(timedOut.error), timedOut.error);
    check(
      `it settled at roughly the timeout, not instantly or never (${elapsed}ms)`,
      elapsed >= 950 && elapsed < 3000,
      elapsed,
    );
    check(
      'THE PENDING MAP IS EMPTY AFTERWARDS',
      correlator.pendingCount() === 0,
      correlator.pendingIds(),
    );

    const timeoutRow = await commandRepo.findOne({ where: { id: timedOut.commandId! } });
    check('the history row is FAILED', timeoutRow?.status === 'FAILED', timeoutRow?.status);
    check(
      'the reason is recorded, not just "sent"',
      Boolean(timeoutRow?.statusMessage?.includes('did not respond')),
      timeoutRow?.statusMessage,
    );
    check(
      'the history row is NOT left claiming success',
      timeoutRow?.status !== 'COMPLETED' && timeoutRow?.status !== 'DELIVERED',
      timeoutRow?.status,
    );

    // ── 3. Concurrency: two requests to the SAME device ────────────────────
    section('3. Two concurrent requests to the same device do not cross');
    const issued: Array<{ id: string; method: string }> = [];
    deviceBehaviour = (_topic, message) => {
      issued.push({ id: message.id, method: message.method });
      // Answer out of order and with a method-specific payload, so a crossed
      // correlation would be unmistakable.
      const delay = message.method === 'readTemp' ? 200 : 40;
      setTimeout(
        () =>
          deliverFromDevice(DEVICE_KEY, {
            id: message.id,
            result: { answeredMethod: message.method },
          }),
        delay,
      );
    };

    const [tempResult, humResult] = await Promise.all([
      gateway.sendRpcRequest(DEVICE_KEY, 'readTemp', undefined, {
        timeoutMs: 3000,
        userId: USER,
        tenantId: TENANT,
      }),
      gateway.sendRpcRequest(DEVICE_KEY, 'readHumidity', undefined, {
        timeoutMs: 3000,
        userId: USER,
        tenantId: TENANT,
      }),
    ]);

    check(
      'both requests got their own correlation id',
      tempResult.requestId !== humResult.requestId,
      { temp: tempResult.requestId, hum: humResult.requestId },
    );
    check('both resolved', tempResult.status === 'response' && humResult.status === 'response', {
      temp: tempResult.status,
      hum: humResult.status,
    });
    check(
      'readTemp got the readTemp answer (answered SECOND, out of order)',
      tempResult.response?.result?.answeredMethod === 'readTemp',
      tempResult.response,
    );
    check(
      'readHumidity got the readHumidity answer (answered FIRST)',
      humResult.response?.result?.answeredMethod === 'readHumidity',
      humResult.response,
    );
    check(
      'THE PENDING MAP IS EMPTY AFTERWARDS',
      correlator.pendingCount() === 0,
      correlator.pendingIds(),
    );

    // ── 4. Ids are unique within a millisecond ─────────────────────────────
    section('4. Correlation ids are unique within one millisecond');
    const ids = new Set<string>();
    for (let i = 0; i < 2000; i++) ids.add(correlator.newRequestId());
    check('2000 ids generated back-to-back are all distinct', ids.size === 2000, ids.size);
    const sameMs = new Set([
      Date.now().toString(),
      Date.now().toString(),
    ]);
    check(
      'for contrast, the old Date.now() scheme collides in the same tick',
      sameMs.size === 1,
      sameMs,
    );

    // ── 5. Reconnect must not strand the map ───────────────────────────────
    section('5. A broker disconnect fails pending requests rather than stranding them');
    deviceBehaviour = () => {
      /* silent */
    };
    const strandedPromise = gateway.sendRpcRequest(DEVICE_KEY, 'slowOp', undefined, {
      timeoutMs: 60_000, // long enough that only the disconnect can settle it
      userId: USER,
      tenantId: TENANT,
    });
    await sleep(100);
    check('one request is pending', correlator.pendingCount() === 1, correlator.pendingCount());

    // Exactly what RpcResponseListener does on its MQTT 'close' event.
    const cancelled = correlator.cancelAll(
      'MQTT connection to the broker dropped before the device responded',
    );
    const stranded = await strandedPromise;
    check('cancelAll reported one cancellation', cancelled === 1, cancelled);
    check('status is "cancelled"', stranded.status === 'cancelled', stranded);
    check(
      'THE PENDING MAP IS EMPTY AFTER A RECONNECT',
      correlator.pendingCount() === 0,
      correlator.pendingIds(),
    );
    const strandedRow = await commandRepo.findOne({ where: { id: stranded.commandId! } });
    check('the history row is FAILED with the disconnect reason', strandedRow?.status === 'FAILED', strandedRow?.status);

    // ── 6. Late / mis-addressed responses ──────────────────────────────────
    section('6. A late or mis-addressed response is dropped, not mismatched');
    deliverFromDevice(DEVICE_KEY, {
      id: timedOut.requestId,
      result: 'too late',
    });
    check(
      'a response for an already-timed-out id matches nothing and creates nothing',
      correlator.pendingCount() === 0,
      correlator.pendingIds(),
    );

    deviceBehaviour = () => {
      /* silent — we deliver by hand below */
    };
    const crossPromise = gateway.sendRpcRequest(DEVICE_KEY, 'ping', undefined, {
      timeoutMs: 1500,
      userId: USER,
      tenantId: TENANT,
    });
    await sleep(50);
    const pendingId = correlator.pendingIds()[0];

    // The right id, arriving on ANOTHER device's response topic.
    // `handleResponse` is a void event handler, so the evidence is that the
    // request is still pending afterwards and still has the same id.
    deliverFromDevice(OTHER_KEY, {
      id: pendingId,
      result: 'from the wrong device',
    });
    check(
      "a response on another device's topic does not resolve this request",
      correlator.pendingCount() === 1 && correlator.pendingIds()[0] === pendingId,
      { pending: correlator.pendingIds() },
    );

    deliverFromDevice(DEVICE_KEY, { result: 'no id at all' });
    check(
      'a response with no id resolves nothing',
      correlator.pendingCount() === 1 && correlator.pendingIds()[0] === pendingId,
      { pending: correlator.pendingIds() },
    );

    // And directly on the correlator, where the return value IS the answer.
    check(
      'resolveResponse() reports no match for a mismatched device key',
      correlator.resolveResponse({
        requestId: pendingId,
        deviceKey: OTHER_KEY,
        payload: { id: pendingId },
        via: 'mqtt',
      }) === false,
    );
    check(
      'resolveResponse() reports no match for an unknown id',
      correlator.resolveResponse({ requestId: 'never-issued', via: 'mqtt' }) === false,
    );
    const crossResult = await crossPromise;
    check('that request still timed out on its own terms', crossResult.status === 'timeout', crossResult);
    check('and the map is empty', correlator.pendingCount() === 0, correlator.pendingIds());

    // ── 6b. A device-reported error is a response, not a timeout ───────────
    section('6b. A device that reports an error');
    deviceBehaviour = (_topic, message) => {
      setTimeout(
        () => deliverFromDevice(DEVICE_KEY, { id: message.id, error: 'relay 1 is jammed' }),
        20,
      );
    };
    const deviceError = await gateway.sendRpcRequest(DEVICE_KEY, 'setRelay', { relay: 1 }, {
      timeoutMs: 2000,
      userId: USER,
      tenantId: TENANT,
    });
    check(
      'status is "response" — the device did answer',
      deviceError.status === 'response',
      deviceError.status,
    );
    check('the error is surfaced', deviceError.error === 'relay 1 is jammed', deviceError.error);
    const errorRow = await commandRepo.findOne({ where: { id: deviceError.commandId! } });
    check(
      'the history row is FAILED with the device\'s own reason',
      errorRow?.status === 'FAILED' && errorRow?.statusMessage === 'relay 1 is jammed',
      { status: errorRow?.status, statusMessage: errorRow?.statusMessage },
    );
    check('the map is empty', correlator.pendingCount() === 0, correlator.pendingIds());

    // ── 7. Fire-and-forget (the poll option) ───────────────────────────────
    section('7. waitForResponse:false returns immediately and is pollable');
    deviceBehaviour = () => {
      /* silent */
    };
    const sent = await gateway.sendRpcRequest(DEVICE_KEY, 'identify', undefined, {
      userId: USER,
      tenantId: TENANT,
      waitForResponse: false,
    });
    check('status is "sent"', sent.status === 'sent', sent);
    check(
      'nothing was registered, so nothing can leak',
      correlator.pendingCount() === 0,
      correlator.pendingIds(),
    );
    const sentRow = await commandRepo.findOne({ where: { id: sent.commandId! } });
    check(
      'the history row is DELIVERED and pollable by commandId',
      sentRow?.status === 'DELIVERED',
      sentRow?.status,
    );

    // ── 8. The CoAP leg into the same correlator ───────────────────────────
    section('8. A device answering over CoAP resolves the same pending request');
    const coapConfigStub: any = { get: (key: string) => (key === 'COAP_PORT' ? String(COAP_PORT) : undefined) };
    const listenerService = new DeviceListenerService(
      deviceRepo,
      new CodecRegistryService(),
      kafkaStub,
    );
    // The REAL DeviceAuthService, not a stub that waves everything through.
    // CoAPAdapter gained this parameter when device authentication became
    // enforced, and the script was still passing seven arguments — so
    // `this.deviceAuth` was undefined and every CoAP check died on
    // "Cannot read properties of undefined (reading 'authenticate')".
    //
    // Using the real service means these checks also confirm a CoAP device
    // must present a credential that verifies, rather than only confirming
    // that the correlator wiring is intact.
    const coapDeviceAuth = new DeviceAuthService(
      dataSource.getRepository(DeviceCredentials),
      deviceRepo,
      dataSource.getRepository(Edge),
      // RedisService is a required dependency and is used unguarded
      // (`this.redis.get(...).catch(...)` — a TypeError on undefined throws
      // before .catch can absorb it), so this is a real in-memory stand-in
      // rather than `undefined`. Honouring the TTL matters: the negative
      // cache stores the sentinel 'MISS', and a stub that ignored it would
      // let a once-refused token stay refused for the rest of the run.
      (() => {
        const store = new Map<string, { value: string; expiresAt: number }>();
        return {
          async get(key: string): Promise<string | null> {
            const hit = store.get(key);
            if (!hit) return null;
            if (hit.expiresAt < Date.now()) {
              store.delete(key);
              return null;
            }
            return hit.value;
          },
          async set(key: string, value: string, ttlSeconds?: number): Promise<void> {
            store.set(key, {
              value,
              expiresAt: Date.now() + (ttlSeconds ?? 60) * 1000,
            });
          },
          async del(key: string): Promise<void> {
            store.delete(key);
          },
        };
      })() as any,
    );

    coapAdapter = new CoAPAdapter(
      listenerService,
      {} as any,
      {} as any,
      // Lwm2mService gained a registration repository (so registrations
      // survive a restart) and device auth. Passed the real repository and
      // the same verifier the adapter uses, so the LwM2M leg is not quietly
      // running against a different identity than the CoAP leg.
      new Lwm2mService(
        listenerService,
        deviceRepo,
        coapConfigStub,
        dataSource.getRepository(entities.Lwm2mRegistration ?? (entities as any).Lwm2mRegistration),
        coapDeviceAuth,
      ),
      correlator,
      deviceRepo,
      coapConfigStub,
      coapDeviceAuth,
    );
    await coapAdapter.start();

    const coapRequestId = correlator.newRequestId();
    const coapPending = correlator.register({
      requestId: coapRequestId,
      deviceKey: DEVICE_KEY,
      method: 'getStatus',
      timeoutMs: 5000,
    });
    check('one request is pending', correlator.pendingCount() === 1);

    const coapAnswer = await coapPost(`/api/v1/${COAP_TOKEN}/rpc`, {
      id: coapRequestId,
      result: { uptime: 42 },
    });
    check(
      '→ 2.04 (correlated), distinguishing it from a device-initiated RPC',
      coapAnswer.code === '2.04' && coapAnswer.body.includes('correlated'),
      coapAnswer,
    );
    const coapOutcome = await coapPending;
    check('the pending request resolved', coapOutcome.status === 'response', coapOutcome);
    check('it is reported as arriving via coap', coapOutcome.via === 'coap', coapOutcome.via);
    check('the device payload came through', coapOutcome.response?.result?.uptime === 42, coapOutcome.response);
    check('THE PENDING MAP IS EMPTY AFTERWARDS', correlator.pendingCount() === 0, correlator.pendingIds());

    // A device-initiated CoAP RPC (nothing pending) must still be accepted.
    const initiated = await coapPost(`/api/v1/${COAP_TOKEN}/rpc`, {
      id: 'device-chosen-id',
      method: 'getTime',
    });
    check(
      'a device-initiated CoAP RPC is still accepted with 2.05',
      initiated.code === '2.05' && initiated.body.includes('accepted'),
      initiated,
    );

    // ── 9. Shutdown settles everything ─────────────────────────────────────
    section('9. Shutdown does not leave callers hanging');
    deviceBehaviour = () => {
      /* silent */
    };
    const shutdownPromise = gateway.sendRpcRequest(DEVICE_KEY, 'longOp', undefined, {
      timeoutMs: 60_000,
      userId: USER,
      tenantId: TENANT,
    });
    await sleep(50);
    check('one request is pending', correlator.pendingCount() === 1);
    correlator.onModuleDestroy();
    const shutdownOutcome = await shutdownPromise;
    check('the caller was settled, not left pending forever', shutdownOutcome.status === 'cancelled', shutdownOutcome);
    check('the map is empty', correlator.pendingCount() === 0, correlator.pendingIds());
  } finally {
    if (coapAdapter) await coapAdapter.stop();
    if (dataSource?.isInitialized) await dataSource.destroy();
  }

  console.log(
    `\n${failures === 0 ? '✅ TWO-WAY RPC VERIFIED' : `❌ ${failures} CHECK(S) FAILED`}`,
  );
  process.exit(failures === 0 ? 0 : 1);
})().catch((error) => {
  console.error('\n❌ RPC verification crashed:', error);
  process.exit(1);
});
