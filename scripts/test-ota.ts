/**
 * scripts/test-ota.ts — End-to-end test for the OTA firmware pipeline.
 *
 *   npx ts-node --transpile-only scripts/test-ota.ts
 *
 * Exercises the REAL endpoints and delivery pipeline:
 *   1. Upload firmware      POST /firmware               (JWT)
 *   2. Assign to a device   POST /firmware/:id/assign    (JWT) → Kafka firmware.update
 *                            → FirmwareConsumer → MQTT push + device.firmwareUpdateStatus=PUSHING
 *   3. Device polls         GET  /ota/:deviceToken       (public) → updateAvailable:true
 *   4. Device downloads     GET  /ota/:deviceToken/download (public) → octet-stream, checksum header
 *   5. Device reports done  POST /ota/:deviceToken/status (public) { SUCCESS, installedVersion }
 *   6. Verify device.currentFirmwareVersion updated + pending cleared (DB).
 *
 * Auth: local seeded-user login is broken, so we mint a valid JWT (signed with
 * the container's JWT_SECRET) + a matching Redis session for the device's owner.
 * DB/Redis/secret are reached via `docker exec` (host :5432 is a different PG).
 */

import { execFileSync } from 'child_process';
import * as crypto from 'crypto';
import * as jwt from 'jsonwebtoken';

const BASE = process.env.OTA_TEST_BASE || 'http://localhost:5000';
const PG = 'smartlife-postgres-local';
const REDIS = 'smartlife-redis-local';
const APP = 'smartlife-app-local';
const DB_USER = 'smartlife';
const DB_NAME = 'smartlife_iot';
const NEW_VERSION = '1.0.1';
const OLD_VERSION = '1.0.0';

function psql(sql: string): string {
  return execFileSync(
    'docker',
    ['exec', PG, 'psql', '-U', DB_USER, '-d', DB_NAME, '-tAqc', sql],
    { encoding: 'utf8' },
  ).trim();
}

function dockerEnv(container: string, name: string): string {
  return execFileSync('docker', ['exec', container, 'printenv', name], {
    encoding: 'utf8',
  }).trim();
}

function redisSet(key: string, value: string, ttl: number): void {
  const pass = dockerEnv(APP, 'REDIS_PASSWORD');
  execFileSync(
    'docker',
    ['exec', REDIS, 'redis-cli', '-a', pass, '-n', '0', 'SET', key, value, 'EX', String(ttl)],
    { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] },
  );
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function unwrap(res: Response): Promise<any> {
  const json: any = await res.json().catch(() => ({}));
  return json?.data !== undefined ? json.data : json;
}

async function main() {
  console.log('═'.repeat(70));
  console.log('OTA firmware pipeline — end-to-end test');
  console.log(`Target: ${BASE}`);
  console.log('═'.repeat(70));

  // ── Pick a device + owner ────────────────────────────────────────────────
  const row = psql(
    `SELECT d.id, d."deviceKey", d."tenantId", d."userId", u.email, u.role
       FROM devices d JOIN users u ON u.id = d."userId"
      WHERE d.deleted_at IS NULL AND u.status = 'active'
      ORDER BY d.created_at ASC LIMIT 1`,
  );
  const [deviceId, deviceKey, tenantId, userId, email, role] = row.split('|');
  console.log(`\n[setup] device ${deviceKey} (owner ${email}, role ${role})`);

  // Reset OTA state deterministically: running OLD_VERSION, nothing pending.
  psql(
    `UPDATE devices SET "currentFirmwareVersion"='${OLD_VERSION}', "firmwareVersion"='${OLD_VERSION}',
       "pendingFirmwareVersion"=NULL, "firmwareUpdateStatus"=NULL, "firmwareUpdateProgress"=NULL,
       "firmwareUpdateError"=NULL, "firmwareUpdateCompletedAt"=NULL
     WHERE id='${deviceId}'`,
  );

  // ── Mint JWT + Redis session ─────────────────────────────────────────────
  const secret = dockerEnv(APP, 'JWT_SECRET');
  const sessionId = crypto.randomUUID();
  redisSet(`user:${userId}:session`, JSON.stringify({ sessionId }), 604800);
  const token = jwt.sign(
    { sub: userId, email, role, tenantId, customerId: null, sessionId },
    secret,
    { expiresIn: '1h' },
  );
  const authHeaders = { Authorization: `Bearer ${token}` };
  console.log(`[setup] minted JWT + Redis session for owner`);

  // ── 1. Upload firmware ───────────────────────────────────────────────────
  const binary = crypto.randomBytes(40000); // 40 KB fake firmware
  const expectedChecksum = crypto.createHash('sha256').update(binary).digest('hex');
  const fd = new FormData();
  fd.append('version', NEW_VERSION);
  fd.append('title', 'E2E OTA test firmware');
  fd.append('description', 'uploaded by test-ota.ts');
  fd.append('file', new Blob([binary], { type: 'application/octet-stream' }), `fw-${NEW_VERSION}.bin`);

  const upRes = await fetch(`${BASE}/firmware`, { method: 'POST', headers: authHeaders, body: fd });
  const firmware = await unwrap(upRes);
  console.log(`\n[1] POST /firmware → ${upRes.status}`);
  if (upRes.status >= 300) throw new Error(`Upload failed: ${JSON.stringify(firmware)}`);
  console.log(`    firmware id: ${firmware.id}, version ${firmware.version}, size ${firmware.size}`);
  console.log(`    checksum match: ${firmware.checksum === expectedChecksum ? 'YES' : 'NO'}`);

  // ── 2. Assign to the device ──────────────────────────────────────────────
  const asRes = await fetch(`${BASE}/firmware/${firmware.id}/assign`, {
    method: 'POST',
    headers: { ...authHeaders, 'Content-Type': 'application/json' },
    body: JSON.stringify({ targetType: 'DEVICE', targetId: deviceId }),
  });
  const assign = await unwrap(asRes);
  console.log(`\n[2] POST /firmware/${firmware.id}/assign → ${asRes.status}`);
  if (asRes.status >= 300) throw new Error(`Assign failed: ${JSON.stringify(assign)}`);
  console.log(`    ${JSON.stringify(assign)}`);

  // Consumer runs async (Kafka → MQTT push → PUSHING). Poll device state.
  let pushState = '';
  for (let i = 0; i < 15; i++) {
    pushState = psql(
      `SELECT "pendingFirmwareVersion"||'|'||COALESCE("firmwareUpdateStatus",'null') FROM devices WHERE id='${deviceId}'`,
    );
    if (pushState.endsWith('|PUSHING')) break;
    await sleep(1000);
  }
  console.log(`    device pending|status after consumer: ${pushState}`);

  // ── 3. Device polls for update ───────────────────────────────────────────
  const pollRes = await fetch(`${BASE}/ota/${deviceKey}`);
  const poll = await unwrap(pollRes);
  console.log(`\n[3] GET /ota/${deviceKey} → ${pollRes.status}`);
  console.log(`    ${JSON.stringify(poll)}`);
  if (!poll.updateAvailable) throw new Error('Expected updateAvailable:true');

  // ── 4. Device downloads the binary ───────────────────────────────────────
  const dlRes = await fetch(`${BASE}/ota/${deviceKey}/download`);
  const dlBuf = Buffer.from(await dlRes.arrayBuffer());
  const dlChecksum = crypto.createHash('sha256').update(dlBuf).digest('hex');
  console.log(`\n[4] GET /ota/${deviceKey}/download → ${dlRes.status}`);
  console.log(`    bytes: ${dlBuf.length}, Content-Length: ${dlRes.headers.get('content-length')}`);
  console.log(`    X-Firmware-Checksum: ${dlRes.headers.get('x-firmware-checksum')}`);
  console.log(`    downloaded checksum matches upload: ${dlChecksum === expectedChecksum ? 'YES' : 'NO'}`);
  if (dlChecksum !== expectedChecksum) throw new Error('Downloaded binary checksum mismatch');

  // ── 5. Device reports SUCCESS ────────────────────────────────────────────
  const stRes = await fetch(`${BASE}/ota/${deviceKey}/status`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ status: 'SUCCESS', installedVersion: NEW_VERSION }),
  });
  const status = await unwrap(stRes);
  console.log(`\n[5] POST /ota/${deviceKey}/status {SUCCESS} → ${stRes.status} ${JSON.stringify(status)}`);

  // ── 6. Verify DB ─────────────────────────────────────────────────────────
  const finalRow = psql(
    `SELECT "currentFirmwareVersion"||'|'||COALESCE("pendingFirmwareVersion",'null')||'|'||COALESCE("firmwareUpdateStatus",'null')
       FROM devices WHERE id='${deviceId}'`,
  );
  const [current, pending, finalStatus] = finalRow.split('|');
  console.log(`\n[6] device after SUCCESS: current=${current}, pending=${pending}, status=${finalStatus}`);

  const ok =
    current === NEW_VERSION && pending === 'null' && finalStatus === 'SUCCESS';
  console.log(`\n${'═'.repeat(70)}`);
  if (!ok) throw new Error('Final device state not as expected');
  console.log(`✅ OTA E2E PASSED — firmware ${OLD_VERSION} → ${NEW_VERSION} delivered and confirmed.`);
  console.log('═'.repeat(70));
}

main().catch((err) => {
  console.error(`\n❌ OTA E2E FAILED: ${err.message}`);
  process.exit(1);
});
