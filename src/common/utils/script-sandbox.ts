import { VM, VMScript } from 'vm2';

/**
 * One place where user-supplied JavaScript is executed.
 *
 * ── Why this file exists ───────────────────────────────────────────────────
 * This codebase ran tenant-authored JavaScript through bare `new Function()`
 * in at least three places:
 *
 *   - `asset-profiles.service.ts`  — calculated-field formulas
 *   - `nodes/filter-node.ts`       — a rule node's filter script
 *   - `nodes/transformation-node.ts` — a rule node's transform script
 *
 * `new Function` compiles into the **host realm**. The code it produces sees
 * this process's globals, so `process.mainModule.require('child_process')` is
 * a short walk from any of them. Every one of those scripts comes from a row a
 * TENANT_ADMIN can write through the API, which made "edit a rule chain" and
 * "edit an asset profile" equivalent to "run code as the server" — on a
 * multi-tenant platform.
 *
 * `ScriptsService.runInSandbox()` already did this correctly with vm2. Rather
 * than copy that configuration into two more files and let the three drift,
 * everything funnels through here.
 *
 * ── Honest limits ──────────────────────────────────────────────────────────
 * vm2 is the repo's existing choice and is enormously better than
 * `new Function`, but it is a JavaScript-level sandbox: it has had critical
 * escape CVEs in the past, and a sandbox escape is a single bug away from a
 * full compromise. The durable answer for untrusted code is a separate V8
 * isolate (`isolated-vm`) or an out-of-process worker with a hard memory and
 * CPU cap. Because every call site now goes through `runUserScript`, that swap
 * is a change to this one function.
 *
 * `asset-profiles.service.ts` deliberately does NOT use this helper: a
 * calculated field is an arithmetic expression, not a program, so it is held
 * to a much stricter rule (a denylist plus `node:vm` with a 50 ms budget).
 * Narrower is safer; do not "unify" the two.
 */

/** Clamped so a node's own config cannot hang a worker indefinitely. */
const MIN_TIMEOUT_MS = 50;
const MAX_TIMEOUT_MS = 10_000;
const DEFAULT_TIMEOUT_MS = 2_000;

export interface UserScriptContext {
  /** The message payload. Cloned before it crosses the boundary. */
  msg: unknown;
  /** Message metadata. Cloned. */
  metadata?: unknown;
  msgType?: string;
}

export interface UserScriptOptions {
  timeoutMs?: number;
  /** Used only in the error message, so a failure names the offending node. */
  label?: string;
}

const clampTimeout = (value?: number): number => {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return DEFAULT_TIMEOUT_MS;
  }
  return Math.min(MAX_TIMEOUT_MS, Math.max(MIN_TIMEOUT_MS, Math.trunc(value)));
};

/**
 * Deep-clone through JSON so only plain data crosses into the sandbox.
 *
 * Passing a live object would hand the script a reference whose prototype
 * chain leads back to this realm — the thing the sandbox exists to prevent —
 * and would also let a script mutate the caller's message in place, which has
 * surprised people in rule chains before.
 */
const clone = <T>(value: T): T => {
  if (value === undefined || value === null) return value;
  try {
    return JSON.parse(JSON.stringify(value));
  } catch {
    return undefined as unknown as T;
  }
};

/**
 * Run a user script as a function body with `msg`, `metadata` and `msgType` in
 * scope, and return its value.
 *
 * A top-level `return` in the user's code exits immediately — the ThingsBoard
 * convention the rest of this codebase follows.
 *
 * Throws on a syntax error, a thrown error inside the script, or a timeout.
 * The caller decides whether that is a failed route or a 400.
 */
export function runUserScript(
  code: string,
  context: UserScriptContext,
  options: UserScriptOptions = {},
): any {
  if (typeof code !== 'string' || !code.trim()) {
    throw new Error('Script is empty');
  }

  const sandbox: Record<string, unknown> = {
    msg: clone(context.msg),
    metadata: clone(context.metadata) ?? {},
    msgType: context.msgType,
    // vm2 leaves Buffer reachable inside the sandbox; it is a host-realm
    // constructor and nothing in a telemetry script needs it. `eval: false`
    // already blocks the .constructor.constructor route, so this is
    // belt-and-braces rather than the primary defence.
    Buffer: undefined,
  };

  const vm = new VM({
    timeout: clampTimeout(options.timeoutMs),
    sandbox,
    eval: false,
    wasm: false,
    allowAsync: false,
  });

  // Emitted exactly once. A wrapper that inlines the source in two branches
  // double-evaluates side effects and turns any multi-statement script into a
  // syntax error the moment it is spliced into `return (…)`.
  const wrapped = [
    '(function (msg, metadata, msgType) {',
    '  "use strict";',
    code,
    '})(msg, metadata, msgType);',
  ].join('\n');

  try {
    const result = vm.run(new VMScript(wrapped));
    // A function or symbol cannot be serialised onward and is never a
    // legitimate result; returning one usually means the script forgot to call
    // its own entry point.
    if (typeof result === 'function' || typeof result === 'symbol') {
      throw new Error('Script must return a value, not a function');
    }
    return clone(result);
  } catch (error: any) {
    const where = options.label ? ` in ${options.label}` : '';
    throw new Error(`Script failed${where}: ${error?.message ?? error}`);
  }
}
