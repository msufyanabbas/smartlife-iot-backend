import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { LessThan, Repository } from 'typeorm';
import { Cron, CronExpression } from '@nestjs/schedule';
import {
  IntegrationEvent,
  IntegrationEventDirection,
  IntegrationEventType,
} from './entities/integration-event.entity';
import { PaginatedResponseDto } from '@common/dto/pagination.dto';

export interface RecordEventInput {
  integrationId: string;
  tenantId: string;
  direction: IntegrationEventDirection;
  eventType: IntegrationEventType;
  success?: boolean;
  message?: string | null;
  deviceId?: string | null;
  deviceKey?: string | null;
  statusCode?: number | null;
  durationMs?: number | null;
  payload?: Record<string, unknown> | null;
}

/**
 * Writes and reads the integration event feed.
 *
 * Two deliberate constraints, both because this is on the telemetry hot path:
 *
 *  1. `record()` NEVER throws and never awaits the caller. An event-log write
 *     failing must not fail the dispatch it describes, let alone the telemetry
 *     ingest behind it.
 *  2. Payloads are truncated. A row is written per message per integration, so
 *     storing the full body would duplicate the telemetry table at a worse
 *     write rate and for less value — the point of the feed is "what happened
 *     and did it work", with enough of the payload to recognise it.
 */
@Injectable()
export class IntegrationEventsService {
  private readonly logger = new Logger(IntegrationEventsService.name);

  /** Characters of serialised payload kept per event. */
  private static readonly PAYLOAD_LIMIT = 2000;

  private readonly retentionDays: number;

  constructor(
    @InjectRepository(IntegrationEvent)
    private readonly eventRepository: Repository<IntegrationEvent>,
    private readonly configService: ConfigService,
  ) {
    const configured = Number(
      this.configService.get('INTEGRATION_EVENT_RETENTION_DAYS'),
    );
    this.retentionDays =
      Number.isFinite(configured) && configured > 0 ? configured : 14;
  }

  /**
   * Fire-and-forget. Returns void immediately; the insert happens detached.
   *
   * Callers on the dispatch path must not pay a database round trip to log
   * that they completed one.
   */
  record(input: RecordEventInput): void {
    void this.recordAsync(input);
  }

  /** Awaitable form, for the handful of callers that genuinely need ordering. */
  async recordAsync(input: RecordEventInput): Promise<void> {
    try {
      await this.eventRepository.insert({
        integrationId: input.integrationId,
        tenantId: input.tenantId,
        direction: input.direction,
        eventType: input.eventType,
        success: input.success ?? true,
        message: input.message ? input.message.slice(0, 1000) : null,
        deviceId: input.deviceId ?? null,
        deviceKey: input.deviceKey ?? null,
        statusCode: input.statusCode ?? null,
        durationMs: input.durationMs ?? null,
        // Cast because TypeORM's QueryDeepPartialEntity treats an index-signature
        // object as possibly a raw SQL expression (`() => string`) and refuses
        // the assignment. The value is a plain jsonb document.
        payload: this.truncatePayload(input.payload) as any,
      });
    } catch (error: any) {
      // Logged, never rethrown — see the class note.
      this.logger.warn(`Could not record integration event: ${error.message}`);
    }
  }

  private truncatePayload(
    payload: Record<string, unknown> | null | undefined,
  ): Record<string, unknown> | null {
    if (!payload) return null;
    try {
      const serialised = JSON.stringify(payload);
      if (serialised.length <= IntegrationEventsService.PAYLOAD_LIMIT) {
        return payload;
      }
      // Kept as a string rather than a deep-pruned object: an operator reading
      // this wants to recognise the message, and a half-pruned object looks
      // like the real thing while being subtly wrong.
      return {
        truncated: true,
        originalLength: serialised.length,
        preview: serialised.slice(0, IntegrationEventsService.PAYLOAD_LIMIT),
      };
    } catch {
      return { unserialisable: true };
    }
  }

  async findForIntegration(
    integrationId: string,
    tenantId: string,
    options: { page?: number; limit?: number; direction?: string; success?: boolean } = {},
  ) {
    const page = Math.max(1, Number(options.page) || 1);
    const limit = Math.min(100, Math.max(1, Number(options.limit) || 25));

    const query = this.eventRepository
      .createQueryBuilder('event')
      .where('event.integrationId = :integrationId', { integrationId })
      .andWhere('event.tenantId = :tenantId', { tenantId });

    if (options.direction) {
      query.andWhere('event.direction = :direction', {
        direction: options.direction,
      });
    }
    if (options.success !== undefined) {
      query.andWhere('event.success = :success', { success: options.success });
    }

    query
      .orderBy('event.created_at', 'DESC')
      // Secondary key so paging is stable: many events share a millisecond on
      // a busy integration, and Postgres gives no order among equal keys.
      .addOrderBy('event.id', 'DESC')
      .skip((page - 1) * limit)
      .take(limit);

    const [data, total] = await query.getManyAndCount();
    return PaginatedResponseDto.create(data, page, limit, total);
  }

  /**
   * The tenant-wide feed, with the integration name joined in so the UI can
   * label each row without a second request per integration.
   */
  async findForTenant(
    tenantId: string,
    options: { page?: number; limit?: number; direction?: string; success?: boolean } = {},
  ) {
    const page = Math.max(1, Number(options.page) || 1);
    const limit = Math.min(100, Math.max(1, Number(options.limit) || 25));

    const query = this.eventRepository
      .createQueryBuilder('event')
      .leftJoin('event.integration', 'integration')
      .addSelect(['integration.id', 'integration.name', 'integration.type'])
      .where('event.tenantId = :tenantId', { tenantId });

    if (options.direction) {
      query.andWhere('event.direction = :direction', {
        direction: options.direction,
      });
    }
    if (options.success !== undefined) {
      query.andWhere('event.success = :success', { success: options.success });
    }

    query
      .orderBy('event.created_at', 'DESC')
      .addOrderBy('event.id', 'DESC')
      .skip((page - 1) * limit)
      .take(limit);

    const [data, total] = await query.getManyAndCount();
    return PaginatedResponseDto.create(data, page, limit, total);
  }

  /** Counts over a window, for the detail page's health summary. */
  async summarise(integrationId: string, tenantId: string, hours = 24) {
    const since = new Date(Date.now() - hours * 60 * 60 * 1000);

    const rows: Array<{ direction: string; success: boolean; count: string }> =
      await this.eventRepository
        .createQueryBuilder('event')
        .select('event.direction', 'direction')
        .addSelect('event.success', 'success')
        .addSelect('COUNT(*)', 'count')
        .where('event.integrationId = :integrationId', { integrationId })
        .andWhere('event.tenantId = :tenantId', { tenantId })
        .andWhere('event.created_at >= :since', { since })
        .groupBy('event.direction')
        .addGroupBy('event.success')
        .getRawMany();

    const summary = {
      windowHours: hours,
      inboundSuccess: 0,
      inboundFailed: 0,
      outboundSuccess: 0,
      outboundFailed: 0,
    };

    for (const row of rows) {
      const count = Number(row.count) || 0;
      if (row.direction === IntegrationEventDirection.INBOUND) {
        if (row.success) summary.inboundSuccess += count;
        else summary.inboundFailed += count;
      } else if (row.direction === IntegrationEventDirection.OUTBOUND) {
        if (row.success) summary.outboundSuccess += count;
        else summary.outboundFailed += count;
      }
    }

    return summary;
  }

  /**
   * Retention sweep.
   *
   * Without it this table grows without bound at telemetry rate — on a tenant
   * with one webhook and 100 devices reporting each minute that is ~144k rows
   * a day.
   */
  @Cron(CronExpression.EVERY_DAY_AT_3AM)
  async prune(): Promise<void> {
    const cutoff = new Date(
      Date.now() - this.retentionDays * 24 * 60 * 60 * 1000,
    );
    try {
      const result = await this.eventRepository.delete({
        createdAt: LessThan(cutoff),
      });
      if (result.affected) {
        this.logger.log(
          `Pruned ${result.affected} integration event(s) older than ${this.retentionDays} day(s)`,
        );
      }
    } catch (error: any) {
      this.logger.warn(`Integration event prune failed: ${error.message}`);
    }
  }
}
