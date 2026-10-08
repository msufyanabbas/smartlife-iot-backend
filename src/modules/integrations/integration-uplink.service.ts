import { Injectable, Logger, forwardRef, Inject } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import * as crypto from 'crypto';
import { Integration } from './entities/integration.entity';
import { Device } from '@modules/devices/entities/device.entity';
import { IntegrationStatus } from '@common/enums/index.enum';
import { DeviceListenerService } from '@modules/protocols/device-listener.service';
import { IntegrationDispatchService } from './integration-dispatch.service';
import { IntegrationEventType } from './entities/integration-event.entity';
import type { StandardTelemetry } from '@common/interfaces/standard-telemetry.interface';

export interface UplinkResult {
  success: boolean;
  message: string;
  deviceId?: string;
  deviceKey?: string;
}

/**
 * ─────────────────────────────────────────────────────────────────────────────
 * Generic inbound uplink: POST /integrations/http/:id
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * One endpoint any HTTP-push source can target — Loriot, Sigfox, a vendor
 * cloud, a gateway script. ThingsBoard calls this an HTTP integration; the
 * shape here is the same idea: the integration row carries the routing key and
 * tells us how to find the device in whatever body the source happens to send.
 *
 * This is NOT the same as `POST /api/v1/ingestion/:deviceKey` in
 * ProtocolsModule. That one is per-device and identifies the device from the
 * URL. This one is per-INTEGRATION: the URL names the integration, and the
 * device is dug out of the body using the integration's own field mapping, so
 * a source that cannot be told to put the device id in a path still works.
 *
 * AUTHENTICATION is the routing key, compared in constant time. It is required
 * — an unauthenticated route that writes telemetry against a named tenant is
 * not something to leave open, and unlike the LoRaWAN webhooks (whose secret is
 * optional for backwards compatibility) this endpoint is new, so it can be
 * strict from the start.
 */
@Injectable()
export class IntegrationUplinkService {
  private readonly logger = new Logger(IntegrationUplinkService.name);

  constructor(
    @InjectRepository(Integration)
    private readonly integrationRepository: Repository<Integration>,
    @InjectRepository(Device)
    private readonly deviceRepository: Repository<Device>,
    @Inject(forwardRef(() => DeviceListenerService))
    private readonly deviceListener: DeviceListenerService,
    private readonly dispatch: IntegrationDispatchService,
  ) {}

  /**
   * Always resolves — never throws and never reports a 4xx/5xx upwards.
   *
   * A push source that receives an error generally retries, and many disable
   * the destination after enough failures. Answering 200 with
   * `{success:false}` keeps a misconfigured mapping from silently detaching
   * the integration at the far end.
   */
  async handleUplink(
    integrationId: string,
    body: any,
    routingKey?: string,
  ): Promise<UplinkResult> {
    try {
      const integration = await this.integrationRepository.findOne({
        where: {
          id: integrationId,
          status: IntegrationStatus.ACTIVE,
          enabled: true,
        },
      });

      if (!integration) {
        // Deliberately vague: this route is public, and confirming which ids
        // exist would let anyone enumerate a tenant's integrations.
        this.logger.warn(`Uplink for unknown or inactive integration ${integrationId}`);
        return { success: false, message: 'Integration not available' };
      }

      const config = (integration.configuration ?? {}) as Record<string, any>;

      if (!this.verifyRoutingKey(config.routingKey, routingKey)) {
        this.logger.warn(`Uplink rejected for ${integration.name}: bad routing key`);
        await this.dispatch.recordInbound({
          integrationId: integration.id,
          tenantId: integration.tenantId,
          success: false,
          message: 'Rejected: invalid routing key',
          eventType: IntegrationEventType.ERROR,
        });
        return { success: false, message: 'Integration not available' };
      }

      const deviceKey = this.extractDeviceKey(config, body);
      if (!deviceKey) {
        const field = config.deviceKeyField || 'deviceKey';
        const message = `No device key found — expected it in the "${field}" property`;
        await this.dispatch.recordInbound({
          integrationId: integration.id,
          tenantId: integration.tenantId,
          success: false,
          message,
          payload: this.asRecord(body),
        });
        return { success: false, message };
      }

      const device = await this.deviceRepository.findOne({
        where: { deviceKey, tenantId: integration.tenantId },
      });

      if (!device) {
        // Deliberately NOT auto-provisioning. The LoRaWAN path does, because a
        // devEUI is a globally unique hardware identity; an arbitrary HTTP
        // source can send any string, and creating a device per unrecognised
        // value would let a misconfigured sender fill the tenant with junk and
        // consume its device quota.
        const message = `Unknown device "${deviceKey}" for this tenant — register it first`;
        await this.dispatch.recordInbound({
          integrationId: integration.id,
          tenantId: integration.tenantId,
          success: false,
          message,
          deviceKey,
          payload: this.asRecord(body),
        });
        return { success: false, message };
      }

      const data = this.extractData(config, body);

      const telemetry: StandardTelemetry = {
        deviceId: device.id,
        deviceKey: device.deviceKey,
        tenantId: integration.tenantId,
        customerId: device.customerId,
        data,
        timestamp: this.extractTimestamp(body),
        receivedAt: Date.now(),
        protocol: 'http',
        metadata: {
          endpoint: `/integrations/http/${integration.id}`,
          integrationId: integration.id,
        } as StandardTelemetry['metadata'],
      };

      // The shared entry point, so an uplink arriving here gets the same codec
      // decode, Kafka publish, alarm evaluation and WebSocket broadcast as one
      // arriving over MQTT. Reimplementing persistence here is how the Tuya
      // path ended up bypassing alarms entirely.
      await this.deviceListener.handleTelemetry(telemetry);

      await this.dispatch.recordInbound({
        integrationId: integration.id,
        tenantId: integration.tenantId,
        success: true,
        deviceId: device.id,
        deviceKey: device.deviceKey,
      });

      return {
        success: true,
        message: 'Uplink ingested',
        deviceId: device.id,
        deviceKey: device.deviceKey,
      };
    } catch (error: any) {
      this.logger.error(`Uplink handling failed: ${error.message}`);
      return { success: false, message: 'Internal error processing uplink' };
    }
  }

  /**
   * Constant-time comparison.
   *
   * `timingSafeEqual` throws on a length mismatch, so lengths are checked
   * first — and that check is itself a (tiny) leak of the key's length, which
   * is accepted: the alternative is hashing both sides, and a routing key is
   * not a password.
   */
  private verifyRoutingKey(expected?: string, provided?: string): boolean {
    if (!expected) {
      // No key configured means the integration was saved before the field
      // became required. Refuse rather than silently accepting anything.
      return false;
    }
    if (!provided) return false;

    const a = Buffer.from(expected);
    const b = Buffer.from(provided);
    if (a.length !== b.length) return false;
    return crypto.timingSafeEqual(a, b);
  }

  /**
   * Find the device key in an arbitrary body.
   *
   * The configured field wins; the fallbacks cover the names the common
   * sources use, so a Sigfox or Loriot push works before anyone configures
   * anything.
   */
  private extractDeviceKey(config: any, body: any): string | null {
    if (!body || typeof body !== 'object') return null;

    const candidates = [
      config.deviceKeyField,
      'deviceKey',
      'deviceId',
      'device',
      'EUI',
      'eui',
      'devEUI',
      'devEui',
      'dev_eui',
      'serial',
    ].filter(Boolean) as string[];

    for (const field of candidates) {
      const value = this.readPath(body, field);
      if (typeof value === 'string' && value.trim()) return value.trim();
      if (typeof value === 'number') return String(value);
    }
    return null;
  }

  /** Supports dotted paths so a nested body needs no reshaping at the source. */
  private readPath(body: any, path: string): unknown {
    if (!path.includes('.')) return body?.[path];
    return path
      .split('.')
      .reduce<any>((node, part) => (node == null ? undefined : node[part]), body);
  }

  private extractData(config: any, body: any): Record<string, any> {
    const field = config.dataField;
    if (!field) return this.asRecord(body) ?? {};

    const extracted = this.readPath(body, field);
    if (extracted && typeof extracted === 'object') {
      return extracted as Record<string, any>;
    }
    if (extracted !== undefined && extracted !== null) {
      // A scalar — usually a hex or base64 frame. Named `rawPayload` so the
      // codec registry picks it up the same way it does for LoRaWAN.
      return { rawPayload: extracted };
    }
    return this.asRecord(body) ?? {};
  }

  private extractTimestamp(body: any): Date {
    const raw =
      body?.timestamp ?? body?.time ?? body?.ts ?? body?.received_at ?? null;
    if (!raw) return new Date();

    // Epoch seconds vs milliseconds: anything below ~2001 in ms is almost
    // certainly seconds.
    if (typeof raw === 'number') {
      return new Date(raw < 1e11 ? raw * 1000 : raw);
    }
    const parsed = new Date(raw);
    return Number.isNaN(parsed.getTime()) ? new Date() : parsed;
  }

  private asRecord(body: any): Record<string, unknown> | null {
    return body && typeof body === 'object' && !Array.isArray(body)
      ? (body as Record<string, unknown>)
      : null;
  }
}
