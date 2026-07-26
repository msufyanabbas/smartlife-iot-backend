import { Injectable, Logger } from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
import {
  INodeProcessor,
  NodeMessage,
  NodeProcessorResult,
} from '../nodes-processor.interface';
import type { RuleEngineService } from '../../rules/rule-engine.service';

/**
 * FLOW node — hands the current message off to another rule chain (a sub-flow).
 *
 * Infinite-loop protection: `metadata.executionPath` accumulates every visited
 * chain id. If the target chain is already in that path, the call is rejected
 * with "circular flow reference detected".
 *
 * configuration:
 * {
 *   targetChainId: string
 * }
 *
 * CIRCULAR-DEPENDENCY NOTE:
 * RuleEngineService lives in RulesModule, which imports NodesModule (for the
 * NodeProcessorFactory). A constructor injection here — even with forwardRef —
 * creates an *eager* ES-module import cycle
 * (flow-node → rule-engine.service → node-processor.factory → flow-node) that
 * SWC's emitDecoratorMetadata turns into a "Cannot access 'FlowNodeProcessor'
 * before initialization" TDZ error at boot. To avoid that we keep the import
 * type-only and resolve the service lazily at first use via ModuleRef, so no
 * runtime module cycle exists.
 */
@Injectable()
export class FlowNodeProcessor implements INodeProcessor {
  private readonly logger = new Logger(FlowNodeProcessor.name);
  private ruleEngineService?: RuleEngineService;

  constructor(private readonly moduleRef: ModuleRef) {}

  private async getEngine(): Promise<RuleEngineService> {
    if (!this.ruleEngineService) {
      // Lazy require breaks the eager import cycle; resolved once and cached.
      const { RuleEngineService } = await import(
        '../../rules/rule-engine.service.js'
      );
      this.ruleEngineService = this.moduleRef.get(RuleEngineService, {
        strict: false,
      });
    }
    return this.ruleEngineService;
  }

  async process(input: NodeMessage, config: any): Promise<NodeProcessorResult> {
    const targetChainId = config?.targetChainId;
    if (!targetChainId) {
      return {
        success: false,
        route: 'failure',
        error: 'flow node requires config.targetChainId',
      };
    }

    const tenantId = input.metadata?.tenantId;
    if (!tenantId) {
      return {
        success: false,
        route: 'failure',
        error: 'flow node requires tenantId in message metadata',
      };
    }

    // ── Infinite-loop protection ──────────────────────────────────────────────
    const executionPath: string[] = Array.isArray(input.metadata?.executionPath)
      ? input.metadata.executionPath
      : [];

    if (executionPath.includes(targetChainId)) {
      this.logger.warn(
        `[flow] circular flow reference detected → ${targetChainId} (path: ${executionPath.join(' → ')})`,
      );
      return {
        success: false,
        route: 'failure',
        error: 'circular flow reference detected',
      };
    }

    // Carry the updated path into the sub-chain so nested FLOW nodes can detect cycles.
    const subMessage: NodeMessage = {
      ...input,
      metadata: {
        ...input.metadata,
        executionPath: [...executionPath, targetChainId],
      },
    };

    try {
      const engine = await this.getEngine();
      const result = await engine.executeChainById(
        tenantId,
        targetChainId,
        subMessage,
      );

      return {
        success: result.success,
        output: {
          ...input,
          metadata: {
            ...subMessage.metadata,
            flowResult: {
              chainId: result.chainId,
              nodesExecuted: result.nodesExecuted,
              success: result.success,
            },
          },
        },
        route: result.success ? 'success' : 'failure',
        error: result.success ? undefined : result.error,
      };
    } catch (error: any) {
      this.logger.error(
        `[flow] sub-chain ${targetChainId} failed: ${error.message}`,
      );
      return {
        success: false,
        route: 'failure',
        error: error.message,
      };
    }
  }
}
