// src/modules/integrations/tuya-sync.service.ts
import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';
import { Cron } from '@nestjs/schedule';
import * as crypto from 'crypto';
import {
  Device,
  DeviceProtocol,
} from '@modules/devices/entities/device.entity';
import {
  CredentialsType,
  DeviceCredentials,
} from '@modules/devices/entities/device-credentials.entity';
import { Telemetry } from '@modules/telemetry/entities/telemetry.entity';
import { WebsocketGateway } from '@modules/websocket/websocket.gateway';
import { Integration } from './entities/integration.entity';
import { TuyaAdapter } from './adapters/tuya.adapter';
import {
  DeviceConnectionType,
  DeviceStatus,
  DeviceType,
  IntegrationStatus,
  IntegrationType,
} from '@common/enums/index.enum';

/** One entry of a Tuya device-list response. Only the fields we consume. */
export interface TuyaCloudDevice {
  id: string;
  name?: string;
  category?: string;
  product_id?: string;
  product_name?: string;
  local_key?: string;
  node_id?: string;
  owner_id?: string;
  online?: boolean;
  lat?: string;
  lon?: string;
  time_zone?: string;
  status?: Array<{ code: string; value: any }>;
}

/**
 * A Tuya event, normalised away from the transport that carried it.
 *
 * The three bizCodes that matter are the ones you subscribe a Tuya messaging
 * rule to: `devicePropertyMessage`, `deviceOnline`, `deviceOffline`. Whether
 * an event reaches us from the event-log poller, the HTTP bridge, or (one day)
 * a real Pulsar consumer, it is shaped into this and handed to
 * `processTuyaMessage()` — so the handling lives in exactly one place.
 */
export interface TuyaMessage {
  bizCode: string;
  devId: string;
  bizData: Record<string, any>;
  /** Tuya event time in epoch ms, when the transport supplies one. */
  ts?: number;
}

export interface TuyaSyncResult {
  created: number;
  updated: number;
  failed: number;
  total: number;
  devices: Array<{
    tuyaId: string;
    deviceId?: string;
    name?: string;
    category?: string;
    online: boolean;
    status?: Array<{ code: string; value: any }>;
    error?: string;
  }>;
}

/**
 * Mirrors a Tuya cloud project's devices into the platform and keeps their
 * state fresh.
 *
 * Three entry points, in increasing order of latency:
 *   1. `handleWebhook()`      — real-time, driven by Tuya's message service
 *   2. `pollAllIntegrations()`— @Cron safety net, every 30s
 *   3. `syncIntegration()`    — full import, on demand and on activation
 *
 * Split out of IntegrationsService (which is CRUD) for the same reason
 * IntegrationDispatchService was: this is the runtime half, it owns a cron and
 * writes to three other modules' tables, and none of that belongs in the
 * per-owner CRUD surface.
 *
 * Contract: every path here is best-effort and **never throws into a caller
 * that did not ask for a result**. A Tuya outage must not fail an integration
 * update, a cron tick, or a webhook delivery.
 */
@Injectable()
export class TuyaSyncService {
  private readonly logger = new Logger(TuyaSyncService.name);

  /** Stateless — one instance is enough, and it shares the static token cache. */
  private readonly tuyaAdapter = new TuyaAdapter();

  /**
   * Guards against overlapping cron ticks. A poll across several integrations
   * with many devices can exceed 30s; without this, ticks would stack up and
   * multiply the load on both Tuya and the database.
   */
  private polling = false;

  /**
   * Last time an unknown-device webhook triggered a full re-import, per
   * integration. A burst of events for a device we do not have would otherwise
   * fire one full device-list sync each.
   */
  private readonly lastAutoSync = new Map<string, number>();
  private static readonly AUTO_SYNC_COOLDOWN_MS = 60_000;

  /**
   * How far back the event-log poller looks when a device has no cursor yet.
   * Bounded so switching `pollDeviceLogs` on replays the last few minutes
   * rather than the project's entire history.
   */
  private static readonly LOG_BACKFILL_MS = 5 * 60_000;

  constructor(
    @InjectRepository(Integration)
    private readonly integrationRepository: Repository<Integration>,
    @InjectRepository(Device)
    private readonly deviceRepository: Repository<Device>,
    @InjectRepository(DeviceCredentials)
    private readonly credentialsRepository: Repository<DeviceCredentials>,
    @InjectRepository(Telemetry)
    private readonly telemetryRepository: Repository<Telemetry>,
    // WebsocketModule imports neither IntegrationsModule nor anything that
    // reaches back to it, so a plain import suffices — no forwardRef needed.
    private readonly websocketGateway: WebsocketGateway,
  ) {}

  // ══════════════════════════════════════════════════════════════════════════
  // INTEGRATION ROUTING
  // ══════════════════════════════════════════════════════════════════════════

  /**
   * Same rule IntegrationDispatchService.resolveAdapter() applies: an explicit
   * TUYA type, or a legacy CLOUD row whose configuration carries Tuya
   * credentials.
   */
  static isTuyaIntegration(integration: Integration): boolean {
    const config: any = integration.configuration ?? {};
    return (
      integration.type === IntegrationType.TUYA ||
      (integration.type === IntegrationType.CLOUD &&
        !!config.clientId &&
        !!config.clientSecret)
    );
  }

  // ══════════════════════════════════════════════════════════════════════════
  // FULL SYNC (import)
  // ══════════════════════════════════════════════════════════════════════════

  /**
   * Import (or refresh) every device bound to the integration's Tuya project.
   *
   * Unlike the poll and webhook paths this one DOES propagate a Tuya failure —
   * it backs an explicit request, and "0 devices" would be a misleading answer
   * to "sync my devices". Per-device failures are collected instead of
   * aborting the run, so one malformed device cannot block the other 49.
   */
  async syncIntegration(integration: Integration): Promise<TuyaSyncResult> {
    const config: any = integration.configuration ?? {};
    const tuyaDevices: TuyaCloudDevice[] =
      await this.tuyaAdapter.getDevices(config);

    const result: TuyaSyncResult = {
      created: 0,
      updated: 0,
      failed: 0,
      total: tuyaDevices.length,
      devices: [],
    };

    for (const td of tuyaDevices) {
      if (!td?.id) continue;

      try {
        const { device, created } = await this.upsertDevice(integration, td);

        if (td.status?.length) {
          await this.saveTuyaTelemetry(device, td.status, 'sync');
        }

        if (created) result.created++;
        else result.updated++;

        result.devices.push({
          tuyaId: td.id,
          deviceId: device.id,
          name: device.name,
          category: td.category,
          online: !!td.online,
          status: td.status,
        });
      } catch (err: any) {
        result.failed++;
        result.devices.push({
          tuyaId: td.id,
          name: td.name,
          category: td.category,
          online: !!td.online,
          error: err.message,
        });
        this.logger.error(
          `Failed to sync Tuya device ${td.id}: ${err.message}`,
        );
      }
    }

    this.logger.log(
      `Tuya sync for integration ${integration.name}: ` +
        `${result.created} created, ${result.updated} updated, ` +
        `${result.failed} failed of ${result.total}`,
    );

    await this.touchIntegration(integration.id);

    return result;
  }

  /**
   * Fire-and-forget sync used by the create/update hooks, so activating an
   * integration imports its devices without the caller waiting on Tuya.
   */
  scheduleSync(integration: Integration): void {
    setImmediate(() => {
      this.syncIntegration(integration)
        .then((r) =>
          this.logger.log(
            `Tuya auto-sync (${integration.name}): ${r.created} created, ${r.updated} updated`,
          ),
        )
        .catch((err) =>
          this.logger.error(
            `Tuya auto-sync failed for ${integration.name}: ${err.message}`,
          ),
        );
    });
  }

  // ══════════════════════════════════════════════════════════════════════════
  // DEVICE UPSERT
  // ══════════════════════════════════════════════════════════════════════════

  private async upsertDevice(
    integration: Integration,
    td: TuyaCloudDevice,
  ): Promise<{ device: Device; created: boolean }> {
    const existing = await this.deviceRepository.findOne({
      where: { externalId: td.id, tenantId: integration.tenantId },
    });

    const online = !!td.online;
    const coords = this.parseCoordinates(td);

    if (existing) {
      existing.status = online ? DeviceStatus.ACTIVE : DeviceStatus.OFFLINE;
      if (online) existing.lastSeenAt = new Date();
      // A name edited in this platform is deliberately NOT overwritten by the
      // Tuya name on every sync — only an empty local name is backfilled.
      if (!existing.name && td.name) existing.name = td.name;
      existing.metadata = {
        ...(existing.metadata ?? {}),
        ...this.buildMetadata(integration, td),
      };
      if (coords) {
        existing.latitude = coords.latitude;
        existing.longitude = coords.longitude;
        existing.location = coords.location;
      }

      const saved = await this.deviceRepository.save(existing);
      return { device: saved, created: false };
    }

    const device = this.deviceRepository.create({
      tenantId: integration.tenantId,
      // devices.customerId mirrors the integration's, so an imported device
      // lands in the same customer scope as the integration that created it.
      customerId: integration.customerId,
      // devices.userId is NOT NULL and there is no interactive creator on the
      // poll/webhook paths — the integration's owner is the closest truth.
      userId: integration.userId,
      deviceKey: await this.resolveDeviceKey(td.id),
      externalId: td.id,
      name: td.name || `Tuya Device ${td.id.substring(0, 8)}`,
      type: this.mapTuyaCategory(td.category),
      protocol: DeviceProtocol.TUYA,
      // Sub-devices behind a Tuya gateway carry a node_id; everything else on
      // the Tuya cloud is a directly connected Wi-Fi device.
      connectionType: td.node_id
        ? DeviceConnectionType.ZIGBEE
        : DeviceConnectionType.WIFI,
      status: online ? DeviceStatus.ACTIVE : DeviceStatus.OFFLINE,
      lastSeenAt: online ? new Date() : undefined,
      manufacturer: 'Tuya',
      model: td.product_name,
      latitude: coords?.latitude,
      longitude: coords?.longitude,
      location: coords?.location,
      metadata: this.buildMetadata(integration, td),
      configuration: {
        tuyaDeviceId: td.id,
        integrationId: integration.id,
      },
      createdBy: integration.userId,
    });

    const saved = await this.deviceRepository.save(device);

    await this.createTuyaCredentials(saved, td);

    this.logger.log(
      `Imported Tuya device ${td.id} as ${saved.deviceKey} (${saved.name})`,
    );

    return { device: saved, created: true };
  }

  private buildMetadata(
    integration: Integration,
    td: TuyaCloudDevice,
  ): Record<string, any> {
    return {
      tuyaDeviceId: td.id,
      tuyaCategory: td.category,
      tuyaProductId: td.product_id,
      tuyaProductName: td.product_name,
      tuyaNodeId: td.node_id,
      tuyaOwnerId: td.owner_id,
      integrationId: integration.id,
      timezone: td.time_zone,
      // NB: local_key is deliberately absent — it is a secret and lives in
      // device_credentials.credentialsValue (select: false), not in the
      // metadata blob every device read returns.
    };
  }

  /**
   * Tuya reports coordinates as strings and uses '0.0' for "unknown", which
   * would otherwise plot every device off the coast of Africa.
   */
  private parseCoordinates(
    td: TuyaCloudDevice,
  ): { latitude: number; longitude: number; location: string } | null {
    const latitude = Number(td.lat);
    const longitude = Number(td.lon);

    if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) return null;
    if (latitude === 0 && longitude === 0) return null;

    return { latitude, longitude, location: `${latitude},${longitude}` };
  }

  /**
   * `tuya_<tuyaDeviceId>` — stable and readable, so MQTT topics and log lines
   * for an imported device are predictable.
   *
   * devices.deviceKey is UNIQUE across the whole platform and soft-deleted rows
   * keep their key, so a collision (same device in two tenants' projects, or a
   * re-import after a delete) falls back to a random suffix rather than failing
   * the import.
   */
  private async resolveDeviceKey(tuyaDeviceId: string): Promise<string> {
    const preferred = `tuya_${tuyaDeviceId}`;

    const collision = await this.deviceRepository.findOne({
      where: { deviceKey: preferred },
      withDeleted: true,
    });

    if (!collision) return preferred;

    return `${preferred}_${crypto.randomBytes(4).toString('hex')}`;
  }

  /**
   * Store the device's Tuya `local_key` as its credential.
   *
   * Non-fatal: a device without a local_key is still perfectly usable through
   * the cloud API — the key only matters for LAN-local control — so a
   * credential failure must not undo a successful import.
   */
  private async createTuyaCredentials(
    device: Device,
    td: TuyaCloudDevice,
  ): Promise<void> {
    try {
      const existing = await this.credentialsRepository.findOne({
        where: { deviceId: device.id },
      });
      if (existing) return;

      await this.credentialsRepository.save(
        this.credentialsRepository.create({
          deviceId: device.id,
          credentialsType: CredentialsType.TUYA,
          // credentialsId is UNIQUE platform-wide; the Tuya device id is the
          // only value here guaranteed to satisfy that. The local_key is the
          // secret and goes in credentialsValue (select: false).
          credentialsId: `tuya_${td.id}`,
          credentialsValue: td.local_key,
        }),
      );
    } catch (err: any) {
      this.logger.warn(
        `Could not store Tuya credentials for device ${device.deviceKey}: ${err.message}`,
      );
    }
  }

  /**
   * Tuya category → platform DeviceType.
   *
   * Categories are Tuya's two-to-five letter product codes. Anything unmapped
   * falls back to SENSOR, which is the read-only default and the safe guess.
   */
  private mapTuyaCategory(category?: string): DeviceType {
    const categoryMap: Record<string, DeviceType> = {
      kg: DeviceType.ACTUATOR, // switch
      tdq: DeviceType.ACTUATOR, // breaker / switch module
      dj: DeviceType.LIGHT, // light
      dd: DeviceType.LIGHT, // light strip
      fwd: DeviceType.LIGHT, // ambient light
      dc: DeviceType.ACTUATOR, // curtain / string light
      cl: DeviceType.ACTUATOR, // curtain motor
      ms: DeviceType.LOCK, // door lock
      mcs: DeviceType.SENSOR, // door/window sensor
      wsdcg: DeviceType.SENSOR, // temperature + humidity sensor
      co2bj: DeviceType.SENSOR, // CO2 detector
      pm25: DeviceType.SENSOR, // air quality
      pir: DeviceType.SENSOR, // motion sensor
      ldcg: DeviceType.SENSOR, // illuminance sensor
      sj: DeviceType.SENSOR, // water leak sensor
      ywbj: DeviceType.SENSOR, // smoke detector
      rqbj: DeviceType.SENSOR, // gas detector
      ggq: DeviceType.ACTUATOR, // irrigation valve
      kt: DeviceType.HVAC, // air conditioner
      wk: DeviceType.THERMOSTAT, // thermostat
      dlq: DeviceType.ACTUATOR, // circuit breaker
      cz: DeviceType.PLUG, // socket / plug
      pc: DeviceType.PLUG, // power strip
      zndb: DeviceType.ENERGY_METER, // smart electricity meter
      sp: DeviceType.CAMERA, // camera
      wg2: DeviceType.GATEWAY, // gateway
    };

    return categoryMap[category ?? ''] ?? DeviceType.SENSOR;
  }

  // ══════════════════════════════════════════════════════════════════════════
  // TELEMETRY
  // ══════════════════════════════════════════════════════════════════════════

  /**
   * Persist a Tuya status list as one telemetry reading and push it out over
   * the WebSocket.
   *
   * Two decisions worth knowing about:
   *
   * 1. **The row is a merged snapshot, not a delta.** A webhook status report
   *    carries only the datapoints that changed; the rest of the platform
   *    (getLatest, dashboards, `data->>'key'` queries) reads the newest row as
   *    the device's complete current state. So the incoming codes are merged
   *    over the previous reading rather than replacing it — otherwise a
   *    `switch_1` event would erase the device's temperature.
   *
   * 2. **Unchanged readings are not stored.** A 30-second poll of an idle
   *    device would otherwise write 2,880 identical rows per device per day.
   *    Nothing is broadcast either, since nothing changed.
   *
   * @returns whether a new reading was actually written.
   */
  private async saveTuyaTelemetry(
    device: Device,
    statusArray: Array<{ code: string; value: any }>,
    source: 'sync' | 'poll' | 'message',
  ): Promise<boolean> {
    const incoming: Record<string, any> = {};
    for (const entry of statusArray ?? []) {
      if (entry?.code !== undefined && entry.code !== null) {
        incoming[entry.code] = entry.value;
      }
    }

    if (Object.keys(incoming).length === 0) return false;

    const latest = await this.telemetryRepository.findOne({
      where: { deviceId: device.id },
      order: { timestamp: 'DESC' },
    });

    const merged = { ...(latest?.data ?? {}), ...incoming };

    if (latest && this.sameReading(latest.data, merged)) return false;

    const timestamp = new Date();

    const saved = await this.telemetryRepository.save(
      this.telemetryRepository.create({
        deviceId: device.id,
        deviceKey: device.deviceKey,
        tenantId: device.tenantId,
        timestamp,
        data: merged,
        batteryLevel: this.extractBattery(merged),
        metadata: {
          source: 'tuya',
          via: source,
          tuyaDeviceId: device.externalId,
        },
      }),
    );

    this.pushTelemetry(device, saved.data, timestamp);

    return true;
  }

  /** Order-insensitive comparison of two telemetry payloads. */
  private sameReading(
    a: Record<string, any> | undefined,
    b: Record<string, any>,
  ): boolean {
    if (!a) return false;

    const keysA = Object.keys(a).sort();
    const keysB = Object.keys(b).sort();
    if (keysA.length !== keysB.length) return false;

    return keysA.every(
      (key, i) => keysB[i] === key && JSON.stringify(a[key]) === JSON.stringify(b[key]),
    );
  }

  /**
   * Battery is the one Tuya datapoint whose unit is unambiguous (a percentage),
   * so it is the only value promoted to a denormalised column.
   *
   * Temperature and humidity are deliberately NOT promoted: Tuya scales those
   * per product (`va_temperature` is usually ×10, but the factor lives in the
   * device's function spec, which the device-list endpoint does not return).
   * Writing an unscaled value into telemetry.temperature would put 245 °C on
   * dashboards and trip every alarm rule. The raw codes remain in `data`.
   */
  private extractBattery(data: Record<string, any>): number | undefined {
    for (const key of ['battery_percentage', 'residual_electricity', 'battery']) {
      const value = Number(data[key]);
      if (Number.isFinite(value) && value >= 0 && value <= 100) return value;
    }
    return undefined;
  }

  // ══════════════════════════════════════════════════════════════════════════
  // WEBSOCKET PUSH — never breaks a sync
  // ══════════════════════════════════════════════════════════════════════════

  private pushTelemetry(
    device: Device,
    data: Record<string, any>,
    timestamp: Date,
  ): void {
    try {
      const payload = {
        deviceId: device.id,
        deviceKey: device.deviceKey,
        tenantId: device.tenantId,
        data,
        timestamp: timestamp.toISOString(),
        source: 'tuya',
      };

      // 'device:telemetry' is the platform-wide contract every widget already
      // listens on (see WebsocketGateway.broadcastDeviceTelemetry and
      // TelemetryConsumer); 'telemetry:update' is emitted alongside it for
      // clients written against the Tuya integration spec.
      this.websocketGateway.emitToDevice(device.id, 'device:telemetry', payload);
      this.websocketGateway.emitToDevice(device.id, 'telemetry:update', payload);
    } catch (err: any) {
      this.logger.warn(
        `WebSocket telemetry push failed for ${device.deviceKey}: ${err.message}`,
      );
    }
  }

  private pushStatus(device: Device, status: DeviceStatus): void {
    try {
      this.websocketGateway.emitToDevice(device.id, 'device:status', {
        deviceId: device.id,
        status,
        isOnline: status === DeviceStatus.ACTIVE,
        timestamp: new Date().toISOString(),
      });
    } catch (err: any) {
      this.logger.warn(
        `WebSocket status push failed for ${device.deviceKey}: ${err.message}`,
      );
    }
  }

  // ══════════════════════════════════════════════════════════════════════════
  // POLLING
  // ══════════════════════════════════════════════════════════════════════════

  /**
   * The message-consumption loop.
   *
   * Tuya has no HTTP webhook and no account-wide message-poll REST endpoint —
   * its message service is Pulsar-only — so this cron IS how events reach the
   * platform. Every 10 seconds it pulls each active project's device state in
   * one call, diffs it, and turns the differences into the same
   * devicePropertyMessage / deviceOnline / deviceOffline handling a Pulsar
   * subscriber would perform. Worst-case latency for a datapoint change is
   * therefore one interval.
   *
   * 10s is affordable because the state pull is a single request per
   * integration regardless of device count (and the access token is cached).
   * Set TUYA_POLL_ENABLED=false to disable — do this on every replica but one,
   * since two instances polling the same project double the API spend and
   * race on the same rows.
   */
  @Cron('*/10 * * * * *')
  async pollAllIntegrations(): Promise<void> {
    if (process.env.TUYA_POLL_ENABLED === 'false') return;

    // A slow run must not stack ticks on top of each other.
    if (this.polling) {
      this.logger.debug('Tuya poll still running — skipping this tick');
      return;
    }
    this.polling = true;

    try {
      const candidates = await this.integrationRepository.find({
        where: {
          type: In([IntegrationType.TUYA, IntegrationType.CLOUD]),
          status: IntegrationStatus.ACTIVE,
          enabled: true,
        },
      });

      // CLOUD is a shared bucket — keep only the rows that are really Tuya.
      const integrations = candidates.filter((i) =>
        TuyaSyncService.isTuyaIntegration(i),
      );

      if (integrations.length === 0) return;

      this.logger.debug(
        `Polling ${integrations.length} Tuya integration(s)...`,
      );

      // allSettled: one unreachable project must not stop the others.
      await Promise.allSettled(
        integrations.map((i) => this.pollIntegration(i)),
      );
    } catch (err: any) {
      this.logger.error(`Tuya polling error: ${err.message}`);
    } finally {
      this.polling = false;
    }
  }

  /**
   * One tick for one integration: device state, then (optionally) the event
   * log. Both are wrapped separately so a failing log poll does not cost us
   * the state poll, which is the one that always works.
   */
  private async pollIntegration(integration: Integration): Promise<void> {
    await this.pollDeviceState(integration);

    // Opt-in: costs one API call PER DEVICE per tick — see pollDeviceMessages.
    if ((integration.configuration as any)?.pollDeviceLogs) {
      await this.pollDeviceMessages(integration);
    }

    await this.touchIntegration(integration.id);
  }

  /**
   * The primary message source: `GET /v1.0/iot-01/associated-users/devices`
   * returns every device in the project *with its full datapoint status* in a
   * single call.
   *
   * That one request is what makes a 10-second interval affordable — it is
   * O(1) in the number of devices, where the per-device log endpoint is O(n).
   * Combined with the change-detection in saveTuyaTelemetry(), state-diffing
   * this response reproduces exactly the `devicePropertyMessage` /
   * `deviceOnline` / `deviceOffline` stream a Pulsar subscriber would see.
   *
   * Its one blind spot: a datapoint that changes and changes back inside a
   * single interval is invisible, because only the endpoints of the interval
   * are observed. `pollDeviceLogs` closes that gap when it matters.
   */
  private async pollDeviceState(integration: Integration): Promise<void> {
    try {
      const tuyaDevices: TuyaCloudDevice[] = await this.tuyaAdapter.getDevices(
        integration.configuration ?? {},
      );

      for (const td of tuyaDevices) {
        if (!td?.id) continue;

        const device = await this.deviceRepository.findOne({
          where: { externalId: td.id, tenantId: integration.tenantId },
        });

        // A device that appeared in Tuya since the last import is picked up by
        // the next full sync (or a bindUser event), not by the poller —
        // creating devices from a cron would make an import failure invisible.
        if (!device) continue;

        await this.applyOnlineState(device, !!td.online);

        if (td.status?.length) {
          await this.saveTuyaTelemetry(device, td.status, 'poll');
        }
      }
    } catch (err: any) {
      this.logger.error(
        `Failed to poll Tuya device state for ${integration.name} (${integration.id}): ${err.message}`,
      );
    }
  }

  // ══════════════════════════════════════════════════════════════════════════
  // MESSAGE CONSUMPTION (event log)
  // ══════════════════════════════════════════════════════════════════════════

  /**
   * Drain each imported device's Tuya event log since the last cursor and feed
   * the entries through the same processTuyaMessage() path as every other
   * transport.
   *
   * **Opt in with `configuration.pollDeviceLogs: true`.** This is one API call
   * per device per tick — at a 10s interval a 100-device project spends 600
   * calls a minute, which Tuya will throttle. Turn it on when you need exact
   * event ordering/timestamps, or need to catch a datapoint that toggles and
   * reverts between two state polls; otherwise pollDeviceState() already
   * carries the same information for one call.
   *
   * Bound by `configuration.maxLogDevices` (default 25) so enabling it on a
   * large project degrades rather than melting the rate limit silently — the
   * number skipped is logged, never hidden.
   */
  private async pollDeviceMessages(integration: Integration): Promise<void> {
    const config: any = integration.configuration ?? {};

    try {
      const devices = await this.deviceRepository.find({
        where: {
          tenantId: integration.tenantId,
          protocol: DeviceProtocol.TUYA,
        },
        order: { lastSeenAt: 'DESC' },
      });

      if (devices.length === 0) return;

      const cap = Number(config.maxLogDevices) || 25;
      const targets = devices.slice(0, cap);

      if (devices.length > targets.length) {
        this.logger.warn(
          `Tuya log poll for ${integration.name}: ${devices.length} devices, ` +
            `polling the ${targets.length} most recently seen (configuration.maxLogDevices). ` +
            `${devices.length - targets.length} skipped this tick.`,
        );
      }

      for (const device of targets) {
        await this.pollOneDeviceLog(integration, device);
      }
    } catch (err: any) {
      this.logger.error(
        `Tuya message poll failed for ${integration.name}: ${err.message}`,
      );
    }
  }

  private async pollOneDeviceLog(
    integration: Integration,
    device: Device,
  ): Promise<void> {
    if (!device.externalId) return;

    const cursor = (device.metadata as any)?.tuyaLogCursor ?? {};

    // First run has no cursor: look back one window rather than all of
    // history, so enabling the feature does not replay months of events.
    const startTime =
      Number(cursor.ts) || Date.now() - TuyaSyncService.LOG_BACKFILL_MS;

    try {
      const { logs, lastRowKey } = await this.tuyaAdapter.getDeviceLogs(
        integration.configuration ?? {},
        device.externalId,
        { startTime, lastRowKey: cursor.rowKey, size: 50 },
      );

      if (!logs.length) return;

      const messages = this.logsToMessages(device.externalId, logs);
      for (const message of messages) {
        await this.applyMessageToDevice(message, device, integration);
      }

      // Advance the cursor past what we just consumed.
      const newestTs = logs.reduce(
        (max, entry) => Math.max(max, Number(entry.event_time) || 0),
        Number(cursor.ts) || 0,
      );

      // Assigned onto the entity first: a fresh object literal does not satisfy
      // TypeORM's QueryDeepPartialEntity mapping of Record<string, any> (same
      // reason as IntegrationDispatchService.recordOutcome).
      device.metadata = {
        ...(device.metadata ?? {}),
        tuyaLogCursor: {
          // +1ms so an event on the boundary is not re-delivered.
          ts: newestTs ? newestTs + 1 : Date.now(),
          rowKey: lastRowKey,
          polledAt: new Date().toISOString(),
        },
      };

      await this.deviceRepository.update(
        { id: device.id },
        { metadata: device.metadata },
      );
    } catch (err: any) {
      // Device logs are an optional enrichment — a project without the log API
      // enabled must not turn every tick into an error storm.
      this.logger.debug(
        `Tuya log poll skipped for ${device.deviceKey}: ${err.message}`,
      );
    }
  }

  /**
   * Convert a device's raw log entries into normalised messages.
   *
   * Property reports are collapsed into ONE devicePropertyMessage per batch
   * (last value per code wins) rather than one message per datapoint: telemetry
   * rows are merged snapshots of current state, so emitting them individually
   * would write one row per changed key for no added fidelity. Online/offline
   * entries stay discrete and are ordered after the properties, so the device's
   * final connectivity state is the newest one observed.
   */
  private logsToMessages(
    devId: string,
    logs: Array<Record<string, any>>,
  ): TuyaMessage[] {
    const ascending = [...logs].sort(
      (a, b) => (Number(a.event_time) || 0) - (Number(b.event_time) || 0),
    );

    const properties = new Map<string, any>();
    const events: TuyaMessage[] = [];

    for (const entry of ascending) {
      const eventId = Number(entry.event_id);
      const ts = Number(entry.event_time) || undefined;

      if (eventId === 1) {
        events.push({ bizCode: 'deviceOnline', devId, bizData: {}, ts });
      } else if (eventId === 2) {
        events.push({ bizCode: 'deviceOffline', devId, bizData: {}, ts });
      } else if (entry.code !== undefined && entry.code !== null) {
        // Everything else carrying a datapoint is a report (event_id 7).
        properties.set(entry.code, this.coerceLogValue(entry.value));
      }
    }

    const messages: TuyaMessage[] = [];

    if (properties.size > 0) {
      messages.push({
        bizCode: 'devicePropertyMessage',
        devId,
        bizData: {
          properties: [...properties].map(([code, value]) => ({ code, value })),
        },
      });
    }

    return [...messages, ...events];
  }

  /**
   * Log values arrive as strings — `"true"`, `"23"` — where the device-list
   * status endpoint returns real booleans and numbers. Normalising here keeps
   * a datapoint's type stable no matter which source produced it; without it,
   * every alternating poll would look like a change and store a new row.
   */
  private coerceLogValue(value: any): any {
    if (typeof value !== 'string') return value;
    if (value === 'true') return true;
    if (value === 'false') return false;

    const trimmed = value.trim();
    if (trimmed !== '' && Number.isFinite(Number(trimmed))) {
      return Number(trimmed);
    }

    // Tuya wraps complex datapoints as JSON strings.
    if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
      try {
        return JSON.parse(trimmed);
      } catch {
        /* leave it as the raw string */
      }
    }

    return value;
  }

  /**
   * Reconcile a device's status with what Tuya reports.
   *
   * `lastSeenAt` is refreshed on EVERY poll while the device is online, not
   * only on a transition: DevicesService.checkOfflineDevices() flips any ACTIVE
   * device with a stale lastSeenAt to OFFLINE every five minutes, so a
   * permanently-online Tuya device would otherwise flap OFFLINE→ACTIVE forever.
   */
  private async applyOnlineState(
    device: Device,
    online: boolean,
  ): Promise<void> {
    const status = online ? DeviceStatus.ACTIVE : DeviceStatus.OFFLINE;
    const changed = device.status !== status;

    // MAINTENANCE and ERROR are operator-set; Tuya connectivity does not
    // override them (mirrors TelemetryService.activityPatch()).
    if (
      device.status === DeviceStatus.MAINTENANCE ||
      device.status === DeviceStatus.ERROR
    ) {
      return;
    }

    // An offline device that is still offline has nothing to write — skipping
    // it keeps the 30s poll from issuing one pointless UPDATE per dark device
    // per tick. An online one always writes, because lastSeenAt must stay
    // fresh (see the doc comment).
    if (!online && !changed) return;

    await this.deviceRepository.update(
      { id: device.id },
      online ? { status, lastSeenAt: new Date() } : { status },
    );

    if (changed) {
      device.status = status;
      this.pushStatus(device, status);
      this.logger.log(
        `Tuya device ${device.deviceKey} is now ${online ? 'online' : 'offline'}`,
      );
    }
  }

  /** Records that the integration did something, for the activity feed. */
  private async touchIntegration(integrationId: string): Promise<void> {
    try {
      await this.integrationRepository.update(
        { id: integrationId },
        { lastActivity: new Date() },
      );
    } catch {
      /* bookkeeping only — never fatal */
    }
  }

  // ══════════════════════════════════════════════════════════════════════════
  // WEBHOOK
  // ══════════════════════════════════════════════════════════════════════════

  /**
   * Tuya message-service receiver.
   *
   * **Always resolves `{ success: true }`**, whatever happens. Tuya retries a
   * non-2xx delivery and disables the subscription after repeated failures, so
   * reporting our own problems back to it would cost us the subscription.
   * Failures are logged instead.
   */
  async handleWebhook(
    body: any,
    clientId?: string,
    providedSecret?: string,
  ): Promise<{ success: boolean }> {
    try {
      const resolvedClientId =
        clientId || body?.clientId || body?.client_id || body?.data?.client_id;

      if (!resolvedClientId) {
        this.logger.warn('Tuya webhook received without a client_id — ignored');
        return { success: true };
      }

      const integration = await this.findIntegrationByClientId(
        String(resolvedClientId),
      );

      if (!integration) {
        this.logger.warn(
          `No active Tuya integration for clientId ${resolvedClientId} — ignored`,
        );
        return { success: true };
      }

      if (!this.verifyWebhookSecret(integration, providedSecret)) {
        this.logger.warn(
          `Tuya webhook for ${integration.name} rejected: bad x-webhook-secret`,
        );
        return { success: true };
      }

      this.logger.debug(
        `Tuya webhook for ${integration.name}: ${JSON.stringify(body)}`,
      );

      for (const event of this.extractEvents(body)) {
        await this.processTuyaMessage(this.toMessage(event), integration);
      }

      await this.touchIntegration(integration.id);

      return { success: true };
    } catch (err: any) {
      this.logger.error(`Tuya webhook processing failed: ${err.message}`);
      return { success: true };
    }
  }

  /**
   * The webhook is unauthenticated by necessity — Tuya's console lets you set a
   * URL, not an Authorization header — so the clientId in the request is the
   * only thing tying a delivery to a tenant. A caller who learns a clientId can
   * therefore inject telemetry for that tenant's devices.
   *
   * Setting `configuration.webhookSecret` closes that: the request must then
   * carry a matching `x-webhook-secret` header, which a reverse proxy in front
   * of this endpoint can inject. Unset (the default) preserves the plain Tuya
   * flow.
   */
  private verifyWebhookSecret(
    integration: Integration,
    providedSecret?: string,
  ): boolean {
    const expected = (integration.configuration as any)?.webhookSecret;
    if (!expected) return true;
    if (!providedSecret) return false;

    const a = Buffer.from(String(expected));
    const b = Buffer.from(String(providedSecret));
    return a.length === b.length && crypto.timingSafeEqual(a, b);
  }

  private async findIntegrationByClientId(
    clientId: string,
  ): Promise<Integration | null> {
    return this.integrationRepository
      .createQueryBuilder('i')
      .where("i.configuration->>'clientId' = :clientId", { clientId })
      .andWhere('i.status = :status', { status: IntegrationStatus.ACTIVE })
      .andWhere('i.enabled = true')
      .andWhere('i.deleted_at IS NULL')
      .getOne();
  }

  /**
   * Normalise the several envelopes Tuya has shipped over the years into a
   * flat list of events: a batch (`events`), a single wrapped event (`data` /
   * `payload`), or a bare event object.
   */
  private extractEvents(body: any): any[] {
    if (Array.isArray(body)) return body;
    if (Array.isArray(body?.events)) return body.events;
    if (Array.isArray(body?.data)) return body.data;
    if (body?.data && typeof body.data === 'object') return [body.data];
    if (body?.payload && typeof body.payload === 'object') return [body.payload];
    return body ? [body] : [];
  }

  /**
   * Shape one raw event — whatever envelope it arrived in — into a TuyaMessage.
   *
   * Tuya has shipped several spellings of the same fields across its Pulsar,
   * HTTP and OpenAPI surfaces, so every known alias is accepted here rather
   * than in the handler.
   */
  private toMessage(event: any): TuyaMessage {
    const devId =
      event?.devId ??
      event?.deviceId ??
      event?.dev_id ??
      event?.bizData?.devId ??
      event?.bizData?.dev_id ??
      event?.biz_data?.dev_id ??
      event?.biz_data?.devId;

    // A bare status report has no envelope; treat the event itself as data.
    const bizData =
      event?.bizData ??
      event?.biz_data ??
      (event?.properties || event?.status ? event : {});

    return {
      bizCode: String(
        event?.bizCode ?? event?.biz_code ?? event?.type ?? event?.event ?? '',
      ),
      devId: devId ? String(devId) : '',
      bizData: bizData ?? {},
      ts: Number(event?.ts ?? event?.t ?? event?.event_time) || undefined,
    };
  }

  /**
   * The single entry point for a Tuya event, whatever delivered it.
   *
   * Resolves the device, then applies the message. Unknown devices trigger a
   * (debounced) import rather than being dropped — a device bound in Tuya
   * after our last sync would otherwise stay invisible forever.
   */
  async processTuyaMessage(
    message: TuyaMessage,
    integration: Integration,
  ): Promise<void> {
    if (!message?.devId) {
      this.logger.debug(
        `Tuya message without a device id — skipped: ${JSON.stringify(message)}`,
      );
      return;
    }

    const device = await this.deviceRepository.findOne({
      where: { externalId: message.devId, tenantId: integration.tenantId },
    });

    if (!device) {
      this.logger.warn(
        `Tuya message for unknown device ${message.devId} — scheduling an import`,
      );
      this.requestAutoSync(integration);
      return;
    }

    await this.applyMessageToDevice(message, device, integration);
  }

  /**
   * Apply a normalised message to a device we have already resolved.
   *
   * The canonical bizCodes are the ones a Tuya messaging rule emits —
   * `devicePropertyMessage`, `deviceOnline`, `deviceOffline` — with the older
   * HTTP-era spellings (`statusReport`, `online`, `offline`) accepted as
   * aliases so both transports land in the same branch.
   */
  private async applyMessageToDevice(
    message: TuyaMessage,
    device: Device,
    integration: Integration,
  ): Promise<void> {
    const bizCode = message.bizCode.toLowerCase().replace(/[_-]/g, '');

    switch (bizCode) {
      // ── devicePropertyMessage ────────────────────────────────────────────
      case 'devicepropertymessage':
      case 'deviceproperty':
      case 'statusreport':
      case 'devicestatus': {
        const properties =
          message.bizData?.properties ??
          message.bizData?.status ??
          message.bizData?.dps ??
          [];

        if (!Array.isArray(properties) || properties.length === 0) break;

        const stored = await this.saveTuyaTelemetry(
          device,
          properties,
          'message',
        );

        // A report proves the device is reachable, whatever it reported.
        await this.applyOnlineState(device, true);

        this.logger.log(
          `Tuya property message for ${device.name}` +
            (stored ? '' : ' (unchanged — not stored)'),
        );
        break;
      }

      // ── deviceOnline ─────────────────────────────────────────────────────
      case 'deviceonline':
      case 'online':
        await this.applyOnlineState(device, true);
        break;

      // ── deviceOffline ────────────────────────────────────────────────────
      case 'deviceoffline':
      case 'offline':
        await this.applyOnlineState(device, false);
        break;

      case 'binduser':
        // A new device was linked to the account — import it.
        this.requestAutoSync(integration);
        break;

      case 'nameupdate': {
        const name = message.bizData?.name;
        if (name) {
          await this.deviceRepository.update({ id: device.id }, { name });
        }
        break;
      }

      case 'delete':
      case 'unbind':
        // Deliberately not deleting the device: its telemetry history and any
        // dashboards/alarms referencing it stay valid. It simply goes offline.
        await this.applyOnlineState(device, false);
        break;

      default:
        this.logger.debug(`Unhandled Tuya bizCode: '${message.bizCode}'`);
    }
  }

  /**
   * Trigger a full import, at most once per cooldown per integration — a burst
   * of events for devices we do not know about would otherwise fire one
   * full device-list sync each.
   */
  private requestAutoSync(integration: Integration): void {
    const last = this.lastAutoSync.get(integration.id) ?? 0;
    if (Date.now() - last < TuyaSyncService.AUTO_SYNC_COOLDOWN_MS) return;

    this.lastAutoSync.set(integration.id, Date.now());
    this.scheduleSync(integration);
  }
}
