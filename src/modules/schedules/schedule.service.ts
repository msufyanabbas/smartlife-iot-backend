// src/modules/schedules/schedule.service.ts
import * as cronParser from 'cron-parser';
import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

import {
  DEFAULT_SCHEDULE_TIMEZONE,
  Schedule,
} from './entities/schedule.entity';
import { ScheduleExecution } from './entities/schedule-execution.entity';
import { CreateScheduleDto } from './dto/create-schedule.dto';
import { UpdateScheduleDto } from './dto/update-schedule.dto';
import { QueryScheduleExecutionDto } from './dto/query-execution.dto';
import {
  PaginationDto,
  PaginatedResponseDto,
} from '@common/dto/pagination.dto';
import {
  ScheduleExecutorService,
  ExecutionResult,
} from './schedule-executor.service';
import { ScheduleCronService } from './schedule-cron.service';
import {
  ScheduleExecutionStatus,
  ScheduleTriggerSource,
  ScheduleTriggerType,
} from '@common/enums/index.enum';
import {
  normaliseAttributeScope,
  validateActionConfig,
  validateTiming,
} from './validators/schedule-configuration.validator';
import type { ScheduleActionConfig } from './interfaces/schedule-action.interface';

/** Columns a client may sort by — anything else is SQL injected into ORDER BY. */
const SORTABLE_COLUMNS = new Set([
  'createdAt',
  'updatedAt',
  'name',
  'type',
  'actionType',
  'enabled',
  'lastRunAt',
  'nextRunAt',
  'runCount',
  'failCount',
]);

@Injectable()
export class SchedulesService {
  private readonly logger = new Logger(SchedulesService.name);

  constructor(
    @InjectRepository(Schedule)
    private readonly scheduleRepository: Repository<Schedule>,
    @InjectRepository(ScheduleExecution)
    private readonly executionRepository: Repository<ScheduleExecution>,
    private readonly executor: ScheduleExecutorService,
    private readonly cronService: ScheduleCronService,
  ) {}

  // ══════════════════════════════════════════════════════════════════════════
  // CRUD
  // ══════════════════════════════════════════════════════════════════════════

  async create(
    userId: string,
    tenantId: string,
    dto: CreateScheduleDto,
  ): Promise<Schedule> {
    const timezone = dto.timezone ?? DEFAULT_SCHEDULE_TIMEZONE;

    this.assertValid(
      {
        type: dto.type,
        cronExpression: dto.cronExpression,
        intervalMs: dto.intervalMs,
        startTime: dto.startTime,
        endTime: dto.endTime,
      },
      dto.actionType,
      dto.actionConfig,
      timezone,
    );

    const schedule = this.scheduleRepository.create({
      ...dto,
      timezone,
      // Applied here rather than left to the column default. `calculateNextRun`
      // returns null for a disabled schedule, and it runs *before* the INSERT —
      // so an omitted `enabled` read as undefined and every schedule created
      // without the field explicitly set was saved enabled with nextRunAt null.
      enabled: dto.enabled ?? true,
      actionConfig: this.normaliseActionConfig(dto.actionConfig),
      userId,
      tenantId,
      createdBy: userId,
      runCount: 0,
      failCount: 0,
    });

    // nextRunAt is derived, never client-supplied — it is the runner's view of
    // the timing fields, so computing it from anything else invites drift.
    schedule.nextRunAt = this.cronService.calculateNextRun(schedule);

    const saved = await this.scheduleRepository.save(schedule);
    this.cronService.registerJob(saved);

    this.logger.log(
      `Created schedule "${saved.name}" (${saved.id}) — ${saved.type}/${saved.actionType}, next run ${saved.nextRunAt?.toISOString() ?? 'never'}`,
    );

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

    const column = SORTABLE_COLUMNS.has(sortBy) ? sortBy : 'createdAt';
    const direction = sortOrder === 'ASC' ? 'ASC' : 'DESC';

    const qb = this.scheduleRepository
      .createQueryBuilder('schedule')
      .where('schedule.userId = :userId', { userId })
      .andWhere('schedule.tenantId = :tenantId', { tenantId });

    if (search) {
      qb.andWhere(
        '(schedule.name ILIKE :search OR schedule.description ILIKE :search)',
        { search: `%${search}%` },
      );
    }

    qb.orderBy(`schedule.${column}`, direction)
      .skip((page - 1) * limit)
      .take(limit);

    const [data, total] = await qb.getManyAndCount();

    return PaginatedResponseDto.create(data, page, limit, total);
  }

  async findOne(
    id: string,
    userId: string,
    tenantId: string,
  ): Promise<Schedule> {
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
    dto: UpdateScheduleDto,
  ): Promise<Schedule> {
    const schedule = await this.findOne(id, userId, tenantId);

    Object.assign(schedule, dto);
    if (dto.actionConfig) {
      schedule.actionConfig = this.normaliseActionConfig(dto.actionConfig);
    }
    schedule.updatedBy = userId;

    // Validate the MERGED entity. The DTO-level validators short-circuit when
    // their anchor field is absent, so a PATCH that flips actionType alone —
    // leaving an actionConfig that no longer matches — only fails here.
    this.assertValid(
      schedule,
      schedule.actionType,
      schedule.actionConfig,
      schedule.timezone,
    );

    schedule.nextRunAt = this.cronService.calculateNextRun(schedule);

    const saved = await this.scheduleRepository.save(schedule);
    this.cronService.rescheduleJob(saved);

    return saved;
  }

  async remove(id: string, userId: string, tenantId: string): Promise<void> {
    const schedule = await this.findOne(id, userId, tenantId);
    this.cronService.unregisterJob(schedule.id);
    await this.scheduleRepository.softRemove(schedule);
  }

  async toggle(
    id: string,
    userId: string,
    tenantId: string,
  ): Promise<Schedule> {
    const schedule = await this.findOne(id, userId, tenantId);

    schedule.enabled = !schedule.enabled;
    schedule.updatedBy = userId;
    schedule.nextRunAt = this.cronService.calculateNextRun(schedule);

    const saved = await this.scheduleRepository.save(schedule);

    if (saved.enabled) this.cronService.registerJob(saved);
    else this.cronService.unregisterJob(saved.id);

    return saved;
  }

  // ══════════════════════════════════════════════════════════════════════════
  // EXECUTION
  // ══════════════════════════════════════════════════════════════════════════

  /**
   * Run a schedule now, regardless of `enabled`.
   *
   * A disabled schedule can still be triggered by hand — that is the point of
   * seeding schedules disabled and letting an operator test one before arming
   * it. `nextRunAt` is recomputed from the timing fields rather than pushed
   * forward, so a manual run does not shift the automatic cadence.
   */
  async run(
    id: string,
    userId: string,
    tenantId: string,
  ): Promise<{
    success: boolean;
    message: string;
    execution: ExecutionResult;
  }> {
    const schedule = await this.findOne(id, userId, tenantId);

    const result = await this.executor.execute(
      schedule,
      ScheduleTriggerSource.MANUAL,
      this.cronService.calculateNextRun(schedule),
    );

    const success = result.status === ScheduleExecutionStatus.SUCCESS;

    return {
      success,
      message: success
        ? `Schedule "${schedule.name}" executed successfully — ${result.summary}`
        : `Schedule "${schedule.name}" failed: ${result.error}`,
      execution: result,
    };
  }

  // ══════════════════════════════════════════════════════════════════════════
  // EXECUTION HISTORY
  // ══════════════════════════════════════════════════════════════════════════

  async getExecutions(
    id: string,
    userId: string,
    tenantId: string,
    query: QueryScheduleExecutionDto,
  ) {
    const schedule = await this.findOne(id, userId, tenantId);

    const page = query.page ?? 1;
    const limit = query.limit ?? 20;

    const qb = this.executionRepository
      .createQueryBuilder('execution')
      .where('execution.scheduleId = :scheduleId', { scheduleId: schedule.id });

    if (query.status) {
      qb.andWhere('execution.status = :status', { status: query.status });
    }

    qb.orderBy('execution.executedAt', 'DESC')
      .skip((page - 1) * limit)
      .take(limit);

    const [executions, total] = await qb.getManyAndCount();

    // Counted across the whole history, not just the returned page — a
    // page-local tally next to lifetime totals reads as a contradiction.
    const [successCount, failedCount] = await Promise.all([
      this.executionRepository.count({
        where: {
          scheduleId: schedule.id,
          status: ScheduleExecutionStatus.SUCCESS,
        },
      }),
      this.executionRepository.count({
        where: {
          scheduleId: schedule.id,
          status: ScheduleExecutionStatus.FAILED,
        },
      }),
    ]);

    return {
      scheduleId: schedule.id,
      scheduleName: schedule.name,
      actionType: schedule.actionType,
      lastRunAt: schedule.lastRunAt,
      lastRunStatus: schedule.lastRunStatus,
      nextRunAt: schedule.nextRunAt,
      runCount: schedule.runCount,
      failCount: schedule.failCount,
      summary: { successCount, failedCount, total },
      ...PaginatedResponseDto.create(executions, page, limit, total),
    };
  }

  async getLatestExecution(id: string, userId: string, tenantId: string) {
    const schedule = await this.findOne(id, userId, tenantId);

    const execution = await this.executionRepository.findOne({
      where: { scheduleId: schedule.id },
      order: { executedAt: 'DESC' },
    });

    if (!execution) {
      return {
        scheduleId: schedule.id,
        scheduleName: schedule.name,
        execution: null,
        message: 'This schedule has not run yet',
      };
    }

    return {
      scheduleId: schedule.id,
      scheduleName: schedule.name,
      execution,
    };
  }

  // ══════════════════════════════════════════════════════════════════════════
  // STATISTICS
  // ══════════════════════════════════════════════════════════════════════════

  /**
   * Validates a cron expression for the UI, without saving anything.
   *
   * Returns the next few fire times rather than a bare true/false, because the
   * question a user actually has is "does this mean what I think it means?" —
   * `0 0 * * 0` parses fine and runs weekly, not daily, and only the preview
   * makes that obvious before the schedule is live.
   */
  validateCronExpression(
    expression: string,
    timezone?: string,
  ): {
    valid: boolean;
    expression: string;
    timezone: string;
    nextRuns: string[];
    error?: string;
  } {
    const tz = timezone || DEFAULT_SCHEDULE_TIMEZONE;
    const trimmed = (expression || '').trim();

    if (!trimmed) {
      return {
        valid: false,
        expression: trimmed,
        timezone: tz,
        nextRuns: [],
        error: 'A cron expression is required',
      };
    }

    try {
      this.cronService.validateCron(trimmed, tz);

      const iterator = cronParser.parseExpression(trimmed, { tz });
      const nextRuns: string[] = [];
      for (let i = 0; i < 5; i++) {
        nextRuns.push(iterator.next().toDate().toISOString());
      }

      return { valid: true, expression: trimmed, timezone: tz, nextRuns };
    } catch (error) {
      return {
        valid: false,
        expression: trimmed,
        timezone: tz,
        nextRuns: [],
        error: (error as Error)?.message ?? 'Invalid cron expression',
      };
    }
  }

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

    const scoped = () =>
      this.scheduleRepository
        .createQueryBuilder('schedule')
        .where('schedule.userId = :userId', { userId })
        .andWhere('schedule.tenantId = :tenantId', { tenantId });

    const [byTriggerRows, byActionRows, totals] = await Promise.all([
      scoped()
        .select('schedule.type', 'type')
        .addSelect('COUNT(*)', 'count')
        .groupBy('schedule.type')
        .getRawMany<{ type: string; count: string }>(),
      scoped()
        .select('schedule.actionType', 'actionType')
        .addSelect('COUNT(*)', 'count')
        .groupBy('schedule.actionType')
        .getRawMany<{ actionType: string; count: string }>(),
      // Property names, not snake_case: no naming strategy is configured, so
      // the columns really are "runCount"/"failCount" and a snake-cased
      // reference here is a 42703 at runtime — which is exactly what the
      // previous SUM(schedule.execution_count) did.
      scoped()
        .select('COALESCE(SUM(schedule.runCount), 0)', 'runs')
        .addSelect('COALESCE(SUM(schedule.failCount), 0)', 'failures')
        .getRawOne<{ runs: string; failures: string }>(),
    ]);

    const toMap = <T extends Record<string, any>>(rows: T[], key: keyof T) =>
      rows.reduce<Record<string, number>>((acc, row) => {
        acc[String(row[key])] = parseInt(row.count, 10);
        return acc;
      }, {});

    const totalRuns = parseInt(totals?.runs ?? '0', 10);
    const totalFailures = parseInt(totals?.failures ?? '0', 10);

    return {
      total,
      enabled,
      disabled,
      byTriggerType: toMap(byTriggerRows, 'type'),
      byActionType: toMap(byActionRows, 'actionType'),
      totalRuns,
      totalFailures,
      successRate:
        totalRuns > 0
          ? Math.round(((totalRuns - totalFailures) / totalRuns) * 100)
          : null,
      /** Timers currently armed in this process, across all tenants. */
      activeTimers: this.cronService.getRegisteredCount(),
    };
  }

  // ══════════════════════════════════════════════════════════════════════════
  // HELPERS
  // ══════════════════════════════════════════════════════════════════════════

  /** Rejects incoherent timing, a bad cron expression, or a mismatched config. */
  private assertValid(
    timing: {
      type: ScheduleTriggerType;
      cronExpression?: string | null;
      intervalMs?: number | null;
      startTime?: Date | null;
      endTime?: Date | null;
    },
    actionType: any,
    actionConfig: ScheduleActionConfig,
    timezone: string,
  ): void {
    const timingError = validateTiming(timing);
    if (timingError) throw new BadRequestException(timingError);

    // Checked for every trigger type, not just CRON: an INTERVAL schedule does
    // not fire by timezone but still stores one, and a garbage value there
    // becomes a CRON schedule that never runs the moment someone edits the
    // type.
    try {
      this.cronService.validateTimezone(timezone);
    } catch {
      throw new BadRequestException(
        `Unknown timezone "${timezone}". Use an IANA zone name such as "Asia/Riyadh" — UTC offset strings like "UTC+3" are not accepted.`,
      );
    }

    if (timing.type === ScheduleTriggerType.CRON && timing.cronExpression) {
      try {
        this.cronService.validateCron(timing.cronExpression, timezone);
      } catch (err: unknown) {
        // 400, not the 500 the old `throw new Error` produced — a malformed
        // cron expression is client input, not a server fault.
        throw new BadRequestException(
          `Invalid cron expression "${timing.cronExpression}" for timezone "${timezone}": ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      }
    }

    const configError = validateActionConfig(actionType, actionConfig);
    if (configError) throw new BadRequestException(configError);
  }

  /** Canonicalises ThingsBoard-style scope spellings before persistence. */
  private normaliseActionConfig(
    config: ScheduleActionConfig,
  ): ScheduleActionConfig {
    if (!config?.attributeUpdate) return config;

    const scope = normaliseAttributeScope(config.attributeUpdate.scope);
    if (!scope) return config;

    return {
      ...config,
      attributeUpdate: { ...config.attributeUpdate, scope },
    };
  }
}
