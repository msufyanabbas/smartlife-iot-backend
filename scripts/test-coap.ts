/**
 * scripts/test-coap.ts
 * End-to-end test for the CoAP adapter — runnable from the host:
 *
 *   npx ts-node scripts/test-coap.ts
 *
 * What it does:
 *   1. Finds a device to target (its `deviceKey` IS its CoAP token). The device
 *      is read from the *dockerized* Postgres via `docker exec ... psql` rather
 *      than a direct `pg` connection, because on this machine a NATIVE Postgres
 *      owns host :5432 — a `localhost:5432` client hits the wrong database. The
 *      container's local socket uses trust auth, so no host creds are needed.
 *   2. Sends a CoAP POST to coap://<host>:5683/api/v1/{deviceToken}/telemetry
 *      with {"temperature": 25.5, "humidity": 60} using the documented `coap`
 *      client pattern, and prints the response code + payload.
 *   3. Verifies the telemetry actually landed in the `telemetry` table (the CoAP
 *      path runs through DeviceListenerService → Kafka → TelemetryConsumer, so
 *      persistence is asynchronous; we poll for a few seconds).
 *   4. Bonus: a CoAP attributes round-trip and a bad-token 4.04 check.
 *
 * Requires the local stack running:
 *   docker compose -f docker-compose.local.yml up -d
 *
 * Env overrides: COAP_HOST, COAP_PORT, PG_CONTAINER, DB_USERNAME, DB_DATABASE.
 */

import * as coap from 'coap';
import { execFileSync } from 'child_process';

const COAP_HOST = process.env.COAP_HOST || 'localhost';
const COAP_PORT = parseInt(process.env.COAP_PORT || '5683', 10);

const PG_CONTAINER = process.env.PG_CONTAINER || 'smartlife-postgres-local';
const PG_USER = process.env.DB_USERNAME || 'smartlife';
const PG_DB = process.env.DB_DATABASE || 'smartlife_iot';

interface CoapResult {
  code: string;
  body: string;
}

/**
 * CoAP request using the documented `coap` client pattern:
 *   const req = coap.request({ host, port, method, pathname })
 *   req.write(Buffer.from(JSON.stringify(payload)))
 *   req.on('response', (res) => { res.code; res.payload.toString() })
 *   req.end()
 */
function coapRequest(opts: {
  method: 'GET' | 'POST';
  pathname: string;
  payload?: unknown;
}): Promise<CoapResult> {
  return new Promise<CoapResult>((resolve, reject) => {
    const req = coap.request({
      host: COAP_HOST,
      port: COAP_PORT,
      method: opts.method,
      pathname: opts.pathname,
      confirmable: true,
    });

    const timer = setTimeout(
      () => reject(new Error('CoAP request timed out — is the adapter listening on UDP 5683?')),
      8000,
    );

    req.on('response', (res: any) => {
      clearTimeout(timer);
      const body: string = res.payload ? res.payload.toString() : '';
      resolve({ code: res.code, body });
    });

    req.on('error', (err: Error) => {
      clearTimeout(timer);
      reject(err);
    });

    if (opts.payload !== undefined) {
      const raw =
        typeof opts.payload === 'string' ? opts.payload : JSON.stringify(opts.payload);
      req.write(Buffer.from(raw));
    }

    req.end();
  });
}

/** Run a SQL statement against the dockerized Postgres (trust auth via socket). */
function psql(sql: string): string {
  const out = execFileSync(
    'docker',
    ['exec', PG_CONTAINER, 'psql', '-U', PG_USER, '-d', PG_DB, '-tAqc', sql],
    { encoding: 'utf8' },
  );
  return out.trim();
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function main() {
  console.log('═'.repeat(70));
  console.log('CoAP adapter end-to-end test');
  console.log(`CoAP target : coap://${COAP_HOST}:${COAP_PORT}`);
  console.log(`Postgres    : docker exec ${PG_CONTAINER} psql -U ${PG_USER} -d ${PG_DB}`);
  console.log('═'.repeat(70));

  // ── 1. Pick a target device ────────────────────────────────────────────────
  const deviceRow = psql(
    `SELECT id, "deviceKey", name FROM devices
      WHERE deleted_at IS NULL
      ORDER BY created_at ASC
      LIMIT 1`,
  );
  if (!deviceRow) {
    throw new Error('No devices in the database. Run `npm run seed` first.');
  }
  const [deviceId, deviceKey, deviceName] = deviceRow.split('|');
  console.log(`\n[1] Target device: ${deviceName}`);
  console.log(`    id        : ${deviceId}`);
  console.log(`    deviceKey : ${deviceKey}  (← CoAP device token)`);

  const baseline = parseInt(
    psql(`SELECT count(*) FROM telemetry WHERE "deviceId" = '${deviceId}'`) || '0',
    10,
  );
  console.log(`    existing telemetry rows: ${baseline}`);

  // ── 2. Send telemetry over CoAP ────────────────────────────────────────────
  const payload = { temperature: 25.5, humidity: 60 };
  console.log(`\n[2] POST coap://${COAP_HOST}:${COAP_PORT}/api/v1/${deviceKey}/telemetry`);
  console.log(`    payload: ${JSON.stringify(payload)}`);
  const telemetryRes = await coapRequest({
    method: 'POST',
    pathname: `/api/v1/${deviceKey}/telemetry`,
    payload,
  });
  console.log(`    → CoAP response code: ${telemetryRes.code}`);
  console.log(`    → CoAP response body: ${telemetryRes.body}`);
  if (telemetryRes.code !== '2.05') {
    throw new Error(`Expected 2.05, got ${telemetryRes.code}`);
  }

  // ── 3. Verify persistence (async via the Kafka pipeline) ───────────────────
  console.log(`\n[3] Verifying telemetry landed in Postgres (polling up to 20s)...`);
  let stored: any = null;
  for (let attempt = 1; attempt <= 20; attempt++) {
    const count = parseInt(
      psql(`SELECT count(*) FROM telemetry WHERE "deviceId" = '${deviceId}'`) || '0',
      10,
    );
    if (count > baseline) {
      const json = psql(
        `SELECT json_build_object(
            'id', id, 'data', data, 'temperature', temperature,
            'humidity', humidity, 'timestamp', timestamp, 'metadata', metadata)
          FROM telemetry
         WHERE "deviceId" = '${deviceId}'
         ORDER BY created_at DESC
         LIMIT 1`,
      );
      stored = JSON.parse(json);
      break;
    }
    await sleep(1000);
  }

  if (!stored) {
    throw new Error(
      'Telemetry was accepted over CoAP (2.05) but did NOT appear in the ' +
        'telemetry table within 20s. Check the Kafka consumer / TelemetryConsumer logs.',
    );
  }
  console.log(`    ✓ Stored telemetry row: ${stored.id}`);
  console.log(`      data        : ${JSON.stringify(stored.data)}`);
  console.log(`      temperature : ${stored.temperature}`);
  console.log(`      humidity    : ${stored.humidity}`);
  console.log(`      timestamp   : ${stored.timestamp}`);
  console.log(`      metadata    : ${JSON.stringify(stored.metadata)}`);

  // ── 4a. Attributes round-trip (bonus) ──────────────────────────────────────
  console.log(`\n[4a] Attributes round-trip (POST then GET)`);
  const setRes = await coapRequest({
    method: 'POST',
    pathname: `/api/v1/${deviceKey}/attributes`,
    payload: { firmwareVersion: '1.4.2', location: 'lab-A' },
  });
  console.log(`     POST attributes → ${setRes.code} ${setRes.body}`);
  const getRes = await coapRequest({
    method: 'GET',
    pathname: `/api/v1/${deviceKey}/attributes`,
  });
  console.log(`     GET  attributes → ${getRes.code} ${getRes.body}`);

  // ── 4b. Unknown token → 4.04 (bonus) ───────────────────────────────────────
  console.log(`\n[4b] Unknown device token should return 4.04`);
  const notFound = await coapRequest({
    method: 'POST',
    pathname: `/api/v1/this-token-does-not-exist/telemetry`,
    payload: { temperature: 1 },
  });
  console.log(`     → ${notFound.code} ${notFound.body}`);
  if (notFound.code !== '4.04') {
    console.warn(`     ⚠ expected 4.04, got ${notFound.code}`);
  }

  console.log(`\n${'═'.repeat(70)}`);
  console.log('✅ CoAP TEST PASSED — telemetry ingested and persisted via CoAP.');
  console.log('═'.repeat(70));
}

main().catch((err) => {
  console.error(`\n❌ CoAP TEST FAILED: ${err.message}`);
  process.exit(1);
});
