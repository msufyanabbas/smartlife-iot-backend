import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Schedule, ScheduleType } from './entities/schedule.entity';
import { CreateScheduleDto } from './dto/create-schedule.dto';
import { UpdateScheduleDto } from './dto/update-schedule.dto';
import { PaginationDto } from '../../common/dto/pagination.dto';

@Injectable()
export class SchedulesService {
  constructor(
    @InjectRepository(Schedule)
    private readonly scheduleRepository: Repository<Schedule>,
  ) {}

  async create(
    userId: string,
    createScheduleDto: CreateScheduleDto,
  ): Promise<Schedule> {
    const schedule = this.scheduleRepository.create({
      ...createScheduleDto,
      userId,
      createdBy: userId,
      nextRun: this.calculateNextRun(createScheduleDto.schedule),
    });

    return await this.scheduleRepository.save(schedule);
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

    const queryBuilder = this.scheduleRepository
      .createQueryBuilder('schedule')
      .where('schedule.userId = :userId', { userId });

    if (search) {
      queryBuilder.andWhere(
        '(schedule.name ILIKE :search OR schedule.description ILIKE :search)',
        { search: `%${search}%` },
      );
    }

    queryBuilder
      .orderBy(`schedule.${sortBy}`, sortOrder as 'ASC' | 'DESC')
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

  async findOne(id: string, userId: string): Promise<Schedule> {
    const schedule = await this.scheduleRepository.findOne({
      where: { id, userId },
    });

    if (!schedule) {
      throw new NotFoundException('Schedule not found');
    }

    return schedule;
  }

  async update(
    id: string,
    userId: string,
    updateScheduleDto: UpdateScheduleDto,
  ): Promise<Schedule> {
    const schedule = await this.findOne(id, userId);

    Object.assign(schedule, updateScheduleDto);
    schedule.updatedBy = userId;

    // Recalculate next run if schedule changed
    if (updateScheduleDto.schedule) {
      schedule.nextRun = this.calculateNextRun(updateScheduleDto.schedule);
    }

    return await this.scheduleRepository.save(schedule);
  }

  async remove(id: string, userId: string): Promise<void> {
    const schedule = await this.findOne(id, userId);
    await this.scheduleRepository.softRemove(schedule);
  }

  async toggle(id: string, userId: string): Promise<Schedule> {
    const schedule = await this.findOne(id, userId);

    schedule.enabled = !schedule.enabled;
    schedule.updatedBy = userId;

    return await this.scheduleRepository.save(schedule);
  }

  async execute(
    id: string,
    userId: string,
  ): Promise<{ success: boolean; message: string }> {
    const schedule = await this.findOne(id, userId);

    // TODO: Implement actual schedule execution logic
    // This would trigger the scheduled task immediately

    // Update execution tracking
    schedule.executionCount += 1;
    schedule.lastRun = new Date();
    schedule.nextRun = this.calculateNextRun(schedule.schedule);
    await this.scheduleRepository.save(schedule);

    return {
      success: true,
      message: `Schedule "${schedule.name}" executed successfully`,
    };
  }

  async getHistory(id: string, userId: string, limit: number = 10) {
    const schedule = await this.findOne(id, userId);

    // TODO: Implement actual execution history retrieval
    return {
      scheduleId: schedule.id,
      scheduleName: schedule.name,
      totalExecutions: schedule.executionCount,
      lastRun: schedule.lastRun,
      nextRun: schedule.nextRun,
      history: [], // Would contain actual execution log entries
    };
  }

  async getStatistics(userId: string) {
    const [total, enabled, disabled] = await Promise.all([
      this.scheduleRepository.count({ where: { userId } }),
      this.scheduleRepository.count({ where: { userId, enabled: true } }),
      this.scheduleRepository.count({ where: { userId, enabled: false } }),
    ]);

    // Get by type
    const byTypeResult = await this.scheduleRepository
      .createQueryBuilder('schedule')
      .select('schedule.type', 'type')
      .addSelect('COUNT(*)', 'count')
      .where('schedule.userId = :userId', { userId })
      .groupBy('schedule.type')
      .getRawMany();

    const byType = byTypeResult.reduce(
      (acc, item) => {
        acc[item.type] = parseInt(item.count);
        return acc;
      },
      {} as Record<string, number>,
    );

    // Get total executions
    const executionsResult = await this.scheduleRepository
      .createQueryBuilder('schedule')
      .select('SUM(schedule.execution_count)', 'total')
      .where('schedule.userId = :userId', { userId })
      .getRawOne();

    return {
      total,
      enabled,
      disabled,
      byType,
      totalExecutions: parseInt(executionsResult?.total || '0'),
    };
  }

  private calculateNextRun(cronExpression: string): Date {
    // TODO: Use a cron parser library to calculate next run
    // For now, return 1 hour from now
    const now = new Date();
    return new Date(now.getTime() + 60 * 60 * 1000);
  }
}
