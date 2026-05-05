// src/modules/schedules/schedule-executor.service.ts
import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { Schedule } from './entities/schedule.entity';
import {
  ScheduleExecutionLog,
  ExecutionStatus,
  TriggerSource,
} from './entities/schedule-execution-log.entity';
import { ScheduleType } from '@common/enums/index.enum';

export interface ExecutionResult {
  success: boolean;
  output?: Record<string, any>;
  error?: string;
}

@Injectable()
export class ScheduleExecutorService {
  private readonly logger = new Logger(ScheduleExecutorService.name);

  constructor(
    @InjectRepository(ScheduleExecutionLog)
    private readonly logRepository: Repository<ScheduleExecutionLog>,
    private readonly eventEmitter: EventEmitter2,
  ) {}

  // ──────────────────────────────────────────────────────────────────────────
  // PUBLIC ENTRY POINT
  // ──────────────────────────────────────────────────────────────────────────

  async execute(
    schedule: Schedule,
    triggeredBy: TriggerSource = TriggerSource.CRON,
  ): Promise<ExecutionResult> {
    const startedAt = new Date();

    // Create the log row immediately so we have a record even on crash
    const log = this.logRepository.create({
      scheduleId: schedule.id,
      tenantId: schedule.tenantId,
      status: ExecutionStatus.SUCCESS, // optimistic; updated on failure
      triggeredBy,
      startedAt,
    });
    await this.logRepository.save(log);

    let result: ExecutionResult;

    try {
      result = await this.dispatch(schedule);
    } catch (err: any) {
      result = { success: false, error: err?.message ?? String(err) };
    }

    // Finalise log
    const finishedAt = new Date();
    log.finishedAt = finishedAt;
    log.durationMs = finishedAt.getTime() - startedAt.getTime();
    log.status = result.success ? ExecutionStatus.SUCCESS : ExecutionStatus.FAILED;
    log.output = result.success
      ? { result: result.output }
      : { error: result.error };

    await this.logRepository.save(log);

    // Update the schedule entity itself
    schedule.recordExecution(result.success, result.error);

    return result;
  }

  // ──────────────────────────────────────────────────────────────────────────
  // DISPATCHER
  // ──────────────────────────────────────────────────────────────────────────

  private async dispatch(schedule: Schedule): Promise<ExecutionResult> {
    this.logger.log(
      `Dispatching schedule "${schedule.name}" (type=${schedule.type}, id=${schedule.id})`,
    );

    switch (schedule.type) {
      case ScheduleType.REPORT:
        return this.handleReport(schedule);
      case ScheduleType.BACKUP:
        return this.handleBackup(schedule);
      case ScheduleType.CLEANUP:
        return this.handleCleanup(schedule);
      case ScheduleType.EXPORT:
        return this.handleExport(schedule);
      case ScheduleType.DEVICE_COMMAND:
        return this.handleDeviceCommand(schedule);
      default:
        throw new Error(`Unknown schedule type: ${(schedule as any).type}`);
    }
  }

  // ──────────────────────────────────────────────────────────────────────────
  // HANDLERS
  // ──────────────────────────────────────────────────────────────────────────

  private async handleReport(schedule: Schedule): Promise<ExecutionResult> {
    const payload = {
      scheduleId: schedule.id,
      tenantId: schedule.tenantId,
      userId: schedule.userId,
      ...schedule.configuration,
    };

    this.logger.log(
      `[REPORT] Emitting schedule.report.requested for schedule ${schedule.id}`,
    );
    await this.eventEmitter.emitAsync('schedule.report.requested', payload);

    return {
      success: true,
      output: { event: 'schedule.report.requested', payload },
    };
  }

  private async handleBackup(schedule: Schedule): Promise<ExecutionResult> {
    const payload = {
      scheduleId: schedule.id,
      tenantId: schedule.tenantId,
      userId: schedule.userId,
      ...schedule.configuration,
    };

    this.logger.log(
      `[BACKUP] Emitting schedule.backup.requested for schedule ${schedule.id}`,
    );
    await this.eventEmitter.emitAsync('schedule.backup.requested', payload);

    return {
      success: true,
      output: { event: 'schedule.backup.requested', payload },
    };
  }

  private async handleCleanup(schedule: Schedule): Promise<ExecutionResult> {
    const payload = {
      scheduleId: schedule.id,
      tenantId: schedule.tenantId,
      userId: schedule.userId,
      ...schedule.configuration,
    };

    this.logger.log(
      `[CLEANUP] Emitting schedule.cleanup.requested for schedule ${schedule.id}`,
    );
    await this.eventEmitter.emitAsync('schedule.cleanup.requested', payload);

    return {
      success: true,
      output: { event: 'schedule.cleanup.requested', payload },
    };
  }

  private async handleExport(schedule: Schedule): Promise<ExecutionResult> {
    const payload = {
      scheduleId: schedule.id,
      tenantId: schedule.tenantId,
      userId: schedule.userId,
      ...schedule.configuration,
    };

    this.logger.log(
      `[EXPORT] Emitting schedule.export.requested for schedule ${schedule.id}`,
    );
    await this.eventEmitter.emitAsync('schedule.export.requested', payload);

    return {
      success: true,
      output: { event: 'schedule.export.requested', payload },
    };
  }

  private async handleDeviceCommand(
    schedule: Schedule,
  ): Promise<ExecutionResult> {
    const config = schedule.configuration as {
      deviceId: string;
      command: string;
      params?: Record<string, any>;
      [key: string]: any;
    };

    if (!config.deviceId || !config.command) {
      throw new Error(
        'DEVICE_COMMAND schedule is missing required configuration fields: deviceId, command',
      );
    }

    const payload = {
      scheduleId: schedule.id,
      tenantId: schedule.tenantId,
      userId: schedule.userId,
      deviceId: config.deviceId,
      command: config.command,
      params: config.params ?? {},
    };

    this.logger.log(
      `[DEVICE_COMMAND] Emitting schedule.device_command.requested ` +
        `(device=${config.deviceId}, cmd=${config.command}) for schedule ${schedule.id}`,
    );
    await this.eventEmitter.emitAsync(
      'schedule.device_command.requested',
      payload,
    );

    return {
      success: true,
      output: { event: 'schedule.device_command.requested', payload },
    };
  }
}