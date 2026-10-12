import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Not, Repository } from 'typeorm';
import { PaginatedResponseDto } from '@common/dto/pagination.dto';
import { RuleChain } from '@modules/rules/entities/rule-chain.entity';
import { Queue } from './entities/queue.entity';
import {
  CreateQueueDto,
  QueueQueryDto,
  UpdateQueueDto,
} from './dto/queue.dto';
import {
  QUEUE_HONOURED_FIELDS,
  QUEUE_STORED_ONLY_FIELDS,
  QUEUE_STORED_ONLY_REASON,
  QueueProcessingStrategy,
  QueueSubmitStrategy,
} from './queue.enum';
import { QueueExecutionService } from './queue-execution.service';

/** Fields a client may send back but which the server owns. */
const CLIENT_IGNORED = ['id', 'tenantId', 'createdAt', 'updatedAt'] as const;

@Injectable()
export class QueuesService {
  private readonly logger = new Logger(QueuesService.name);

  constructor(
    @InjectRepository(Queue)
    private readonly queueRepo: Repository<Queue>,
    // The RuleChain repository rather than RulesModule: QueuesModule must stay
    // importable from RulesModule (the rule-engine consumer reads queue
    // settings), and importing RulesModule back would close that cycle.
    @InjectRepository(RuleChain)
    private readonly ruleChainRepo: Repository<RuleChain>,
    private readonly execution: QueueExecutionService,
  ) {}

  // ══════════════════════════════════════════════════════════════════════════
  // CRUD
  // ══════════════════════════════════════════════════════════════════════════

  async create(
    tenantId: string,
    userId: string,
    dto: CreateQueueDto,
  ): Promise<Queue> {
    const name = dto.name.trim();
    await this.assertNameFree(tenantId, name);

    const queue = this.queueRepo.create({
      ...this.strip(dto),
      name,
      tenantId,
      userId,
      createdBy: userId,
    });

    const saved = await this.queueRepo.save(queue);
    this.execution.invalidate(tenantId);
    this.logger.log(
      `Queue "${saved.name}" (${saved.id}) created for tenant ${tenantId} — ` +
        `${saved.submitStrategy}/${saved.processingStrategy}, timeout ${saved.packProcessingTimeout}ms`,
    );
    return saved;
  }

  async findAll(
    tenantId: string,
    query: QueueQueryDto,
  ): Promise<PaginatedResponseDto<Queue>> {
    const page = query.page ?? 1;
    const limit = query.limit ?? 10;

    const qb = this.queueRepo
      .createQueryBuilder('q')
      .where('q.tenantId = :tenantId', { tenantId });

    if (query.search) {
      qb.andWhere('(q.name ILIKE :search OR q.description ILIKE :search)', {
        search: `%${query.search}%`,
      });
    }
    if (query.enabled !== undefined) {
      qb.andWhere('q.enabled = :enabled', { enabled: query.enabled });
    }

    const sortable = new Set([
      'name',
      'createdAt',
      'updatedAt',
      'partitions',
      'lastUsedAt',
    ]);
    const sortBy = sortable.has(query.sortBy ?? '') ? query.sortBy! : 'name';

    const [rows, total] = await qb
      .orderBy(`q.${sortBy}`, query.sortOrder ?? 'ASC', 'NULLS LAST')
      .skip((page - 1) * limit)
      .take(limit)
      .getManyAndCount();

    return PaginatedResponseDto.create(rows, page, limit, total);
  }

  async findOne(tenantId: string, id: string): Promise<Queue> {
    const queue = await this.queueRepo.findOne({ where: { id, tenantId } });
    if (!queue) throw new NotFoundException(`Queue ${id} not found`);
    return queue;
  }

  async update(
    tenantId: string,
    id: string,
    userId: string,
    dto: UpdateQueueDto,
  ): Promise<Queue> {
    const queue = await this.findOne(tenantId, id);

    if (dto.name !== undefined) {
      const name = dto.name.trim();
      if (name !== queue.name) {
        await this.assertNameFree(tenantId, name, id);
        // A chain references a queue BY NAME, so renaming one would orphan
        // every chain pointing at the old name. Rewrite them in the same call.
        const moved = await this.renameInChains(tenantId, queue.name, name);
        if (moved > 0) {
          this.logger.log(
            `Queue rename "${queue.name}" → "${name}" repointed ${moved} rule chain(s)`,
          );
        }
      }
      queue.name = name;
    }

    Object.assign(queue, this.strip({ ...dto, name: undefined }));
    queue.updatedBy = userId;

    const saved = await this.queueRepo.save(queue);
    this.execution.invalidate(tenantId);
    return saved;
  }

  async remove(tenantId: string, id: string): Promise<{ message: string }> {
    const queue = await this.findOne(tenantId, id);

    // Deleting a queue a chain still names would leave that chain resolving to
    // nothing — which silently means "no queue semantics", i.e. no timeout and
    // no retries. Refuse and say which chains to detach first.
    const assigned = await this.findChainsByQueueName(tenantId, queue.name);
    if (assigned.length > 0) {
      throw new BadRequestException({
        message: `Queue "${queue.name}" is still assigned to ${assigned.length} rule chain(s)`,
        errors: assigned.map(
          (c) =>
            `rule chain "${c.name}" (${c.id}) names this queue — detach it with DELETE /queues/${id}/rule-chains/${c.id}`,
        ),
      });
    }

    await this.queueRepo.softRemove(queue);
    this.execution.invalidate(tenantId);
    return { message: `Queue "${queue.name}" deleted` };
  }

  // ══════════════════════════════════════════════════════════════════════════
  // RULE CHAIN ASSIGNMENT — the consumer of this configuration
  // ══════════════════════════════════════════════════════════════════════════

  /**
   * Point a rule chain at this queue.
   *
   * Stored as `RuleChain.configuration.queueName`, a jsonb key, rather than a
   * new column on `rule_chains`: it needs no migration against a table another
   * module owns, and `PUT /rule-chains/:id` already round-trips the whole
   * `configuration` object, so the editor does not lose the assignment on save.
   */
  async assignRuleChain(
    tenantId: string,
    queueId: string,
    ruleChainId: string,
  ): Promise<{ message: string; ruleChainId: string; queueName: string }> {
    const queue = await this.findOne(tenantId, queueId);
    const chain = await this.ruleChainRepo.findOne({
      where: { id: ruleChainId, tenantId },
    });
    if (!chain) {
      throw new NotFoundException(
        `Rule chain ${ruleChainId} not found in this tenant`,
      );
    }

    chain.configuration = { ...(chain.configuration ?? {}), queueName: queue.name };
    await this.ruleChainRepo.save(chain);

    return {
      message: `Rule chain "${chain.name}" will be processed on queue "${queue.name}"`,
      ruleChainId: chain.id,
      queueName: queue.name,
    };
  }

  async unassignRuleChain(
    tenantId: string,
    queueId: string,
    ruleChainId: string,
  ): Promise<{ message: string }> {
    const queue = await this.findOne(tenantId, queueId);
    const chain = await this.ruleChainRepo.findOne({
      where: { id: ruleChainId, tenantId },
    });
    if (!chain) {
      throw new NotFoundException(
        `Rule chain ${ruleChainId} not found in this tenant`,
      );
    }
    if (chain.configuration?.queueName !== queue.name) {
      throw new BadRequestException(
        `Rule chain "${chain.name}" is not assigned to queue "${queue.name}"`,
      );
    }

    const { queueName: _dropped, ...rest } = chain.configuration ?? {};
    chain.configuration = rest;
    await this.ruleChainRepo.save(chain);

    return {
      message: `Rule chain "${chain.name}" detached from queue "${queue.name}"`,
    };
  }

  async listRuleChains(tenantId: string, queueId: string) {
    const queue = await this.findOne(tenantId, queueId);
    const chains = await this.findChainsByQueueName(tenantId, queue.name);
    return {
      queue: { id: queue.id, name: queue.name },
      ruleChains: chains.map((c) => ({
        id: c.id,
        name: c.name,
        status: c.status,
        enabled: c.enabled,
        isRoot: c.isRoot,
      })),
    };
  }

  private findChainsByQueueName(
    tenantId: string,
    queueName: string,
  ): Promise<RuleChain[]> {
    // jsonb ->> comparison; parameterised, never interpolated.
    return this.ruleChainRepo
      .createQueryBuilder('c')
      .where('c.tenantId = :tenantId', { tenantId })
      .andWhere(`c.configuration ->> 'queueName' = :queueName`, { queueName })
      .getMany();
  }

  private async renameInChains(
    tenantId: string,
    from: string,
    to: string,
  ): Promise<number> {
    const chains = await this.findChainsByQueueName(tenantId, from);
    for (const chain of chains) {
      chain.configuration = { ...(chain.configuration ?? {}), queueName: to };
    }
    if (chains.length) await this.ruleChainRepo.save(chains);
    return chains.length;
  }

  // ══════════════════════════════════════════════════════════════════════════
  // READ-ONLY SURFACES
  // ══════════════════════════════════════════════════════════════════════════

  /**
   * What this platform actually does with a queue definition.
   *
   * Served so the configuration screen can mark a field "stored, not yet
   * honoured" instead of letting an operator tune a number nothing reads. The
   * two lists come from `queue.enum.ts` and are the same ones
   * `QueueExecutionService` is written against.
   */
  getCapabilities() {
    return {
      honoured: [...QUEUE_HONOURED_FIELDS],
      storedOnly: [...QUEUE_STORED_ONLY_FIELDS],
      storedOnlyReason: QUEUE_STORED_ONLY_REASON,
      submitStrategies: Object.values(QueueSubmitStrategy).map((value) => ({
        value,
        honoured:
          value === QueueSubmitStrategy.BURST ||
          value === QueueSubmitStrategy.SEQUENTIAL_BY_ORIGINATOR ||
          value === QueueSubmitStrategy.SEQUENTIAL_BY_TENANT,
      })),
      processingStrategies: Object.values(QueueProcessingStrategy).map(
        (value) => ({ value, honoured: true }),
      ),
      consumedBy:
        'RuleEngineConsumer. A rule chain names a queue via ' +
        'configuration.queueName (POST /queues/:id/rule-chains); messages routed ' +
        'to that chain are then executed under the queue’s submit strategy, pack ' +
        'processing timeout, processing strategy and retry settings.',
    };
  }

  async getStatistics(tenantId: string) {
    const queues = await this.queueRepo.find({ where: { tenantId } });
    const assignedCounts = await this.ruleChainRepo
      .createQueryBuilder('c')
      .select(`c.configuration ->> 'queueName'`, 'queueName')
      .addSelect('COUNT(*)', 'chains')
      .where('c.tenantId = :tenantId', { tenantId })
      .andWhere(`c.configuration ->> 'queueName' IS NOT NULL`)
      .groupBy(`c.configuration ->> 'queueName'`)
      .getRawMany<{ queueName: string; chains: string }>();

    const byName = new Map(
      assignedCounts.map((r) => [r.queueName, Number(r.chains)]),
    );

    return {
      total: queues.length,
      enabled: queues.filter((q) => q.enabled).length,
      assignedRuleChains: assignedCounts.reduce(
        (sum, r) => sum + Number(r.chains),
        0,
      ),
      queues: queues.map((q) => ({
        id: q.id,
        name: q.name,
        enabled: q.enabled,
        submitStrategy: q.submitStrategy,
        processingStrategy: q.processingStrategy,
        packProcessingTimeout: q.packProcessingTimeout,
        ruleChains: byName.get(q.name) ?? 0,
        // bigint columns come back as strings from the driver.
        processedCount: Number(q.processedCount ?? 0),
        failedCount: Number(q.failedCount ?? 0),
        timedOutCount: Number(q.timedOutCount ?? 0),
        lastUsedAt: q.lastUsedAt ?? null,
      })),
    };
  }

  // ══════════════════════════════════════════════════════════════════════════
  // HELPERS
  // ══════════════════════════════════════════════════════════════════════════

  private async assertNameFree(
    tenantId: string,
    name: string,
    exceptId?: string,
  ): Promise<void> {
    const clash = await this.queueRepo.findOne({
      where: exceptId
        ? { tenantId, name, id: Not(exceptId) }
        : { tenantId, name },
    });
    if (clash) {
      throw new ConflictException(
        `A queue named "${name}" already exists in this tenant`,
      );
    }
  }

  /** Drop server-owned fields a client round-tripped, and undefined keys. */
  private strip<T extends object>(dto: T): Partial<Queue> {
    const out: Record<string, any> = {};
    for (const [key, value] of Object.entries(dto)) {
      if ((CLIENT_IGNORED as readonly string[]).includes(key)) continue;
      if (value === undefined) continue;
      out[key] = value;
    }
    return out as Partial<Queue>;
  }
}
