import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { RuleChain } from '@modules/index.entities';
import { Node } from '../nodes/entities/node.entity';
import { RulesService } from './rules.service';
import { NodeProcessorFactory } from '../nodes/node-processor.factory';
import {
  NodeMessage,
  NodeProcessorResult,
} from '../nodes/nodes-processor.interface';
import {
  RuleExecutionResultDto,
  NodeTraceEntryDto,
} from './dto/rule-execution.dto';

const MAX_NODE_HOPS = 50;

@Injectable()
export class RuleEngineService {
  private readonly logger = new Logger(RuleEngineService.name);

  constructor(
    private readonly rulesService: RulesService,
    private readonly nodeProcessorFactory: NodeProcessorFactory,
    @InjectRepository(Node)
    private readonly nodeRepo: Repository<Node>,
    @InjectRepository(RuleChain)
    private readonly ruleChainRepo: Repository<RuleChain>,
  ) {}

  // ══════════════════════════════════════════════════════════════════════════
  // PUBLIC ENTRY POINT
  // ══════════════════════════════════════════════════════════════════════════

  async execute(
    tenantId: string,
    message: NodeMessage,
  ): Promise<RuleExecutionResultDto[]> {
    const chains = await this.loadMatchingChains(tenantId, message);

    if (chains.length === 0) {
      this.logger.debug(
        `No active rule chains match message type "${message.type}" for tenant ${tenantId}`,
      );
      return [];
    }

    const results: RuleExecutionResultDto[] = [];

    for (const chain of chains) {
      try {
        const result = await this.executeChain(chain, message);
        results.push(result);
      } catch (err: any) {
        this.logger.error(
          `Chain ${chain.id} (${chain.name}) threw unexpectedly: ${err.message}`,
        );
        results.push({
          chainId: chain.id,
          chainName: chain.name,
          success: false,
          executionTime: 0,
          nodesExecuted: 0,
          error: err.message,
          trace: [],
        });
      }
    }

    return results;
  }

  /**
   * Execute a single chain by id. Used by the FLOW node to invoke a sub-chain.
   * Throws NotFoundException (via RulesService.findOne) if the chain is missing.
   */
  async executeChainById(
    tenantId: string,
    chainId: string,
    message: NodeMessage,
  ): Promise<RuleExecutionResultDto> {
    const chain = await this.rulesService.findOne(tenantId, chainId);
    return this.executeChain(chain, message);
  }

  // ══════════════════════════════════════════════════════════════════════════
  // PRIVATE: CHAIN SELECTION
  // ══════════════════════════════════════════════════════════════════════════

  private async loadMatchingChains(
    tenantId: string,
    message: NodeMessage,
  ): Promise<RuleChain[]> {
    const activeChains = await this.rulesService.findActive(tenantId);
    const matched: RuleChain[] = [];

    for (const chain of activeChains) {
      const cfg = chain.configuration;

      // Message-type filter: skip chains that declare types not matching this message.
      if (
        cfg?.messageTypes?.length &&
        cfg.messageTypes.length > 0 &&
        !cfg.messageTypes.includes(message.type)
      ) {
        continue;
      }

      // Device-type filter: only applied when the chain declares deviceTypes AND
      // the message carries a deviceType in its metadata.
      if (
        cfg?.deviceTypes?.length &&
        cfg.deviceTypes.length > 0 &&
        message.metadata?.deviceType &&
        !cfg.deviceTypes.includes(message.metadata.deviceType)
      ) {
        continue;
      }

      matched.push(chain);
    }

    return matched;
  }

  // ══════════════════════════════════════════════════════════════════════════
  // PRIVATE: SINGLE CHAIN EXECUTION
  // ══════════════════════════════════════════════════════════════════════════

  private async executeChain(
    chain: RuleChain,
    message: NodeMessage,
  ): Promise<RuleExecutionResultDto> {
    const chainStart = Date.now();

    const nodes = await this.rulesService.findNodes(chain.tenantId, chain.id);
    const trace = await this.traverseNodes(nodes, chain.rootNodeId, message);

    const executionTime = Date.now() - chainStart;
    const success = trace.length === 0 || trace[trace.length - 1].success;
    const firstError = trace.find((t) => t.error)?.error;

    chain.recordExecution(
      success,
      executionTime,
      firstError,
      trace.find((t) => t.error)?.nodeId,
    );
    this.ruleChainRepo
      .save(chain)
      .catch((e) =>
        this.logger.error(
          `Failed to save chain stats for ${chain.id}: ${e.message}`,
        ),
      );

    this.logger.log(
      `Chain "${chain.name}" — ${trace.length} nodes in ${executionTime}ms [${success ? 'OK' : 'FAIL'}]`,
    );

    return {
      chainId: chain.id,
      chainName: chain.name,
      success,
      executionTime,
      nodesExecuted: trace.length,
      error: firstError,
      trace,
    };
  }

  // ══════════════════════════════════════════════════════════════════════════
  // PRIVATE: NODE TRAVERSAL
  // ══════════════════════════════════════════════════════════════════════════

  private async traverseNodes(
    nodes: Node[],
    rootNodeId: string | undefined,
    initialMessage: NodeMessage,
  ): Promise<NodeTraceEntryDto[]> {
    if (nodes.length === 0) return [];

    const nodeMap = new Map<string, Node>(nodes.map((n) => [n.id, n]));

    // Resolve start node
    let currentNode = this.resolveStartNode(nodes, nodeMap, rootNodeId);
    if (!currentNode) {
      this.logger.warn(
        'Cannot determine start node — no rootNodeId and no root candidate found',
      );
      return [];
    }

    const trace: NodeTraceEntryDto[] = [];
    let message = initialMessage;
    let hops = 0;

    while (currentNode && hops < MAX_NODE_HOPS) {
      // Skip disabled nodes — follow success route to stay in the chain
      if (!currentNode.enabled) {
        const nextId = currentNode.getSuccessConnection();
        currentNode = nextId ? nodeMap.get(nextId) : undefined;
        continue;
      }

      const nodeStart = Date.now();
      let result: NodeProcessorResult;

      try {
        const processor = this.nodeProcessorFactory.getProcessor(
          currentNode.type,
        );
        result = await processor.process(message, currentNode.configuration);
      } catch (err: any) {
        result = { success: false, error: err.message, route: 'failure' };
      }

      const nodeElapsed = Date.now() - nodeStart;

      // Persist node execution stats (fire-and-forget so pipeline is not blocked)
      currentNode.recordExecution(result.success, nodeElapsed, result.error);
      this.nodeRepo
        .save(currentNode)
        .catch((e) =>
          this.logger.error(
            `Failed to save node stats for ${currentNode!.id}: ${e.message}`,
          ),
        );

      const route = result.route ?? (result.success ? 'success' : 'failure');

      trace.push({
        nodeId: currentNode.id,
        nodeName: currentNode.name,
        nodeType: currentNode.type,
        success: result.success,
        route,
        executionTime: nodeElapsed,
        error: result.error,
      });

      // Pass the (possibly transformed) message forward
      if (result.output) {
        message = result.output;
      }

      // Resolve next node
      const nextNodeId = this.resolveNextNode(currentNode, route);
      currentNode = nextNodeId ? nodeMap.get(nextNodeId) : undefined;
      hops++;
    }

    if (hops >= MAX_NODE_HOPS) {
      this.logger.warn(
        `Rule chain hit the ${MAX_NODE_HOPS}-hop limit — possible infinite loop`,
      );
    }

    return trace;
  }

  // ══════════════════════════════════════════════════════════════════════════
  // PRIVATE: HELPERS
  // ══════════════════════════════════════════════════════════════════════════

  private resolveStartNode(
    nodes: Node[],
    nodeMap: Map<string, Node>,
    rootNodeId: string | undefined,
  ): Node | undefined {
    if (rootNodeId) {
      const root = nodeMap.get(rootNodeId);
      if (root) return root;
      this.logger.warn(
        `rootNodeId "${rootNodeId}" not found in node list — falling back to heuristic`,
      );
    }

    // Fallback: node that is not referenced as a target by any other node
    const allTargets = new Set(
      nodes.flatMap((n) => (n.connections ?? []).map((c) => c.targetNodeId)),
    );
    return nodes.find((n) => !allTargets.has(n.id));
  }

  private resolveNextNode(node: Node, route: string): string | undefined {
    // First try to find a connection whose type exactly matches the route label
    const exact = node.connections?.find((c) => c.connectionType === route);
    if (exact) return exact.targetNodeId;

    // Fall back to semantic success/failure helpers
    if (route === 'success' || route === 'true') {
      return node.getSuccessConnection();
    }
    if (route === 'failure' || route === 'false') {
      return node.getFailureConnection();
    }

    // 'default' connection type is the catch-all
    return node.connections?.find((c) => c.connectionType === 'default')
      ?.targetNodeId;
  }
}
