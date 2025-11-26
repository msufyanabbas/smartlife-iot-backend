import {
  Injectable,
  NotFoundException,
  ConflictException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Automation, AutomationStatus } from './entities/automation.entity';
import { CreateAutomationDto } from './dto/create-automation.dto';
import { UpdateAutomationDto } from './dto/update-automation.dto';
import { PaginationDto } from '../../common/dto/pagination.dto';

@Injectable()
export class AutomationService {
  constructor(
    @InjectRepository(Automation)
    private readonly automationRepository: Repository<Automation>,
  ) {}

  async create(
    userId: string,
    createAutomationDto: CreateAutomationDto,
  ): Promise<Automation> {
    // Check if automation with same name exists
    const existing = await this.automationRepository.findOne({
      where: { name: createAutomationDto.name, userId },
    });

    if (existing) {
      throw new ConflictException('Automation with this name already exists');
    }

    const automation = this.automationRepository.create({
      ...createAutomationDto,
      userId,
      createdBy: userId,
      status: createAutomationDto.enabled
        ? AutomationStatus.ACTIVE
        : AutomationStatus.INACTIVE,
    });

    return await this.automationRepository.save(automation);
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

    const queryBuilder = this.automationRepository
      .createQueryBuilder('automation')
      .where('automation.userId = :userId', { userId });

    if (search) {
      queryBuilder.andWhere(
        '(automation.name ILIKE :search OR automation.description ILIKE :search)',
        { search: `%${search}%` },
      );
    }

    queryBuilder
      .orderBy(`automation.${sortBy}`, sortOrder as 'ASC' | 'DESC')
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

  async findOne(id: string, userId: string): Promise<Automation> {
    const automation = await this.automationRepository.findOne({
      where: { id, userId },
    });

    if (!automation) {
      throw new NotFoundException('Automation not found');
    }

    return automation;
  }

  async update(
    id: string,
    userId: string,
    updateAutomationDto: UpdateAutomationDto,
  ): Promise<Automation> {
    const automation = await this.findOne(id, userId);

    Object.assign(automation, updateAutomationDto);
    automation.updatedBy = userId;

    // Update status based on enabled flag
    if (updateAutomationDto.enabled !== undefined) {
      automation.status = updateAutomationDto.enabled
        ? AutomationStatus.ACTIVE
        : AutomationStatus.INACTIVE;
    }

    return await this.automationRepository.save(automation);
  }

  async remove(id: string, userId: string): Promise<void> {
    const automation = await this.findOne(id, userId);
    await this.automationRepository.softRemove(automation);
  }

  async toggle(id: string, userId: string): Promise<Automation> {
    const automation = await this.findOne(id, userId);

    automation.enabled = !automation.enabled;
    automation.status = automation.enabled
      ? AutomationStatus.ACTIVE
      : AutomationStatus.INACTIVE;
    automation.updatedBy = userId;

    return await this.automationRepository.save(automation);
  }

  async execute(
    id: string,
    userId: string,
  ): Promise<{ success: boolean; message: string }> {
    const automation = await this.findOne(id, userId);

    if (!automation.enabled) {
      throw new ConflictException('Automation is disabled');
    }

    // TODO: Implement actual automation execution logic
    // This would trigger the action based on the automation configuration

    // Update execution tracking
    automation.executionCount += 1;
    automation.lastTriggered = new Date();
    await this.automationRepository.save(automation);

    return {
      success: true,
      message: `Automation "${automation.name}" executed successfully`,
    };
  }

  async getStatistics(userId: string) {
    const [total, active, inactive] = await Promise.all([
      this.automationRepository.count({ where: { userId } }),
      this.automationRepository.count({
        where: { userId, status: AutomationStatus.ACTIVE },
      }),
      this.automationRepository.count({
        where: { userId, status: AutomationStatus.INACTIVE },
      }),
    ]);

    // Get total executions
    const executionsResult = await this.automationRepository
      .createQueryBuilder('automation')
      .select('SUM(automation.execution_count)', 'total')
      .where('automation.userId = :userId', { userId })
      .getRawOne();

    // Get by trigger type
    const byTriggerResult = await this.automationRepository
      .createQueryBuilder('automation')
      .select("automation.trigger->>'type'", 'type')
      .addSelect('COUNT(*)', 'count')
      .where('automation.userId = :userId', { userId })
      .groupBy("automation.trigger->>'type'")
      .getRawMany();

    const byTrigger = byTriggerResult.reduce(
      (acc, item) => {
        acc[item.type] = parseInt(item.count);
        return acc;
      },
      {} as Record<string, number>,
    );

    return {
      total,
      active,
      inactive,
      totalExecutions: parseInt(executionsResult?.total || '0'),
      byTrigger,
    };
  }

  async getExecutionLogs(id: string, userId: string, limit: number = 10) {
    const automation = await this.findOne(id, userId);

    // TODO: Implement actual execution log retrieval from a logs table
    // For now, return basic info
    return {
      automationId: automation.id,
      automationName: automation.name,
      totalExecutions: automation.executionCount,
      lastTriggered: automation.lastTriggered,
      logs: [], // Would contain actual log entries
    };
  }
}
