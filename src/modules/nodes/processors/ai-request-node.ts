import { Injectable, Logger } from '@nestjs/common';
import {
  INodeProcessor,
  NodeMessage,
  NodeProcessorResult,
} from '../nodes-processor.interface';
import { AiService } from '@modules/ai/ai.service';

/**
 * ─────────────────────────────────────────────────────────────────────────────
 * AI_REQUEST node — call a registered LLM from inside a rule chain
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * configuration:
 * {
 *   modelId: string,          // uuid of a row in ai_models — NOT a provider
 *                             // model name, and NOT a credential
 *   systemPrompt?: string,
 *   userPrompt: string,
 *   responseFormat?: 'TEXT' | 'JSON' | 'JSON_SCHEMA',
 *   schema?: object,          // required for JSON_SCHEMA
 *   timeoutSeconds?: number,  // 1..600, default 60
 *   outputKey?: string        // merge under this key instead of replacing data
 * }
 *
 * TEMPLATING, which is the whole reason this node is useful:
 *   $[*]      the whole message data object, as JSON
 *   $[key]    one field of the message data
 *   ${*}      the whole metadata object, as JSON
 *   ${key}    one metadata field
 *
 * Same syntax as the rest of the engine so a prompt reads like every other
 * node's configuration.
 *
 * WHY THE CREDENTIAL IS NOT HERE: a rule chain can be exported, imported into
 * another tenant, and shared as a template (§4f). A provider API key in this
 * node's `configuration` jsonb would travel with every one of those. The node
 * stores a uuid and `AiService` resolves it tenant-scoped at call time, so an
 * exported chain carries a dangling reference rather than a live key.
 */
@Injectable()
export class AiRequestNodeProcessor implements INodeProcessor {
  private readonly logger = new Logger(AiRequestNodeProcessor.name);

  constructor(private readonly ai: AiService) {}

  async process(input: NodeMessage, config: any): Promise<NodeProcessorResult> {
    const modelId = config?.modelId;
    if (!modelId) {
      return {
        success: false,
        route: 'failure',
        error: 'ai_request requires config.modelId (a registered AI model)',
      };
    }
    if (!config?.userPrompt) {
      return {
        success: false,
        route: 'failure',
        error: 'ai_request requires config.userPrompt',
      };
    }

    // The tenant comes from the MESSAGE, never from the configuration — a
    // crafted chain must not be able to name another tenant's model.
    const tenantId =
      (input as any)?.metadata?.tenantId ?? (input as any)?.tenantId;
    if (!tenantId) {
      return {
        success: false,
        route: 'failure',
        error: 'ai_request could not determine the tenant from the message',
      };
    }

    try {
      const completion = await this.ai.complete(modelId, tenantId, {
        systemPrompt: substitute(config.systemPrompt, input),
        userPrompt: substitute(config.userPrompt, input),
        responseFormat: config.responseFormat ?? 'TEXT',
        schema: config.schema ?? null,
        timeoutSeconds: config.timeoutSeconds,
      });

      // Default behaviour matches ThingsBoard: the response REPLACES the
      // message data, originator and metadata pass through. `outputKey` is an
      // addition — replacing the data throws away the reading that prompted
      // the call, which is usually the thing the next node needs.
      const data = config.outputKey
        ? { ...input.data, [config.outputKey]: completion.data }
        : completion.data;

      return {
        success: true,
        route: 'success',
        output: {
          ...input,
          data,
          metadata: {
            ...input.metadata,
            aiRequest: {
              model: completion.model,
              inputTokens: completion.usage?.inputTokens,
              outputTokens: completion.usage?.outputTokens,
            },
          },
        },
      };
    } catch (error: any) {
      // Timeout, bad credential, unknown model and provider 5xx all land
      // here and all route to `failure`. There is deliberately no retry: a
      // chain that silently retries an LLM call three times is three times
      // the bill for a message the operator believes failed once. Put a
      // retry on the failure edge if you want one.
      const message = error?.message ?? 'Unknown error';
      this.logger.warn(`[ai_request] ${message}`);
      return { success: false, route: 'failure', error: message };
    }
  }
}

/**
 * Substitute `$[...]` from message data and `${...}` from metadata.
 *
 * A missing key resolves to an empty string rather than the literal
 * `$[foo]` — a placeholder that reaches the model as text is read as an
 * instruction, and models are startlingly willing to invent a value for it.
 */
export function substitute(
  template: string | null | undefined,
  message: NodeMessage,
): string {
  if (!template) return '';
  const data = (message?.data ?? {}) as Record<string, unknown>;
  const metadata = (message?.metadata ?? {}) as Record<string, unknown>;

  const render = (value: unknown): string => {
    if (value === null || value === undefined) return '';
    if (typeof value === 'object') return JSON.stringify(value);
    return String(value);
  };

  return template
    .replace(/\$\[\*\]/g, () => JSON.stringify(data))
    .replace(/\$\{\*\}/g, () => JSON.stringify(metadata))
    .replace(/\$\[([^\]]+)\]/g, (_m, key) => render(data[key.trim()]))
    .replace(/\$\{([^}]+)\}/g, (_m, key) => render(metadata[key.trim()]));
}
