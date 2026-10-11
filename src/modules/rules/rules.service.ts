import {
  Injectable,
  NotFoundException,
  ConflictException,
  Logger,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, Repository } from 'typeorm';
import { RuleChain } from '@modules/index.entities';
import { RuleChainStatus } from '@common/enums/index.enum';
import {
  CreateRuleChainDto,
  UpdateRuleChainDto,
  RuleChainQueryDto,
} from './dto/rule-chain.dto';
import { Node } from '../nodes/entities/node.entity';
import { PaginatedResponseDto } from '@common/dto/pagination.dto';
import { SubscriptionsService } from '@modules/subscriptions/subscriptions.service';
import {
  SaveRuleChainMetadataDto,
  RuleChainNodeDto,
} from './dto/rule-chain-metadata.dto';
import {
  listRuleNodeCatalogue,
  resolveNodeOutputs,
  validateNodeConfig,
} from './rule-node-catalogue';
import { NodeType } from '@common/enums/index.enum';
import { BadRequestException } from '@nestjs/common';

@Injectable()
export class RulesService {
  private readonly logger = new Logger(RulesService.name);

  constructor(
    @InjectRepository(RuleChain)
    private readonly ruleChainRepo: Repository<RuleChain>,
    @InjectRepository(Node)
    private readonly nodeRepo: Repository<Node>,
    // SubscriptionsModule is @Global() — no module import needed, no cycle.
    private readonly subscriptionsService: SubscriptionsService,
    // Needed for the metadata save, which must be one transaction.
    private readonly dataSource: DataSource,
  ) {}

  // ══════════════════════════════════════════════════════════════════════════
  // CREATE
  // ══════════════════════════════════════════════════════════════════════════

  async create(
    tenantId: string,
    userId: string,
    dto: CreateRuleChainDto,
  ): Promise<RuleChain> {
    const existing = await this.ruleChainRepo.findOne({
      where: { tenantId, name: dto.name },
    });

    if (existing) {
      throw new ConflictException('Rule chain with this name already exists');
    }

    const ruleChain = this.ruleChainRepo.create({
      ...dto,
      tenantId,
      userId,
      createdBy: userId,
      status:
        dto.enabled !== false
          ? RuleChainStatus.ACTIVE
          : RuleChainStatus.INACTIVE,
      isRoot: dto.isRoot ?? false,
      enabled: dto.enabled ?? true,
      configuration: dto.configuration ?? {},
    });

    const saved = await this.ruleChainRepo.save(ruleChain);

    try {
      await this.subscriptionsService.incrementTenantUsage(
        tenantId,
        'ruleChains',
      );
    } catch (e) {
      this.logger.warn(`Failed to update usage counter: ${(e as Error).message}`);
    }

    this.logger.log(`Rule chain created: ${saved.id} by user ${userId}`);
    return saved;
  }

  // ══════════════════════════════════════════════════════════════════════════
  // READ
  // ══════════════════════════════════════════════════════════════════════════

  async findAll(tenantId: string, query: RuleChainQueryDto) {
    const { page = 1, limit = 20, search, isActive } = query;
    const skip = (page - 1) * limit;

    const qb = this.ruleChainRepo
      .createQueryBuilder('rc')
      .where('rc.tenantId = :tenantId', { tenantId });

    if (search) {
      qb.andWhere('(rc.name ILIKE :search OR rc.description ILIKE :search)', {
        search: `%${search}%`,
      });
    }

    if (isActive !== undefined) {
      if (isActive) {
        qb.andWhere('rc.status = :status', { status: RuleChainStatus.ACTIVE });
      } else {
        qb.andWhere('rc.status != :status', { status: RuleChainStatus.ACTIVE });
      }
    }

    qb.orderBy('rc.createdAt', 'DESC').skip(skip).take(limit);

    const [data, total] = await qb.getManyAndCount();

    return PaginatedResponseDto.create(data, page, limit, total);
  }

  async findOne(tenantId: string, id: string): Promise<RuleChain> {
    const ruleChain = await this.ruleChainRepo.findOne({
      where: { id, tenantId },
    });

    if (!ruleChain) {
      throw new NotFoundException('Rule chain not found');
    }

    return ruleChain;
  }

  async findActive(tenantId: string): Promise<RuleChain[]> {
    return this.ruleChainRepo.find({
      where: { tenantId, status: RuleChainStatus.ACTIVE, enabled: true },
    });
  }

  // ══════════════════════════════════════════════════════════════════════════
  // UPDATE
  // ══════════════════════════════════════════════════════════════════════════

  async update(
    tenantId: string,
    id: string,
    userId: string,
    dto: UpdateRuleChainDto,
  ): Promise<RuleChain> {
    const ruleChain = await this.findOne(tenantId, id);

    Object.assign(ruleChain, dto);
    ruleChain.updatedBy = userId;

    if (dto.enabled !== undefined) {
      ruleChain.status = dto.enabled
        ? RuleChainStatus.ACTIVE
        : RuleChainStatus.INACTIVE;
    }

    const saved = await this.ruleChainRepo.save(ruleChain);
    this.logger.log(`Rule chain updated: ${id} by user ${userId}`);
    return saved;
  }

  async activate(
    tenantId: string,
    id: string,
    userId: string,
  ): Promise<RuleChain> {
    const ruleChain = await this.findOne(tenantId, id);
    ruleChain.activate();
    ruleChain.updatedBy = userId;
    const saved = await this.ruleChainRepo.save(ruleChain);
    this.logger.log(`Rule chain activated: ${id}`);
    return saved;
  }

  async deactivate(
    tenantId: string,
    id: string,
    userId: string,
  ): Promise<RuleChain> {
    const ruleChain = await this.findOne(tenantId, id);
    ruleChain.deactivate();
    ruleChain.updatedBy = userId;
    const saved = await this.ruleChainRepo.save(ruleChain);
    this.logger.log(`Rule chain deactivated: ${id}`);
    return saved;
  }

  // ══════════════════════════════════════════════════════════════════════════
  // DELETE
  // ══════════════════════════════════════════════════════════════════════════

  async delete(tenantId: string, id: string, userId: string): Promise<void> {
    const ruleChain = await this.findOne(tenantId, id);
    ruleChain.deletedBy = userId;
    await this.ruleChainRepo.save(ruleChain);
    await this.ruleChainRepo.softRemove(ruleChain);

    try {
      await this.subscriptionsService.decrementTenantUsage(
        tenantId,
        'ruleChains',
      );
    } catch (e) {
      this.logger.warn(`Failed to update usage counter: ${(e as Error).message}`);
    }

    this.logger.log(`Rule chain deleted: ${id} by user ${userId}`);
  }

  // ══════════════════════════════════════════════════════════════════════════
  // NODES
  // ══════════════════════════════════════════════════════════════════════════

  async findNodes(tenantId: string, chainId: string) {
    await this.findOne(tenantId, chainId);

    return this.nodeRepo.find({
      where: { tenantId, ruleChainId: chainId },
      order: { createdAt: 'ASC' },
    });
  }


  // ══════════════════════════════════════════════════════════════════════════
  // GRAPH (METADATA)
  // ══════════════════════════════════════════════════════════════════════════

  /** The node palette and per-type config fields. Static — no tenant data. */
  getNodeCatalogue() {
    return listRuleNodeCatalogue();
  }

  /**
   * The whole graph plus the problems that would stop it working.
   *
   * `resolvedRootNodeId` repeats the engine's own fallback — the node no edge
   * targets — rather than leaving the editor to guess. A chain whose
   * `rootNodeId` is unset still runs, and showing a different entry point than
   * the engine will actually use is worse than showing none.
   */
  async getMetadata(tenantId: string, id: string) {
    const ruleChain = await this.findOne(tenantId, id);
    const nodes = await this.nodeRepo.find({
      where: { tenantId, ruleChainId: id },
      order: { createdAt: 'ASC' },
    });

    return {
      ruleChain,
      nodes,
      resolvedRootNodeId: this.resolveRootNodeId(ruleChain.rootNodeId, nodes),
      issues: this.validateGraph(nodes, ruleChain.rootNodeId),
    };
  }

  /** Mirrors RuleEngineService.resolveStartNode(). Keep the two in step. */
  private resolveRootNodeId(
    storedRootNodeId: string | undefined,
    nodes: Node[],
  ): string | null {
    if (storedRootNodeId && nodes.some((n) => n.id === storedRootNodeId)) {
      return storedRootNodeId;
    }
    const targeted = new Set(
      nodes.flatMap((n) => (n.connections ?? []).map((c) => c.targetNodeId)),
    );
    return nodes.find((n) => !targeted.has(n.id))?.id ?? null;
  }

  /**
   * Static analysis of a saved graph.
   *
   * Every one of these is a chain that saves cleanly and then misbehaves at
   * runtime, which is exactly the class of problem a visual editor should catch
   * before the operator wonders why nothing happens.
   */
  validateGraph(
    nodes: Node[],
    storedRootNodeId?: string,
  ): Array<{ level: 'error' | 'warning'; nodeId?: string; message: string }> {
    const issues: Array<{
      level: 'error' | 'warning';
      nodeId?: string;
      message: string;
    }> = [];

    if (nodes.length === 0) {
      issues.push({
        level: 'warning',
        message: 'This chain has no nodes, so nothing happens when it runs.',
      });
      return issues;
    }

    const byId = new Map(nodes.map((n) => [n.id, n]));
    const rootId = this.resolveRootNodeId(storedRootNodeId, nodes);

    if (!rootId) {
      issues.push({
        level: 'error',
        message:
          'No entry node: every node is the target of an edge, so the engine cannot pick a start. Set one node as the entry point or remove the edge into it.',
      });
    }

    // Edges to nowhere.
    for (const node of nodes) {
      for (const conn of node.connections ?? []) {
        if (!byId.has(conn.targetNodeId)) {
          issues.push({
            level: 'error',
            nodeId: node.id,
            message: `"${node.name}" has a ${conn.connectionType} edge to a node that no longer exists.`,
          });
        }
      }
    }

    // Routes the node can never emit — the engine would never follow them.
    for (const node of nodes) {
      const possible = resolveNodeOutputs(node.type, node.configuration).map(
        (o) => o.route,
      );
      if (possible.length === 0) continue;
      for (const conn of node.connections ?? []) {
        if (!possible.includes(conn.connectionType)) {
          issues.push({
            level: 'warning',
            nodeId: node.id,
            message: `"${node.name}" has an edge labelled "${conn.connectionType}", which a ${node.type} node never emits (it emits ${possible.join(', ')}). That edge will never be followed.`,
          });
        }
      }
    }

    // Unreachable nodes.
    if (rootId) {
      const seen = new Set<string>();
      const queue = [rootId];
      while (queue.length) {
        const current = queue.shift()!;
        if (seen.has(current)) continue;
        seen.add(current);
        for (const conn of byId.get(current)?.connections ?? []) {
          if (byId.has(conn.targetNodeId)) queue.push(conn.targetNodeId);
        }
      }
      for (const node of nodes) {
        if (!seen.has(node.id)) {
          issues.push({
            level: 'warning',
            nodeId: node.id,
            message: `"${node.name}" cannot be reached from the entry node, so it never runs.`,
          });
        }
      }
    }

    // Incomplete configuration.
    for (const node of nodes) {
      for (const message of validateNodeConfig(node.type, node.configuration)) {
        issues.push({ level: 'error', nodeId: node.id, message });
      }
      if (!node.enabled) {
        issues.push({
          level: 'warning',
          nodeId: node.id,
          message: `"${node.name}" is disabled — the engine skips it and follows its success edge.`,
        });
      }
    }

    return issues;
  }

  /**
   * Replace the chain's whole graph, in one transaction.
   *
   * Three things this has to get right, each of which is a bug if it does not:
   *
   *  1. **Temporary ids.** A node the user just dropped has no server id, but
   *     its edges reference it already. Client ids are mapped to real ones
   *     after insert and every connection is rewritten, so the editor never
   *     has to save in two phases.
   *  2. **Deletes.** Nodes of this chain absent from the payload are removed —
   *     that is what makes this a replace rather than an upsert, and it is why
   *     the DTO documents `nodes` as the complete set.
   *  3. **Tenant scoping on update.** An existing node is only touched when it
   *     belongs to this tenant AND this chain, so a crafted payload cannot
   *     re-parent another tenant's node by id.
   */
  async saveMetadata(
    tenantId: string,
    chainId: string,
    userId: string,
    dto: SaveRuleChainMetadataDto,
  ) {
    const chain = await this.findOne(tenantId, chainId);

    // Validate before opening the transaction: a 400 should not have rolled
    // anything back, and reporting every problem at once beats one per retry.
    const errors: string[] = [];
    const seenIds = new Set<string>();
    for (const node of dto.nodes) {
      if (!Object.values(NodeType).includes(node.type)) {
        errors.push(`Unknown node type "${node.type}" on "${node.name}"`);
      }
      errors.push(...validateNodeConfig(node.type, node.configuration));
      if (node.id) {
        if (seenIds.has(node.id)) {
          errors.push(`Duplicate node id "${node.id}" in the payload`);
        }
        seenIds.add(node.id);
      }
    }

    // Edges must land on a node present in this payload.
    const payloadIds = new Set(dto.nodes.map((n) => n.id).filter(Boolean));
    for (const node of dto.nodes) {
      for (const conn of node.connections ?? []) {
        if (!payloadIds.has(conn.targetNodeId)) {
          errors.push(
            `"${node.name}" has an edge to "${conn.targetNodeId}", which is not in this payload`,
          );
        }
      }
    }

    if (errors.length) {
      throw new BadRequestException({
        message: 'The rule chain graph is not valid',
        errors,
      });
    }

    return this.dataSource.transaction(async (manager) => {
      const nodeRepo = manager.getRepository(Node);
      const chainRepo = manager.getRepository(RuleChain);

      const existing = await nodeRepo.find({
        where: { tenantId, ruleChainId: chainId },
      });
      const existingById = new Map(existing.map((n) => [n.id, n]));

      /** Client id (temporary or real) → the saved row's real id. */
      const idMap = new Map<string, string>();
      const saved: Node[] = [];

      // Pass 1: insert and update without connections. The edges cannot be
      // written yet because a target may still be a temporary id.
      for (const incoming of dto.nodes) {
        const current = incoming.id
          ? existingById.get(incoming.id)
          : undefined;

        if (current) {
          Object.assign(current, this.nodeFieldsFrom(incoming));
          current.updatedBy = userId;
          const row = await nodeRepo.save(current);
          idMap.set(incoming.id!, row.id);
          saved.push(row);
        } else {
          const row = await nodeRepo.save(
            nodeRepo.create({
              ...this.nodeFieldsFrom(incoming),
              tenantId,
              customerId: chain.customerId,
              userId,
              createdBy: userId,
              ruleChainId: chainId,
              connections: [],
            }),
          );
          // A temporary id maps to the new real id; a payload id that matched
          // nothing (a node deleted in another tab) maps to its replacement.
          if (incoming.id) idMap.set(incoming.id, row.id);
          saved.push(row);
        }
      }

      // Pass 2: rewrite the edges now that every node has a real id.
      for (let i = 0; i < dto.nodes.length; i++) {
        const incoming = dto.nodes[i];
        const row = saved[i];
        row.connections = (incoming.connections ?? []).map((conn) => ({
          targetNodeId: idMap.get(conn.targetNodeId) ?? conn.targetNodeId,
          connectionType: conn.connectionType,
          label: conn.label,
        }));
        await nodeRepo.save(row);
      }

      // Pass 3: drop the nodes the editor removed.
      const keptIds = new Set(saved.map((n) => n.id));
      const removed = existing.filter((n) => !keptIds.has(n.id));
      if (removed.length) {
        await nodeRepo.softRemove(removed);
      }

      // Entry node, mapped through the same table.
      const requestedRoot = dto.rootNodeId
        ? (idMap.get(dto.rootNodeId) ?? dto.rootNodeId)
        : undefined;
      chain.rootNodeId =
        requestedRoot && keptIds.has(requestedRoot)
          ? requestedRoot
          : (this.resolveRootNodeId(undefined, saved) ?? undefined);
      chain.updatedBy = userId;
      await chainRepo.save(chain);

      this.logger.log(
        `Rule chain ${chainId} graph saved: ${saved.length} node(s), ${removed.length} removed`,
      );

      return {
        ruleChain: chain,
        nodes: saved,
        resolvedRootNodeId: this.resolveRootNodeId(chain.rootNodeId, saved),
        issues: this.validateGraph(saved, chain.rootNodeId),
      };
    });
  }

  /** The node columns a metadata save is allowed to set. */
  private nodeFieldsFrom(incoming: RuleChainNodeDto) {
    return {
      name: incoming.name,
      description: incoming.description,
      type: incoming.type,
      enabled: incoming.enabled ?? true,
      debugMode: incoming.debugMode ?? false,
      configuration: incoming.configuration ?? {},
      position: incoming.position ?? { x: 0, y: 0 },
    };
  }

  // ══════════════════════════════════════════════════════════════════════════
  // ROOT CHAIN
  // ══════════════════════════════════════════════════════════════════════════

  /**
   * Make this the tenant's root chain, clearing the flag everywhere else.
   *
   * `isRoot` is a boolean on each row rather than a pointer on the tenant, so
   * nothing stops two rows claiming it. Doing the unset in the same transaction
   * is what keeps that from happening.
   */
  async setRoot(tenantId: string, id: string, userId: string) {
    const chain = await this.findOne(tenantId, id);

    return this.dataSource.transaction(async (manager) => {
      const repo = manager.getRepository(RuleChain);
      await repo.update({ tenantId, isRoot: true }, { isRoot: false });
      chain.isRoot = true;
      chain.updatedBy = userId;
      return repo.save(chain);
    });
  }

  // ══════════════════════════════════════════════════════════════════════════
  // IMPORT / EXPORT
  // ══════════════════════════════════════════════════════════════════════════

  /**
   * A portable copy of the chain.
   *
   * Ids, counters and tenant columns are deliberately stripped: an export that
   * carried them would either collide on import or silently re-point edges at
   * another tenant's nodes. Edges are re-expressed against the node's INDEX in
   * the array, which is stable across tenants.
   */
  async exportChain(tenantId: string, id: string) {
    const chain = await this.findOne(tenantId, id);
    const nodes = await this.nodeRepo.find({
      where: { tenantId, ruleChainId: id },
      order: { createdAt: 'ASC' },
    });

    const indexById = new Map(nodes.map((n, i) => [n.id, i]));

    return {
      formatVersion: 1,
      name: chain.name,
      description: chain.description,
      configuration: chain.configuration ?? {},
      tags: chain.tags ?? [],
      rootNodeIndex: chain.rootNodeId
        ? (indexById.get(chain.rootNodeId) ?? null)
        : null,
      nodes: nodes.map((n) => ({
        name: n.name,
        description: n.description,
        type: n.type,
        enabled: n.enabled,
        debugMode: n.debugMode,
        configuration: n.configuration ?? {},
        position: n.position ?? { x: 0, y: 0 },
        connections: (n.connections ?? [])
          // An edge whose target is gone is dropped rather than exported as a
          // dangling index.
          .filter((c) => indexById.has(c.targetNodeId))
          .map((c) => ({
            targetNodeIndex: indexById.get(c.targetNodeId)!,
            connectionType: c.connectionType,
            label: c.label,
          })),
      })),
    };
  }

  /** Create a chain from an export. Names are de-duplicated, not rejected. */
  async importChain(tenantId: string, userId: string, payload: any) {
    if (!payload || !Array.isArray(payload.nodes)) {
      throw new BadRequestException(
        'Not a rule chain export: expected an object with a "nodes" array',
      );
    }

    const baseName = String(payload.name ?? 'Imported rule chain').slice(0, 200);
    let name = baseName;
    for (let attempt = 1; attempt <= 50; attempt++) {
      const clash = await this.ruleChainRepo.findOne({
        where: { tenantId, name },
      });
      if (!clash) break;
      name = `${baseName} (${attempt})`;
    }

    const chain = await this.create(tenantId, userId, {
      name,
      description: payload.description,
      configuration: payload.configuration ?? {},
      // Imported chains land as drafts: activating one that points at device
      // ids or integration ids from another tenant should be a decision, not a
      // side effect of importing.
      enabled: false,
    } as any);

    const nodes: RuleChainNodeDto[] = (payload.nodes as any[]).map(
      (n, index) => ({
        id: `import-${index}`,
        name: String(n.name ?? `Node ${index + 1}`),
        description: n.description,
        type: n.type,
        enabled: n.enabled ?? true,
        debugMode: n.debugMode ?? false,
        configuration: n.configuration ?? {},
        position: n.position ?? { x: 120 + index * 220, y: 120 },
        connections: (Array.isArray(n.connections) ? n.connections : [])
          .filter(
            (c: any) =>
              Number.isInteger(c?.targetNodeIndex) &&
              c.targetNodeIndex >= 0 &&
              c.targetNodeIndex < payload.nodes.length,
          )
          .map((c: any) => ({
            targetNodeId: `import-${c.targetNodeIndex}`,
            connectionType: String(c.connectionType ?? 'success'),
            label: c.label,
          })),
      }),
    );

    const rootNodeId = Number.isInteger(payload.rootNodeIndex)
      ? `import-${payload.rootNodeIndex}`
      : undefined;

    return this.saveMetadata(tenantId, chain.id, userId, {
      nodes,
      rootNodeId,
    });
  }

  /** Copy a chain, graph and all, as a draft. */
  async duplicate(tenantId: string, id: string, userId: string) {
    const exported = await this.exportChain(tenantId, id);
    return this.importChain(tenantId, userId, {
      ...exported,
      name: `${exported.name} (copy)`,
    });
  }

  // ══════════════════════════════════════════════════════════════════════════
  // STATISTICS
  // ══════════════════════════════════════════════════════════════════════════

  async getStatistics(tenantId: string) {
    const [total, active, inactive, draft] = await Promise.all([
      this.ruleChainRepo.count({ where: { tenantId } }),
      this.ruleChainRepo.count({
        where: { tenantId, status: RuleChainStatus.ACTIVE },
      }),
      this.ruleChainRepo.count({
        where: { tenantId, status: RuleChainStatus.INACTIVE },
      }),
      this.ruleChainRepo.count({
        where: { tenantId, status: RuleChainStatus.DRAFT },
      }),
    ]);

    const execResult = await this.ruleChainRepo
      .createQueryBuilder('rc')
      .select('SUM(rc.executionCount)', 'total')
      .addSelect('SUM(rc.successCount)', 'success')
      .addSelect('SUM(rc.failureCount)', 'failures')
      .where('rc.tenantId = :tenantId', { tenantId })
      .getRawOne();

    return {
      total,
      active,
      inactive,
      draft,
      totalExecutions: parseInt(execResult?.total || '0'),
      totalSuccesses: parseInt(execResult?.success || '0'),
      totalFailures: parseInt(execResult?.failures || '0'),
    };
  }
}
