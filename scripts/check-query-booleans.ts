/**
 * ─────────────────────────────────────────────────────────────────────────────
 * Guard: a boolean query parameter must be coerced from the RAW value
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * The bug this prevents has now been written four separate times in this
 * repository, in three different modules, and every instance looked like a fix
 * and did nothing.
 *
 * A query string is text, so `?active=false` arrives as the string `"false"`,
 * which is truthy. Two ways to get it wrong:
 *
 *   1. `@IsBoolean()` with no transform. `enableImplicitConversion: true`
 *      turns `"false"` into `Boolean("false")` → **true**, validation passes,
 *      and the handler sees `true`. Passing `false` does what passing `true`
 *      does. Measured on `GET /assets?active=false`: it returned the ACTIVE
 *      assets.
 *
 *   2. `@Transform(({ value }) => value === 'true')` — the apparent fix, and
 *      the subtler failure. class-transformer applies the implicit conversion
 *      **before** the transform, so `value` is already `true` and the string
 *      is gone. Every input yields `true`. This one is worse than (1) because
 *      the code reads as though the problem were handled.
 *
 * Only `obj[key]` — the untransformed source object — holds what the client
 * sent. `toQueryBoolean` in `src/common/transformers/` is the one
 * implementation, and this guard requires it.
 *
 * Static, no database, no boot: it reads source text, which is the only way to
 * see a decorator that typechecks perfectly and is inert.
 *
 *   npx ts-node -T -r tsconfig-paths/register scripts/check-query-booleans.ts
 */
import { readdirSync, readFileSync, statSync } from 'fs';
import { join, relative } from 'path';

const root = join(__dirname, '..', 'src');

let failures = 0;
let checks = 0;
const ok = (label: string, condition: boolean, detail?: unknown) => {
  checks++;
  if (condition) console.log(`  \u001b[32m✓\u001b[0m ${label}`);
  else {
    failures++;
    console.error(`  \u001b[31m✗\u001b[0m ${label}`, detail ?? '');
  }
};

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (full.endsWith('.ts')) out.push(full);
  }
  return out;
}

interface Offence {
  file: string;
  property: string;
  kind: 'no-transform' | 'reads-value';
  line: number;
}

const offences: Offence[] = [];

/** The shared transformer, and the local aliases that are assigned from it. */
const ACCEPTED_TRANSFORMS = /@Transform\(\s*(toQueryBoolean|toBoolean)\s*\)/;

/**
 * Strip comments before scanning.
 *
 * Without this the guard reads its own explanatory prose — which quotes
 * `@IsBoolean()` and `@Transform(({ value }) => …)` in order to describe the
 * bug — as if it were code, and reports the documentation as the defect. The
 * §4p trap: a guard that greps for a decorator finds one quoted in a comment.
 * Line numbers are preserved by replacing comment bodies with blanks rather
 * than deleting them.
 */
function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
    .replace(/\/\/[^\n]*/g, (m) => m.replace(/[^\n]/g, ' '));
}

for (const file of walk(root)) {
  // The transformer itself describes the bug it fixes; it is pinned by
  // behaviour at the end of this script, not by scanning.
  if (file.endsWith('query-boolean.transformer.ts')) continue;

  const raw = readFileSync(file, 'utf8');
  if (!raw.includes('@IsBoolean')) continue;

  const source = stripComments(raw);
  const lines = source.split('\n');

  for (let i = 0; i < lines.length; i++) {
    if (!/@IsBoolean\(/.test(lines[i])) continue;

    // The property this decorator belongs to is the next non-decorator,
    // non-comment line.
    let property = '(unknown)';
    for (let j = i + 1; j < Math.min(i + 6, lines.length); j++) {
      const candidate = lines[j].trim();
      if (!candidate || candidate.startsWith('@') || candidate.startsWith(')')) continue;
      if (!/^[a-zA-Z_$][\w$]*\s*[?!]?\s*:/.test(candidate)) continue;
      property = candidate.replace(/[?:;].*$/, '').trim();
      break;
    }

    // This property's own decorator block: walk back while the lines are
    // decorators or their continuations, and stop at anything else. Bounding
    // it matters — a wider window picks up the PREVIOUS property's
    // @Transform and declares this one defended when it is not.
    const blockLines: string[] = [lines[i]];
    for (let j = i - 1; j >= 0; j--) {
      const text = lines[j].trim();
      if (text === '') break;
      blockLines.unshift(lines[j]);
      // The start of the block is the first decorator at this nesting level.
      if (text.startsWith('@Api') || text.startsWith('@IsOptional')) {
        // keep walking: these commonly sit above @Transform
      }
      // A property declaration bounds it.
      if (/^[a-zA-Z_$][\w$]*\s*[?!]?\s*:/.test(text)) break;
    }
    const block = blockLines.join('\n');

    // Only QUERY DTOs matter: a JSON body carries a real boolean, and
    // `@IsBoolean()` on a body field is correct as it stands. Query DTOs are
    // identified by filename, which is the convention this repo follows.
    const isQueryDto = /query|filter/i.test(file);
    if (!isQueryDto) continue;

    if (!/@Transform\(/.test(block)) {
      offences.push({ file, property, kind: 'no-transform', line: i + 1 });
    } else if (!ACCEPTED_TRANSFORMS.test(block)) {
      // A transform that reads `({ value })` for a boolean is the inert kind.
      if (/@Transform\(\s*\(\s*\{\s*value\s*\}/.test(block)) {
        offences.push({ file, property, kind: 'reads-value', line: i + 1 });
      }
    }
  }
}

console.log('\n── Boolean query parameters ───────────────────────────────\n');

const inert = offences.filter((o) => o.kind === 'reads-value');
ok(
  'no boolean query param is coerced from the already-converted `value`',
  inert.length === 0,
  inert.length > 0
    ? '\n' +
      inert
        .map(
          (o) =>
            `       ${relative(root, o.file)}:${o.line} — ${o.property}\n` +
            `         @Transform(({ value }) => …) runs AFTER the implicit conversion, so it\n` +
            `         always sees true. Use @Transform(toQueryBoolean).`,
        )
        .join('\n')
    : undefined,
);

const undefended = offences.filter((o) => o.kind === 'no-transform');
ok(
  'every boolean query param has a transform at all',
  undefended.length === 0,
  undefended.length > 0
    ? '\n' +
      undefended
        .map(
          (o) =>
            `       ${relative(root, o.file)}:${o.line} — ${o.property}\n` +
            `         Boolean("false") is true. Use @Transform(toQueryBoolean).`,
        )
        .join('\n')
    : undefined,
);

// ── The transformer itself has to read the raw value ────────────────────────
//
// The guard above only checks that the SHARED function is used. If that
// function were ever rewritten to read `value`, every call site would still
// pass while every one of them became inert — so the implementation is pinned
// too, and pinned by BEHAVIOUR rather than by text.
const transformerPath = join(root, 'common/transformers/query-boolean.transformer.ts');
const transformer = readFileSync(transformerPath, 'utf8');
ok(
  'the shared transformer reads obj[key], not value',
  /\(\s*obj\s+as[\s\S]{0,80}\)\?\.\[key\]/.test(transformer) || /obj\?\.\[key\]/.test(transformer),
  'query-boolean.transformer.ts must read the untransformed source object',
);

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { toQueryBoolean } = require('../src/common/transformers/query-boolean.transformer');

const behaves = (raw: unknown, expected: boolean | undefined) =>
  toQueryBoolean({ obj: { flag: raw }, key: 'flag', value: raw, type: 0 } as any) === expected;

ok('"false" → false', behaves('false', false));
ok('"true" → true', behaves('true', true));
ok('"0" → false', behaves('0', false));
ok('"1" → true', behaves('1', true));
ok('a real false → false', behaves(false, false));
ok('a real true → true', behaves(true, true));
ok('absent → undefined, so "not specified" is not "false"', behaves(undefined, undefined));
ok('empty → undefined', behaves('', undefined));

console.log(
  failures === 0
    ? `\n\u001b[32mPASS\u001b[0m — ${checks} checks: a boolean query parameter means what it says\n`
    : `\n\u001b[31mFAIL\u001b[0m — ${failures} of ${checks} checks failed\n`,
);
process.exit(failures === 0 ? 0 : 1);
