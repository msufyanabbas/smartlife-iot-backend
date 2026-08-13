import { Injectable, Logger } from '@nestjs/common';
import * as vm from 'vm';
import {
  INodeProcessor,
  NodeMessage,
  NodeProcessorResult,
} from '../nodes-processor.interface';
import { ScriptsService } from '../../scripts/scripts.service';
import { ScriptType } from '@common/enums/index.enum';

/**
 * SCRIPT node — runs a script against the message and routes on the result.
 *
 * Two sources of code, in priority order:
 *
 * 1. `configuration.scriptId` — a row in the `scripts` table, executed by
 *    ScriptsService inside a vm2 sandbox. This is the supported path: the
 *    script is versioned, testable via POST /scripts/:id/test, reusable across
 *    chains, and its execution statistics are recorded.
 * 2. `configuration.script` — a raw inline string, executed with Node's `vm`.
 *    Legacy, kept so existing node rows keep working. `vm` is a *containment*
 *    boundary, not a security one, so inline scripts are only as trustworthy as
 *    whoever can edit the node.
 *
 * Routing follows the script type:
 *   FILTER        → 'true' / 'false'
 *   VALIDATION    → 'true' when {valid:true}, else 'false'
 *   TRANSFORMATION→ 'success', message replaced by {msg, metadata, msgType}
 *   ENRICHMENT    → 'success', result merged into metadata
 *   other         → 'success', object results replace msg
 * A failed run always routes 'failure'.
 *
 * configuration:
 * {
 *   scriptId?: string,   // preferred
 *   script?: string,     // legacy inline JS
 *   timeout?: number     // inline path only; stored scripts carry their own
 * }
 */
@Injectable()
export class ScriptNodeProcessor implements INodeProcessor {
  private readonly logger = new Logger(ScriptNodeProcessor.name);

  constructor(private readonly scriptsService: ScriptsService) {}

  async process(input: NodeMessage, config: any): Promise<NodeProcessorResult> {
    if (config?.scriptId) {
      return this.runStoredScript(input, config.scriptId);
    }
    return this.runInlineScript(input, config);
  }

  // ══════════════════════════════════════════════════════════════════════════
  // STORED SCRIPT (vm2, via ScriptsService)
  // ══════════════════════════════════════════════════════════════════════════

  private async runStoredScript(
    input: NodeMessage,
    scriptId: string,
  ): Promise<NodeProcessorResult> {
    const tenantId = input.metadata?.tenantId;
    if (!tenantId) {
      return {
        success: false,
        route: 'failure',
        error: 'script node requires tenantId in message metadata',
      };
    }

    let script;
    try {
      script = await this.scriptsService.findOne(scriptId, tenantId);
    } catch {
      // NotFound — a chain pointing at a deleted or foreign script.
      return {
        success: false,
        route: 'failure',
        error: `script ${scriptId} not found for this tenant`,
      };
    }

    const execution = await this.scriptsService.execute(scriptId, tenantId, {
      msg: input.data ?? {},
      metadata: input.metadata ?? {},
      msgType: input.type,
    });

    if (!execution.success) {
      this.logger.warn(
        `[script] ${script.name} failed: ${execution.error ?? 'unknown error'}`,
      );
      return {
        success: false,
        route: 'failure',
        error: execution.error,
      };
    }

    return this.applyResult(input, script.type, execution.result);
  }

  /** Turn a typed script result into a routing decision plus an output message. */
  private applyResult(
    input: NodeMessage,
    type: ScriptType,
    result: any,
  ): NodeProcessorResult {
    switch (type) {
      case ScriptType.FILTER: {
        const passed = result === true;
        return { success: passed, output: input, route: passed ? 'true' : 'false' };
      }

      case ScriptType.VALIDATION: {
        const valid = result?.valid !== false;
        return {
          success: valid,
          output: input,
          route: valid ? 'true' : 'false',
          error: valid ? undefined : (result?.error ?? 'validation failed'),
        };
      }

      case ScriptType.TRANSFORMATION:
        return {
          success: true,
          route: 'success',
          output: {
            ...input,
            data: result?.msg ?? input.data,
            metadata: result?.metadata ?? input.metadata,
            type: result?.msgType ?? input.type,
          },
        };

      case ScriptType.ENRICHMENT:
        return {
          success: true,
          route: 'success',
          output: {
            ...input,
            metadata: { ...input.metadata, ...(result ?? {}) },
          },
        };

      default:
        // PROCESSING / AGGREGATION — an object result becomes the new message
        // body; anything else is carried alongside without destroying `data`.
        return {
          success: true,
          route: 'success',
          output: {
            ...input,
            data:
              result !== null && typeof result === 'object' && !Array.isArray(result)
                ? result
                : input.data,
            metadata:
              result !== null && typeof result === 'object'
                ? input.metadata
                : { ...input.metadata, scriptResult: result },
          },
        };
    }
  }

  // ══════════════════════════════════════════════════════════════════════════
  // LEGACY INLINE SCRIPT (node:vm)
  // ══════════════════════════════════════════════════════════════════════════

  private async runInlineScript(
    input: NodeMessage,
    config: any,
  ): Promise<NodeProcessorResult> {
    const timeout = config?.timeout ?? 5000;
    const source = config?.script;

    if (!source || typeof source !== 'string') {
      return {
        success: false,
        route: 'failure',
        error:
          'script node requires `scriptId` (preferred) or a string `script` in configuration',
      };
    }

    try {
      // Sandbox exposes only msg + metadata; `__result` captures the return value.
      const sandbox: Record<string, any> = {
        msg: input.data ?? {},
        metadata: input.metadata ?? {},
        __result: undefined,
      };
      const context = vm.createContext(sandbox);

      // Wrap in an IIFE so the user script can use a top-level `return`.
      const wrapped = `__result = (function (msg, metadata) { "use strict"; ${source}\n })(msg, metadata);`;
      const script = new vm.Script(wrapped);
      script.runInContext(context, { timeout });

      const out = (sandbox.__result ?? {}) as { route?: string; data?: any };
      const route = out.route === 'failure' ? 'failure' : 'success';
      const data = out.data !== undefined ? out.data : input.data;

      return {
        success: route !== 'failure',
        output: { ...input, data },
        route,
        error:
          route === 'failure' ? 'script returned failure route' : undefined,
      };
    } catch (error: any) {
      const timedOut = /timed out/i.test(error?.message ?? '');
      const message = timedOut
        ? `script execution timed out after ${timeout}ms`
        : (error?.message ?? 'script execution failed');
      this.logger.warn(`[script] ${message}`);
      return {
        success: false,
        route: 'failure',
        error: message,
      };
    }
  }
}
