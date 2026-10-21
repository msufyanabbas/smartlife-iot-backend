/**
 * ─────────────────────────────────────────────────────────────────────────────
 * Guard: a socket may only join rooms it is authorized for
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * The bug this exists to prevent was made three times independently, which is
 * the signature of a rule with no home. Every `@SubscribeMessage` handler in
 * every gateway took a device id off the wire and called
 * `client.join('device:' + id)`. `WsJwtGuard` ran first, so the caller was a
 * real authenticated user — and that was the whole check. Any account could
 * stream any tenant's telemetry and alarms by naming a uuid, and the server
 * logged it as an ordinary subscription.
 *
 * `tsc` sees nothing wrong with joining a room. A test would need a running
 * Socket.IO server, a database and two tenants' fixtures. So this reads the
 * gateways and asserts the property directly: no subscribe handler joins a
 * device: or customer: room without first asking the authorizer.
 *
 * It also pins the authorizer's own failure direction. An authorizer that
 * answers "allow" when it cannot reach the database is worse than none,
 * because it looks like protection.
 *
 *   npx ts-node -T -r tsconfig-paths/register scripts/check-ws-authorization.ts
 */
import { existsSync, readFileSync } from 'fs';
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

const GATEWAYS = [
  'src/modules/websocket/websocket.gateway.ts',
  'src/modules/alarms/alarms.gateway.ts',
  'src/modules/telemetry/telemetry.gateway.ts',
];

// ── 1. The authorizer ─────────────────────────────────────────────────────
section('1. WsSubscriptionAuthorizer');

const auth = read('src/common/websocket/ws-subscription-authorizer.ts');
ok('the authorizer exists', auth.length > 0);
ok(
  'it scopes device reads by tenant',
  /where[\s\S]{0,200}tenantId/.test(auth),
);
ok(
  'a customer-scoped token is narrowed to its own customer',
  /if \(customerId\)[\s\S]{0,120}where\.customerId = customerId/.test(auth),
);
ok(
  'a non-super-admin with no tenantId is refused, not waved through',
  /if \(!tenantId\)[\s\S]{0,400}return \{ allowed: \[\], refused: requested \}/.test(
    auth,
  ),
  'a missing claim must not act as a wildcard',
);
ok(
  'SUPER_ADMIN is the only cross-tenant exception, and it is explicit',
  /role === UserRole\.SUPER_ADMIN/.test(auth),
);
ok(
  'a thrown error denies (fails closed)',
  /catch[\s\S]{0,400}return \{ allowed: \[\], refused: requested \}/.test(auth),
  'an authorizer that cannot answer must not answer "yes"',
);
// A malformed id reaches Postgres as a uuid comparison and raises
// `invalid input syntax for type uuid` — a 500 from a subscribe payload, and
// a crash loop if the widget retries.
ok(
  'malformed ids are refused before the query, not by the database',
  /UUID_RE/.test(auth) && /UUID_RE\.test/.test(auth),
);
ok(
  'the customer-room check requires the caller’s own customerId to match',
  /principal\.customerId === customerId/.test(auth),
);

// ── 2. No unguarded joins ─────────────────────────────────────────────────
section('2. Every subscribe handler authorizes before joining');

/**
 * Split a gateway into `@SubscribeMessage` blocks. A block runs from one
 * decorator to the next (or to the first server-initiated section), which is
 * coarse but sufficient: the question is only whether the authorizer is
 * called somewhere inside the handler that joins the room.
 */
function handlerBlocks(src: string): { name: string; body: string }[] {
  const parts = src.split(/@SubscribeMessage\(/).slice(1);
  return parts.map((part) => {
    const name = (part.match(/^\s*['"`]([^'"`]+)['"`]/) ?? [, 'unknown'])[1];
    // Stop at the next decorator that is not part of this handler.
    const end = part.search(/\n\s*@(OnEvent|Cron|OnModuleInit)\b/);
    return { name: name as string, body: end === -1 ? part : part.slice(0, end) };
  });
}

/** A join into a tenant-scoped room: device:<id> or customer:<id>. */
const SCOPED_JOIN = /client\.join\(\s*`(device|customer):\$\{/;

for (const file of GATEWAYS) {
  const src = read(file);
  const short = file.split('/').pop();
  ok(`${short} exists`, src.length > 0);
  if (!src) continue;

  const offenders: string[] = [];
  for (const { name, body } of handlerBlocks(src)) {
    if (!SCOPED_JOIN.test(body)) continue; // joins nothing scoped
    if (/this\.authorizer\./.test(body)) continue; // asks first
    offenders.push(name);
  }

  ok(
    `${short}: no subscribe handler joins a scoped room unauthorized`,
    offenders.length === 0,
    offenders.length > 0
      ? `unauthorized join in handler(s): ${offenders.join(', ')}`
      : undefined,
  );

  ok(
    `${short}: injects the authorizer`,
    src.includes('authorizer: WsSubscriptionAuthorizer'),
  );
}

// ── 3. Wiring ─────────────────────────────────────────────────────────────
section('3. The provider is actually reachable at runtime');

ok(
  'the module exists and depends on no feature module',
  (() => {
    const mod = read('src/common/websocket/ws-authorization.module.ts');
    if (!mod) return false;
    // Only the Device repository — anything else risks the gateway cycle.
    // Matched non-greedily to the closing bracket of `imports:` itself; a
    // `[^\]]*` capture stops inside `forFeature([Device])` and never sees it.
    const imports = mod.match(/imports:\s*\[([\s\S]*?)\],?\s*\n\s*providers:/)?.[1] ?? '';
    const other = imports.replace(/TypeOrmModule\.forFeature\(\[Device\]\)/, '');
    return (
      imports.includes('TypeOrmModule.forFeature([Device])') &&
      !/\bModule\b/.test(other)
    );
  })(),
  'a provider shared across the gateway cycle must stay repository-only',
);

for (const mod of [
  'src/modules/websocket/websocket.module.ts',
  'src/modules/alarms/alarms.module.ts',
  'src/modules/telemetry/telemetry.module.ts',
]) {
  const src = read(mod);
  const short = mod.split('/').pop();
  // A gateway whose module forgets the import fails at boot, not at compile —
  // Nest throws "can't resolve dependencies" only when it instantiates.
  ok(`${short} imports WsAuthorizationModule`, src.includes('WsAuthorizationModule'));
  ok(
    `${short} imports it exactly once`,
    (src.match(/import \{ WsAuthorizationModule \}/g) ?? []).length === 1,
    'a duplicate import statement is a TS duplicate-identifier error',
  );
}

// ── 4. The other two holes in the same files ──────────────────────────────
section('4. Related leaks in the same gateways');

const ws = read('src/modules/websocket/websocket.gateway.ts');
// `this.server.emit(...)` is a broadcast to EVERY socket in the namespace.
// The command handler used it to "send a command to a device", so one
// tenant's userId, tenantId, deviceId and command went to every other
// tenant's browser — and nothing on the server ever listened for it.
ok(
  'device:command no longer broadcasts to the whole namespace',
  !/this\.server\.emit\('device:command:request'/.test(ws),
  "use this.server.to(room).emit(...), not this.server.emit(...)",
);
ok(
  'device:command authorizes the device first',
  /handleDeviceCommand[\s\S]{0,500}this\.authorizer\./.test(ws),
);

const telemetry = read('src/modules/telemetry/telemetry.gateway.ts');
ok(
  'the telemetry gateway no longer allows any origin',
  // Anchored to the start of a line so the comment recording what it USED to
  // be ("Was `origin: '*'`") does not read as the thing it warns about.
  !/^\s*origin:\s*'\*'/m.test(telemetry),
  "cors.origin must come from websocketCorsOrigin(), not '*'",
);
ok(
  'the telemetry gateway resolves its origin from configuration',
  /origin:\s*websocketCorsOrigin\(\)/.test(telemetry),
);
ok(
  'get:subscriptions requires authentication',
  /@SubscribeMessage\('get:subscriptions'\)\s*\n\s*@UseGuards\(WsJwtGuard\)/.test(
    telemetry,
  ),
  'it enumerated a socket’s subscriptions with no guard at all',
);

// ── 5. The scoping inputs actually arrive ─────────────────────────────────
//
// The authorizer narrows by `client.data.customerId`. If the guard stops
// setting it, or the login token stops carrying it, that narrowing does not
// fail — it silently stops applying, and a customer user quietly regains
// tenant-wide visibility. A control that can become inert without any test
// going red is the defect this whole guard file exists to catch, so the two
// links in that chain are pinned here.
section('5. The claims the authorizer scopes by are actually populated');

const guard = read('src/common/guards/ws-jwt.guard.ts');
ok(
  'the socket guard copies tenantId onto client.data',
  /client\.data\.tenantId\s*=/.test(guard),
);
ok(
  'the socket guard copies customerId onto client.data',
  /client\.data\.customerId\s*=/.test(guard),
  'without it, every customer user is treated as tenant-wide',
);

const authSvc = read('src/modules/auth/auth.service.ts');
ok(
  'the signed access token carries tenantId',
  /tenantId:\s*user\.tenantId/.test(authSvc),
);
ok(
  'the signed access token carries customerId',
  /customerId:\s*user\.customerId/.test(authSvc),
  'the guard can only forward a claim the token actually contains',
);

// Refusals must not confirm that another tenant's device exists.
ok(
  'a refusal does not disclose whether the device exists',
  !/Forbidden|not your device|belongs to another tenant/i.test(ws),
  'answer "not found", not "not yours"',
);

console.log(
  failures === 0
    ? `\n\u001b[32mPASS\u001b[0m — ${checks} checks: socket room joins are authorized, not just authenticated\n`
    : `\n\u001b[31mFAIL\u001b[0m — ${failures} of ${checks} checks failed\n`,
);
process.exit(failures === 0 ? 0 : 1);
