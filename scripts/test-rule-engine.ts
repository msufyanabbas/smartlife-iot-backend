/**
 * End-to-end test for the Rule Engine pipeline.
 *
 * What this script does:
 *  1. Login as tenant admin
 *  2. GET first available device
 *  3. POST /rule-chains — create "Test Chain"
 *  4. POST /rule-chains/:id/activate — make it ACTIVE (required for engine to pick it up)
 *  5. POST /nodes × 2 — filter node + action node, both wired to the chain
 *  6. POST /telemetry/devices/:deviceKey — direct HTTP telemetry ingest
 *  7. Publish a message directly to Kafka topic `rules.input` — bypasses MQTT
 *     (necessary because MQTT broker is not running in local dev)
 *  8. Wait 3s for the consumer to process
 *  9. GET /rule-chains/:id — print executionCount, lastExecuted, errorHistory
 */

import axios from 'axios';
import { Kafka } from 'kafkajs';

// ── Config ──────────────────────────────────────────────────────────────────
// NOTE: main.ts does not call setGlobalPrefix, so routes are served at the
// root (e.g. /auth/login), not under /api.
const BASE = 'http://localhost:5000';
const KAFKA_BROKER = 'localhost:9093';

// Seeded tenant admin credentials (from src/database/seeds/user/user.seeder.ts)
const EMAIL = 'admin@acmecorp.com';
const PASSWORD = 'TenantAdmin@123';

// ── Helpers ──────────────────────────────────────────────────────────────────
const log = (label: string, value?: any) => {
  console.log(`\n${'─'.repeat(60)}`);
  console.log(`  ${label}`);
  if (value !== undefined) console.log(JSON.stringify(value, null, 2));
};

const step = (n: number, desc: string) =>
  console.log(`\n${'═'.repeat(60)}\n  STEP ${n}: ${desc}\n${'═'.repeat(60)}`);

const http = axios.create({ baseURL: BASE, timeout: 10_000 });

function authHeader(token: string) {
  return { headers: { Authorization: `Bearer ${token}` } };
}

// ── Main ─────────────────────────────────────────────────────────────────────
async function run() {
  console.log('\n🚀  Rule Engine E2E Test\n');

  // ── Step 1: Login ──────────────────────────────────────────────────────────
  step(1, `Login as ${EMAIL}`);
  const loginRes = await http.post('/auth/login', { email: EMAIL, password: PASSWORD });
  const { accessToken, user } = loginRes.data?.data ?? loginRes.data;
  log('Logged in', { userId: user?.id, tenantId: user?.tenantId, role: user?.role });

  const auth = authHeader(accessToken);
  const tenantId: string = user.tenantId;

  // ── Step 2: Get first device ───────────────────────────────────────────────
  step(2, 'GET /devices — find first device');
  const devicesRes = await http.get('/devices?limit=1', auth);
  const devices = devicesRes.data?.data?.data ?? devicesRes.data?.data ?? devicesRes.data;
  const deviceList = Array.isArray(devices) ? devices : devices?.data ?? [];

  if (!deviceList.length) {
    console.error('❌  No devices found — run `npm run seed` first');
    process.exit(1);
  }
  const device = deviceList[0];
  log('Using device', { id: device.id, name: device.name, deviceKey: device.deviceKey });

  // ── Step 3: Create rule chain ──────────────────────────────────────────────
  step(3, 'POST /rule-chains — create "Test Chain"');

  // Clean up any leftover "Test Chain" from a previous run (avoids 409 conflict)
  const existingRes = await http.get('/rule-chains?limit=100', auth);
  const existingRaw =
    existingRes.data?.data?.data ?? existingRes.data?.data ?? existingRes.data;
  const existingChains = Array.isArray(existingRaw)
    ? existingRaw
    : existingRaw?.data ?? [];
  for (const c of existingChains.filter((c: any) => c.name === 'Test Chain')) {
    await http.delete(`/rule-chains/${c.id}`, auth);
    log('Deleted leftover chain', { id: c.id });
  }

  const chainRes = await http.post(
    '/rule-chains',
    {
      name: 'Test Chain',
      description: 'E2E test rule chain',
      isRoot: false,
      enabled: true,
      configuration: {
        messageTypes: ['TELEMETRY'],
      },
    },
    auth,
  );
  const chain = chainRes.data?.data ?? chainRes.data;
  log('Rule chain created', { id: chain.id, status: chain.status, enabled: chain.enabled });

  // ── Step 4: Activate the chain ─────────────────────────────────────────────
  step(4, `POST /rule-chains/${chain.id}/activate`);
  const activateRes = await http.post(`/rule-chains/${chain.id}/activate`, {}, auth);
  const activated = activateRes.data?.data ?? activateRes.data;
  log('Rule chain activated', { status: activated.status, enabled: activated.enabled });

  // ── Step 5a: Create filter node ────────────────────────────────────────────
  step(5, 'POST /nodes — create FILTER node');
  const filterRes = await http.post(
    '/nodes',
    {
      name: 'Telemetry Type Filter',
      type: 'filter',
      ruleChainId: chain.id,
      enabled: true,
      configuration: {
        filterType: 'condition',
        messageTypes: ['TELEMETRY'],
      },
      position: { x: 100, y: 200 },
    },
    auth,
  );
  const filterNode = filterRes.data?.data ?? filterRes.data;
  log('Filter node created', { id: filterNode.id, type: filterNode.type });

  // ── Step 5b: Create action node ────────────────────────────────────────────
  step(5, 'POST /nodes — create ACTION node');
  const actionRes = await http.post(
    '/nodes',
    {
      name: 'Create Alarm',
      type: 'action',
      ruleChainId: chain.id,
      enabled: true,
      configuration: {
        actionType: 'create_alarm',
        alarmType: 'TestAlarm',
        name: 'Test Alarm',
        severity: 'WARNING',
        description: 'Created by rule engine E2E test',
      },
      position: { x: 300, y: 200 },
    },
    auth,
  );
  const actionNode = actionRes.data?.data ?? actionRes.data;
  log('Action node created', { id: actionNode.id, type: actionNode.type });

  // ── Step 6: POST telemetry via HTTP ────────────────────────────────────────
  step(6, `POST /telemetry/devices/${device.deviceKey} — direct HTTP ingest`);
  try {
    const telemetryPayload = {
      timestamp: new Date().toISOString(),
      data: { temperature: 35.5, humidity: 60, pressure: 1013 },
    };
    const telRes = await http.post(
      `/telemetry/devices/${device.deviceKey}`,
      telemetryPayload,
      auth,
    );
    const telData = telRes.data?.data ?? telRes.data;
    log('Telemetry stored (direct HTTP)', { id: telData?.id ?? '(saved)' });
  } catch (err: any) {
    console.warn(`⚠️  Direct telemetry ingest failed: ${err.message} — continuing`);
  }

  // ── Step 7: Publish to Kafka rules.input ───────────────────────────────────
  //   The direct HTTP telemetry endpoint bypasses the Kafka pipeline,
  //   so we publish directly to `rules.input` to trigger the rule engine.
  //   (MQTT broker is not running in local dev; this is the reliable path.)
  step(7, `Publish to Kafka rules.input for tenant ${tenantId}`);
  const kafka = new Kafka({
    clientId: 'rule-engine-test',
    brokers: [KAFKA_BROKER],
    connectionTimeout: 5_000,
    retry: { retries: 2 },
  });
  const producer = kafka.producer();

  try {
    await producer.connect();
    log('Kafka producer connected');

    const message = {
      tenantId,
      entityId: device.id,
      entityType: 'DEVICE',
      eventType: 'TELEMETRY',
      data: { temperature: 35.5, humidity: 60 },
      deviceKey: device.deviceKey,
      timestamp: Date.now(),
    };

    await producer.send({
      topic: 'rules.input',
      messages: [{ key: device.id, value: JSON.stringify(message) }],
    });

    log('Message sent to rules.input', message);
    await producer.disconnect();
  } catch (err: any) {
    console.error(`❌  Kafka publish failed: ${err.message}`);
    console.error(
      '   Make sure Kafka is running (docker compose up kafka) and accessible on localhost:9093',
    );
    await producer.disconnect().catch(() => {});
  }

  // ── Step 8: Wait for consumer to process ──────────────────────────────────
  step(8, 'Waiting 5 seconds for rule engine consumer...');
  await new Promise(r => setTimeout(r, 5000));

  // ── Step 9: Fetch rule chain stats ─────────────────────────────────────────
  step(9, `GET /rule-chains/${chain.id} — check execution stats`);
  const statsRes = await http.get(`/rule-chains/${chain.id}`, auth);
  const updated = statsRes.data?.data ?? statsRes.data;

  log('Rule chain stats', {
    id: updated.id,
    name: updated.name,
    status: updated.status,
    executionCount: updated.executionCount,
    successCount: updated.successCount,
    failureCount: updated.failureCount,
    lastExecuted: updated.lastExecuted,
    averageExecutionTime: updated.averageExecutionTime,
    errorHistory: updated.errorHistory ?? [],
  });

  // ── Summary ────────────────────────────────────────────────────────────────
  console.log('\n' + '═'.repeat(60));
  if (updated.executionCount > 0) {
    console.log(`\n✅  SUCCESS — chain executed ${updated.executionCount} time(s)`);
    console.log(`   Last executed: ${updated.lastExecuted}`);
    console.log(`   Success rate:  ${updated.successCount}/${updated.executionCount}`);
    if (updated.averageExecutionTime) {
      console.log(`   Avg duration:  ${updated.averageExecutionTime}ms`);
    }
  } else {
    console.log('\n⚠️  executionCount is still 0.');
    console.log('   Possible causes:');
    console.log('   1. Kafka is not reachable on localhost:9093');
    console.log('   2. The rule chain was not ACTIVE when the message arrived');
    console.log('   3. No active rule chains matched message type "TELEMETRY"');
    console.log('   4. The rule engine consumer group has a pending rebalance (try again)');
  }
  console.log('\n' + '═'.repeat(60) + '\n');
}

run().catch(err => {
  console.error('\n❌  Test failed');
  console.error('   message:        ', err?.message);
  console.error('   response.status:', err?.response?.status);
  console.error('   response.data:  ', JSON.stringify(err?.response?.data));
  if (err?.code) console.error('   code:           ', err.code);
  process.exit(1);
});
