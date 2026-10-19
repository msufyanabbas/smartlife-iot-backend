/**
 * Every `@RequirePermissions('x:y')` in the codebase must name a permission
 * the seeder actually creates.
 *
 *   npm run check:permissions
 *
 * WHY: `PermissionGuard` resolves a user's effective set from seeded rows. A
 * permission string that is never seeded can never be granted to anyone, so
 * the route it guards is a **permanent 403** for every CUSTOMER and
 * CUSTOMER_USER — and it looks like a bug in the guard, not a typo in a
 * decorator. `tsc` sees only a string literal.
 *
 * It also catches the reverse drift: adding an action to a controller before
 * adding it to the seeder.
 *
 * No database required — both sides are read from source.
 */
import { readFileSync, readdirSync, statSync } from 'fs';
import { join } from 'path';

const ROOT = join(__dirname, '..');

let failures = 0;
const ok = (label: string, cond: boolean, detail?: unknown) => {
  if (cond) console.log(`  ✓ ${label}`);
  else {
    failures++;
    console.error(`  ✗ ${label}`, detail ?? '');
  }
};

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (full.endsWith('.ts')) out.push(full);
  }
  return out;
}

// ── What the seeder creates ──────────────────────────────────────────────────
const seedDir = join(ROOT, 'src/database/seeds/permissions');
const seeded = new Set<string>();
for (const file of walk(seedDir)) {
  const src = readFileSync(file, 'utf8');
  // Entries look like { resource: 'devices', action: 'read', ... }
  const re = /resource:\s*'([a-z_-]+)'[\s\S]{0,400}?action:\s*'([a-z]+)'/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src))) seeded.add(`${m[1]}:${m[2]}`);
  // Also pick up any that list action before resource.
  const re2 = /action:\s*'([a-z]+)'[\s\S]{0,400}?resource:\s*'([a-z_-]+)'/g;
  while ((m = re2.exec(src))) seeded.add(`${m[2]}:${m[1]}`);
}

// ── What the controllers demand ──────────────────────────────────────────────
const used = new Map<string, string[]>(); // permission -> files
for (const file of walk(join(ROOT, 'src/modules'))) {
  if (!file.endsWith('.controller.ts')) continue;
  const src = readFileSync(file, 'utf8');
  const re = /@RequirePermissions\(([^)]*)\)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src))) {
    for (const lit of m[1].matchAll(/'([^']+)'/g)) {
      const rel = file.replace(`${ROOT}/`, '');
      used.set(lit[1], [...(used.get(lit[1]) ?? []), rel]);
    }
  }
}

console.log('\n── Permission strings ─────────────');
console.log(`  seeded: ${seeded.size}   demanded by controllers: ${used.size}`);

const unseeded = [...used.keys()].filter((p) => !seeded.has(p));
ok(
  'every demanded permission is seeded (an unseeded one is a permanent 403)',
  unseeded.length === 0,
  unseeded.map((p) => `${p}  <- ${[...new Set(used.get(p))].join(', ')}`),
);

const malformed = [...used.keys()].filter((p) => !/^[a-z_-]+:[a-z]+$/.test(p));
ok('every permission is well-formed resource:action', malformed.length === 0, malformed);

// ── Coverage, reported but not enforced ──────────────────────────────────────
let handlers = 0;
let decorated = 0;
for (const file of walk(join(ROOT, 'src/modules'))) {
  if (!file.endsWith('.controller.ts')) continue;
  const lines = readFileSync(file, 'utf8').split('\n');
  for (let i = 0; i < lines.length; i++) {
    if (!/^\s*@(Get|Post|Put|Patch|Delete)\(/.test(lines[i])) continue;
    handlers++;
    // Scan to the next route decorator or the handler body.
    for (let j = i + 1; j < Math.min(i + 25, lines.length); j++) {
      if (/^\s*@(Get|Post|Put|Patch|Delete)\(/.test(lines[j])) break;
      if (lines[j].includes('@RequirePermissions')) {
        decorated++;
        break;
      }
    }
  }
}
const pct = ((decorated / handlers) * 100).toFixed(1);
console.log(
  `\n  coverage: ${decorated}/${handlers} handlers (${pct}%) carry ` +
    `@RequirePermissions`,
);
console.log(
  '  Undecorated handlers are OPEN — PermissionGuard returns true with no\n' +
    '  metadata. Coverage is reported, not enforced, because raising it is\n' +
    '  incremental work; see CLAUDE.md §4k.',
);

console.log(
  failures
    ? `\nFAIL — ${failures} check(s) failed`
    : '\nPASS — every demanded permission exists in the seeder',
);
process.exit(failures ? 1 : 0);
