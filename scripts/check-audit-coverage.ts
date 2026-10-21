/**
 * ─────────────────────────────────────────────────────────────────────────────
 * Guard: the audit log actually records things
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * The bug this exists to prevent has already happened, twice over, and both
 * halves typechecked perfectly:
 *
 *   1. **Ten of the eighteen `@OnEvent` handlers in
 *      `audit-events.service.ts` had no emitter anywhere in the codebase.**
 *      `user.login`, `user.login.failed`, `user.logout`,
 *      `user.role.changed`, `device.created`, `device.updated`,
 *      `device.deleted`, `device.disconnected` and `device.command.sent` all
 *      returned zero for `grep "emit('<name>'"`. The handlers were complete,
 *      correct, well-commented — and unreachable. Authentication was not
 *      recorded at all: the audit log could not answer "who logged in".
 *
 *   2. **The `@Audit()` interceptor was on 3 of 56 controllers**, one handler
 *      each, out of ~700 routes. `AuditInterceptor` is registered globally and
 *      returns `next.handle()` untouched when a handler has no AUDIT_KEY
 *      metadata, so an undecorated route is silence, not an error.
 *
 * Check 1 is the one that would have caught the original bug, and it is the
 * only check here that can fail for a reason other than "someone removed a
 * decorator": an `@OnEvent` handler with no emitter is dead code that looks
 * like coverage.
 *
 * It also asserts that the seeder does not write fabricated audit rows. In any
 * other table demo data is a convenience; in an audit log a row that does not
 * correspond to something that happened destroys the table's only property.
 *
 *   npm run check:audit-coverage
 */
import { readFileSync, existsSync, readdirSync, statSync } from 'fs';
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

function info(label: string): void {
  console.log(`  \u001b[36m·\u001b[0m ${label}`);
}

function section(title: string): void {
  console.log(`\n── ${title} ${'─'.repeat(Math.max(0, 58 - title.length))}`);
}

const read = (p: string): string => {
  const full = join(root, p);
  return existsSync(full) ? readFileSync(full, 'utf8') : '';
};

/** Every .ts file under src, so "is this event emitted anywhere" is honest. */
function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      if (entry === 'node_modules' || entry === 'dist') continue;
      walk(full, out);
    } else if (entry.endsWith('.ts') && !entry.endsWith('.d.ts')) {
      out.push(full);
    }
  }
  return out;
}

const srcFiles = walk(join(root, 'src'));
const sources = new Map<string, string>();
for (const f of srcFiles) sources.set(f, readFileSync(f, 'utf8'));

// ── 1. Every audit @OnEvent handler has an emitter ────────────────────────
//
// THE check. Written first because it is the one that would have caught the
// original defect, and because it keeps catching it: a handler added here
// without an emitter is a silent no-op that reads as coverage.
section('1. Every audit @OnEvent handler has an emitter');

const eventsService = read('src/modules/audit/audit-events.service.ts');
ok('audit-events.service.ts exists', eventsService.length > 0);

const handled = [
  ...eventsService.matchAll(/@OnEvent\(\s*'([^']+)'\s*\)/g),
].map((m) => m[1]);

ok(
  `handlers found (${handled.length})`,
  handled.length >= 18,
  handled.length,
);

/**
 * Count emitters for an event name.
 *
 * `audit-events.service.ts` is excluded from the search: a handler quoting its
 * own event name in a comment must not count as an emitter, which is exactly
 * how a check like this gets quietly defeated.
 */
function emitterSites(event: string): string[] {
  const needle = new RegExp(
    `emit(?:Async)?\\(\\s*['"\`]${event.replace(/\./g, '\\.')}['"\`]`,
  );
  const sites: string[] = [];
  for (const [file, src] of sources) {
    if (file.endsWith('audit-events.service.ts')) continue;
    if (needle.test(src)) sites.push(file.replace(root + '/', ''));
  }
  return sites;
}

const orphans: string[] = [];
for (const event of handled) {
  const sites = emitterSites(event);
  if (sites.length === 0) orphans.push(event);
}

ok(
  'no audit handler is orphaned (every @OnEvent has >= 1 emitter)',
  orphans.length === 0,
  orphans.length
    ? `orphaned events: ${orphans.join(', ')} — the handler exists, nothing ` +
      `emits it, so the action is NOT recorded`
    : undefined,
);

for (const event of handled) {
  const sites = emitterSites(event);
  info(
    `${event.padEnd(26)} ← ${
      sites.length ? sites.join(', ') : 'NOTHING'
    }`,
  );
}

// The four that matter most, named explicitly so a regression names itself
// rather than appearing as "1 orphan".
section('1b. Authentication specifically');

for (const event of [
  'user.login',
  'user.login.failed',
  'user.logout',
  'user.role.changed',
]) {
  const sites = emitterSites(event);
  ok(
    `'${event}' is emitted (${sites.length} site(s))`,
    sites.length > 0,
    'a security audit log that cannot answer "who logged in" is not an audit log',
  );
}

ok(
  'login and logout are emitted from the auth service',
  /emit\(\s*'user\.login'/.test(read('src/modules/auth/auth.service.ts')) &&
    /emit\(\s*'user\.logout'/.test(read('src/modules/auth/auth.service.ts')),
);

// A failed login must be recorded on EVERY failure mode, not only the happy
// unhappy path. Bad password, inactive account and bad 2FA code are three
// separate branches and each was silent.
const authSrc = read('src/modules/auth/auth.service.ts');
ok(
  'failed logins are recorded for bad credentials, inactive accounts AND bad 2FA',
  (authSrc.match(/emitLoginFailed\(/g) ?? []).length >= 5,
  (authSrc.match(/emitLoginFailed\(/g) ?? []).length,
);

// ── 2. Handlers cannot throw their row away ───────────────────────────────
//
// `audit_logs.tenantId` is NOT NULL. Several emitters send only the entity
// (`{ user }`, `{ alarm }`), so a handler reading `payload.tenantId` directly
// got `undefined`, the INSERT threw, and because EventEmitter2.emit() discards
// the returned promise the failure surfaced as an unhandled rejection rather
// than anything a developer would see. Eight handlers that DID fire wrote
// nothing for this reason.
section('2. The write path cannot silently discard a row');

ok(
  'there is one guarded write path, not a logAction() call per handler',
  /private async record\(/.test(eventsService),
);
ok(
  'the write path catches and logs instead of rethrowing into the emitter',
  /catch \(error\)[\s\S]{0,400}logger\.error/.test(eventsService),
);
ok(
  'tenantId is resolved from the entity when the emitter did not send it',
  /resolveTenantId/.test(eventsService) &&
    /payload\?\.user\?\.tenantId/.test(eventsService),
);
ok(
  'no handler calls auditService.logAction() directly any more',
  !/this\.auditService\.logAction\(\{/.test(eventsService),
  'a direct call bypasses the tenant guard and the catch',
);
ok(
  "the 'system' tenant sentinel is gone",
  !/tenantId:[^\n]*\|\|\s*'system'/.test(eventsService),
  'tenantId relates to tenants(id); a sentinel is an FK violation or an unreadable row',
);

// ── 3. @Audit() coverage across the API ───────────────────────────────────
section('3. @Audit() coverage on state-changing routes');

const controllers = srcFiles.filter((f) => f.endsWith('.controller.ts'));
const WRITE_VERB = /^\s*@(Post|Put|Patch|Delete)\(/;

let writeRoutes = 0;
let audited = 0;
let publicWrites = 0;
const undecorated: string[] = [];

for (const file of controllers) {
  const src = sources.get(file)!;
  const lines = src.split('\n');
  for (let i = 0; i < lines.length; i++) {
    if (!WRITE_VERB.test(lines[i])) continue;
    writeRoutes++;

    const window: string[] = [];
    for (const h of lines.slice(i + 1, i + 40)) {
      if (/^\s*@(Get|Post|Put|Patch|Delete)\(/.test(h)) break;
      window.push(h);
    }
    const joined = window.join('\n');

    if (/@Public/.test(joined)) {
      publicWrites++;
      continue;
    }
    if (/@Audit\(/.test(joined)) {
      audited++;
    } else {
      undecorated.push(
        `${file.replace(root + '/', '')}:${i + 1} ${lines[i].trim()}`,
      );
    }
  }
}

const auditable = writeRoutes - publicWrites;
const pct = auditable ? Math.round((audited / auditable) * 1000) / 10 : 0;

info(`${writeRoutes} state-changing routes across ${controllers.length} controllers`);
info(`${publicWrites} are @Public (no authenticated actor to attribute a row to)`);
info(`${audited} of ${auditable} auditable write routes carry @Audit()  —  ${pct}%`);

// The floor is set well below current coverage on purpose. This check is a
// ratchet against the API regressing to the 3-controller state it was in, not
// a demand that every new route be decorated in the same commit — and the
// undecorated list below says exactly which ones to look at.
ok(
  `coverage of auditable write routes is at least 60% (currently ${pct}%)`,
  pct >= 60,
  `${undecorated.length} undecorated`,
);
ok(
  'more than three controllers carry @Audit()',
  new Set(
    controllers.filter((f) => /@Audit\(/.test(sources.get(f)!)),
  ).size > 3,
);

if (undecorated.length) {
  console.log(
    `\n  Undecorated auditable write routes (${undecorated.length}) — ` +
      `expected for reads-in-disguise and event-covered routes:`,
  );
  for (const line of undecorated.slice(0, 40)) console.log(`    ${line}`);
  if (undecorated.length > 40) {
    console.log(`    … and ${undecorated.length - 40} more`);
  }
}

// ── 4. The seeder does not fabricate audit rows ───────────────────────────
section('4. The seeder does not fabricate audit rows');

const seeder = read('src/database/seeds/audit-log/audit-log.seeder.ts');
ok('the audit-log seeder exists (so there is something to gate)', seeder.length > 0);
ok(
  'it is gated behind an explicit opt-in flag',
  /SEED_DEMO_AUDIT_LOGS/.test(seeder),
  'a seeded database must not show audit activity that never happened',
);
ok(
  'the gate defaults to OFF (requires an exact "true")',
  /process\.env\.SEED_DEMO_AUDIT_LOGS !== 'true'/.test(seeder),
);
ok(
  'the gate returns before any repository write',
  seeder.indexOf('SEED_DEMO_AUDIT_LOGS') <
    Math.min(
      ...[seeder.indexOf('.save('), seeder.indexOf('.insert(')].filter(
        (n) => n > -1,
      ),
    ),
  'gating after the first write would seed rows anyway',
);

// ── 5. Retention ──────────────────────────────────────────────────────────
section('5. Retention');

const retention = read('src/modules/audit/audit-retention.service.ts');
ok('a retention service exists', retention.length > 0);
ok('it runs on a cron', /@Cron\(/.test(retention));
ok(
  'the window is configurable via AUDIT_RETENTION_DAYS',
  /AUDIT_RETENTION_DAYS/.test(retention),
);
ok(
  'it is registered as a provider (an unregistered @Cron never fires)',
  /AuditRetentionService/.test(read('src/modules/audit/audit.module.ts')),
  'this is the AuditConsumer mistake: a complete class in no module',
);
ok(
  'the sweep is a single idempotent DELETE, so it is safe unlocked on N replicas',
  /auditRepository\.delete\(/.test(retention) &&
    /LessThan\(cutoff\)/.test(retention),
);
ok(
  'the lock-friendliness is stated in a comment for the distributed-lock work',
  /lock/i.test(retention),
);
ok(
  'a bad or negative value falls back to the default rather than deleting everything',
  /Number\.isFinite\(parsed\) && parsed >= 0/.test(retention),
);
ok(
  'it filters on `timestamp`, the column deleteOld() and every index use',
  /timestamp: LessThan/.test(retention),
  'filtering on createdAt would disagree with DELETE /audit/cleanup/:daysOld',
);

// ── 6. The dead Kafka consumer is gone ────────────────────────────────────
section('6. No dead write path');

ok(
  'audit.consumer.ts is deleted, not left unregistered',
  !existsSync(join(root, 'src/modules/audit/audit.consumer.ts')),
  '533 lines consuming topics nothing produces, in no module — see the report',
);
ok(
  'nothing references AuditConsumer',
  ![...sources.values()].some((s) => /AuditConsumer/.test(s)),
);

console.log(
  failures === 0
    ? `\n\u001b[32mPASS\u001b[0m — ${checks} checks: every audit handler is reachable, ` +
      `${pct}% of auditable write routes are decorated, retention is configured\n`
    : `\n\u001b[31mFAIL\u001b[0m — ${failures} of ${checks} checks failed\n`,
);
process.exit(failures === 0 ? 0 : 1);
