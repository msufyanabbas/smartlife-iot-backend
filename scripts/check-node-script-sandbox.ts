/**
 * Proves the rule-node script processors cannot reach the host process.
 *
 *   npm run check:node-sandbox
 *
 * Companion to `check-expression-sandbox.ts`. Three places in this codebase ran
 * tenant-authored JavaScript through bare `new Function()`, which compiles into
 * the host realm; two of them were these rule-node processors. The script comes
 * from `node.configuration.script`, so editing a rule chain was arbitrary code
 * execution as the server process.
 *
 * Both processors now go through `@common/utils/script-sandbox`. This asserts
 * the behaviour, not the mechanism, so it should still pass if vm2 is later
 * swapped for `isolated-vm`.
 */
import { FilterNodeProcessor } from '../src/modules/nodes/filter-node';
import { TransformationNodeProcessor } from '../src/modules/nodes/transformation-node';

const filter = new FilterNodeProcessor();
const transform = new TransformationNodeProcessor();

let failures = 0;
const ok = (label: string, condition: boolean, detail?: unknown) => {
  if (condition) console.log(`  ✓ ${label}`);
  else {
    failures++;
    console.error(`  ✗ ${label}`, detail ?? '');
  }
};

const msg = (data: Record<string, any>) => ({
  data,
  metadata: { deviceId: 'd1' },
}) as any;

/**
 * A hostile script must not succeed. "Succeeded" means the processor returned
 * a success result — a thrown error, or a failure route, is the safe outcome.
 *
 * Note the trap: `typeof process` on an unbound identifier evaluates to the
 * STRING "undefined" and does not throw. A probe that only checks for a throw
 * passes vacuously against a leaking sandbox, so each probe below asserts on
 * the value that came back.
 */
const escapes: Array<[string, string]> = [
  ['process.pid', 'return process.pid;'],
  ['process via global', 'return global.process.pid;'],
  ['require', 'return require("fs").readdirSync("/");'],
  ['constructor chain', 'return ({}).constructor.constructor("return process")();'],
  ['Function', 'return Function("return process")();'],
  ['eval', 'return eval("process");'],
  ['Buffer', 'return Buffer.alloc(4).toString();'],
  ['this.constructor', 'return this.constructor.constructor("return process.env")();'],
];

console.log('\n── Filter node: host access refused ───────────');
for (const [label, code] of escapes) {
  let leaked: any = 'THREW';
  try {
    leaked = (filter as any).executeScript(code, msg({ t: 1 }));
  } catch {
    /* expected */
  }
  // A leak returns something truthy and process-shaped; a safe sandbox either
  // throws or yields undefined/false.
  ok(
    `filter: ${label}`,
    leaked === 'THREW' || leaked === false || leaked === undefined,
    leaked,
  );
}

console.log('\n── Transformation node: host access refused ───');
for (const [label, code] of escapes) {
  let leaked: any = 'THREW';
  try {
    leaked = (transform as any).executeTransformScript(code, msg({ t: 1 }));
  } catch {
    /* expected */
  }
  ok(
    `transform: ${label}`,
    leaked === 'THREW' || leaked === undefined || leaked === null,
    leaked,
  );
}

console.log('\n── Legitimate scripts still work ──────────────');
ok(
  'filter returns true for a matching message',
  (filter as any).executeScript('return msg.temperature > 30;', msg({ temperature: 35 })) === true,
);
ok(
  'filter returns false for a non-matching message',
  (filter as any).executeScript('return msg.temperature > 30;', msg({ temperature: 10 })) === false,
);
const transformed = (transform as any).executeTransformScript(
  'msg.celsius = (msg.f - 32) / 1.8; return msg;',
  msg({ f: 212 }),
);
ok('transform computes a derived key', transformed?.celsius === 100, transformed);
ok(
  'transform can read metadata',
  (transform as any).executeTransformScript('return { d: metadata.deviceId };', msg({}))?.d === 'd1',
);

console.log('\n── Resource and isolation limits ──────────────');
let looped: any = 'THREW';
try {
  looped = (filter as any).executeScript('while(true){}', msg({}));
} catch {
  /* expected */
}
ok('an infinite loop is interrupted', looped === 'THREW', looped);

// The caller's message must not be mutable from inside the sandbox: a rule
// chain that silently rewrote the message for every downstream node would be
// very hard to debug.
const original = msg({ keep: 1 });
try {
  (transform as any).executeTransformScript('msg.keep = 999; return msg;', original);
} catch {
  /* not the point of this probe */
}
ok('the caller’s payload is not mutated', original.data.keep === 1, original.data);

console.log(
  failures
    ? `\nFAIL — ${failures} check(s) failed; rule-node scripts are not contained`
    : '\nPASS — rule-node scripts run, host access is refused',
);
process.exit(failures ? 1 : 0);
