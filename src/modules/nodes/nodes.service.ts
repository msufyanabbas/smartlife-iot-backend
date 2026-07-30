import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Node } from './entities/node.entity';
import { NodeType } from '@common/enums/index.enum';
import { CreateNodeDto } from './dto/create-node.dto';
import { UpdateNodeDto } from './dto/update-node.dto';
import { PaginationDto, PaginatedResponseDto } from '../../common/dto/pagination.dto';

@Injectable()
export class NodesService {
  private readonly logger = new Logger(NodesService.name);

  constructor(
    @InjectRepository(Node)
    private readonly nodeRepository: Repository<Node>,
  ) {}

  async create(
    tenantId: string,
    userId: string,
    createDto: CreateNodeDto,
  ): Promise<Node> {
    const node = this.nodeRepository.create({
      ...createDto,
      tenantId,
      userId,
      createdBy: userId,
      position: createDto.position || { x: 0, y: 0 },
    });

    return await this.nodeRepository.save(node);
  }

  async findAll(tenantId: string, paginationDto?: PaginationDto) {
    const {
      page = 1,
      limit = 50,
      search,
      sortBy = 'createdAt',
      sortOrder = 'DESC',
    } = paginationDto || {};
    const skip = (page - 1) * limit;

    const queryBuilder = this.nodeRepository
      .createQueryBuilder('node')
      .where('node.tenantId = :tenantId', { tenantId });

    if (search) {
      queryBuilder.andWhere(
        '(node.name ILIKE :search OR node.description ILIKE :search)',
        { search: `%${search}%` },
      );
    }

    queryBuilder
      .orderBy(`node.${sortBy}`, sortOrder as 'ASC' | 'DESC')
      .skip(skip)
      .take(limit);

    const [data, total] = await queryBuilder.getManyAndCount();

    return PaginatedResponseDto.create(data, page, limit, total);
  }

  async findByRuleChain(
    tenantId: string,
    ruleChainId: string,
  ): Promise<Node[]> {
    return await this.nodeRepository.find({
      where: { tenantId, ruleChainId },
      order: { createdAt: 'ASC' },
    });
  }

  async findOne(id: string, tenantId: string): Promise<Node> {
    const node = await this.nodeRepository.findOne({
      where: { id, tenantId },
    });

    if (!node) {
      throw new NotFoundException('Node not found');
    }

    return node;
  }

  async update(
    id: string,
    tenantId: string,
    userId: string,
    updateDto: UpdateNodeDto,
  ): Promise<Node> {
    const node = await this.findOne(id, tenantId);

    Object.assign(node, updateDto);
    node.updatedBy = userId;

    return await this.nodeRepository.save(node);
  }

  async remove(id: string, tenantId: string): Promise<void> {
    const node = await this.findOne(id, tenantId);
    await this.nodeRepository.softRemove(node);
  }

  async toggle(id: string, tenantId: string, userId: string): Promise<Node> {
    const node = await this.findOne(id, tenantId);
    node.enabled = !node.enabled;
    node.updatedBy = userId;
    return await this.nodeRepository.save(node);
  }

  async getStatistics(tenantId: string) {
    const [total, enabled] = await Promise.all([
      this.nodeRepository.count({ where: { tenantId } }),
      this.nodeRepository.count({ where: { tenantId, enabled: true } }),
    ]);

    const byTypeResult = await this.nodeRepository
      .createQueryBuilder('node')
      .select('node.type', 'type')
      .addSelect('COUNT(*)', 'count')
      .where('node.tenantId = :tenantId', { tenantId })
      .groupBy('node.type')
      .getRawMany();

    const byType = byTypeResult.reduce(
      (acc, item) => {
        acc[item.type] = parseInt(item.count);
        return acc;
      },
      {} as Record<string, number>,
    );

    return {
      total,
      enabled,
      disabled: total - enabled,
      byType,
    };
  }
}
