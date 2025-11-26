import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Node, NodeType } from './entities/node.entity';
import { CreateNodeDto } from './dto/create-node.dto';
import { UpdateNodeDto } from './dto/update-node.dto';
import { PaginationDto } from '../../common/dto/pagination.dto';

@Injectable()
export class NodesService {
  constructor(
    @InjectRepository(Node)
    private readonly nodeRepository: Repository<Node>,
  ) {}

  async create(userId: string, createDto: CreateNodeDto): Promise<Node> {
    const node = this.nodeRepository.create({
      ...createDto,
      userId,
      createdBy: userId,
      position: createDto.position || { x: 0, y: 0 },
    });

    return await this.nodeRepository.save(node);
  }

  async findAll(userId: string, paginationDto?: PaginationDto) {
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
      .where('node.userId = :userId', { userId });

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

    return {
      data,
      total,
      page,
      limit,
      totalPages: Math.ceil(total / limit),
    };
  }

  async findByRuleChain(userId: string, ruleChainId: string): Promise<Node[]> {
    return await this.nodeRepository.find({
      where: { userId, ruleChainId },
      order: { createdAt: 'ASC' },
    });
  }

  async findOne(id: string, userId: string): Promise<Node> {
    const node = await this.nodeRepository.findOne({
      where: { id, userId },
    });

    if (!node) {
      throw new NotFoundException('Node not found');
    }

    return node;
  }

  async update(
    id: string,
    userId: string,
    updateDto: UpdateNodeDto,
  ): Promise<Node> {
    const node = await this.findOne(id, userId);

    Object.assign(node, updateDto);
    node.updatedBy = userId;

    return await this.nodeRepository.save(node);
  }

  async remove(id: string, userId: string): Promise<void> {
    const node = await this.findOne(id, userId);
    await this.nodeRepository.softRemove(node);
  }

  async toggle(id: string, userId: string): Promise<Node> {
    const node = await this.findOne(id, userId);
    node.enabled = !node.enabled;
    node.updatedBy = userId;
    return await this.nodeRepository.save(node);
  }

  async getStatistics(userId: string) {
    const [total, enabled] = await Promise.all([
      this.nodeRepository.count({ where: { userId } }),
      this.nodeRepository.count({ where: { userId, enabled: true } }),
    ]);

    const byTypeResult = await this.nodeRepository
      .createQueryBuilder('node')
      .select('node.type', 'type')
      .addSelect('COUNT(*)', 'count')
      .where('node.userId = :userId', { userId })
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
