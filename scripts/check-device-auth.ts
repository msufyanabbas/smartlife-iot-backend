/**
 * ─────────────────────────────────────────────────────────────────────────────
 * Guard: device authentication is actually enforced on every ingest path
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * The bug this exists to prevent has already happened once, and it is the
 * kind that typechecks perfectly: `device_credentials` modelled three
 * credential types, `verifyCredentials()` was written correctly, and nothing
 * ever called it. Every ingest path resolved the device by `deviceKey` — a
 * public identifier — so the platform had no device authentication at all
 * while appearing to have three kinds.
 *
 * `tsc` cannot see that. A test would need a database, Kafka and a broker.
 * This reads the source and asserts the properties that matter:
 *
 *   • every public ingest path goes through DeviceAuthService
 *   • no ingest path resolves a device by deviceKey behind its back
 *   • enforcement defaults to ON
 *   • secrets are compared in constant time
 *   • the broker is configured to delegate authn AND authz
 *
 *   npx ts-node -T -r tsconfig-paths/register scripts/check-device-auth.ts
 */
import { readFileSync, existsSync } from 'fs';
import { join } from 'path';

const root = join(__dirname, '..');
let failures = 0;
let checks = 0;

function ok(label: string, condition: boolean, detail?: unknown): void {
  checks++;
  if (condition) {
    console.log(`  \u001b[32m✓\u001b[0m ${label}`);
  } else {
    failures++;
    console.log(`  \u001b[31m✗\u001b[0m ${label}`);
    if (detail !== undefined) console.log('     ', detail);
  }
}

function section(title: string): void {
  console.log(`\n── ${title} ${'─'.repeat(Math.max(0, 58 - title.length))}`);
}

const read = (p: string): string => {
  const full = join(root, p);
  return existsSync(full) ? readFileSync(full, 'utf8') : '';
};

// ── 1. The verifier itself ────────────────────────────────────────────────
section('1. DeviceAuthService');

const svc = read('src/modules/device-auth/device-auth.service.ts');
ok('the service exists', svc.length > 0);
ok(
  'enforcement defaults to ON (only an explicit "false" disables it)',
  svc.includes("process.env.DEVICE_AUTH_ENFORCED !== 'false'"),
);
ok(
  'secrets are compared with timingSafeEqual, not ===',
  svc.includes('timingSafeEqual'),
);
ok(
  'both sides are hashed before comparison, so lengths cannot leak',
  /createHash\('sha256'\)[\s\S]{0,200}timingSafeEqual/.test(svc),
);
ok(
  'failed lookups are cached, so bad tokens cannot amplify into queries',
  svc.includes('NEGATIVE_TTL_SECONDS'),
);
ok(
  'an unexpected error denies rather than allows (fails closed)',
  /catch[\s\S]{0,260}return null/.test(svc),
);
ok(
  'credential types are not interchangeable',
  svc.includes('allowedTypes.includes'),
);
ok(
  'revocation can invalidate the cache',
  svc.includes('async invalidate('),
);

// ── 2. Ingest paths ───────────────────────────────────────────────────────
section('2. Every ingest path authenticates');

const http = read('src/modules/protocols/adapters/http.adapter.ts');
const coap = read('src/modules/protocols/adapters/coap.adapter.ts');

ok('HTTP adapter injects DeviceAuthService', http.includes('deviceAuth'));
ok(
  'HTTP single-device ingest resolves through the verifier',
  /resolveDevice\(/.test(http) && http.includes('deviceAuth.authenticate'),
);
ok(
  'HTTP ingest uses the AUTHENTICATED deviceKey, not the URL segment',
  http.includes('deviceId: authed.device.deviceKey'),
);
// Route ORDER decides whether the hardened batch handler is reachable at
// all. Nest matches in declaration order, so with `@Post(':deviceId')` first
// every POST to /v1/ingestion/batch was captured by the single-device
// handler with deviceId='batch' — the batch route was dead code, and all the
// authorization on it was decorative.
ok(
  'the batch route is declared BEFORE the :deviceId route, so it is reachable',
  http.indexOf("@Post('batch')") !== -1 &&
    http.indexOf("@Post('batch')") < http.indexOf("@Post(':deviceId')"),
  'a static segment must be declared above a parameterised one',
);

ok(
  'HTTP batch ingest requires the caller to authenticate',
  /caller[\s\S]{0,300}Unauthorized/.test(http),
);
ok(
  'HTTP batch entries are bounded by the caller’s tenant',
  http.includes('caller.device.tenantId'),
);
ok('CoAP adapter injects DeviceAuthService', coap.includes('deviceAuth'));
ok(
  'CoAP resolves its path token through the verifier',
  /findDeviceByToken[\s\S]{0,700}deviceAuth\.authenticate/.test(coap),
);

// The original defect, stated directly: a device resolved by key alone.
//
// A lookup may opt out with an `// auth-safe:` comment immediately above it,
// which must say WHY it is not an identity decision — an outbound downlink
// address lookup, for instance. Opting out is deliberately visible in a diff;
// silently widening this regex is how the hole would come back.
function bareKeyLookups(src: string): number {
  const lines = src.split('\n');
  let count = 0;
  for (let i = 0; i < lines.length; i++) {
    if (!/deviceRepository\.findOne\(/.test(lines[i])) continue;
    const window = lines.slice(i, i + 4).join(' ');
    if (!/where:\s*\{\s*deviceKey/.test(window)) continue;
    const preceding = lines.slice(Math.max(0, i - 6), i).join(' ');
    if (preceding.includes('auth-safe:')) continue;
    count++;
  }
  return count;
}
ok(
  'CoAP no longer resolves a device by deviceKey alone',
  bareKeyLookups(coap) === 0,
  'found an unannotated bare deviceKey lookup in coap.adapter.ts',
);
ok(
  'HTTP no longer resolves a device by deviceKey alone',
  bareKeyLookups(http) === 0,
  'found an unannotated bare deviceKey lookup in http.adapter.ts',
);

// `lookupByDeviceKey` is a deliberate, documented exception. Assert it stays
// rare — if it spreads, authentication has quietly been routed around.
const lookupUses = (http.match(/lookupByDeviceKey/g) ?? []).length;
ok(
  `the unauthenticated lookup helper is used sparingly (${lookupUses} call sites in http.adapter)`,
  lookupUses <= 3,
  lookupUses,
);

// ── 3. The MQTT broker ────────────────────────────────────────────────────
section('3. EMQX delegates both decisions');

const emqx = read('docker/emqx/emqx.conf');
ok('an EMQX 5 configuration file exists', emqx.length > 0);
ok(
  'authentication is delegated to the application',
  emqx.includes('/device-auth/mqtt/authn'),
);
ok(
  'authorization is delegated too — authn alone lets a device forge others',
  emqx.includes('/device-auth/mqtt/authz'),
);
ok('unmatched topics are denied', /no_match\s*=\s*deny/.test(emqx));

const prodCompose = read('docker-compose.prod.yml');
ok(
  'the config is mounted into the EMQX container',
  prodCompose.includes('docker/emqx/emqx.conf:/opt/emqx/etc/emqx.conf'),
);
ok(
  'the EMQX 4.x no-op variables are gone',
  !/^\s*-\s*EMQX_ALLOW_ANONYMOUS=/m.test(prodCompose),
  'EMQX_ALLOW_ANONYMOUS is a 4.x variable and does nothing on 5.x',
);

const ctrl = read('src/modules/device-auth/device-auth.controller.ts');
ok(
  'the platform’s own broker client is allowed, so ingestion survives',
  ctrl.includes('MQTT_USERNAME') && ctrl.includes('is_superuser: true'),
);
ok(
  'a blank MQTT_PASSWORD does not become a bypass',
  /platformUser\s*&&\s*\n?\s*platformPass\s*&&/.test(ctrl),
);
ok(
  'the topic ACL binds a device to its OWN deviceKey',
  ctrl.includes('devices/${key}/telemetry'),
);

// ── 4. Operability ────────────────────────────────────────────────────────
section('4. The migration path exists');

ok(
  'a backfill script issues credentials to devices that have none',
  existsSync(join(root, 'scripts/backfill-device-credentials.ts')),
);
const backfill = read('scripts/backfill-device-credentials.ts');
ok('the backfill is a dry run unless --apply is passed', backfill.includes('--apply'));
ok(
  'the backfill never rotates an existing credential',
  backfill.includes('c.id IS NULL'),
);
ok(
  'tokens come from a CSPRNG',
  backfill.includes('crypto.randomBytes(32)'),
);
ok(
  'the module is registered in the application',
  read('src/modules/index.module.ts').includes('DeviceAuthModule'),
);

console.log(
  failures === 0
    ? `\n\u001b[32mPASS\u001b[0m — ${checks} checks: device authentication is enforced on every ingest path\n`
    : `\n\u001b[31mFAIL\u001b[0m — ${failures} of ${checks} checks failed\n`,
);
process.exit(failures === 0 ? 0 : 1);
