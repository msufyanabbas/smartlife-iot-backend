/**
 * Proves the calculated-field evaluator cannot reach the host process.
 *
 *   npm run check:expression-sandbox
 *
 * This guards a real, previously-exploitable hole:
 * `AssetProfilesService.evaluateExpression` used `new Function(...)`, which
 * compiles into the host realm. The expression is tenant-supplied
 * (`profile.calculatedFields[].expression`, settable by any TENANT_ADMIN), so
 * "edit an asset profile" was "run arbitrary code as the server".
 *
 * The method is private, so this script reaches it the way a test would. If
 * someone later swaps the implementation for an expression parser, this file
 * should still pass unchanged — that is the point of testing the behaviour
 * rather than the mechanism.
 */
import { AssetProfilesService } from '../src/modules/profiles/asset-profiles.service';

const evaluate = (expression: string, context: Record<string, any> = {}) =>
  (AssetProfilesService.prototype as any).evaluateExpression.call(
    AssetProfilesService.prototype,
    expression,
    context,
  );

let failures = 0;
const ok = (label: string, condition: boolean, detail?: unknown) => {
  if (condition) console.log(`  ✓ ${label}`);
  else {
    failures++;
    console.error(`  ✗ ${label}`, detail ?? '');
  }
};

/** An expression that must be refused, however it is written. */
const mustThrow = (label: string, expression: string) => {
  let threw = false;
  let value: unknown;
  try {
    value = evaluate(expression, { x: 1 });
  } catch {
    threw = true;
  }
  ok(label, threw, threw ? undefined : `returned ${String(value)}`);
};

console.log('\n── Legitimate formulas still work ─────────────');
ok('arithmetic', evaluate('area * 2', { area: 21 }) === 42);
ok(
  'comparison',
  evaluate('temperature > 30', { temperature: 35 }) === true,
);
ok(
  'conditional',
  evaluate('floors > 1 ? "multi" : "single"', { floors: 3 }) === 'multi',
);
ok(
  'nested attribute data',
  evaluate('meta.rooms + 1', { meta: { rooms: 4 } }) === 5,
);
ok('string concatenation', evaluate('a + b', { a: 'x', b: 'y' }) === 'xy');

console.log('\n── Host access is refused ─────────────────────');
mustThrow('process', 'process.pid');
mustThrow('process via global', 'globalThis.process.pid');
mustThrow('require', 'require("fs")');
mustThrow('Function constructor', 'Function("return 1")()');
mustThrow(
  'constructor-chain escape',
  '({}).constructor.constructor("return process")()',
);
mustThrow('prototype pollution', '({}).__proto__.polluted = 1');
mustThrow('arrow function', '(() => 1)()');
mustThrow('template literal', '`${1}`');
mustThrow('import', 'import("fs")');
mustThrow('setTimeout', 'setTimeout(() => 1, 0)');
mustThrow('Buffer', 'Buffer.alloc(1)');

console.log('\n── Resource limits ────────────────────────────');
mustThrow('infinite loop is cut off', 'while(true){}');
mustThrow('over-long expression', `1 + ${'1 + '.repeat(200)}1`);
mustThrow('empty expression', '');

console.log('\n── The escape it actually had ─────────────────');
// The precise payload that worked against `new Function`.
let escaped: any = null;
try {
  escaped = evaluate('this.constructor.constructor("return process.env")()');
} catch {
  /* expected */
}
ok(
  'the original new Function() payload no longer returns process.env',
  escaped === null || escaped === undefined,
  escaped && typeof escaped === 'object' ? 'LEAKED ENV' : escaped,
);

console.log(
  failures
    ? `\nFAIL — ${failures} check(s) failed; the evaluator is not safe`
    : '\nPASS — formulas evaluate, host access is refused',
);
process.exit(failures ? 1 : 0);
