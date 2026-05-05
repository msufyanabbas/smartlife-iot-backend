// src/modules/schedules/schedule.service.ts
import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import * as cronParser from 'cron-parser';
import { Schedule } from './entities/schedule.entity';
import {
  ScheduleExecutionLog,
  ExecutionStatus,
  TriggerSource,
} from './entities/schedule-execution-log.entity';
import { CreateScheduleDto } from './dto/create-schedule.dto';
import { UpdateScheduleDto } from './dto/update-schedule.dto';
import { PaginationDto } from '../../common/dto/pagination.dto';
import { ScheduleExecutorService } from './schedule-executor.service';
import { ScheduleCronService } from './schedule-cron.service';

@Injectable()
export class SchedulesService {
  constructor(
    @InjectRepository(Schedule)
    private readonly scheduleRepository: Repository<Schedule>,

    @InjectRepository(ScheduleExecutionLog)
    private readonly logRepository: Repository<ScheduleExecutionLog>,

    private readonly executor: ScheduleExecutorService,
    private readonly cronService: ScheduleCronService,
  ) {}

  // ──────────────────────────────────────────────────────────────────────────
  // CRUD
  // ──────────────────────────────────────────────────────────────────────────

  async create(
    userId: string,
    tenantId: string,
    createScheduleDto: CreateScheduleDto,
  ): Promise<Schedule> {
    const schedule = this.scheduleRepository.create({
      ...createScheduleDto,
      userId,
      tenantId,
      createdBy: userId,
      nextRun: this.calculateNextRun(createScheduleDto.schedule),
    });

    const saved = await this.scheduleRepository.save(schedule);

    // Register the new job in the cron runner
    this.cronService.registerJob(saved);

    return saved;
  }

  async findAll(
    userId: string,
    tenantId: string,
    paginationDto: PaginationDto,
  ) {
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
      .where('schedule.userId = :userId', { userId })
      .andWhere('schedule.tenantId = :tenantId', { tenantId });

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

  async findOne(id: string, userId: string, tenantId: string): Promise<Schedule> {
    const schedule = await this.scheduleRepository.findOne({
      where: { id, userId, tenantId },
    });

    if (!schedule) {
      throw new NotFoundException(`Schedule with id "${id}" not found`);
    }

    return schedule;
  }

  async update(
    id: string,
    userId: string,
    tenantId: string,
    updateScheduleDto: UpdateScheduleDto,
  ): Promise<Schedule> {
    const schedule = await this.findOne(id, userId, tenantId);

    Object.assign(schedule, updateScheduleDto);
    schedule.updatedBy = userId;

    if (updateScheduleDto.schedule) {
      schedule.nextRun = this.calculateNextRun(updateScheduleDto.schedule);
    }

    const saved = await this.scheduleRepository.save(schedule);

    // Reschedule the cron job to reflect expression / enabled changes
    this.cronService.rescheduleJob(saved);

    return saved;
  }

  async remove(id: string, userId: string, tenantId: string): Promise<void> {
    const schedule = await this.findOne(id, userId, tenantId);

    this.cronService.unregisterJob(schedule.id);

    await this.scheduleRepository.softRemove(schedule);
  }

  async toggle(id: string, userId: string, tenantId: string): Promise<Schedule> {
    const schedule = await this.findOne(id, userId, tenantId);

    schedule.enabled = !schedule.enabled;
    schedule.updatedBy = userId;

    const saved = await this.scheduleRepository.save(schedule);

    if (saved.enabled) {
      this.cronService.registerJob(saved);
    } else {
      this.cronService.unregisterJob(saved.id);
    }

    return saved;
  }

  // ──────────────────────────────────────────────────────────────────────────
  // EXECUTION
  // ──────────────────────────────────────────────────────────────────────────

  async execute(
    id: string,
    userId: string,
    tenantId: string,
  ): Promise<{ success: boolean; message: string; output?: Record<string, any> }> {
    const schedule = await this.findOne(id, userId, tenantId);

    const result = await this.executor.execute(schedule, TriggerSource.MANUAL);

    // Recalculate nextRun and persist the entity changes from recordExecution()
    schedule.nextRun = this.calculateNextRun(schedule.schedule);
    await this.scheduleRepository.save(schedule);

    return {
      success: result.success,
      message: result.success
        ? `Schedule "${schedule.name}" executed successfully`
        : `Schedule "${schedule.name}" execution failed: ${result.error}`,
      output: result.output,
    };
  }

  // ──────────────────────────────────────────────────────────────────────────
  // HISTORY
  // ──────────────────────────────────────────────────────────────────────────

  async getHistory(
    id: string,
    userId: string,
    tenantId: string,
    paginationDto: { page?: number; limit?: number } = {},
  ) {
    // Verify ownership before returning logs
    const schedule = await this.findOne(id, userId, tenantId);

    const page = paginationDto.page ?? 1;
    const limit = Math.min(paginationDto.limit ?? 20, 100); // cap at 100
    const skip = (page - 1) * limit;

    const [logs, total] = await this.logRepository.findAndCount({
      where: { scheduleId: schedule.id },
      order: { startedAt: 'DESC' },
      skip,
      take: limit,
    });

    const successCount = logs.filter(
      (l) => l.status === ExecutionStatus.SUCCESS,
    ).length;
    const failedCount = logs.filter(
      (l) => l.status === ExecutionStatus.FAILED,
    ).length;

    return {
      scheduleId: schedule.id,
      scheduleName: schedule.name,
      totalExecutions: schedule.executionCount,
      failureCount: schedule.failureCount,
      lastRun: schedule.lastRun,
      nextRun: schedule.nextRun,
      pagination: {
        page,
        limit,
        total,
        totalPages: Math.ceil(total / limit),
      },
      summary: { successCount, failedCount },
      history: logs,
    };
  }

  // ──────────────────────────────────────────────────────────────────────────
  // STATISTICS
  // ──────────────────────────────────────────────────────────────────────────

  async getStatistics(userId: string, tenantId: string) {
    const [total, enabled, disabled] = await Promise.all([
      this.scheduleRepository.count({ where: { userId, tenantId } }),
      this.scheduleRepository.count({
        where: { userId, tenantId, enabled: true },
      }),
      this.scheduleRepository.count({
        where: { userId, tenantId, enabled: false },
      }),
    ]);

    const byTypeResult = await this.scheduleRepository
      .createQueryBuilder('schedule')
      .select('schedule.type', 'type')
      .addSelect('COUNT(*)', 'count')
      .where('schedule.userId = :userId', { userId })
      .andWhere('schedule.tenantId = :tenantId', { tenantId })
      .groupBy('schedule.type')
      .getRawMany();

    const byType = byTypeResult.reduce(
      (acc, item) => {
        acc[item.type] = parseInt(item.count, 10);
        return acc;
      },
      {} as Record<string, number>,
    );

    const executionsResult = await this.scheduleRepository
      .createQueryBuilder('schedule')
      .select('SUM(schedule.execution_count)', 'total')
      .addSelect('SUM(schedule.failure_count)', 'failures')
      .where('schedule.userId = :userId', { userId })
      .andWhere('schedule.tenantId = :tenantId', { tenantId })
      .getRawOne();

    return {
      total,
      enabled,
      disabled,
      byType,
      totalExecutions: parseInt(executionsResult?.total ?? '0', 10),
      totalFailures: parseInt(executionsResult?.failures ?? '0', 10),
    };
  }

  // ──────────────────────────────────────────────────────────────────────────
  // HELPERS
  // ──────────────────────────────────────────────────────────────────────────

  /**
   * Parse a cron expression and return the next scheduled Date.
   * Uses `cron-parser` (UTC, no DST ambiguity).
   */
  calculateNextRun(cronExpression: string): Date {
    try {
      const interval = cronParser.parseExpression(cronExpression, {
        utc: true,
      });
      return interval.next().toDate();
    } catch (err: any) {
      throw new Error(
        `Invalid cron expression "${cronExpression}": ${err?.message}`,
      );
    }
  }
}