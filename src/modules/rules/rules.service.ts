import {
  Injectable,
  NotFoundException,
  ConflictException,
  Logger,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { RuleChain } from '@modules/index.entities';
import { RuleChainStatus } from '@common/enums/index.enum';
import {
  CreateRuleChainDto,
  UpdateRuleChainDto,
  RuleChainQueryDto,
} from './dto/rule-chain.dto';
import { Node } from '../nodes/entities/node.entity';
import { PaginatedResponseDto } from '@common/dto/pagination.dto';

@Injectable()
export class RulesService {
  private readonly logger = new Logger(RulesService.name);

  constructor(
    @InjectRepository(RuleChain)
    private readonly ruleChainRepo: Repository<RuleChain>,
    @InjectRepository(Node)
    private readonly nodeRepo: Repository<Node>,
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
