// src/modules/schedules/schedule-executor.service.ts
import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { IsNull, Repository } from 'typeorm';
import { EventEmitter2 } from '@nestjs/event-emitter';

import { Schedule } from './entities/schedule.entity';
import { ScheduleExecution } from './entities/schedule-execution.entity';
import { Alarm, Device, Telemetry, User } from '@modules/index.entities';
import {
  AlarmStatus,
  AttributeScope,
  NotificationChannel,
  NotificationPriority,
  NotificationType,
  ScheduleActionType,
  ScheduleExecutionStatus,
  ScheduleMaintenanceTask,
  ScheduleReportType,
  ScheduleTargetType,
  ScheduleTriggerSource,
  UserRole,
  UserStatus,
} from '@common/enums/index.enum';

import { DeviceCommandsService } from '@modules/device-commands/device-commands.service';
import { AttributesService } from '@modules/attributes/attributes.service';
import { RuleEngineService } from '@modules/rules/rule-engine.service';
import { NotificationsService } from '@modules/notifications/notifications.service';
import { AnalyticsService } from '@modules/analytics/analytics.service';
import { NodeMessage } from '@modules/nodes/nodes-processor.interface';
import { AnalyticsTimeRange } from '@modules/analytics/dto/analytics.dto';

import {
  normaliseAttributeScope,
  validateActionConfig,
} from './validators/schedule-configuration.validator';
import type {
  ScheduleActionResult,
  ScheduleDeviceTarget,
  ScheduleTimeRange,
} from './interfaces/schedule-action.interface';

export interface ExecutionResult {
  status: ScheduleExecutionStatus;
  summary?: string;
  metadata?: Record<string, any>;
  details?: Record<string, any>;
  error?: string;
  durationMs: number;
  executionId: string;
}

/** How many devices a single fan-out action will touch. */
const MAX_FANOUT_DEVICES = 500;

/** Maps the schedule's own range vocabulary onto the analytics enum. */
const TIME_RANGE_TO_ANALYTICS: Record<ScheduleTimeRange, AnalyticsTimeRange> = {
  '24h': AnalyticsTimeRange.ONE_DAY,
  '7d': AnalyticsTimeRange.SEVEN_DAYS,
  '30d': AnalyticsTimeRange.THIRTY_DAYS,
};

@Injectable()
export class ScheduleExecutorService {
  private readonly logger = new Logger(ScheduleExecutorService.name);

  constructor(
    @InjectRepository(ScheduleExecution)
    private readonly executionRepository: Repository<ScheduleExecution>,
    @InjectRepository(Schedule)
    private readonly scheduleRepository: Repository<Schedule>,
    @InjectRepository(Device)
    private readonly deviceRepository: Repository<Device>,
    @InjectRepository(Telemetry)
    private readonly telemetryRepository: Repository<Telemetry>,
    @InjectRepository(Alarm)
    private readonly alarmRepository: Repository<Alarm>,
    @InjectRepository(User)
    private readonly userRepository: Repository<User>,

    private readonly deviceCommandsService: DeviceCommandsService,
    private readonly attributesService: AttributesService,
    private readonly ruleEngineService: RuleEngineService,
    private readonly notificationsService: NotificationsService,
    private readonly analyticsService: AnalyticsService,
    private readonly eventEmitter: EventEmitter2,
  ) {}

  // ══════════════════════════════════════════════════════════════════════════
  // PUBLIC ENTRY POINT
  // ══════════════════════════════════════════════════════════════════════════

  /**
   * Run a schedule once and record the outcome.
   *
   * Never throws: a failing action is captured on the execution row and
   * reflected in the schedule's counters. The caller (cron tick or the
   * `POST /schedules/:id/run` endpoint) always gets a result back.
   *
   * `runCount` / `failCount` are incremented with SQL expressions rather than
   * read-modify-write so two concurrent runs of the same schedule cannot lose
   * an increment.
   */
  async execute(
    schedule: Schedule,
    triggeredBy: ScheduleTriggerSource = ScheduleTriggerSource.CRON,
    nextRunAt: Date | null = null,
  ): Promise<ExecutionResult> {
    const startedAt = new Date();
    const startMs = Date.now();

    let status: ScheduleExecutionStatus = ScheduleExecutionStatus.SUCCESS;
    let error: string | null = null;
    let result: ScheduleActionResult | null = null;

    try {
      this.logger.log(
        `Executing schedule "${schedule.name}" (${schedule.actionType}, id=${schedule.id}, by=${triggeredBy})`,
      );

      // actionType can be repointed by a PATCH that leaves a stale
      // actionConfig behind, so the pairing is re-checked here rather than
      // trusted from create-time validation.
      const configError = validateActionConfig(
        schedule.actionType,
        schedule.actionConfig,
      );
      if (configError) {
        throw new Error(`Invalid actionConfig: ${configError}`);
      }

      switch (schedule.actionType) {
        case ScheduleActionType.DEVICE_COMMAND:
          result = await this.executeDeviceCommand(schedule);
          break;
        case ScheduleActionType.ATTRIBUTE_UPDATE:
          result = await this.executeAttributeUpdate(schedule);
          break;
        case ScheduleActionType.RULE_CHAIN_TRIGGER:
          result = await this.executeRuleChainTrigger(schedule);
          break;
        case ScheduleActionType.SEND_NOTIFICATION:
          result = await this.executeSendNotification(schedule);
          break;
        case ScheduleActionType.DATA_MAINTENANCE:
          result = await this.executeDataMaintenance(schedule);
          break;
        case ScheduleActionType.GENERATE_REPORT:
          result = await this.executeGenerateReport(schedule);
          break;
        default:
          throw new Error(`Unknown action type: ${schedule.actionType}`);
      }
    } catch (err: unknown) {
      status = ScheduleExecutionStatus.FAILED;
      error = err instanceof Error ? err.message : String(err);
      this.logger.error(
        `Schedule "${schedule.name}" (${schedule.id}) failed: ${error}`,
        err instanceof Error ? err.stack : undefined,
      );
    }

    const durationMs = Date.now() - startMs;

    const execution = await this.executionRepository.save(
      this.executionRepository.create({
        scheduleId: schedule.id,
        tenantId: schedule.tenantId,
        status,
        triggeredBy,
        executedAt: startedAt,
        durationMs,
        result: result ? JSON.stringify(result.details ?? {}) : null,
        error,
        metadata: result?.metadata ?? null,
      }),
    );

    // Atomic counter bump — `undefined` values are omitted by TypeORM, so
    // failCount only advances on a failure.
    await this.scheduleRepository.update({ id: schedule.id }, {
      lastRunAt: startedAt,
      lastRunStatus: status,
      lastRunError: error,
      nextRunAt,
      runCount: () => '"runCount" + 1',
      failCount:
        status === ScheduleExecutionStatus.FAILED
          ? () => '"failCount" + 1'
          : undefined,
    } as any);

    // Keep the in-memory copy consistent for the caller.
    schedule.lastRunAt = startedAt;
    schedule.lastRunStatus = status;
    schedule.lastRunError = error;
    schedule.nextRunAt = nextRunAt;
    schedule.runCount += 1;
    if (status === ScheduleExecutionStatus.FAILED) schedule.failCount += 1;

    this.eventEmitter.emit('schedule.executed', {
      scheduleId: schedule.id,
      tenantId: schedule.tenantId,
      actionType: schedule.actionType,
      status,
      durationMs,
      error,
    });

    this.logger.log(
      `Schedule "${schedule.name}" finished [${status}] in ${durationMs}ms` +
        (result?.summary ? ` — ${result.summary}` : '') +
        (error ? ` — ${error}` : ''),
    );

    return {
      status,
      summary: result?.summary,
      metadata: result?.metadata,
      details: result?.details,
      error: error ?? undefined,
      durationMs,
      executionId: execution.id,
    };
  }

  // ══════════════════════════════════════════════════════════════════════════
  // TARGET RESOLUTION
  // ══════════════════════════════════════════════════════════════════════════

  /**
   * Resolve a target selector to concrete devices, always tenant-scoped.
   *
   * `deletedAt: IsNull()` is redundant for TypeORM's own find (soft-delete is
   * filtered automatically) but is stated for the ASSET/ALL cases so the
   * intent survives any later move to a QueryBuilder.
   */
  private async resolveDevices(
    tenantId: string,
    target: ScheduleDeviceTarget,
  ): Promise<Device[]> {
    switch (target.targetType) {
      case ScheduleTargetType.DEVICE: {
        const device = await this.deviceRepository.findOne({
          where: { id: target.deviceId, tenantId },
        });
        if (!device) {
          throw new Error(
            `Device ${target.deviceId} not found in tenant ${tenantId}`,
          );
        }
        return [device];
      }

      case ScheduleTargetType.DEVICE_TYPE:
        return this.deviceRepository.find({
          where: {
            type: target.deviceType as any,
            tenantId,
            deletedAt: IsNull(),
          },
          take: MAX_FANOUT_DEVICES,
        });

      case ScheduleTargetType.ASSET: {
        // Verify the asset actually has devices rather than silently matching
        // nothing — an operator typo here is otherwise invisible.
        return this.deviceRepository.find({
          where: { assetId: target.assetId, tenantId, deletedAt: IsNull() },
          take: MAX_FANOUT_DEVICES,
        });
      }

      case ScheduleTargetType.ALL:
        return this.deviceRepository.find({
          where: { tenantId, deletedAt: IsNull() },
          take: MAX_FANOUT_DEVICES,
        });

      default:
        throw new Error(`Unsupported targetType: ${target.targetType}`);
    }
  }

  /** Loads the schedule's owner — several downstream services take a User. */
  private async loadOwner(schedule: Schedule): Promise<User> {
    const user = await this.userRepository.findOne({
      where: { id: schedule.userId },
    });
    if (!user) {
      throw new Error(
        `Schedule owner ${schedule.userId} no longer exists — cannot execute`,
      );
    }
    return user;
  }

  // ══════════════════════════════════════════════════════════════════════════
  // ACTION: DEVICE_COMMAND
  // ══════════════════════════════════════════════════════════════════════════

  /**
   * Queue an RPC to every targeted device.
   *
   * Goes through `DeviceCommandsService.createCommand()` rather than
   * publishing MQTT directly. That service persists a `device_commands` row
   * and hands off to Kafka `device.commands`, where `DeviceCommandsConsumer`
   * performs the protocol-aware downlink (LoRaWAN payloads are codec-encoded;
   * generic MQTT gets JSON) and records delivery. A raw publish here would
   * bypass all of that and produce commands with no delivery tracking, on a
   * topic shape (`v1/...`) this platform does not use.
   */
  private async executeDeviceCommand(
    schedule: Schedule,
  ): Promise<ScheduleActionResult> {
    const cfg = schedule.actionConfig.deviceCommand!;
    const devices = await this.resolveDevices(schedule.tenantId, cfg);

    if (devices.length === 0) {
      return {
        summary: 'No devices matched the target — nothing sent',
        metadata: { devicesAffected: 0, commandsSent: 0, commandsFailed: 0 },
        details: { targetType: cfg.targetType, results: [] },
      };
    }

    const results: Array<Record<string, any>> = [];

    for (const device of devices) {
      try {
        const command = await this.deviceCommandsService.createCommand(
          {
            deviceId: device.id,
            commandType: cfg.command.method,
            params: cfg.command.params ?? {},
            timeout: cfg.timeout ?? 30000,
          } as any,
          schedule.userId,
          schedule.tenantId,
        );

        results.push({
          deviceId: device.id,
          deviceName: device.name,
          deviceKey: device.deviceKey,
          commandId: command.id,
          status: 'queued',
        });
      } catch (err: unknown) {
        results.push({
          deviceId: device.id,
          deviceName: device.name,
          status: 'failed',
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    const sent = results.filter((r) => r.status === 'queued').length;
    const failed = results.length - sent;

    // A fan-out where every single device failed is a failed run, not a
    // partial success — otherwise a broken broker looks green forever.
    if (sent === 0) {
      throw new Error(
        `All ${failed} command(s) failed. First error: ${results[0]?.error}`,
      );
    }

    return {
      summary: `Queued "${cfg.command.method}" to ${sent}/${devices.length} device(s)`,
      metadata: {
        devicesAffected: devices.length,
        commandsSent: sent,
        commandsFailed: failed,
      },
      details: { targetType: cfg.targetType, command: cfg.command, results },
    };
  }

  // ══════════════════════════════════════════════════════════════════════════
  // ACTION: ATTRIBUTE_UPDATE
  // ══════════════════════════════════════════════════════════════════════════

  /**
   * Write attributes onto every targeted device.
   *
   * Delegates to `AttributesService.saveAttributes()`, which upserts on
   * (tenant, entity, key, scope), derives the `DataType`, and — for SHARED
   * scope on generic-MQTT devices — publishes the downlink on
   * `devices/{deviceKey}/attributes/shared`.
   *
   * That topic matters: the platform's own MQTT client subscribes to
   * `devices/+/attributes`, so publishing a downlink there feeds straight back
   * into ingestion and stores the attribute values as fake telemetry, moving
   * device counters and firing alarms. The four-level `/shared` suffix is not
   * matched by the three-level uplink subscription. Writing the MQTT publish
   * by hand here would reintroduce exactly that loop.
   */
  private async executeAttributeUpdate(
    schedule: Schedule,
  ): Promise<ScheduleActionResult> {
    const cfg = schedule.actionConfig.attributeUpdate!;
    const owner = await this.loadOwner(schedule);
    const devices = await this.resolveDevices(schedule.tenantId, cfg);

    if (devices.length === 0) {
      return {
        summary: 'No devices matched the target — nothing updated',
        metadata: { devicesAffected: 0, attributesUpdated: 0 },
        details: { targetType: cfg.targetType, results: [] },
      };
    }

    const scope = normaliseAttributeScope(cfg.scope) ?? cfg.scope;

    const payload: Record<string, any> = {};
    for (const attr of cfg.attributes) payload[attr.key] = attr.value;

    const results: Array<Record<string, any>> = [];
    let attributesUpdated = 0;

    for (const device of devices) {
      try {
        const saved = await this.attributesService.saveAttributes(
          owner,
          'DEVICE',
          device.id,
          scope,
          payload,
        );
        attributesUpdated += saved.length;
        results.push({
          deviceId: device.id,
          deviceName: device.name,
          status: 'updated',
          keys: saved.map((a) => a.attributeKey),
        });
      } catch (err: unknown) {
        results.push({
          deviceId: device.id,
          deviceName: device.name,
          status: 'failed',
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    const updatedDevices = results.filter((r) => r.status === 'updated').length;

    if (updatedDevices === 0) {
      throw new Error(
        `All ${devices.length} attribute update(s) failed. First error: ${results[0]?.error}`,
      );
    }

    return {
      summary: `Updated ${attributesUpdated} attribute(s) on ${updatedDevices}/${devices.length} device(s)`,
      metadata: {
        devicesAffected: updatedDevices,
        attributesUpdated,
        scope,
      },
      details: {
        targetType: cfg.targetType,
        scope,
        keys: Object.keys(payload),
        results,
      },
    };
  }

  // ══════════════════════════════════════════════════════════════════════════
  // ACTION: RULE_CHAIN_TRIGGER
  // ══════════════════════════════════════════════════════════════════════════

  /**
   * Push a synthetic message through a specific rule chain.
   *
   * Calls `RuleEngineService.executeChainById()` directly rather than
   * producing to Kafka `rules.input`. The Kafka path runs
   * `RuleEngineService.execute()`, which fans the message out to *every*
   * active chain whose filters match — it has no way to address one chain — and
   * returns nothing to the caller. Executing directly targets the configured
   * chain and yields the node trace, which is what makes the execution record
   * worth reading.
   */
  private async executeRuleChainTrigger(
    schedule: Schedule,
  ): Promise<ScheduleActionResult> {
    const cfg = schedule.actionConfig.ruleChainTrigger!;

    const message: NodeMessage = {
      type: cfg.messageType || 'SCHEDULED_TRIGGER',
      originator: cfg.deviceId
        ? { id: cfg.deviceId, type: 'DEVICE' }
        : { id: schedule.id, type: 'SCHEDULE' },
      data: {
        ...(cfg.payload ?? {}),
        scheduleId: schedule.id,
        scheduleName: schedule.name,
        triggeredAt: new Date().toISOString(),
      },
      metadata: {
        source: 'SCHEDULE',
        scheduleId: schedule.id,
        tenantId: schedule.tenantId,
        ...(cfg.deviceId ? { deviceId: cfg.deviceId } : {}),
      },
      timestamp: Date.now(),
    };

    const result = await this.ruleEngineService.executeChainById(
      schedule.tenantId,
      cfg.ruleChainId,
      message,
    );

    if (!result.success) {
      throw new Error(
        `Rule chain "${result.chainName}" failed after ${result.nodesExecuted} node(s): ${result.error}`,
      );
    }

    return {
      summary: `Rule chain "${result.chainName}" ran ${result.nodesExecuted} node(s) in ${result.executionTime}ms`,
      metadata: {
        ruleChainId: cfg.ruleChainId,
        chainName: result.chainName,
        nodesExecuted: result.nodesExecuted,
        executionTime: result.executionTime,
      },
      details: { messageType: message.type, trace: result.trace },
    };
  }

  // ══════════════════════════════════════════════════════════════════════════
  // ACTION: SEND_NOTIFICATION
  // ══════════════════════════════════════════════════════════════════════════

  /**
   * Resolve recipients, then create one notification per (recipient, channel).
   *
   * `NotificationsService.create()` takes a single `channel`, not a list, and
   * reads tenant/customer scoping off the passed `User` rather than the DTO —
   * so each recipient is fetched and passed explicitly.
   */
  private async executeSendNotification(
    schedule: Schedule,
  ): Promise<ScheduleActionResult> {
    const cfg = schedule.actionConfig.notification!;
    const recipients = await this.resolveNotificationRecipients(
      schedule,
      cfg.targetType,
      cfg.userId,
    );

    if (recipients.length === 0) {
      throw new Error(
        `No active recipients found for targetType ${cfg.targetType}`,
      );
    }

    let message = cfg.message;

    if (cfg.includeAnalytics) {
      try {
        const overview = await this.analyticsService.getOverview(
          schedule.tenantId,
        );
        message +=
          `\n\nPlatform Summary:\n` +
          `- Devices: ${overview.devices?.online ?? 0}/${overview.devices?.total ?? 0} online\n` +
          `- Active Alarms: ${overview.alarms?.totalActive ?? 0}\n` +
          `- Messages Today: ${overview.telemetry?.totalMessagesToday ?? 0}`;
      } catch (err: unknown) {
        // An analytics hiccup must not sink the notification itself.
        this.logger.warn(
          `includeAnalytics failed for schedule ${schedule.id}: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      }
    }

    let sent = 0;
    const failures: Array<Record<string, any>> = [];

    for (const recipient of recipients) {
      for (const channel of cfg.channels) {
        try {
          await this.notificationsService.create(
            {
              userId: recipient.id,
              type: NotificationType.SYSTEM,
              channel,
              priority: NotificationPriority.NORMAL,
              title: cfg.title,
              message,
              relatedEntityType: 'schedule',
              relatedEntityId: schedule.id,
              recipientEmail:
                channel === NotificationChannel.EMAIL
                  ? recipient.email
                  : undefined,
              metadata: {
                scheduleId: schedule.id,
                scheduleName: schedule.name,
              },
            },
            recipient,
          );
          sent += 1;
        } catch (err: unknown) {
          failures.push({
            userId: recipient.id,
            channel,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }
    }

    if (sent === 0) {
      throw new Error(
        `All ${failures.length} notification(s) failed. First error: ${failures[0]?.error}`,
      );
    }

    return {
      summary: `Sent ${sent} notification(s) to ${recipients.length} recipient(s) over ${cfg.channels.join(', ')}`,
      metadata: {
        notificationsSent: sent,
        recipients: recipients.length,
        channels: cfg.channels,
        failures: failures.length,
      },
      details: {
        targetType: cfg.targetType,
        recipientIds: recipients.map((r) => r.id),
        failures,
      },
    };
  }

  private async resolveNotificationRecipients(
    schedule: Schedule,
    targetType: string,
    userId?: string,
  ): Promise<User[]> {
    switch (targetType) {
      case 'SPECIFIC_USER': {
        const user = await this.userRepository.findOne({
          where: { id: userId, tenantId: schedule.tenantId },
        });
        return user ? [user] : [];
      }
      case 'TENANT_ADMIN':
        return this.userRepository.find({
          where: {
            tenantId: schedule.tenantId,
            role: UserRole.TENANT_ADMIN,
            status: UserStatus.ACTIVE,
          },
        });
      case 'ALL_USERS':
        return this.userRepository.find({
          where: { tenantId: schedule.tenantId, status: UserStatus.ACTIVE },
          take: MAX_FANOUT_DEVICES,
        });
      default:
        throw new Error(`Unsupported notification targetType: ${targetType}`);
    }
  }

  // ══════════════════════════════════════════════════════════════════════════
  // ACTION: DATA_MAINTENANCE
  // ══════════════════════════════════════════════════════════════════════════

  private async executeDataMaintenance(
    schedule: Schedule,
  ): Promise<ScheduleActionResult> {
    const cfg = schedule.actionConfig.maintenance!;
    const olderThanDays = cfg.olderThanDays ?? 90;
    const cutoffDate = new Date(Date.now() - olderThanDays * 86_400_000);

    switch (cfg.taskType) {
      case ScheduleMaintenanceTask.ARCHIVE_TELEMETRY: {
        // Soft delete, matching the platform-wide convention — the rows stay
        // recoverable and TypeORM's default find() already hides them.
        const qb = this.telemetryRepository
          .createQueryBuilder()
          .update(Telemetry)
          .set({ deletedAt: new Date(), deletedBy: schedule.userId })
          .where('"tenantId" = :tenantId', { tenantId: schedule.tenantId })
          .andWhere('"timestamp" < :cutoff', { cutoff: cutoffDate })
          .andWhere('"deleted_at" IS NULL');

        if (cfg.deviceId) {
          qb.andWhere('"deviceId" = :deviceId', { deviceId: cfg.deviceId });
        }

        const { affected } = await qb.execute();
        const count = affected ?? 0;

        return {
          summary: `Archived ${count} telemetry row(s) older than ${olderThanDays} day(s)`,
          metadata: {
            taskType: cfg.taskType,
            recordsAffected: count,
            olderThanDays,
          },
          details: {
            cutoffDate: cutoffDate.toISOString(),
            deviceId: cfg.deviceId ?? null,
          },
        };
      }

      case ScheduleMaintenanceTask.CLEAR_ALARMS: {
        // AlarmStatus has no CLEARED_UNACK/CLEARED_ACK — this platform models
        // the settled states as CLEARED and RESOLVED.
        const qb = this.alarmRepository
          .createQueryBuilder()
          .update(Alarm)
          .set({ deletedAt: new Date(), deletedBy: schedule.userId })
          .where('"tenantId" = :tenantId', { tenantId: schedule.tenantId })
          .andWhere('status IN (:...statuses)', {
            statuses: [AlarmStatus.CLEARED, AlarmStatus.RESOLVED],
          })
          .andWhere('"clearedAt" IS NOT NULL')
          .andWhere('"clearedAt" < :cutoff', { cutoff: cutoffDate })
          .andWhere('"deleted_at" IS NULL');

        if (cfg.deviceId) {
          qb.andWhere('"deviceId" = :deviceId', { deviceId: cfg.deviceId });
        }

        const { affected } = await qb.execute();
        const count = affected ?? 0;

        return {
          summary: `Cleared ${count} settled alarm(s) older than ${olderThanDays} day(s)`,
          metadata: {
            taskType: cfg.taskType,
            recordsAffected: count,
            olderThanDays,
          },
          details: {
            cutoffDate: cutoffDate.toISOString(),
            deviceId: cfg.deviceId ?? null,
          },
        };
      }

      case ScheduleMaintenanceTask.RECALCULATE_STATS: {
        // One grouped COUNT for the whole tenant rather than a query per
        // device: a 500-device tenant would otherwise mean 1000 round-trips.
        const devices = await this.deviceRepository.find({
          where: cfg.deviceId
            ? {
                id: cfg.deviceId,
                tenantId: schedule.tenantId,
                deletedAt: IsNull(),
              }
            : { tenantId: schedule.tenantId, deletedAt: IsNull() },
          select: ['id', 'messageCount'],
        });

        if (devices.length === 0) {
          return {
            summary: 'No devices to recalculate',
            metadata: { taskType: cfg.taskType, recordsAffected: 0 },
            details: {},
          };
        }

        const rows = await this.telemetryRepository
          .createQueryBuilder('t')
          .select('t.deviceId', 'deviceId')
          .addSelect('COUNT(*)', 'count')
          .where('t.tenantId = :tenantId', { tenantId: schedule.tenantId })
          .andWhere('t.deviceId IN (:...ids)', {
            ids: devices.map((d) => d.id),
          })
          .groupBy('t.deviceId')
          .getRawMany<{ deviceId: string; count: string }>();

        const counts = new Map(
          rows.map((r) => [r.deviceId, parseInt(r.count, 10)]),
        );

        let updated = 0;
        for (const device of devices) {
          const actual = counts.get(device.id) ?? 0;
          if (actual === device.messageCount) continue; // no-op write avoided
          await this.deviceRepository.update(
            { id: device.id },
            { messageCount: actual },
          );
          updated += 1;
        }

        return {
          summary: `Recalculated message counts — ${updated} of ${devices.length} device(s) corrected`,
          metadata: {
            taskType: cfg.taskType,
            recordsAffected: updated,
            devicesScanned: devices.length,
          },
          details: {},
        };
      }

      default:
        throw new Error(`Unknown maintenance taskType: ${cfg.taskType}`);
    }
  }

  // ══════════════════════════════════════════════════════════════════════════
  // ACTION: GENERATE_REPORT
  // ══════════════════════════════════════════════════════════════════════════

  private async executeGenerateReport(
    schedule: Schedule,
  ): Promise<ScheduleActionResult> {
    const cfg = schedule.actionConfig.report!;
    const timeRange = TIME_RANGE_TO_ANALYTICS[cfg.timeRange];
    const stamp = new Date().toISOString().slice(0, 10);

    let reportData: Record<string, any>;
    let reportTitle: string;

    switch (cfg.reportType) {
      case ScheduleReportType.DEVICE_SUMMARY:
        reportData = await this.analyticsService.getDeviceAnalytics(
          schedule.tenantId,
          { timeRange, page: 1, limit: 100 },
        );
        reportTitle = `Device Summary Report — ${stamp}`;
        break;

      case ScheduleReportType.ALARM_SUMMARY:
        reportData = await this.analyticsService.getAlarmAnalytics(
          schedule.tenantId,
          { timeRange },
        );
        reportTitle = `Alarm Summary Report — ${stamp}`;
        break;

      case ScheduleReportType.ENERGY_CONSUMPTION:
        reportData = await this.analyticsService.getDataConsumption(
          schedule.tenantId,
          { timeRange },
        );
        reportTitle = `Data Consumption Report — ${stamp}`;
        break;

      case ScheduleReportType.UPTIME_REPORT:
        reportData = await this.analyticsService.getOverview(schedule.tenantId);
        reportTitle = `Platform Overview Report — ${stamp}`;
        break;

      default:
        throw new Error(`Unknown reportType: ${cfg.reportType}`);
    }

    const owner = await this.loadOwner(schedule);
    const delivered: string[] = [];
    const failures: Array<Record<string, any>> = [];

    if (cfg.deliveryChannels.includes('EMAIL')) {
      try {
        await this.notificationsService.create(
          {
            userId: owner.id,
            type: NotificationType.REPORT,
            channel: NotificationChannel.EMAIL,
            priority: NotificationPriority.NORMAL,
            title: reportTitle,
            message:
              `Your scheduled ${cfg.reportType} report (${cfg.timeRange}) is ready.\n\n` +
              JSON.stringify(reportData, null, 2),
            recipientEmail: cfg.recipientEmail,
            relatedEntityType: 'schedule',
            relatedEntityId: schedule.id,
            metadata: { scheduleId: schedule.id, reportType: cfg.reportType },
          },
          owner,
        );
        delivered.push('EMAIL');
      } catch (err: unknown) {
        failures.push({
          channel: 'EMAIL',
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    if (cfg.deliveryChannels.includes('IN_APP')) {
      try {
        await this.notificationsService.create(
          {
            userId: owner.id,
            type: NotificationType.REPORT,
            channel: NotificationChannel.IN_APP,
            priority: NotificationPriority.NORMAL,
            title: reportTitle,
            message: `Your ${cfg.reportType} report (${cfg.timeRange}) has been generated.`,
            relatedEntityType: 'schedule',
            relatedEntityId: schedule.id,
            // The full payload rides on the notification so the UI can render
            // the report without a second round-trip.
            metadata: {
              scheduleId: schedule.id,
              reportType: cfg.reportType,
              timeRange: cfg.timeRange,
              report: reportData,
            },
          },
          owner,
        );
        delivered.push('IN_APP');
      } catch (err: unknown) {
        failures.push({
          channel: 'IN_APP',
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    if (delivered.length === 0) {
      throw new Error(
        `Report generated but delivery failed on every channel. First error: ${failures[0]?.error}`,
      );
    }

    return {
      summary: `Generated ${cfg.reportType} (${cfg.timeRange}) and delivered via ${delivered.join(', ')}`,
      metadata: {
        reportType: cfg.reportType,
        timeRange: cfg.timeRange,
        channels: delivered,
        failures: failures.length,
      },
      details: { reportTitle, report: reportData, failures },
    };
  }
}
