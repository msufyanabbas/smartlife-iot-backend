import { Injectable, Logger } from '@nestjs/common';
import * as vm from 'vm';
import {
  INodeProcessor,
  NodeMessage,
  NodeProcessorResult,
} from '../nodes-processor.interface';

/**
 * SCRIPT node — executes tenant-provided JavaScript in a sandboxed VM context.
 *
 * Uses Node's built-in `vm` module with a hard timeout (NOT `new Function()`,
 * which cannot be time-bounded and shares the caller's scope). The user script
 * runs with `msg` (input.data) and `metadata` (input.metadata) in scope and is
 * expected to `return { route: 'success' | 'failure', data: {...} }`.
 *
 * configuration:
 * {
 *   script: string,    // JS source
 *   timeout?: number   // ms, default 5000
 * }
 */
@Injectable()
export class ScriptNodeProcessor implements INodeProcessor {
  private readonly logger = new Logger(ScriptNodeProcessor.name);

  async process(input: NodeMessage, config: any): Promise<NodeProcessorResult> {
    const timeout = config?.timeout ?? 5000;
    const source = config?.script;

    if (!source || typeof source !== 'string') {
      return {
        success: false,
        route: 'failure',
        error: 'script node requires a string `script` in configuration',
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
