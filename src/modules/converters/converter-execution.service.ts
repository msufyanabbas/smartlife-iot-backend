import { Injectable, Logger } from '@nestjs/common';
import { VM, VMScript } from 'vm2';
import { CodecRegistryService } from '../devices/codecs/codec-registry.service';
import { Converter } from './entities/converter.entity';
import { ConverterDirection, ConverterType } from './converter.enums';
import { JsonMappingRule } from './converter-catalogue';

/**
 * ─────────────────────────────────────────────────────────────────────────────
 * The executor. One method per converter type, and a trace of every step.
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * Nothing here persists anything or reads the database; `ConvertersService`
 * owns the row and the counters. That split is what lets
 * `POST /converters/:id/test` run the real executor without the sample payloads
 * making a converter's health look worse than its traffic did — the same
 * reasoning as `RuleEngineService.testChain()` and `persistStats = false`.
 *
 * ── Script sandboxing ───────────────────────────────────────────────────────
 * Two in-repo precedents were available and they are not equally safe:
 *
 *   - `ScriptsService.runInSandbox()` uses **vm2** with `eval: false`,
 *     `wasm: false`, `allowAsync: false`, injects no host intrinsics, and
 *     deep-clones in and out.
 *   - `modules/nodes/filter-node.ts:115` and
 *     `modules/nodes/transformation-node.ts:61` use a bare `new Function(...)`,
 *     which is not a boundary at all — the code runs in this process with the
 *     module scope of the node file. (`processors/script-node.ts` uses
 *     `node:vm` for its legacy inline path, better but still only containment.)
 *
 * This follows the vm2 one. `payload` and `metadata` are deep-cloned in and the
 * result is deep-cloned out, so a script can neither mutate the caller's
 * objects nor hand back a live proxy into its own context. `Buffer` is shadowed
 * away because vm2 leaves it reachable and it is a host-realm constructor;
 * `eval: false` already blocks the `.constructor.constructor` route out of any
 * such object, so that is belt-and-braces rather than the primary defence.
 */

export interface ConverterTraceStep {
  step: number;
  name: string;
  status: 'ok' | 'skipped' | 'error';
  /** One line a human can read without unfolding the payload. */
  detail: string;
  durationMs: number;
  /** Present for mapping steps: what the path resolved to before transforms. */
  resolved?: unknown;
  /** Present for mapping steps: what was written out. */
  value?: unknown;
}

export interface ConverterExecutionResult {
  success: boolean;
  /** The converted payload, or null when the run failed. */
  output: Record<string, any> | null;
  error?: string;
  /** Pulled out of the INPUT payload by `deviceKeyPath`, when configured. */
  deviceKey?: string;
  /** Epoch milliseconds resolved from `timestampPath`, when configured. */
  timestamp?: number;
  durationMs: number;
  trace: ConverterTraceStep[];
  /** `console.log` output from a script converter. */
  logs?: string[];
}

export interface ConvertContext {
  /** Free-form context handed to the executor — deviceKey, fPort, devEUI… */
  metadata?: Record<string, any>;
  /** Downlink only: the command to encode. */
  command?: { type: string; params?: any };
}

const MIN_SCRIPT_TIMEOUT_MS = 50;
const MAX_SCRIPT_TIMEOUT_MS = 10_000;
const DEFAULT_SCRIPT_TIMEOUT_MS = 2_000;
const MAX_LOG_ENTRIES = 50;
const MAX_LOG_LENGTH = 500;

@Injectable()
export class ConverterExecutionService {
  private readonly logger = new Logger(ConverterExecutionService.name);

  constructor(private readonly codecRegistry: CodecRegistryService) {}

  // ══════════════════════════════════════════════════════════════════════════
  // ENTRY POINT
  // ══════════════════════════════════════════════════════════════════════════

  /**
   * Run `converter` over `payload`. Never throws: a converter that blows up on
   * one malformed reading must not take down the uplink path that called it, so
   * the failure comes back as `{success:false, error}` with the trace intact.
   */
  async run(
    converter: Converter,
    payload: unknown,
    context: ConvertContext = {},
  ): Promise<ConverterExecutionResult> {
    const started = Date.now();
    const trace: ConverterTraceStep[] = [];
    const config = converter.configuration ?? {};

    const input = this.parseInput(payload, trace);
    const deviceKey = this.extractDeviceKey(input, config, trace);
    const timestamp = this.extractTimestamp(input, config, trace);

    try {
      let output: Record<string, any> | null;
      let logs: string[] | undefined;

      switch (converter.type) {
        case ConverterType.JSON:
          output = this.runJson(converter, input, trace);
          break;
        case ConverterType.CODEC:
          output = this.runCodec(converter, input, context, trace);
          break;
        case ConverterType.SCRIPT: {
          const scriptResult = this.runScript(converter, input, context, trace);
          output = scriptResult.output;
          logs = scriptResult.logs;
          break;
        }
        default:
          // Unreachable while the enum and the switch agree; an unknown value
          // in the column (a hand-edited row) lands here rather than silently
          // returning the payload unchanged.
          throw new Error(`Converter type "${converter.type}" has no executor`);
      }

      return {
        success: true,
        output,
        deviceKey,
        timestamp,
        durationMs: Date.now() - started,
        trace,
        ...(logs?.length ? { logs } : {}),
      };
    } catch (error: any) {
      const message = error?.message ?? 'conversion failed';
      trace.push({
        step: trace.length + 1,
        name: 'failed',
        status: 'error',
        detail: message,
        durationMs: 0,
      });
      return {
        success: false,
        output: null,
        error: message,
        deviceKey,
        timestamp,
        durationMs: Date.now() - started,
        trace,
      };
    }
  }

  // ══════════════════════════════════════════════════════════════════════════
  // JSON — declarative field mapping
  // ══════════════════════════════════════════════════════════════════════════

  private runJson(
    converter: Converter,
    input: unknown,
    trace: ConverterTraceStep[],
  ): Record<string, any> {
    const config = converter.configuration ?? {};
    const rules: JsonMappingRule[] = Array.isArray(config.mappings)
      ? config.mappings
      : [];

    if (!rules.length) {
      // Declared `required` in the manifest, so this only happens on a row that
      // predates the mapping or was written around the validator.
      throw new Error('json converter has no mappings configured');
    }

    const source = this.asObject(input);
    const output: Record<string, any> = {};
    const units: Record<string, string> = {};
    const stripNulls = config.stripNulls !== false;

    for (const rule of rules) {
      const stepStarted = Date.now();
      const resolved = this.resolvePath(source, rule.source);

      if (resolved === undefined) {
        if (rule.required) {
          throw new Error(
            `required source path "${rule.source}" is missing from the payload`,
          );
        }
        if (rule.default !== undefined) {
          output[rule.target] = rule.default;
          trace.push({
            step: trace.length + 1,
            name: `map ${rule.source} → ${rule.target}`,
            status: 'ok',
            detail: 'path absent; wrote the configured default',
            durationMs: Date.now() - stepStarted,
            resolved: undefined,
            value: rule.default,
          });
          continue;
        }
        trace.push({
          step: trace.length + 1,
          name: `map ${rule.source} → ${rule.target}`,
          status: 'skipped',
          detail: `path "${rule.source}" is not present in the payload`,
          durationMs: Date.now() - stepStarted,
        });
        continue;
      }

      const transformed = this.applyTransforms(resolved, rule);

      if (transformed === null && stripNulls) {
        trace.push({
          step: trace.length + 1,
          name: `map ${rule.source} → ${rule.target}`,
          status: 'skipped',
          detail: 'value is null and "Drop null results" is on',
          durationMs: Date.now() - stepStarted,
          resolved,
        });
        continue;
      }

      output[rule.target] = transformed;
      if (rule.unit) units[rule.target] = rule.unit;

      trace.push({
        step: trace.length + 1,
        name: `map ${rule.source} → ${rule.target}`,
        status: 'ok',
        detail: this.describeTransforms(rule),
        durationMs: Date.now() - stepStarted,
        resolved,
        value: transformed,
      });
    }

    if (config.includeUnmapped === true) {
      const stepStarted = Date.now();
      const claimed = new Set(
        rules.map((rule) => rule.source.split(/[.[]/)[0]).filter(Boolean),
      );
      const copied: string[] = [];
      for (const [key, value] of Object.entries(source)) {
        if (claimed.has(key) || key in output) continue;
        output[key] = value;
        copied.push(key);
      }
      trace.push({
        step: trace.length + 1,
        name: 'copy unmapped keys',
        status: copied.length ? 'ok' : 'skipped',
        detail: copied.length
          ? `copied ${copied.length}: ${copied.join(', ')}`
          : 'no unmapped top-level keys left to copy',
        durationMs: Date.now() - stepStarted,
      });
    }

    // A sidecar rather than inline keys, so `$units` can never collide with a
    // telemetry key a mapping produced.
    if (Object.keys(units).length) output.$units = units;

    return output;
  }

  /** Cast first, then scale, then offset — so `scale` always sees a number. */
  private applyTransforms(value: unknown, rule: JsonMappingRule): any {
    let out: any = value;

    switch (rule.cast) {
      case 'number': {
        const numeric = Number(out);
        out = Number.isFinite(numeric) ? numeric : null;
        break;
      }
      case 'integer': {
        const numeric = Number(out);
        out = Number.isFinite(numeric) ? Math.trunc(numeric) : null;
        break;
      }
      case 'string':
        out =
          out === null || out === undefined
            ? null
            : typeof out === 'object'
              ? JSON.stringify(out)
              : String(out);
        break;
      case 'boolean':
        // '0' and 'false' are the two values a vendor sends that would both be
        // truthy under a bare Boolean() cast.
        out =
          typeof out === 'string'
            ? !['', '0', 'false', 'off', 'no'].includes(out.trim().toLowerCase())
            : Boolean(out);
        break;
      default:
        break;
    }

    const scale = rule.scale === undefined ? undefined : Number(rule.scale);
    const offset = rule.offset === undefined ? undefined : Number(rule.offset);

    if (scale !== undefined && Number.isFinite(scale)) {
      const numeric = Number(out);
      if (!Number.isFinite(numeric)) {
        throw new Error(
          `cannot scale "${rule.source}": ${JSON.stringify(value)} is not numeric`,
        );
      }
      out = numeric * scale;
    }
    if (offset !== undefined && Number.isFinite(offset)) {
      const numeric = Number(out);
      if (!Number.isFinite(numeric)) {
        throw new Error(
          `cannot offset "${rule.source}": ${JSON.stringify(value)} is not numeric`,
        );
      }
      out = numeric + offset;
    }

    // Floating-point scaling turns 308 * 0.1 into 30.800000000000004, which
    // then reaches a dashboard. Snap it back to something a sensor could mean.
    if (typeof out === 'number' && !Number.isInteger(out)) {
      out = Math.round(out * 1e6) / 1e6;
    }

    return out;
  }

  private describeTransforms(rule: JsonMappingRule): string {
    const parts: string[] = [];
    if (rule.cast) parts.push(`cast to ${rule.cast}`);
    if (rule.scale !== undefined) parts.push(`× ${rule.scale}`);
    if (rule.offset !== undefined) parts.push(`+ ${rule.offset}`);
    if (rule.unit) parts.push(`unit ${rule.unit}`);
    return parts.length ? parts.join(', ') : 'copied as-is';
  }

  // ══════════════════════════════════════════════════════════════════════════
  // CODEC — delegates to CodecRegistryService
  // ══════════════════════════════════════════════════════════════════════════

  /**
   * The point of the whole module: the 80+ Milesight codecs under
   * `devices/codecs/` are reachable from a converter without reimplementing a
   * byte of decoding. Everything here is payload extraction and codec
   * selection; `CodecRegistryService` does the work and is not modified.
   */
  private runCodec(
    converter: Converter,
    input: unknown,
    context: ConvertContext,
    trace: ConverterTraceStep[],
  ): Record<string, any> {
    const config = converter.configuration ?? {};

    if (converter.direction === ConverterDirection.DOWNLINK) {
      return this.runCodecDownlink(converter, context, trace);
    }

    // ── 1. Dig the frame out of the message ───────────────────────────────
    let stepStarted = Date.now();
    const path =
      typeof config.payloadPath === 'string' && config.payloadPath.trim()
        ? config.payloadPath.trim()
        : undefined;

    let frame: unknown = input;
    if (path) {
      frame = this.resolvePath(this.asObject(input), path);
      if (frame === undefined) {
        throw new Error(
          `payload path "${path}" is not present in the message`,
        );
      }
    }
    trace.push({
      step: trace.length + 1,
      name: 'extract frame',
      status: 'ok',
      detail: path
        ? `took the frame from "${path}"`
        : 'the message is the frame',
      durationMs: Date.now() - stepStarted,
      value: typeof frame === 'string' ? frame : '[object]',
    });

    // ── 2. Pick the codec, and say which and why ──────────────────────────
    stepStarted = Date.now();
    const codecId =
      typeof config.codecId === 'string' && config.codecId.trim()
        ? config.codecId.trim()
        : undefined;
    const manufacturer =
      typeof config.manufacturer === 'string' ? config.manufacturer : undefined;
    const model = typeof config.model === 'string' ? config.model : undefined;
    const fPort = this.resolveFPort(config, context);

    let chosen = codecId ? this.codecRegistry.getCodec(codecId) : undefined;
    if (codecId && !chosen) {
      // CodecRegistryService.decode() would fall through to auto-detection and
      // then to `{raw_data, decoded:false}`. For a converter that names a
      // codec, a typo'd id must be an error, not a silent downgrade.
      throw new Error(
        `codec "${codecId}" is not registered — see GET /codecs for what is`,
      );
    }
    if (!chosen && manufacturer && model) {
      chosen = this.codecRegistry.findCodec(manufacturer, model);
      if (!chosen && config.allowAutoDetect !== true) {
        throw new Error(
          `no codec registered for ${manufacturer} ${model}, and auto-detection is off`,
        );
      }
    }
    if (!chosen && config.allowAutoDetect !== true) {
      throw new Error(
        'no codec selected: name a codecId, or a manufacturer and model, or turn on auto-detection',
      );
    }

    trace.push({
      step: trace.length + 1,
      name: 'select codec',
      status: 'ok',
      detail: chosen
        ? `${chosen.codecId} (${chosen.manufacturer} ${chosen.supportedModels.join('/')})`
        : 'none configured — probing every registered codec',
      durationMs: Date.now() - stepStarted,
    });

    // ── 3. Decode, through the registry ───────────────────────────────────
    stepStarted = Date.now();
    const decoded = this.codecRegistry.decode(frame, {
      ...(chosen ? { codecId: chosen.codecId } : {}),
      ...(manufacturer ? { manufacturer } : {}),
      ...(model ? { model } : {}),
      ...(fPort !== undefined ? { fPort } : {}),
      ...(context.metadata?.devEUI ? { devEUI: context.metadata.devEUI } : {}),
    });

    // The registry swallows a codec that throws and answers
    // `{raw_data, decoded:false, error}`. A converter has somewhere to report
    // that, so it does, instead of writing a non-telemetry object to telemetry.
    if (decoded && (decoded as any).decoded === false) {
      throw new Error(
        (decoded as any).error ??
          'the registry could not decode this payload with any codec',
      );
    }

    const keys = Object.keys(decoded ?? {});
    trace.push({
      step: trace.length + 1,
      name: 'decode',
      status: 'ok',
      detail: `${keys.length} key(s): ${keys.slice(0, 12).join(', ')}${keys.length > 12 ? '…' : ''}`,
      durationMs: Date.now() - stepStarted,
    });

    return decoded as Record<string, any>;
  }

  private runCodecDownlink(
    converter: Converter,
    context: ConvertContext,
    trace: ConverterTraceStep[],
  ): Record<string, any> {
    const config = converter.configuration ?? {};
    const stepStarted = Date.now();

    const codecId =
      typeof config.codecId === 'string' && config.codecId.trim()
        ? config.codecId.trim()
        : undefined;
    if (!codecId) {
      throw new Error(
        'a codec downlink needs an explicit codecId — encoding cannot be auto-detected',
      );
    }

    const type = context.command?.type ?? config.commandType;
    if (!type || typeof type !== 'string') {
      throw new Error(
        'a codec downlink needs a command: pass `command: {type, params}`',
      );
    }

    const encoded = this.codecRegistry.encode(
      { type, params: context.command?.params },
      { codecId },
    );

    trace.push({
      step: trace.length + 1,
      name: 'encode',
      status: 'ok',
      detail: `${codecId} encoded "${type}" → ${encoded.data}`,
      durationMs: Date.now() - stepStarted,
    });

    return { ...encoded };
  }

  private resolveFPort(
    config: Record<string, any>,
    context: ConvertContext,
  ): number | undefined {
    // Per-message wins: one converter serves many devices, and the fPort is a
    // property of the frame, not of the configuration.
    const candidates = [context.metadata?.fPort, config.fPort];
    for (const candidate of candidates) {
      const numeric = Number(candidate);
      if (candidate !== undefined && candidate !== null && Number.isFinite(numeric)) {
        return numeric;
      }
    }
    return undefined;
  }

  // ══════════════════════════════════════════════════════════════════════════
  // SCRIPT — vm2, following ScriptsService
  // ══════════════════════════════════════════════════════════════════════════

  private runScript(
    converter: Converter,
    input: unknown,
    context: ConvertContext,
    trace: ConverterTraceStep[],
  ): { output: Record<string, any> | null; logs: string[] } {
    const config = converter.configuration ?? {};
    const source = config.script;

    if (typeof source !== 'string' || !source.trim()) {
      throw new Error('script converter has no script configured');
    }

    const timeout = this.resolveTimeout(config.timeout);
    const logs: string[] = [];
    const stepStarted = Date.now();

    const sandbox = {
      payload: this.clone(input),
      metadata: this.clone(context.metadata ?? {}),
      command: this.clone(context.command ?? null),
      // vm2 leaves Buffer reachable, and it is a host-realm constructor.
      // Nothing in a converter script needs it, so shadow it away.
      Buffer: undefined,
      console: {
        log: (...args: any[]) => this.pushLog(logs, '', args),
        info: (...args: any[]) => this.pushLog(logs, '', args),
        warn: (...args: any[]) => this.pushLog(logs, 'WARN', args),
        error: (...args: any[]) => this.pushLog(logs, 'ERROR', args),
      },
    };

    let raw: unknown;
    try {
      const vm = new VM({
        timeout,
        sandbox,
        eval: false,
        wasm: false,
        allowAsync: false,
      });
      raw = vm.run(new VMScript(this.buildWrapper(source)));
    } catch (error: any) {
      const message = error?.message ?? 'script execution failed';
      if (/timed out/i.test(message)) {
        throw new Error(`script execution timed out after ${timeout}ms`);
      }
      throw new Error(message);
    }

    const output = this.sanitize(raw);

    if (output === undefined || output === null) {
      throw new Error(
        'script returned nothing — return an object of telemetry keys',
      );
    }
    if (typeof output !== 'object' || Array.isArray(output)) {
      throw new Error(
        `script returned ${Array.isArray(output) ? 'an array' : typeof output}; an object of telemetry keys is required`,
      );
    }

    trace.push({
      step: trace.length + 1,
      name: 'run script',
      status: 'ok',
      detail: `vm2 sandbox, ${timeout}ms budget; returned ${Object.keys(output).length} key(s)`,
      durationMs: Date.now() - stepStarted,
      value: output,
    });

    return { output: output as Record<string, any>, logs };
  }

  /**
   * Wrap the user's code as a function body, exactly once.
   *
   * A top-level `return` exits immediately (the ThingsBoard style). If the code
   * instead *declares* `decode`/`encode`/`main`, execution falls through to the
   * dispatch lines, which hoisting makes able to see the declaration.
   * `typeof X === 'function'` on an undeclared identifier is safe even under
   * strict mode, so an absent entry point costs nothing.
   *
   * Emitting the source once matters: a wrapper that inlines it in two branches
   * double-evaluates side effects and turns any multi-statement script into a
   * syntax error the moment it is spliced into `return (…)`.
   */
  private buildWrapper(code: string): string {
    return [
      '(function (payload, metadata, command) {',
      '  "use strict";',
      code,
      '  if (typeof decode === "function") return decode(payload, metadata);',
      '  if (typeof encode === "function") return encode(command, metadata);',
      '  if (typeof main === "function") return main(payload, metadata);',
      '  return undefined;',
      '})(payload, metadata, command);',
    ].join('\n');
  }

  /** Compile-only check, so create/update rejects a syntax error immediately. */
  assertScriptCompiles(code: string): void {
    new VMScript(this.buildWrapper(code)).compile();
  }

  private resolveTimeout(configured?: unknown): number {
    const value = Number(configured);
    if (!Number.isFinite(value) || value <= 0) return DEFAULT_SCRIPT_TIMEOUT_MS;
    return Math.min(
      Math.max(Math.round(value), MIN_SCRIPT_TIMEOUT_MS),
      MAX_SCRIPT_TIMEOUT_MS,
    );
  }

  // ══════════════════════════════════════════════════════════════════════════
  // SHARED HELPERS
  // ══════════════════════════════════════════════════════════════════════════

  /**
   * Resolve a dot path, with array indices in either notation.
   *
   *   'object.temperature'      → obj.object.temperature
   *   'readings.0.value'        → obj.readings[0].value
   *   'readings[0].value'       → the same
   *
   * Returns `undefined` for a path that does not exist, which is what lets the
   * mapping loop tell "absent" from "present but null". Own properties only:
   * `constructor.prototype` and `__proto__` resolve to undefined rather than
   * handing a path expression a route up the prototype chain.
   */
  resolvePath(source: unknown, path: string): unknown {
    if (source === null || source === undefined || typeof path !== 'string') {
      return undefined;
    }

    const segments = path
      .replace(/\[(\d+)\]/g, '.$1')
      .split('.')
      .map((segment) => segment.trim())
      .filter((segment) => segment.length > 0);

    let current: any = source;
    for (const segment of segments) {
      if (current === null || current === undefined) return undefined;

      if (Array.isArray(current)) {
        const index = Number(segment);
        if (!Number.isInteger(index)) return undefined;
        current = current[index];
        continue;
      }

      if (typeof current !== 'object') return undefined;
      if (!Object.prototype.hasOwnProperty.call(current, segment)) {
        return undefined;
      }
      current = current[segment];
    }

    return current;
  }

  /**
   * A JSON string arriving as the payload is normal — an MQTT message body and
   * an HTTP relay both deliver one. Parse it once, here, so every type sees an
   * object and a mapping path works the same either way.
   */
  private parseInput(payload: unknown, trace: ConverterTraceStep[]): unknown {
    const started = Date.now();

    if (typeof payload !== 'string') {
      trace.push({
        step: trace.length + 1,
        name: 'read payload',
        status: 'ok',
        detail: Array.isArray(payload)
          ? 'array'
          : payload === null
            ? 'null'
            : typeof payload,
        durationMs: Date.now() - started,
      });
      return payload;
    }

    const trimmed = payload.trim();
    if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
      try {
        const parsed = JSON.parse(trimmed);
        trace.push({
          step: trace.length + 1,
          name: 'read payload',
          status: 'ok',
          detail: 'parsed the body as JSON',
          durationMs: Date.now() - started,
        });
        return parsed;
      } catch {
        // Fall through: a codec converter is handed the string untouched, and a
        // JSON converter will fail informatively on its first mapping.
      }
    }

    trace.push({
      step: trace.length + 1,
      name: 'read payload',
      status: 'ok',
      detail: 'raw string (hex/base64 frame or non-JSON body)',
      durationMs: Date.now() - started,
    });
    return payload;
  }

  private extractDeviceKey(
    input: unknown,
    config: Record<string, any>,
    trace: ConverterTraceStep[],
  ): string | undefined {
    const path = config.deviceKeyPath;
    if (typeof path !== 'string' || !path.trim()) return undefined;

    const started = Date.now();
    const resolved = this.resolvePath(input, path.trim());
    const value =
      resolved === undefined || resolved === null ? undefined : String(resolved);

    trace.push({
      step: trace.length + 1,
      name: 'resolve device identity',
      status: value ? 'ok' : 'skipped',
      detail: value
        ? `"${path}" → ${value}`
        : `"${path}" is not present in the payload`,
      durationMs: Date.now() - started,
      value,
    });
    return value;
  }

  private extractTimestamp(
    input: unknown,
    config: Record<string, any>,
    trace: ConverterTraceStep[],
  ): number | undefined {
    const path = config.timestampPath;
    if (typeof path !== 'string' || !path.trim()) return undefined;

    const started = Date.now();
    const resolved = this.resolvePath(input, path.trim());
    let value: number | undefined;

    if (typeof resolved === 'number' && Number.isFinite(resolved)) {
      // A vendor sends either; 1e12 is the ~2001 boundary that separates them.
      value = resolved < 1e12 ? Math.round(resolved * 1000) : Math.round(resolved);
    } else if (typeof resolved === 'string' && resolved.trim()) {
      const parsed = Date.parse(resolved);
      if (!Number.isNaN(parsed)) value = parsed;
    }

    trace.push({
      step: trace.length + 1,
      name: 'resolve timestamp',
      status: value === undefined ? 'skipped' : 'ok',
      detail:
        value === undefined
          ? `"${path}" is absent or unparseable; the reading time will be "now"`
          : `"${path}" → ${new Date(value).toISOString()}`,
      durationMs: Date.now() - started,
      value,
    });
    return value;
  }

  private asObject(input: unknown): Record<string, any> {
    if (input !== null && typeof input === 'object' && !Array.isArray(input)) {
      return input as Record<string, any>;
    }
    throw new Error(
      `a json converter needs an object payload, got ${
        Array.isArray(input) ? 'an array' : input === null ? 'null' : typeof input
      }`,
    );
  }

  /**
   * Deep-copy a value out of the sandbox. vm2 hands back host-side proxies for
   * objects created inside the VM; JSON round-tripping severs that link and
   * drops functions, so nothing live escapes into the rest of the platform.
   */
  private sanitize(value: any): any {
    if (value === undefined || value === null) return value;

    const type = typeof value;
    if (type === 'boolean' || type === 'number' || type === 'string') return value;
    if (type === 'function' || type === 'symbol' || type === 'bigint') {
      return undefined;
    }

    try {
      return JSON.parse(JSON.stringify(value));
    } catch {
      throw new Error(
        'script returned a value that cannot be serialised (circular reference?)',
      );
    }
  }

  private clone<T>(value: T): T {
    try {
      return JSON.parse(JSON.stringify(value ?? null));
    } catch {
      return null as unknown as T;
    }
  }

  private pushLog(logs: string[], level: string, args: any[]): void {
    if (logs.length >= MAX_LOG_ENTRIES) return;

    const line = args
      .map((arg) => {
        if (typeof arg === 'string') return arg;
        try {
          return JSON.stringify(arg) ?? String(arg);
        } catch {
          return String(arg);
        }
      })
      .join(' ');

    logs.push(`${level ? `${level}: ` : ''}${line}`.slice(0, MAX_LOG_LENGTH));
  }
}
