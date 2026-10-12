/**
 * Verifies the LwM2M registration + reporting server with REAL CoAP requests
 * over UDP, against a real PostgreSQL database.
 *
 *   createdb transportcheck
 *   npx ts-node --transpile-only -r tsconfig-paths/register \
 *     scripts/verify-lwm2m.ts transportcheck
 *
 * The CoAP client pattern is the one in `scripts/test-coap.ts`; the server is
 * the real `CoAPAdapter`, started in this process on LWM2M_TEST_PORT (default
 * 15683) so it does not collide with a running stack on 5683. Services are
 * wired by hand because an unreachable Kafka broker stops the app booting
 * (CLAUDE.md §11) — only KafkaService is stubbed, and it records what would
 * have been published.
 *
 * What it proves, in order:
 *   1. Register (POST /rd) → 2.01 Created, with the registration id in the
 *      Location-Path option a real client reads it from.
 *   2. An UNKNOWN endpoint is REJECTED (4.03) and NO device row is created.
 *      That is the point: /rd is reachable by anything that can send a
 *      datagram to the CoAP port and the endpoint name is attacker-chosen, so
 *      auto-provisioning here would let a loop of random names exhaust a
 *      tenant's device quota (CLAUDE.md §4e).
 *   3. Update (POST /rd/:id) → 2.04, and the expiry moves forward.
 *   4. A SenML JSON Send (POST /dp) lands as telemetry via
 *      DeviceListenerService.handleTelemetry() — the same unified path as
 *      MQTT/HTTP — with OMA resource paths mapped to telemetry keys, including
 *      a profile-declared custom mapping.
 *   5. Registration-lifetime expiry marks the device OFFLINE.
 *   6. De-register (DELETE /rd/:id) → 2.02 and marks the device OFFLINE.
 *   7. Unknown registration id → 4.04; a Send from an unregistered endpoint
 *      → 4.03; a non-JSON Send body → 4.00.
 *   8. The documented out-of-scope list is served over HTTP for the frontend.
 */
import { DataSource, Repository } from 'typeorm';
import { randomUUID } from 'crypto';
import * as coap from 'coap';
import * as entities from '../src/modules/index.entities';
import { Device } from '../src/modules/devices/entities/device.entity';
import { DeviceProfile } from '../src/modules/profiles/entities/device-profile.entity';
import { DeviceListenerService } from '../src/modules/protocols/device-listener.service';
import { CoAPAdapter } from '../src/modules/protocols/adapters/coap.adapter';
import { Lwm2mService } from '../src/modules/protocols/lwm2m/lwm2m.service';
import { RpcCorrelatorService } from '../src/modules/protocols/rpc-correlator.service';
import { CodecRegistryService } from '../src/modules/devices/codecs/codec-registry.service';
import { LWM2M_CAPABILITIES, LWM2M_SCOPE_SUMMARY } from '../src/modules/protocols/lwm2m/lwm2m.scope';
import { DeviceTransportType } from '../src/common/enums/device-profile.enum';
import { DeviceStatus, DeviceType } from '../src/common/enums/device.enum';

const database = process.argv[2] ?? 'transportcheck';
const COAP_PORT = Number(process.env.LWM2M_TEST_PORT ?? 15683);

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

const TENANT = randomUUID();
const USER = randomUUID();
const ENDPOINT = 'lwm2mfix-sensor-01';

interface CoapResult {
  code: string;
  body: string;
  /** Location-Path option values, as a real LwM2M client would read them. */
  locationPath: string[];
}

function coapRequest(opts: {
  method: 'GET' | 'POST' | 'DELETE';
  pathname: string;
  query?: string;
  payload?: string;
  contentFormat?: string;
}): Promise<CoapResult> {
  return new Promise<CoapResult>((resolve, reject) => {
    const req = coap.request({
      host: '127.0.0.1',
      port: COAP_PORT,
      method: opts.method,
      pathname: opts.pathname,
      query: opts.query,
      confirmable: true,
    });

    if (opts.contentFormat) {
      req.setOption('Content-Format', opts.contentFormat);
    }

    const timer = setTimeout(
      () => reject(new Error(`CoAP ${opts.method} ${opts.pathname} timed out`)),
      8000,
    );

    req.on('response', (res: any) => {
      clearTimeout(timer);
      // The `coap` package exposes options both as res.options and, for
      // repeatable ones, res.headers — read whichever is populated.
      const fromOptions: string[] = (res.options ?? [])
        .filter((o: any) => o.name === 'Location-Path')
        .map((o: any) => o.value?.toString?.() ?? String(o.value));
      const header = res.headers?.['Location-Path'];
      const fromHeader: string[] = Array.isArray(header)
        ? header.map((v: any) => v?.toString?.() ?? String(v))
        : header
          ? [String(header)]
          : [];
      resolve({
        code: res.code,
        body: res.payload ? res.payload.toString() : '',
        locationPath: fromOptions.length > 0 ? fromOptions : fromHeader,
      });
    });

    req.on('error', (err: Error) => {
      clearTimeout(timer);
      reject(err);
    });

    if (opts.payload !== undefined) req.write(Buffer.from(opts.payload));
    req.end();
  });
}

(async () => {
  let dataSource: DataSource | null = null;
  let adapter: CoAPAdapter | null = null;

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

    section('0. Schema + fixtures + CoAP server');
    await dataSource.initialize();
    const deviceRepo: Repository<Device> = dataSource.getRepository(Device);
    const profileRepo: Repository<DeviceProfile> =
      dataSource.getRepository(DeviceProfile);

    await deviceRepo.query(`DELETE FROM devices WHERE "deviceKey" LIKE 'lwm2mfix-%'`);
    await deviceRepo.query(`DELETE FROM device_profiles WHERE name LIKE 'LwM2M fixture%'`);
    await deviceRepo.query(`DELETE FROM users WHERE id = $1`, [USER]);
    await deviceRepo.query(`DELETE FROM tenants WHERE id = $1`, [TENANT]);

    await deviceRepo.query(
      `INSERT INTO tenants (id, name, email) VALUES ($1, $2, $3)`,
      [TENANT, `LwM2M fixture tenant ${TENANT.slice(0, 8)}`, `lwm2m-${TENANT.slice(0, 8)}@example.invalid`],
    );
    await deviceRepo.query(
      `INSERT INTO users (id, email, password, name, role, "tenantId")
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [USER, `lwm2m-${USER.slice(0, 8)}@example.invalid`, 'not-a-real-hash', 'LwM2M fixture admin', 'tenant_admin', TENANT],
    );

    const profile = await profileRepo.save(
      profileRepo.create({
        tenantId: TENANT,
        name: 'LwM2M fixture profile',
        transportType: DeviceTransportType.LWM2M,
        transportConfiguration: {
          lwm2m: {
            objectIds: [3, 3303, 3304],
            lifetime: 300,
            binding: 'U',
            // Documented in lwm2m.service.ts: path → telemetry key, read from
            // the profile so a deployment can name its own resources.
            resourceMappings: [{ path: '/3347/0/5500', key: 'doorOpen' }],
          },
        } as any,
      }),
    );

    const device = await deviceRepo.save(
      deviceRepo.create({
        deviceKey: ENDPOINT,
        name: ENDPOINT,
        type: DeviceType.SENSOR,
        status: DeviceStatus.INACTIVE,
        tenantId: TENANT,
        userId: USER,
        deviceProfileId: profile.id,
        messageCount: 0,
        errorCount: 0,
      }),
    );
    check('fixtures created', Boolean(device.id));

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

    const configStub: any = {
      get: (key: string) =>
        ({
          COAP_PORT: String(COAP_PORT),
          // A short grace period so the expiry check does not need a long wait.
          LWM2M_LIFETIME_GRACE_SECONDS: '0',
          LWM2M_EXPIRY_SWEEP_SECONDS: '1',
        })[key],
    };

    const lwm2m = new Lwm2mService(listener, deviceRepo, configStub);
    const correlator = new RpcCorrelatorService();

    adapter = new CoAPAdapter(
      listener,
      {} as any, // AttributesService — not exercised by the LwM2M routes
      {} as any, // FirmwareService  — not exercised by the LwM2M routes
      lwm2m,
      correlator,
      deviceRepo,
      configStub,
    );
    await adapter.start();
    check(`CoAP server listening on UDP ${COAP_PORT}`, true);

    // ── 1. Register ────────────────────────────────────────────────────────
    section('1. Register (POST /rd)');
    const registerRes = await coapRequest({
      method: 'POST',
      pathname: '/rd',
      query: `ep=${ENDPOINT}&lt=60&b=U&lwm2m=1.1`,
      payload: '</1/0>,</3/0>;ct=110,</3303/0>,</3347/0>',
      contentFormat: 'application/link-format',
    });
    check('→ 2.01 Created', registerRes.code === '2.01', registerRes);

    const registrationId = JSON.parse(registerRes.body || '{}').registrationId;
    check('a registration id was returned', Boolean(registrationId), registerRes.body);
    check(
      'Location-Path is /rd/<registrationId> — what a real client reads',
      registerRes.locationPath.length === 2 &&
        registerRes.locationPath[0] === 'rd' &&
        registerRes.locationPath[1] === registrationId,
      registerRes.locationPath,
    );

    const registration = lwm2m.getRegistrationByEndpoint(ENDPOINT);
    check(
      'the object links from the body were parsed',
      registration?.objectLinks.map((l) => l.path).join(',') ===
        '/1/0,/3/0,/3303/0,/3347/0',
      registration?.objectLinks,
    );
    check(
      'link attributes were parsed (ct=110 on /3/0)',
      registration?.objectLinks.find((l) => l.path === '/3/0')?.attributes.ct === '110',
      registration?.objectLinks,
    );
    check(
      'lifetime and binding came from the query',
      registration?.lifetime === 60 && registration?.binding === 'U',
      { lifetime: registration?.lifetime, binding: registration?.binding },
    );
    check(
      'the endpoint resolved to the right device',
      registration?.deviceId === device.id && registration?.tenantId === TENANT,
      registration,
    );

    // ── 2. An unknown endpoint must NOT be provisioned ─────────────────────
    section('2. An unknown endpoint is rejected, not provisioned');
    const beforeCount = await deviceRepo.count();
    const rogueRes = await coapRequest({
      method: 'POST',
      pathname: '/rd',
      query: 'ep=attacker-chosen-endpoint-name&lt=60',
      payload: '</3/0>',
    });
    check('→ 4.03 Forbidden', rogueRes.code === '4.03', rogueRes);
    check(
      'the rejection says why, so firmware can be fixed',
      rogueRes.body.includes('does not auto-provision'),
      rogueRes.body,
    );
    const afterCount = await deviceRepo.count();
    check(
      'NO device row was created — a tenant quota cannot be exhausted from /rd',
      afterCount === beforeCount,
      { beforeCount, afterCount },
    );
    check(
      'and no registration was recorded for it',
      lwm2m.getRegistrationByEndpoint('attacker-chosen-endpoint-name') === undefined,
    );

    const missingEpRes = await coapRequest({
      method: 'POST',
      pathname: '/rd',
      query: 'lt=60',
    });
    check('a registration with no ?ep= is 4.00', missingEpRes.code === '4.00', missingEpRes);

    // ── 3. Update ──────────────────────────────────────────────────────────
    section('3. Update (POST /rd/:id)');
    const expiryBefore = lwm2m.getRegistration(registrationId)!.expiresAt.getTime();
    await new Promise((r) => setTimeout(r, 1100));
    const updateRes = await coapRequest({
      method: 'POST',
      pathname: `/rd/${registrationId}`,
      query: 'lt=120',
    });
    check('→ 2.04 Changed', updateRes.code === '2.04', updateRes);
    const updated = lwm2m.getRegistration(registrationId)!;
    check('the new lifetime was applied', updated.lifetime === 120, updated.lifetime);
    check(
      'the expiry moved forward',
      updated.expiresAt.getTime() > expiryBefore,
      { before: expiryBefore, after: updated.expiresAt.getTime() },
    );

    const unknownUpdateRes = await coapRequest({
      method: 'POST',
      pathname: '/rd/not-a-real-registration',
    });
    check(
      'an update against an unknown registration is 4.04',
      unknownUpdateRes.code === '4.04',
      unknownUpdateRes,
    );

    // ── 4. SenML Send ──────────────────────────────────────────────────────
    section('4. Send (POST /dp) with SenML JSON');
    published.length = 0;
    const senml = JSON.stringify([
      { bn: '/3303/0/', bt: 1760000000, n: '5700', u: 'Cel', v: 21.5 },
      { bn: '/3304/0/', n: '5700', u: '%RH', v: 48 },
      { bn: '/3/0/', n: '9', v: 87 },
      { bn: '/3347/0/', n: '5500', vb: true },
      { bn: '/3/0/', n: '3', vs: '1.4.2' },
    ]);
    const sendRes = await coapRequest({
      method: 'POST',
      pathname: '/dp',
      query: `ep=${ENDPOINT}`,
      payload: senml,
      contentFormat: 'application/senml+json',
    });
    check('→ 2.04 Changed', sendRes.code === '2.04', sendRes);

    check(
      'exactly one message reached the unified telemetry path',
      published.length === 1,
      published.length,
    );
    const message = published[0]?.message;
    check(
      'on the same Kafka topic MQTT/HTTP/CoAP telemetry uses',
      published[0]?.topic === 'telemetry.device.raw',
      published[0]?.topic,
    );
    check('protocol is reported as lwm2m', message?.protocol === 'lwm2m', message?.protocol);
    check(
      'OMA 3303/0/5700 mapped to `temperature`',
      message?.data?.temperature === 21.5,
      message?.data,
    );
    check(
      'OMA 3304/0/5700 mapped to `humidity`',
      message?.data?.humidity === 48,
      message?.data,
    );
    check(
      'OMA 3/0/9 mapped to `batteryLevel`',
      message?.data?.batteryLevel === 87,
      message?.data,
    );
    check(
      'the profile-declared mapping /3347/0/5500 → `doorOpen` was used (vb boolean)',
      message?.data?.doorOpen === true,
      message?.data,
    );
    check(
      'a string value (vs) survived — 3/0/3 → firmwareVersion',
      message?.data?.firmwareVersion === '1.4.2',
      message?.data,
    );
    check(
      'SenML units are carried as sibling keys',
      message?.data?.temperature_unit === 'Cel' && message?.data?.humidity_unit === '%RH',
      message?.data,
    );
    check(
      'temperature was promoted to the dedicated column',
      message?.data?.temperature === 21.5 && message?.metadata?.lwm2mEndpoint === ENDPOINT,
      message?.metadata,
    );

    const afterSend = await deviceRepo.findOne({ where: { id: device.id } });
    check(
      'device activity was updated by the unified path',
      Boolean(afterSend?.lastSeenAt) && (afterSend?.messageCount ?? 0) >= 1,
      { lastSeenAt: afterSend?.lastSeenAt, messageCount: afterSend?.messageCount },
    );

    // A Send from an endpoint that never registered.
    const strangerSend = await coapRequest({
      method: 'POST',
      pathname: '/dp',
      query: 'ep=lwm2mfix-never-registered',
      payload: '[{"bn":"/3303/0/5700","v":1}]',
    });
    check(
      'a Send from an unregistered endpoint is 4.03',
      strangerSend.code === '4.03',
      strangerSend,
    );

    const badBody = await coapRequest({
      method: 'POST',
      pathname: '/dp',
      query: `ep=${ENDPOINT}`,
      payload: 'not json at all',
    });
    check('a non-JSON Send body is 4.00', badBody.code === '4.00', badBody);
    check(
      'and the 4.00 says SenML CBOR / TLV are not supported',
      badBody.body.includes('CBOR'),
      badBody.body,
    );

    // ── 5. Lifetime expiry marks the device offline ────────────────────────
    section('5. Registration lifetime expiry');
    await deviceRepo.update({ id: device.id }, { status: DeviceStatus.ACTIVE });
    check(
      'the device is ACTIVE and registered before the expiry',
      (await deviceRepo.findOne({ where: { id: device.id } }))?.status ===
        DeviceStatus.ACTIVE &&
        lwm2m.getRegistration(registrationId) !== undefined,
    );

    // Force the registration past its lifetime instead of waiting 120s, then
    // run the same sweep the interval runs.
    lwm2m.expireRegistrationNow(registrationId);
    const expired = await lwm2m.expireStaleRegistrations();
    check('the sweep reported the endpoint as expired', expired.includes(ENDPOINT), expired);
    check(
      'the registration was dropped',
      lwm2m.getRegistration(registrationId) === undefined,
    );
    check(
      'and the endpoint index was dropped with it (no leak)',
      lwm2m.getRegistrationByEndpoint(ENDPOINT) === undefined,
    );
    const afterExpiry = await deviceRepo.findOne({ where: { id: device.id } });
    check(
      'the device was marked OFFLINE',
      afterExpiry?.status === DeviceStatus.OFFLINE,
      afterExpiry?.status,
    );
    check(
      'an Update after expiry is 4.04, telling the client to re-register',
      (await coapRequest({ method: 'POST', pathname: `/rd/${registrationId}` })).code ===
        '4.04',
    );

    // ── 6. De-register ─────────────────────────────────────────────────────
    section('6. De-register (DELETE /rd/:id)');
    const reRegister = await coapRequest({
      method: 'POST',
      pathname: '/rd',
      query: `ep=${ENDPOINT}&lt=300`,
      payload: '</3/0>',
    });
    check('re-registration after expiry works', reRegister.code === '2.01', reRegister);
    const secondId = JSON.parse(reRegister.body).registrationId;
    await deviceRepo.update({ id: device.id }, { status: DeviceStatus.ACTIVE });

    const deregRes = await coapRequest({
      method: 'DELETE',
      pathname: `/rd/${secondId}`,
    });
    check('→ 2.02 Deleted', deregRes.code === '2.02', deregRes);
    check(
      'the registration is gone',
      lwm2m.getRegistration(secondId) === undefined &&
        lwm2m.getRegistrationByEndpoint(ENDPOINT) === undefined,
    );
    check(
      'the device was marked OFFLINE immediately',
      (await deviceRepo.findOne({ where: { id: device.id } }))?.status ===
        DeviceStatus.OFFLINE,
    );
    check(
      're-registering twice does not accumulate registrations',
      (await (async () => {
        await coapRequest({ method: 'POST', pathname: '/rd', query: `ep=${ENDPOINT}&lt=300` });
        await coapRequest({ method: 'POST', pathname: '/rd', query: `ep=${ENDPOINT}&lt=300` });
        return lwm2m.listRegistrations().filter((r) => r.endpoint === ENDPOINT).length;
      })()) === 1,
    );

    // ── 7. Wrong methods ───────────────────────────────────────────────────
    section('7. Method handling');
    check(
      'GET /rd is 4.05',
      (await coapRequest({ method: 'GET', pathname: '/rd' })).code === '4.05',
    );
    check(
      'GET /dp is 4.05',
      (await coapRequest({ method: 'GET', pathname: '/dp' })).code === '4.05',
    );
    check(
      'an unrelated path is still 4.00 and now mentions /rd and /dp',
      await (async () => {
        const res = await coapRequest({ method: 'POST', pathname: '/nonsense' });
        return res.code === '4.00' && res.body.includes('/rd');
      })(),
    );

    // ── 8. The scope is machine-readable ───────────────────────────────────
    section('8. Out-of-scope features are declared, not hidden');
    const unsupported = LWM2M_CAPABILITIES.filter((c) => !c.supported).map(
      (c) => c.operation,
    );
    check(
      'Observe/Notify is declared NOT supported',
      unsupported.some((o) => o.includes('Observe')),
      unsupported,
    );
    check(
      'server-initiated Read/Write/Execute is declared NOT supported',
      unsupported.some((o) => o.includes('Execute')),
      unsupported,
    );
    check(
      'Bootstrap is declared NOT supported',
      unsupported.some((o) => o.includes('Bootstrap')),
      unsupported,
    );
    check(
      'DTLS is declared NOT supported',
      unsupported.some((o) => o.includes('DTLS')),
      unsupported,
    );
    check(
      'the summary the frontend renders lists the same gaps',
      LWM2M_SCOPE_SUMMARY.notSupported.length >= 5 &&
        LWM2M_SCOPE_SUMMARY.secure === false,
      LWM2M_SCOPE_SUMMARY,
    );
    check(
      'and it says so in prose too',
      LWM2M_SCOPE_SUMMARY.summary.includes('Nothing is ever sent'),
      LWM2M_SCOPE_SUMMARY.summary,
    );
  } finally {
    if (adapter) await adapter.stop();
    if (dataSource?.isInitialized) await dataSource.destroy();
  }

  console.log(
    `\n${failures === 0 ? '✅ LWM2M VERIFIED' : `❌ ${failures} CHECK(S) FAILED`}`,
  );
  process.exit(failures === 0 ? 0 : 1);
})().catch((error) => {
  console.error('\n❌ LwM2M verification crashed:', error);
  process.exit(1);
});
