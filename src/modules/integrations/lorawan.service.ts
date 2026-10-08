import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import * as crypto from 'crypto';
import { Integration } from './entities/integration.entity';
import {
  Device,
  DeviceProtocol,
} from '@modules/devices/entities/device.entity';
import {
  DeviceConnectionType,
  DeviceStatus,
  DeviceType,
  IntegrationStatus,
  IntegrationType,
} from '@common/enums/index.enum';
import { StandardTelemetry } from '@common/interfaces/standard-telemetry.interface';
import { DeviceListenerService } from '@modules/protocols/device-listener.service';

/**
 * Result returned to the network server. Both webhooks always answer HTTP 200
 * with this body — never a 4xx/5xx — because ChirpStack and The Things Stack
 * both disable an HTTP integration that keeps failing. Callers inspect
 * `success` instead. Same convention as the Tuya webhook.
 */
export interface LorawanWebhookResult {
  success: boolean;
  message: string;
  deviceId?: string;
  devEUI?: string;
  created?: boolean;
}

/** Transport-neutral uplink, produced by both the ChirpStack and TTN parsers. */
interface NormalisedUplink {
  devEUI: string;
  deviceName?: string;
  applicationId?: string;
  /** Already-decoded telemetry from the network server's own codec. */
  decoded?: Record<string, any>;
  /** Raw base64 frame, used only when the network server sent no decoded payload. */
  rawBase64?: string;
  rssi?: number;
  snr?: number;
  frequency?: number;
  dataRate?: number;
  frameCounter?: number;
  port?: number;
  timestamp: Date;
}

/**
 * Inbound LoRaWAN uplink webhooks (ChirpStack and The Things Stack v3).
 *
 * Both routes are @Public — the network server calls them directly and cannot
 * present a JWT — so the whole problem this service solves is working out
 * *whose* uplink just arrived, then handing it to the normal ingestion
 * pipeline.
 *
 * ── Tenant resolution ─────────────────────────────────────────────────────
 * Tried in order; the first that yields exactly one ACTIVE integration wins:
 *
 *   1. `X-Tenant-Id` header — explicit, and still validated: the tenant must
 *      own an active integration of the matching network type. The header on
 *      its own is NOT trusted as authorisation.
 *   2. `applicationId` query param, matched against
 *      `configuration.applicationId`.
 *   3. The application id carried in the uplink body itself
 *      (`applicationName`/`applicationID` for ChirpStack,
 *      `end_device_ids.application_ids.application_id` for TTN).
 *   4. If the platform holds exactly ONE active integration of that network
 *      type across all tenants, it is used. More than one is ambiguous and is
 *      rejected rather than guessed — guessing would put one tenant's devices
 *      in another tenant.
 *
 * ── Security caveat ───────────────────────────────────────────────────────
 * These endpoints are unauthenticated, so anyone who learns a tenant id or
 * application id can post telemetry for that tenant's devices. Set
 * `configuration.webhookSecret` on the integration to additionally require a
 * matching `x-webhook-secret` header; that is the only thing here that
 * constitutes real authentication.
 */
@Injectable()
export class LorawanService {
  private readonly logger = new Logger(LorawanService.name);

  constructor(
    @InjectRepository(Integration)
    private readonly integrationRepository: Repository<Integration>,
    @InjectRepository(Device)
    private readonly deviceRepository: Repository<Device>,
    private readonly deviceListener: DeviceListenerService,
  ) {}

  // ══════════════════════════════════════════════════════════════════════════
  // PUBLIC ENTRY POINTS
  // ══════════════════════════════════════════════════════════════════════════

  async handleChirpStackWebhook(
    body: any,
    applicationId?: string,
    tenantId?: string,
    webhookSecret?: string,
  ): Promise<LorawanWebhookResult> {
    return this.handle(
      IntegrationType.CHIRPSTACK,
      DeviceProtocol.LORAWAN_CHIRPSTACK,
      () => this.parseChirpStack(body),
      { applicationId, tenantId, webhookSecret },
    );
  }

  async handleTtnWebhook(
    body: any,
    applicationId?: string,
    tenantId?: string,
    webhookSecret?: string,
  ): Promise<LorawanWebhookResult> {
    return this.handle(
      IntegrationType.TTN,
      DeviceProtocol.LORAWAN_TTN,
      () => this.parseTtn(body),
      { applicationId, tenantId, webhookSecret },
    );
  }

  // ══════════════════════════════════════════════════════════════════════════
  // SHARED PIPELINE
  // ══════════════════════════════════════════════════════════════════════════

  /**
   * Constant-time secret comparison.
   *
   * `!==` on a webhook secret leaks it a character at a time: the comparison
   * returns as soon as two bytes differ, so an attacker who can measure the
   * response time can recover the secret in linear rather than exponential
   * attempts. These routes are public and unauthenticated apart from this
   * check, which makes them exactly the case where it matters.
   *
   * `timingSafeEqual` throws on a length mismatch, so lengths are compared
   * first. That reveals the secret's length, which is accepted — a length is
   * not usefully guessable material.
   */
  private secretMatches(expected: string, provided?: string): boolean {
    if (!provided) return false;
    const a = Buffer.from(String(expected));
    const b = Buffer.from(provided);
    if (a.length !== b.length) return false;
    return crypto.timingSafeEqual(a, b);
  }

  private async handle(
    networkType: IntegrationType,
    deviceProtocol: DeviceProtocol,
    parse: () => NormalisedUplink | null,
    ctx: { applicationId?: string; tenantId?: string; webhookSecret?: string },
  ): Promise<LorawanWebhookResult> {
    try {
      const uplink = parse();
      if (!uplink) {
        return { success: false, message: 'Malformed uplink: no DevEUI found' };
      }

      const integration = await this.resolveIntegration(
        networkType,
        ctx.applicationId ?? uplink.applicationId,
        ctx.tenantId,
      );

      if (!integration) {
        this.logger.warn(
          `No ${networkType} integration resolved for uplink from ${uplink.devEUI} ` +
            `(tenantId=${ctx.tenantId ?? '-'}, applicationId=${ctx.applicationId ?? uplink.applicationId ?? '-'})`,
        );
        return {
          success: false,
          message:
            'No active integration matched this uplink. Send X-Tenant-Id, or an ' +
            'applicationId matching the integration configuration.',
          devEUI: uplink.devEUI,
        };
      }

      const expectedSecret = (integration.configuration as any)?.webhookSecret;
      if (expectedSecret && !this.secretMatches(expectedSecret, ctx.webhookSecret)) {
        this.logger.warn(
          `Rejected ${networkType} uplink for tenant ${integration.tenantId}: bad webhook secret`,
        );
        return { success: false, message: 'Invalid webhook secret' };
      }

      const { device, created } = await this.findOrCreateDevice(
        integration,
        uplink,
        deviceProtocol,
      );

      await this.deviceListener.handleTelemetry(
        this.toStandardTelemetry(device, uplink),
      );

      return {
        success: true,
        message: created
          ? 'Device created and uplink ingested'
          : 'Uplink ingested',
        deviceId: device.id,
        devEUI: uplink.devEUI,
        created,
      };
    } catch (error) {
      // Never throw: a 500 makes the network server retry and eventually
      // disable the integration.
      this.logger.error(
        `${networkType} webhook failed: ${(error as Error).message}`,
      );
      return { success: false, message: 'Internal error processing uplink' };
    }
  }

  // ══════════════════════════════════════════════════════════════════════════
  // TENANT RESOLUTION
  // ══════════════════════════════════════════════════════════════════════════

  private async resolveIntegration(
    networkType: IntegrationType,
    applicationId?: string,
    tenantId?: string,
  ): Promise<Integration | null> {
    // Only ACTIVE + enabled rows are eligible; a disabled integration should
    // stop accepting uplinks, not silently keep ingesting.
    const candidates = await this.integrationRepository.find({
      where: {
        type: networkType,
        status: IntegrationStatus.ACTIVE,
        enabled: true,
        ...(tenantId ? { tenantId } : {}),
      },
    });

    if (candidates.length === 0) return null;
    if (candidates.length === 1 && !applicationId) return candidates[0];

    if (applicationId) {
      const matched = candidates.filter(
        (i) => (i.configuration as any)?.applicationId === applicationId,
      );
      if (matched.length === 1) return matched[0];
      if (matched.length > 1) {
        this.logger.warn(
          `Ambiguous ${networkType} uplink: ${matched.length} integrations share applicationId ${applicationId}`,
        );
        return null;
      }
      // applicationId given but matched nothing — fall through to the
      // single-candidate rule below rather than failing outright, so an
      // integration configured without an applicationId still works.
    }

    if (candidates.length === 1) return candidates[0];

    this.logger.warn(
      `Ambiguous ${networkType} uplink: ${candidates.length} active integrations and ` +
        'no X-Tenant-Id / applicationId to disambiguate',
    );
    return null;
  }

  // ══════════════════════════════════════════════════════════════════════════
  // DEVICE PROVISIONING
  // ══════════════════════════════════════════════════════════════════════════

  /**
   * Devices are keyed by DevEUI. `deviceKey` is globally unique, so the DevEUI
   * is looked up scoped to the tenant first (via metadata) and only then by
   * deviceKey — two tenants can legitimately hold the same DevEUI if a device
   * is moved between accounts.
   */
  private async findOrCreateDevice(
    integration: Integration,
    uplink: NormalisedUplink,
    protocol: DeviceProtocol,
  ): Promise<{ device: Device; created: boolean }> {
    const devEUI = uplink.devEUI.toLowerCase();

    const existing = await this.deviceRepository
      .createQueryBuilder('device')
      .where('device.tenantId = :tenantId', { tenantId: integration.tenantId })
      .andWhere(
        `(LOWER(device."deviceKey") = :devEUI OR LOWER(device.metadata->>'devEUI') = :devEUI)`,
        { devEUI },
      )
      .getOne();

    if (existing) return { device: existing, created: false };

    const device = this.deviceRepository.create({
      tenantId: integration.tenantId,
      customerId: integration.customerId ?? undefined,
      // Device.userId is NOT NULL; the integration's owner is the closest
      // thing to a creator for a device that provisioned itself.
      userId: integration.userId,
      createdBy: integration.userId,
      deviceKey: devEUI,
      name: uplink.deviceName?.trim() || `LoRaWAN ${devEUI}`,
      type: DeviceType.SENSOR,
      status: DeviceStatus.ACTIVE,
      protocol,
      connectionType: DeviceConnectionType.LORA,
      activatedAt: new Date(),
      metadata: {
        devEUI,
        source: protocol,
        integrationId: integration.id,
        ...(uplink.applicationId
          ? { lorawanApplicationId: uplink.applicationId }
          : {}),
      },
    });

    const saved = await this.deviceRepository.save(device);
    this.logger.log(
      `Auto-provisioned LoRaWAN device ${devEUI} (${saved.id}) for tenant ${integration.tenantId}`,
    );

    return { device: saved, created: true };
  }

  // ══════════════════════════════════════════════════════════════════════════
  // PARSERS
  // ══════════════════════════════════════════════════════════════════════════

  /**
   * ChirpStack uplink. `object` is ChirpStack's own decoded payload; `data` is
   * the raw base64 frame, used only when `object` is absent.
   */
  private parseChirpStack(body: any): NormalisedUplink | null {
    const devEUI: string | undefined =
      body?.devEUI ?? body?.devEui ?? body?.deviceInfo?.devEui;
    if (!devEUI || typeof devEUI !== 'string') return null;

    // rxInfo is per-gateway; the strongest signal is the meaningful one.
    const rx = this.strongest(body?.rxInfo, 'rssi');

    return {
      devEUI,
      deviceName: body?.deviceName ?? body?.deviceInfo?.deviceName,
      applicationId:
        body?.applicationID ??
        body?.applicationId ??
        body?.applicationName ??
        body?.deviceInfo?.applicationId,
      decoded: this.asObject(body?.object),
      rawBase64: typeof body?.data === 'string' ? body.data : undefined,
      rssi: this.num(rx?.rssi),
      snr: this.num(rx?.loRaSNR ?? rx?.snr),
      frequency: this.num(body?.txInfo?.frequency),
      dataRate: this.num(body?.txInfo?.dr ?? body?.dr),
      frameCounter: this.num(body?.fCnt),
      port: this.num(body?.fPort),
      timestamp: this.date(body?.time ?? rx?.time),
    };
  }

  /**
   * TTN v3 uplink. Snake_case throughout and a different envelope from
   * ChirpStack, which is why the two have separate routes rather than one
   * shared handler.
   */
  private parseTtn(body: any): NormalisedUplink | null {
    const ids = body?.end_device_ids;
    const devEUI: string | undefined = ids?.dev_eui;
    if (!devEUI || typeof devEUI !== 'string') return null;

    const uplink = body?.uplink_message ?? {};
    const rx = this.strongest(uplink?.rx_metadata, 'rssi');

    return {
      devEUI,
      deviceName: ids?.device_id,
      applicationId: ids?.application_ids?.application_id,
      decoded: this.asObject(uplink?.decoded_payload),
      rawBase64:
        typeof uplink?.frm_payload === 'string' ? uplink.frm_payload : undefined,
      rssi: this.num(rx?.rssi),
      snr: this.num(rx?.snr),
      frequency: this.num(uplink?.settings?.frequency),
      dataRate: this.num(uplink?.settings?.data_rate_index),
      frameCounter: this.num(uplink?.f_cnt),
      port: this.num(uplink?.f_port),
      // TTN's server timestamp is preferred so replayed or queued uplinks keep
      // their true ordering.
      timestamp: this.date(uplink?.received_at ?? body?.received_at),
    };
  }

  // ══════════════════════════════════════════════════════════════════════════
  // MAPPING
  // ══════════════════════════════════════════════════════════════════════════

  /**
   * Hand off to the platform's unified ingestion entry point, exactly as the
   * MQTT and CoAP paths do. DeviceListenerService takes it from here: codec
   * decode (a pass-through for the already-decoded payload), device activity
   * update, then Kafka → TelemetryConsumer → persist + alarms + WebSocket +
   * outbound integrations.
   */
  private toStandardTelemetry(
    device: Device,
    uplink: NormalisedUplink,
  ): StandardTelemetry {
    // Prefer the network server's decoded payload; fall back to the raw frame
    // so the codec registry can decode it.
    const data = uplink.decoded ?? uplink.rawBase64 ?? {};

    return {
      deviceId: device.id,
      deviceKey: device.deviceKey,
      tenantId: device.tenantId,
      customerId: device.customerId ?? undefined,
      data: data as Record<string, any>,
      signalStrength: uplink.rssi,
      timestamp: uplink.timestamp,
      receivedAt: Date.now(),
      protocol: 'lorawan',
      metadata: {
        devEUI: uplink.devEUI,
        rssi: uplink.rssi,
        snr: uplink.snr,
        frequency: uplink.frequency,
        dataRate: uplink.dataRate,
        frameCounter: uplink.frameCounter,
        port: uplink.port,
        fPort: uplink.port,
        codecId: device.metadata?.codecId as string | undefined,
      },
      rawPayload: uplink.rawBase64,
    };
  }

  // ── Small helpers ─────────────────────────────────────────────────────────

  /** Pick the gateway entry with the strongest (least negative) signal. */
  private strongest(list: any, key: string): any {
    if (!Array.isArray(list) || list.length === 0) return undefined;
    return list.reduce((best, item) => {
      const a = this.num(item?.[key]);
      const b = this.num(best?.[key]);
      if (a === undefined) return best;
      if (b === undefined) return item;
      return a > b ? item : best;
    }, list[0]);
  }

  private asObject(value: unknown): Record<string, any> | undefined {
    return value && typeof value === 'object' && !Array.isArray(value)
      ? (value as Record<string, any>)
      : undefined;
  }

  private num(value: unknown): number | undefined {
    const n = Number(value);
    return Number.isFinite(n) ? n : undefined;
  }

  private date(value: unknown): Date {
    if (typeof value === 'string' || typeof value === 'number') {
      const d = new Date(value);
      if (!Number.isNaN(d.getTime())) return d;
    }
    return new Date();
  }
}
