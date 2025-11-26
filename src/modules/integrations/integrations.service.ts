import {
  Injectable,
  NotFoundException,
  ConflictException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Integration, IntegrationStatus } from './entities/integration.entity';
import { CreateIntegrationDto } from './dto/create-integration.dto';
import { UpdateIntegrationDto } from './dto/update-integration.dto';
import { PaginationDto } from '../../common/dto/pagination.dto';

@Injectable()
export class IntegrationsService {
  constructor(
    @InjectRepository(Integration)
    private readonly integrationRepository: Repository<Integration>,
  ) {}

  async create(
    userId: string,
    createIntegrationDto: CreateIntegrationDto,
  ): Promise<Integration> {
    // Check if integration with same name exists
    const existing = await this.integrationRepository.findOne({
      where: { name: createIntegrationDto.name, userId },
    });

    if (existing) {
      throw new ConflictException('Integration with this name already exists');
    }

    const integration = this.integrationRepository.create({
      ...createIntegrationDto,
      userId,
      createdBy: userId,
    });

    return await this.integrationRepository.save(integration);
  }

  async findAll(userId: string, paginationDto: PaginationDto) {
    const {
      page = 1,
      limit = 10,
      search,
      sortBy = 'createdAt',
      sortOrder = 'DESC',
    } = paginationDto;
    const skip = (page - 1) * limit;

    const queryBuilder = this.integrationRepository
      .createQueryBuilder('integration')
      .where('integration.userId = :userId', { userId });

    if (search) {
      queryBuilder.andWhere(
        '(integration.name ILIKE :search OR integration.description ILIKE :search)',
        { search: `%${search}%` },
      );
    }

    queryBuilder
      .orderBy(`integration.${sortBy}`, sortOrder as 'ASC' | 'DESC')
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

  async findOne(id: string, userId: string): Promise<Integration> {
    const integration = await this.integrationRepository.findOne({
      where: { id, userId },
    });

    if (!integration) {
      throw new NotFoundException('Integration not found');
    }

    return integration;
  }

  async update(
    id: string,
    userId: string,
    updateIntegrationDto: UpdateIntegrationDto,
  ): Promise<Integration> {
    const integration = await this.findOne(id, userId);

    Object.assign(integration, updateIntegrationDto);
    integration.updatedBy = userId;

    return await this.integrationRepository.save(integration);
  }

  async remove(id: string, userId: string): Promise<void> {
    const integration = await this.findOne(id, userId);
    await this.integrationRepository.softRemove(integration);
  }

  async toggleStatus(id: string, userId: string): Promise<Integration> {
    const integration = await this.findOne(id, userId);

    integration.enabled = !integration.enabled;
    integration.status = integration.enabled
      ? IntegrationStatus.ACTIVE
      : IntegrationStatus.INACTIVE;
    integration.updatedBy = userId;

    return await this.integrationRepository.save(integration);
  }

  async testConnection(
    id: string,
    userId: string,
  ): Promise<{ success: boolean; message: string }> {
    const integration = await this.findOne(id, userId);

    // TODO: Implement actual connection testing based on integration type
    return {
      success: true,
      message: `Successfully connected to ${integration.name}`,
    };
  }

  async getStatistics(userId: string) {
    const [total, active, errors] = await Promise.all([
      this.integrationRepository.count({ where: { userId } }),
      this.integrationRepository.count({
        where: { userId, status: IntegrationStatus.ACTIVE },
      }),
      this.integrationRepository.count({
        where: { userId, status: IntegrationStatus.ERROR },
      }),
    ]);

    const byTypeResult = await this.integrationRepository
      .createQueryBuilder('integration')
      .select('integration.type', 'type')
      .addSelect('COUNT(*)', 'count')
      .where('integration.userId = :userId', { userId })
      .groupBy('integration.type')
      .getRawMany();

    const byType = byTypeResult.reduce(
      (acc, item) => {
        acc[item.type] = parseInt(item.count);
        return acc;
      },
      {} as Record<string, number>,
    );

    const totalMessagesResult = await this.integrationRepository
      .createQueryBuilder('integration')
      .select('SUM(integration.messages_processed)', 'total')
      .where('integration.userId = :userId', { userId })
      .getRawOne();

    return {
      total,
      active,
      errors,
      inactive: total - active - errors,
      byType,
      totalMessages: parseInt(totalMessagesResult?.total || '0'),
    };
  }

  async incrementMessageCount(id: string, userId: string): Promise<void> {
    await this.integrationRepository.increment(
      { id, userId },
      'messagesProcessed',
      1,
    );

    await this.integrationRepository.update(
      { id, userId },
      { lastActivity: new Date() },
    );
  }
}
