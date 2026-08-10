// src/modules/integrations/integration-dispatch.service.ts
import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Device } from '@modules/index.entities';
import { Integration } from './entities/integration.entity';
import { IntegrationStatus, IntegrationType } from '@common/enums/index.enum';
import { WebhookAdapter } from './adapters/webhook.adapter';
import { MqttAdapter } from './adapters/mqtt.adapter';
import { TuyaAdapter } from './adapters/tuya.adapter';
import { AwsIotAdapter } from './adapters/aws-iot.adapter';
import { HttpAdapter } from './adapters/http.adapter';
import type {
  ConnectionResult,
  DispatchResult,
  IIntegrationAdapter,
} from './adapters/adapter.interface';

export interface TelemetryPayload {
  deviceId: string;
  deviceKey?: string;
  tenantId: string;
  deviceType?: string;
  assetId?: string;
  data: Record<string, any>;
  timestamp: Date;
}

/**
 * The runtime half of the integrations module: takes a telemetry event and
 * fans it out to every active integration in the tenant whose filter matches.
 *
 * Contract with the telemetry pipeline: **this never throws and never
 * rethrows**. A broken third-party endpoint must not turn a successfully
 * ingested reading into a failed Kafka message.
 */
@Injectable()
export class IntegrationDispatchService {
  private readonly logger = new Logger(IntegrationDispatchService.name);

  // Adapters are stateless, so one instance each is enough. They are plain
  // classes rather than providers — nothing about them needs DI.
  private readonly adapters: Partial<Record<IntegrationType, IIntegrationAdapter>> = {
    [IntegrationType.WEBHOOK]: new WebhookAdapter(),
    [IntegrationType.MQTT]: new MqttAdapter(),
    [IntegrationType.TUYA]: new TuyaAdapter(),
    [IntegrationType.AWS_IOT]: new AwsIotAdapter(),
    [IntegrationType.API]: new HttpAdapter(),
  };

  constructor(
    @InjectRepository(Integration)
    private readonly integrationRepository: Repository<Integration>,
    // Read-only: resolves deviceType/assetId when a filter needs them.
    @InjectRepository(Device)
    private readonly deviceRepository: Repository<Device>,
  ) {}

  /**
   * Pick the adapter for an integration.
   *
   * CLOUD predates the explicit TUYA/AWS_IOT members and is still the type on
   * existing rows, so it is routed by looking at the configuration rather than
   * being dropped. Anything else (NOTIFICATION, DATABASE, bare CLOUD) has no
   * adapter and is skipped with a warning.
   */
  private resolveAdapter(integration: Integration): IIntegrationAdapter | null {
    const direct = this.adapters[integration.type];
    if (direct) return direct;

    if (integration.type === IntegrationType.CLOUD) {
      const config: any = integration.configuration ?? {};
      if (config.accessKeyId || config.endpoint) {
        return this.adapters[IntegrationType.AWS_IOT] ?? null;
      }
      if (config.clientId && config.clientSecret) {
        return this.adapters[IntegrationType.TUYA] ?? null;
      }
    }

    return null;
  }

  // ══════════════════════════════════════════════════════════════════════════
  // DISPATCH
  // ══════════════════════════════════════════════════════════════════════════

  async dispatchTelemetry(payload: TelemetryPayload): Promise<void> {
    try {
      const integrations = await this.integrationRepository.find({
        where: {
          tenantId: payload.tenantId,
          status: IntegrationStatus.ACTIVE,
          enabled: true,
        },
      });

      if (integrations.length === 0) return;

      // deviceType/assetId live on the Device, not on the telemetry envelope.
      // Load it once, and only when some integration actually filters on it.
      const enriched = (await this.needsDeviceLookup(integrations, payload))
        ? await this.enrichFromDevice(payload)
        : payload;

      const matched = integrations.filter((i) =>
        this.deviceMatchesFilter(i, enriched),
      );
      if (matched.length === 0) return;

      // allSettled: one slow or failing endpoint must not stop the others.
      await Promise.allSettled(
        matched.map((i) => this.dispatchToIntegration(i, enriched)),
      );
    } catch (err: any) {
      // Deliberate catch-all — see the class doc.
      this.logger.error(`Integration dispatch failed: ${err.message}`);
    }
  }

  private needsDeviceLookup(
    integrations: Integration[],
    payload: TelemetryPayload,
  ): boolean {
    const missing =
      payload.deviceType === undefined || payload.assetId === undefined;
    return (
      missing &&
      integrations.some(
        (i) => i.deviceFilter?.deviceType || i.deviceFilter?.assetId,
      )
    );
  }

  private async enrichFromDevice(
    payload: TelemetryPayload,
  ): Promise<TelemetryPayload> {
    try {
      const device = await this.deviceRepository.findOne({
        where: { id: payload.deviceId },
        select: ['id', 'type', 'assetId', 'deviceKey'],
      });
      if (!device) return payload;

      return {
        ...payload,
        deviceType: payload.deviceType ?? device.type,
        assetId: payload.assetId ?? device.assetId,
        deviceKey: payload.deviceKey ?? device.deviceKey,
      };
    } catch {
      // A failed enrichment only means type/asset filters cannot match.
      return payload;
    }
  }

  /** Fields are ANDed. No filter (or an empty object) matches every device. */
  private deviceMatchesFilter(
    integration: Integration,
    payload: TelemetryPayload,
  ): boolean {
    const filter = integration.deviceFilter;
    if (!filter) return true;

    if (filter.deviceId && filter.deviceId !== payload.deviceId) return false;
    if (filter.deviceType && filter.deviceType !== payload.deviceType) return false;
    if (filter.assetId && filter.assetId !== payload.assetId) return false;

    return true;
  }

  private async dispatchToIntegration(
    integration: Integration,
    payload: TelemetryPayload,
  ): Promise<void> {
    const startedAt = Date.now();

    const adapter = this.resolveAdapter(integration);
    if (!adapter) {
      this.logger.warn(
        `No adapter for integration type '${integration.type}' (${integration.name}) — skipped`,
      );
      return;
    }

    // Rate limiting uses the entity's own window logic. Both the check and the
    // increment mutate `rateLimiting`, so the column is persisted either way.
    if (integration.isRateLimited()) {
      this.logger.warn(
        `Integration ${integration.name} is rate limited — dropping message`,
      );
      return;
    }
    integration.incrementRateLimit();

    let result: DispatchResult;
    try {
      result = await adapter.dispatch(
        integration.configuration ?? {},
        this.buildPayload(integration, payload),
      );
    } catch (err: any) {
      // Adapters are contracted not to throw; this is belt-and-braces.
      result = { success: false, error: err.message };
    }

    const duration = Date.now() - startedAt;
    await this.recordOutcome(integration, result, duration);

    if (result.success) {
      this.logger.debug(
        `Integration ${integration.name} dispatch ok (${duration}ms)`,
      );
    } else {
      this.logger.warn(
        `Integration ${integration.name} dispatch failed after ${duration}ms: ${result.error}`,
      );
    }
  }

  /**
   * Shape the outbound body.
   *
   * dataFilter is applied here, before the payload leaves the platform, so an
   * integration never receives telemetry keys it was not granted.
   */
  private buildPayload(
    integration: Integration,
    payload: TelemetryPayload,
  ): any {
    const config: any = integration.configuration ?? {};
    const data = this.applyDataFilter(integration, payload.data);
    const timestamp = payload.timestamp.toISOString();

    if (config.payloadTemplate) {
      try {
        const rendered = JSON.stringify(config.payloadTemplate)
          .replace(/\{\{\s*deviceId\s*\}\}/g, payload.deviceId)
          .replace(/\{\{\s*deviceKey\s*\}\}/g, payload.deviceKey ?? '')
          .replace(/\{\{\s*tenantId\s*\}\}/g, payload.tenantId)
          .replace(/\{\{\s*timestamp\s*\}\}/g, timestamp);
        return JSON.parse(rendered);
      } catch (err: any) {
        // Fall through to the default shape rather than dropping the message.
        this.logger.warn(
          `Integration ${integration.name} has an invalid payloadTemplate (${err.message}) — using default payload`,
        );
      }
    }

    return {
      deviceId: payload.deviceId,
      deviceKey: payload.deviceKey,
      tenantId: payload.tenantId,
      timestamp,
      data,
      source: 'SmartLife IoT Platform',
    };
  }

  private applyDataFilter(
    integration: Integration,
    data: Record<string, any>,
  ): Record<string, any> {
    const keys = integration.dataFilter?.keys;
    if (!keys || keys.length === 0) return data ?? {};

    const filtered: Record<string, any> = {};
    for (const key of keys) {
      if (data && key in data) filtered[key] = data[key];
    }
    return filtered;
  }

  /**
   * Persist the outcome through the entity's own bookkeeping methods
   * (recordSuccess/recordFailure), which own the counter, error-history and
   * auto-disable-after-10-failures rules.
   *
   * Only the stats columns are written, so a concurrent config edit is not
   * clobbered by a dispatch. Counters are read-modify-write rather than atomic
   * SQL increments, so under heavy concurrency a count can be lost — acceptable
   * for statistics, and it keeps the auto-disable logic in one place.
   */
  private async recordOutcome(
    integration: Integration,
    result: DispatchResult,
    duration: number,
  ): Promise<void> {
    try {
      if (result.success) {
        integration.recordSuccess();
      } else {
        integration.recordFailure(
          result.error ?? 'unknown error',
          result.statusCode,
        );
      }

      integration.additionalInfo = {
        ...(integration.additionalInfo ?? {}),
        lastLatencyMs: duration,
      };

      await this.integrationRepository.update(
        { id: integration.id },
        {
          messagesProcessed: integration.messagesProcessed,
          messagesSucceeded: integration.messagesSucceeded,
          messagesFailed: integration.messagesFailed,
          consecutiveFailures: integration.consecutiveFailures,
          lastActivity: integration.lastActivity,
          lastSuccess: integration.lastSuccess,
          lastFailure: integration.lastFailure,
          lastError: integration.lastError ?? null,
          errorHistory: integration.errorHistory,
          status: integration.status,
          enabled: integration.enabled,
          rateLimiting: integration.rateLimiting,
          additionalInfo: integration.additionalInfo,
        },
      );
    } catch (err: any) {
      // Stats bookkeeping must never break dispatch.
      this.logger.warn(
        `Failed to record outcome for integration ${integration.id}: ${err.message}`,
      );
    }
  }

  // ══════════════════════════════════════════════════════════════════════════
  // CONNECTION TEST
  // ══════════════════════════════════════════════════════════════════════════

  /**
   * Probe an integration through the same adapter dispatch uses.
   *
   * Scoped by userId to match the rest of IntegrationsService — the CRUD
   * surface is per-owner, not per-tenant.
   */
  async testConnection(
    integrationId: string,
    userId: string,
  ): Promise<ConnectionResult & { latencyMs: number }> {
    const integration = await this.integrationRepository.findOne({
      where: { id: integrationId, userId },
    });

    if (!integration) throw new NotFoundException('Integration not found');

    const adapter = this.resolveAdapter(integration);
    if (!adapter) {
      return {
        connected: false,
        message: `Connection test not implemented for type '${integration.type}'`,
        latencyMs: 0,
      };
    }

    const startedAt = Date.now();
    let result: ConnectionResult;
    try {
      result = await adapter.testConnection(integration.configuration ?? {});
    } catch (err: any) {
      result = { connected: false, message: err.message };
    }
    const latencyMs = Date.now() - startedAt;

    // A probe is real traffic, so it updates lastActivity — but deliberately
    // NOT the success/failure counters, which count telemetry dispatches.
    try {
      await this.integrationRepository.update(
        { id: integrationId },
        { lastActivity: new Date() },
      );
    } catch {
      /* non-fatal */
    }

    return { ...result, latencyMs };
  }
}
