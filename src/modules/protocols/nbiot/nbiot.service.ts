// src/modules/protocols/nbiot/nbiot.service.ts
import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  forwardRef,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { IsNull, Not, Repository } from 'typeorm';
import * as crypto from 'crypto';
import { NbIotDevice } from './entities/nbiot-device.entity';
import { Device } from '@modules/devices/entities/device.entity';
import { Integration } from '@modules/integrations/entities/integration.entity';
import { DeviceListenerService } from '../device-listener.service';
import { IntegrationStatus, IntegrationType } from '@common/enums/index.enum';
import type { StandardTelemetry } from '@common/interfaces/standard-telemetry.interface';
import type {
  CreateNbIotDeviceDto,
  UpdateNbIotDeviceDto,
} from './dto/nbiot-device.dto';

/** The canonical telemetry keys the radio metrics are stored under. */
export const NBIOT_SIGNAL_KEYS = {
  rsrp: 'nbiotRsrp',
  rsrq: 'nbiotRsrq',
  sinr: 'nbiotSinr',
  ecl: 'nbiotEcl',
  coverageClass: 'nbiotCoverageClass',
  txPower: 'nbiotTxPower',
} as const;

export interface NbIotSignalMetrics {
  rsrp?: number;
  rsrq?: number;
  sinr?: number;
  ecl?: number;
  coverageClass?: number;
  txPower?: number;
  cellId?: string;
  tac?: string;
  plmn?: string;
  band?: number;
}

export interface NbIotUplinkResult {
  success: boolean;
  message: string;
  deviceId?: string;
  deviceKey?: string;
  /** Which identifier matched, so a misconfigured sender can be corrected. */
  matchedBy?: 'imei' | 'imsi' | 'iccid' | 'msisdn' | 'deviceKey';
  /** Radio metrics lifted out of the body and stored as telemetry. */
  signal?: NbIotSignalMetrics;
  telemetryKeys?: string[];
}

/**
 * Carrier spellings for each radio metric, in priority order.
 *
 * This table is the honest core of NB-IoT support. There is no standard uplink
 * envelope: Huawei's OceanConnect nests under `service.data`, Vodafone and
 * Telefónica flatten with their own names, and a bare module firmware often
 * just copies the `+CESQ` / `+NUESTATS` fields verbatim. Every one of these
 * spellings has been seen in the wild for the same number, and without the
 * table the metric silently lands as an unrelated telemetry key — or not at
 * all.
 */
const SIGNAL_ALIASES: Record<keyof NbIotSignalMetrics, string[]> = {
  rsrp: ['rsrp', 'RSRP', 'signalPower', 'signal_power', 'rsrpDbm', 'rsrp_dbm'],
  rsrq: ['rsrq', 'RSRQ', 'signalQuality', 'signal_quality'],
  sinr: ['sinr', 'SINR', 'snr', 'SNR'],
  ecl: ['ecl', 'ECL', 'eclValue', 'coverageEnhancementLevel', 'ce_level', 'ceLevel'],
  coverageClass: [
    'coverageClass',
    'coverage_class',
    'coverageLevel',
    'cov_class',
  ],
  txPower: ['txPower', 'tx_power', 'txpower', 'totalPower'],
  cellId: ['cellId', 'cell_id', 'cellID', 'ci', 'eci', 'cell'],
  tac: ['tac', 'TAC', 'trackingAreaCode'],
  plmn: ['plmn', 'PLMN', 'mccmnc'],
  band: ['band', 'Band', 'earfcnBand'],
};

/** Sub-objects a carrier commonly nests the real payload inside. */
const NESTED_PAYLOAD_PATHS = [
  'data',
  'payload',
  'body',
  'service.data',
  'services.0.data',
  'reported',
  'deviceInfo',
  'uplink',
];

/**
 * ─────────────────────────────────────────────────────────────────────────────
 * NB-IoT: modelling, plus one real inbound path
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * NB-IoT is a radio BEARER. There is no NB-IoT application protocol to
 * implement — the device speaks CoAP, MQTT-SN or HTTP over it, and this
 * platform already ingests CoAP (UDP 5683), MQTT and HTTP. Claiming to have
 * "added the NB-IoT protocol" would be claiming to have written a radio stack.
 *
 * So what is built here is the two things that genuinely were missing:
 *
 *  1. **The identity an NB-IoT fault is diagnosed from** — IMSI, IMEI, ICCID,
 *     carrier, APN — in a table that can be queried, and the radio metrics as
 *     real telemetry series so they chart, alarm and export like any other.
 *  2. **A carrier HTTP push endpoint** (`POST /nbiot/uplink/:integrationId`)
 *     that resolves the device by SIM identity rather than by a deviceKey the
 *     carrier does not know, normalises whichever spelling of RSRP the carrier
 *     chose, and ends at `DeviceListenerService.handleTelemetry()`.
 *
 * Point 2 is why this is not just modelling. A carrier platform knows the IMEI
 * and the MSISDN; it does not know this platform's `deviceKey`, so
 * `POST /integrations/http/:id` — which looks the device up by key — cannot
 * serve it. That lookup, and the metric normalisation, are the whole reason
 * this route exists rather than reusing the generic one.
 *
 * A device that talks CoAP directly needs none of this: it already works
 * through `CoAPAdapter`, and its RSRP arrives as telemetry if the firmware
 * sends it — under whatever key the firmware used. Canonicalising on that path
 * too is what `applyToTelemetry()` is for, and it is deliberately NOT wired in
 * yet; see its doc block for why.
 */
@Injectable()
export class NbIotService {
  private readonly logger = new Logger(NbIotService.name);

  constructor(
    @InjectRepository(NbIotDevice)
    private readonly repo: Repository<NbIotDevice>,
    @InjectRepository(Device)
    private readonly deviceRepo: Repository<Device>,
    @InjectRepository(Integration)
    private readonly integrationRepo: Repository<Integration>,
    @Inject(forwardRef(() => DeviceListenerService))
    private readonly deviceListener: DeviceListenerService,
  ) {}

  // ══════════════════════════════════════════════════════════════════════════
  // CRUD — every query pinned to the tenant, 404 (not 403) outside it
  // ══════════════════════════════════════════════════════════════════════════

  async findAll(tenantId: string): Promise<NbIotDevice[]> {
    return this.repo.find({
      where: { tenantId },
      relations: { device: true },
      order: { createdAt: 'DESC' },
    });
  }

  async findOne(id: string, tenantId: string): Promise<NbIotDevice> {
    const row = await this.repo.findOne({
      where: { id, tenantId },
      relations: { device: true },
    });
    if (!row) throw new NotFoundException('NB-IoT device not found');
    return row;
  }

  async create(
    tenantId: string,
    userId: string,
    dto: CreateNbIotDeviceDto,
  ): Promise<NbIotDevice> {
    await this.assertDeviceInTenant(dto.deviceId, tenantId);
    await this.assertDeviceNotClaimed(tenantId, dto.deviceId);
    await this.assertIdentifiersFree(tenantId, dto);

    const row = this.repo.create({
      ...dto,
      tenantId,
      createdBy: userId,
      uplinkCount: '0',
    });
    const saved = await this.repo.save(row);
    return this.findOne(saved.id, tenantId);
  }

  async update(
    id: string,
    tenantId: string,
    userId: string,
    dto: UpdateNbIotDeviceDto,
  ): Promise<NbIotDevice> {
    const existing = await this.findOne(id, tenantId);
    if (dto.deviceId && dto.deviceId !== existing.deviceId) {
      await this.assertDeviceInTenant(dto.deviceId, tenantId);
      await this.assertDeviceNotClaimed(tenantId, dto.deviceId, id);
    }
    await this.assertIdentifiersFree(tenantId, dto, id);

    Object.assign(existing, dto, { updatedBy: userId });
    await this.repo.save(existing);
    return this.findOne(id, tenantId);
  }

  async remove(id: string, tenantId: string): Promise<void> {
    const row = await this.findOne(id, tenantId);
    await this.repo.softRemove(row);
  }

  /**
   * List with an honest "overdue" verdict.
   *
   * `Device.isOnline()` hard-codes a five-minute window, which is simply wrong
   * for a PSM device that reports once a day — it would show every healthy
   * NB-IoT sensor as offline. This uses the device's own
   * `expectedReportIntervalSeconds`, and says "unknown" rather than guessing
   * when none is set.
   */
  async getStatus(tenantId: string) {
    const rows = await this.findAll(tenantId);
    const now = Date.now();

    return {
      total: rows.length,
      enabled: rows.filter((row) => row.enabled).length,
      note:
        'NB-IoT is a bearer, not an application protocol. These devices ingest ' +
        'over CoAP (UDP 5683), MQTT, or the carrier push endpoint ' +
        'POST /nbiot/uplink/:integrationId — there is no separate NB-IoT wire ' +
        'protocol to connect.',
      devices: rows.map((row) => {
        const silentSeconds = row.lastUplinkAt
          ? Math.round((now - new Date(row.lastUplinkAt).getTime()) / 1000)
          : null;
        const expected = row.expectedReportIntervalSeconds ?? null;
        return {
          id: row.id,
          deviceId: row.deviceId,
          deviceName: row.device?.name ?? null,
          deviceKey: row.device?.deviceKey ?? null,
          imei: row.imei ?? null,
          imsi: row.imsi ?? null,
          iccid: row.iccid ?? null,
          carrier: row.carrier ?? null,
          apn: row.apn ?? null,
          appProtocol: row.appProtocol,
          enabled: row.enabled,
          lastUplinkAt: row.lastUplinkAt ?? null,
          uplinkCount: Number(row.uplinkCount ?? 0),
          signal: {
            rsrp: row.lastRsrp ?? null,
            rsrq: row.lastRsrq ?? null,
            sinr: row.lastSinr ?? null,
            ecl: row.lastEcl ?? null,
            coverageClass: row.lastCoverageClass ?? null,
            cellId: row.lastCellId ?? null,
            tac: row.lastTac ?? null,
          },
          // A triple, not a boolean: "we do not know what normal looks like
          // for this device" is a different answer from "it is late".
          reportHealth:
            silentSeconds === null
              ? 'never-reported'
              : expected === null
                ? 'unknown'
                : // 2x the expected interval before calling it late: one
                  // missed uplink is normal on a marginal cell, two is a fault.
                  silentSeconds > expected * 2
                  ? 'overdue'
                  : 'ok',
          silentSeconds,
          expectedReportIntervalSeconds: expected,
          signalQuality: this.describeRsrp(row.lastRsrp ?? null),
        };
      }),
    };
  }

  /**
   * RSRP → a word.
   *
   * The thresholds are the ones field engineers use: above -90 dBm is a strong
   * cell, below -115 dBm is where NB-IoT starts repeating transmissions and
   * burning battery, and below -125 dBm it will usually attach and then fail
   * to deliver.
   */
  private describeRsrp(
    rsrp: number | null,
  ): 'excellent' | 'good' | 'fair' | 'poor' | 'unusable' | 'unknown' {
    if (rsrp === null || !Number.isFinite(rsrp)) return 'unknown';
    if (rsrp >= -90) return 'excellent';
    if (rsrp >= -105) return 'good';
    if (rsrp >= -115) return 'fair';
    if (rsrp >= -125) return 'poor';
    return 'unusable';
  }

  // ══════════════════════════════════════════════════════════════════════════
  // CARRIER UPLINK — the working inbound path
  // ══════════════════════════════════════════════════════════════════════════

  /**
   * Handle one carrier push.
   *
   * ALWAYS resolves and never throws. A push source that receives a 4xx/5xx
   * generally retries and many disable the destination after enough failures,
   * so this answers 200 with `success:false` — the same rule every other
   * inbound path on this platform follows (CLAUDE.md §4e).
   */
  async handleUplink(
    integrationId: string,
    body: any,
    routingKey?: string,
  ): Promise<NbIotUplinkResult> {
    try {
      const integration = await this.integrationRepo.findOne({
        where: {
          id: integrationId,
          status: IntegrationStatus.ACTIVE,
          enabled: true,
        },
      });

      if (
        !integration ||
        (integration.type !== IntegrationType.NBIOT_HTTP &&
          integration.type !== IntegrationType.NBIOT_COAP)
      ) {
        // Deliberately vague: this route is public, and confirming which ids
        // exist would let anyone enumerate a tenant's integrations.
        this.logger.warn(
          `NB-IoT uplink for unknown, inactive or wrong-typed integration ${integrationId}`,
        );
        return { success: false, message: 'Integration not available' };
      }

      const config = (integration.configuration ?? {}) as Record<string, any>;
      if (!this.verifyRoutingKey(config.routingKey, routingKey)) {
        this.logger.warn(
          `NB-IoT uplink rejected for "${integration.name}": bad routing key`,
        );
        return { success: false, message: 'Integration not available' };
      }

      const flat = this.flatten(body);
      const identity = this.extractIdentity(config, body, flat);
      if (!identity) {
        return {
          success: false,
          message:
            'No device identifier found. Expected one of imei, imsi, iccid, ' +
            'msisdn or deviceKey in the body (configure `identifierField` on ' +
            'the integration to name a different property).',
        };
      }

      const match = await this.resolveDevice(integration.tenantId, identity);
      if (!match) {
        // NOT auto-provisioning, for the reason the generic HTTP uplink gives:
        // an arbitrary push source can send any string, and creating a device
        // per unrecognised value would let a misconfigured sender exhaust the
        // tenant's device quota. A LoRaWAN DevEUI is auto-provisioned because
        // it is a globally unique hardware identity; an IMEI is too, but the
        // SIM has to be registered against a device here before telemetry has
        // anywhere to go.
        return {
          success: false,
          message: `No NB-IoT device registered with ${identity.field} "${identity.value}" in this organisation — add it under Connectivity → NB-IoT first`,
        };
      }

      const { row, device } = match;
      const signal = this.normaliseSignalMetrics(body, flat);
      const payload = this.extractPayload(config, body, flat);

      // Signal metrics become ordinary telemetry keys, so they chart, alarm
      // and export exactly like a temperature series. That is the requirement:
      // an operator should be able to put a threshold on RSRP without anything
      // special existing for it.
      const data: Record<string, any> = { ...payload };
      for (const [metric, key] of Object.entries(NBIOT_SIGNAL_KEYS)) {
        const value = signal[metric as keyof NbIotSignalMetrics];
        if (typeof value === 'number' && Number.isFinite(value)) {
          data[key] = value;
        }
      }

      if (Object.keys(data).length === 0) {
        return {
          success: false,
          message:
            'Uplink carried no readable payload and no radio metrics, so there ' +
            'was nothing to store.',
          deviceId: device.id,
          deviceKey: device.deviceKey,
          matchedBy: identity.field,
        };
      }

      const telemetry: StandardTelemetry = {
        deviceId: device.id,
        deviceKey: device.deviceKey,
        tenantId: integration.tenantId,
        customerId: device.customerId,
        data,
        // RSRP is the signal strength an NB-IoT operator means, so it is
        // promoted to the first-class field rather than left only as a key.
        signalStrength: signal.rsrp,
        timestamp: this.extractTimestamp(body, flat),
        receivedAt: Date.now(),
        protocol: 'http',
        metadata: {
          endpoint: `/nbiot/uplink/${integration.id}`,
          integrationId: integration.id,
          bearer: 'nb-iot',
          carrier: row.carrier ?? undefined,
          apn: row.apn ?? undefined,
          imei: row.imei ?? undefined,
          nbiotCellId: signal.cellId,
          nbiotTac: signal.tac,
          nbiotPlmn: signal.plmn ?? row.plmn ?? undefined,
          nbiotBand: signal.band ?? row.band ?? undefined,
          matchedBy: identity.field,
        } as StandardTelemetry['metadata'],
        rawPayload: body,
      };

      // The unified entry point — codec decode, device activity update, Kafka
      // publish, and therefore alarm evaluation and WebSocket broadcast.
      // Writing telemetry here instead is how the Tuya path ended up bypassing
      // alarms entirely (CLAUDE.md §4d).
      await this.deviceListener.handleTelemetry(telemetry);

      await this.recordUplink(row.id, signal);

      return {
        success: true,
        message: 'Uplink ingested',
        deviceId: device.id,
        deviceKey: device.deviceKey,
        matchedBy: identity.field,
        signal,
        telemetryKeys: Object.keys(data),
      };
    } catch (error: any) {
      this.logger.error(`NB-IoT uplink handling failed: ${error.message}`);
      return { success: false, message: 'Internal error processing uplink' };
    }
  }

  /**
   * Lift the radio metrics out of an arbitrary body and cache them on the row.
   *
   * ── NOTHING CALLS THIS YET. Read before wiring it in. ────────────────────
   *
   * A device that sends `{"temp":21,"rsrp":-95}` to UDP 5683 ALREADY ingests
   * through `CoAPAdapter` with no change — `rsrp` simply lands as a telemetry
   * key spelled the way the firmware spelled it. What this method would add on
   * that path is canonicalisation (so `signalPower` and `RSRP` both become
   * `nbiotRsrp`) and keeping the row's cached metrics current.
   *
   * It is not wired into `CoAPAdapter` or `MQTTService` because doing so costs
   * a `nbiot_devices` lookup on EVERY CoAP and MQTT message from every device
   * in the platform, for a feature only NB-IoT devices need. That belongs
   * behind the same kind of bounded, time-limited device cache
   * `IntegrationMqttInboundService` uses (60 s, 5000 entries), and adding an
   * unbounded lookup to the telemetry hot path first would be the wrong order.
   *
   * Until then: the carrier HTTP path canonicalises, the direct CoAP path does
   * not, and a dashboard reading a direct-CoAP device's signal has to use the
   * key the firmware sends.
   */
  async applyToTelemetry(
    tenantId: string,
    deviceId: string,
    data: Record<string, any>,
  ): Promise<Record<string, any>> {
    const row = await this.repo.findOne({ where: { tenantId, deviceId } });
    if (!row) return data;

    const signal = this.normaliseSignalMetrics(data, this.flatten(data));
    const enriched = { ...data };
    for (const [metric, key] of Object.entries(NBIOT_SIGNAL_KEYS)) {
      const value = signal[metric as keyof NbIotSignalMetrics];
      if (typeof value === 'number' && Number.isFinite(value)) {
        enriched[key] = value;
      }
    }
    await this.recordUplink(row.id, signal);
    return enriched;
  }

  /** Cache the last-known metrics. Never throws — it is bookkeeping. */
  private async recordUplink(
    rowId: string,
    signal: NbIotSignalMetrics,
  ): Promise<void> {
    try {
      await this.repo.update(rowId, {
        lastUplinkAt: new Date(),
        uplinkCount: () => '"uplinkCount" + 1',
        // Only overwrite what the uplink actually carried: a carrier that
        // omits RSRQ on some messages must not blank the last known value.
        ...(signal.rsrp !== undefined ? { lastRsrp: signal.rsrp } : {}),
        ...(signal.rsrq !== undefined ? { lastRsrq: signal.rsrq } : {}),
        ...(signal.sinr !== undefined ? { lastSinr: signal.sinr } : {}),
        ...(signal.ecl !== undefined ? { lastEcl: signal.ecl } : {}),
        ...(signal.coverageClass !== undefined
          ? { lastCoverageClass: signal.coverageClass }
          : {}),
        ...(signal.cellId !== undefined ? { lastCellId: signal.cellId } : {}),
        ...(signal.tac !== undefined ? { lastTac: signal.tac } : {}),
      } as any);
    } catch (error) {
      this.logger.debug(
        `NB-IoT row update failed for ${rowId}: ${(error as Error).message}`,
      );
    }
  }

  // ══════════════════════════════════════════════════════════════════════════
  // BODY PARSING
  // ══════════════════════════════════════════════════════════════════════════

  /**
   * Flatten a nested body to a single map of lowercased leaf name → value.
   *
   * Carriers nest differently and inconsistently — Huawei puts the payload
   * under `services[0].data`, others under `data` or `reported` — and the same
   * metric appears at a different depth per platform. Flattening once and
   * matching leaf names is what makes one alias table cover all of them
   * instead of one parser per carrier.
   *
   * Depth-capped: a hostile or runaway body must not be able to make this walk
   * forever, and nothing real nests radio metrics eight levels down.
   */
  private flatten(
    value: any,
    depth = 0,
    out: Record<string, any> = {},
  ): Record<string, any> {
    if (depth > 8 || value === null || typeof value !== 'object') return out;
    for (const [key, child] of Object.entries(value)) {
      const lower = key.toLowerCase();
      if (child !== null && typeof child === 'object') {
        this.flatten(child, depth + 1, out);
      } else if (!(lower in out)) {
        // First occurrence wins: the shallowest copy of a duplicated key is
        // the envelope's own, which is the one the carrier documents.
        out[lower] = child;
      }
    }
    return out;
  }

  private extractIdentity(
    config: Record<string, any>,
    body: any,
    flat: Record<string, any>,
  ): {
    field: 'imei' | 'imsi' | 'iccid' | 'msisdn' | 'deviceKey';
    value: string;
  } | null {
    const configured = config.identifierField as string | undefined;
    const candidates: Array<
      [string, 'imei' | 'imsi' | 'iccid' | 'msisdn' | 'deviceKey']
    > = [
      ...(configured
        ? ([[configured, this.fieldKindOf(configured)]] as Array<
            [string, 'imei' | 'imsi' | 'iccid' | 'msisdn' | 'deviceKey']
          >)
        : []),
      ['imei', 'imei'],
      ['imsi', 'imsi'],
      ['iccid', 'iccid'],
      ['msisdn', 'msisdn'],
      ['devicekey', 'deviceKey'],
      ['deviceid', 'deviceKey'],
      ['devicename', 'deviceKey'],
    ];

    for (const [name, kind] of candidates) {
      const raw = this.readPath(body, name) ?? flat[name.toLowerCase()];
      if (raw === undefined || raw === null) continue;
      const value = String(raw).trim();
      if (value) return { field: kind, value };
    }
    return null;
  }

  private fieldKindOf(
    name: string,
  ): 'imei' | 'imsi' | 'iccid' | 'msisdn' | 'deviceKey' {
    const lower = name.toLowerCase();
    if (lower.includes('imei')) return 'imei';
    if (lower.includes('imsi')) return 'imsi';
    if (lower.includes('iccid')) return 'iccid';
    if (lower.includes('msisdn')) return 'msisdn';
    return 'deviceKey';
  }

  /**
   * Resolve the SIM row and its device, tenant-scoped.
   *
   * Scoped by tenant on BOTH lookups. An IMEI is globally unique, but trusting
   * that to make the query unscoped is exactly the shape §4g found eight
   * times: it would let a push to one tenant's integration write telemetry
   * onto another tenant's device.
   */
  private async resolveDevice(
    tenantId: string,
    identity: { field: string; value: string },
  ): Promise<{ row: NbIotDevice; device: Device } | null> {
    if (identity.field === 'deviceKey') {
      const device = await this.deviceRepo.findOne({
        where: { deviceKey: identity.value, tenantId },
      });
      if (!device) return null;
      const row = await this.repo.findOne({
        where: { tenantId, deviceId: device.id, enabled: true },
      });
      if (!row) return null;
      return { row, device };
    }

    const row = await this.repo.findOne({
      where: {
        tenantId,
        enabled: true,
        [identity.field]: identity.value,
      } as any,
    });
    if (!row) return null;

    const device = await this.deviceRepo.findOne({
      where: { id: row.deviceId, tenantId },
    });
    if (!device) return null;
    return { row, device };
  }

  /**
   * Normalise whichever spelling of each metric the carrier chose.
   *
   * Values are sanity-checked against their physical ranges rather than taken
   * on trust. A carrier that reports RSRP as a positive 95 (dropping the
   * sign), or ECL as 255 when it means "unknown", would otherwise write a
   * nonsense point into a series an operator is about to alarm on.
   */
  normaliseSignalMetrics(
    body: any,
    flat?: Record<string, any>,
  ): NbIotSignalMetrics {
    const map = flat ?? this.flatten(body);
    const metrics: NbIotSignalMetrics = {};

    const pick = (metric: keyof NbIotSignalMetrics): any => {
      for (const alias of SIGNAL_ALIASES[metric]) {
        const direct = this.readPath(body, alias);
        if (direct !== undefined && direct !== null) return direct;
        const flattened = map[alias.toLowerCase()];
        if (flattened !== undefined && flattened !== null) return flattened;
      }
      return undefined;
    };

    const numeric = (value: any): number | undefined => {
      if (value === undefined || value === null || value === '') return undefined;
      const parsed = typeof value === 'number' ? value : Number(value);
      return Number.isFinite(parsed) ? parsed : undefined;
    };

    // RSRP: -156 … -31 dBm in 3GPP terms. A positive value is a dropped sign,
    // which is common enough to be worth correcting rather than discarding.
    let rsrp = numeric(pick('rsrp'));
    if (rsrp !== undefined && rsrp > 0 && rsrp <= 156) rsrp = -rsrp;
    if (rsrp !== undefined && rsrp >= -160 && rsrp <= -20) metrics.rsrp = rsrp;

    // RSRQ: -34 … 2.5 dB.
    let rsrq = numeric(pick('rsrq'));
    if (rsrq !== undefined && rsrq > 3 && rsrq <= 34) rsrq = -rsrq;
    if (rsrq !== undefined && rsrq >= -40 && rsrq <= 5) metrics.rsrq = rsrq;

    // SINR: roughly -20 … 40 dB.
    const sinr = numeric(pick('sinr'));
    if (sinr !== undefined && sinr >= -30 && sinr <= 50) metrics.sinr = sinr;

    // ECL: 0, 1 or 2. 255 is the modules' "unknown", not a level.
    const ecl = numeric(pick('ecl'));
    if (ecl !== undefined && ecl >= 0 && ecl <= 2) metrics.ecl = ecl;

    const coverageClass = numeric(pick('coverageClass'));
    if (
      coverageClass !== undefined &&
      coverageClass >= 0 &&
      coverageClass <= 10
    ) {
      metrics.coverageClass = coverageClass;
    }

    const txPower = numeric(pick('txPower'));
    if (txPower !== undefined && txPower >= -60 && txPower <= 50) {
      metrics.txPower = txPower;
    }

    const band = numeric(pick('band'));
    if (band !== undefined && band >= 1 && band <= 255) metrics.band = band;

    for (const field of ['cellId', 'tac', 'plmn'] as const) {
      const raw = pick(field);
      if (raw === undefined || raw === null) continue;
      const value = String(raw).trim();
      if (value && value.length <= 32) metrics[field] = value;
    }

    return metrics;
  }

  /**
   * The application payload, with the envelope's own fields removed.
   *
   * Without the subtraction every uplink would store `imei`, `routingKey` and
   * the carrier's internal ids as telemetry keys, which is how a device ends
   * up with 30 series nobody asked for.
   */
  private extractPayload(
    config: Record<string, any>,
    body: any,
    flat: Record<string, any>,
  ): Record<string, any> {
    const configuredField = config.dataField as string | undefined;
    if (configuredField) {
      const extracted = this.readPath(body, configuredField);
      if (extracted && typeof extracted === 'object') {
        return extracted as Record<string, any>;
      }
      if (extracted !== undefined && extracted !== null) {
        // A scalar — usually a hex or base64 frame. Named `rawPayload` so the
        // codec registry picks it up the way it does for LoRaWAN.
        return { rawPayload: extracted };
      }
    }

    for (const path of NESTED_PAYLOAD_PATHS) {
      const nested = this.readPath(body, path);
      if (nested && typeof nested === 'object' && !Array.isArray(nested)) {
        return this.stripEnvelope(nested as Record<string, any>);
      }
      if (typeof nested === 'string' && nested.trim()) {
        return { rawPayload: nested.trim() };
      }
    }

    return this.stripEnvelope(flat);
  }

  private stripEnvelope(source: Record<string, any>): Record<string, any> {
    const drop = new Set(
      [
        'imei',
        'imsi',
        'iccid',
        'msisdn',
        'routingkey',
        'devicekey',
        'deviceid',
        'devicename',
        'apn',
        'carrier',
        'timestamp',
        'time',
        'ts',
        'received_at',
        'receivedat',
        'eventtime',
        // The radio metrics are re-added under their canonical keys, so the
        // carrier's own spelling is dropped to avoid storing both.
        ...Object.values(SIGNAL_ALIASES).flat().map((a) => a.toLowerCase()),
      ].map((key) => key.toLowerCase()),
    );

    const out: Record<string, any> = {};
    for (const [key, value] of Object.entries(source)) {
      if (drop.has(key.toLowerCase())) continue;
      if (value === null || value === undefined) continue;
      out[key] = value;
    }
    return out;
  }

  private readPath(body: any, path: string): unknown {
    if (!body || typeof body !== 'object') return undefined;
    if (!path.includes('.')) return body[path];
    return path
      .split('.')
      .reduce<any>(
        (node, part) => (node == null ? undefined : node[part]),
        body,
      );
  }

  private extractTimestamp(body: any, flat: Record<string, any>): Date {
    const raw =
      this.readPath(body, 'timestamp') ??
      this.readPath(body, 'eventTime') ??
      flat['timestamp'] ??
      flat['eventtime'] ??
      flat['time'] ??
      flat['ts'] ??
      flat['received_at'] ??
      null;
    if (!raw) return new Date();

    if (typeof raw === 'number') {
      // Epoch seconds vs milliseconds: anything below ~2001 expressed in ms is
      // almost certainly seconds that were not multiplied.
      const ms = raw < 1_000_000_000_000 ? raw * 1000 : raw;
      const date = new Date(ms);
      return Number.isNaN(date.getTime()) ? new Date() : date;
    }

    const date = new Date(String(raw));
    return Number.isNaN(date.getTime()) ? new Date() : date;
  }

  /**
   * Constant-time routing-key comparison.
   *
   * `timingSafeEqual` throws on a length mismatch, so lengths are compared
   * first — which leaks the key's length, and is accepted for the same reason
   * `IntegrationUplinkService` accepts it: a routing key is not a password.
   */
  private verifyRoutingKey(expected?: string, provided?: string): boolean {
    if (!expected || !provided) return false;
    const a = Buffer.from(expected);
    const b = Buffer.from(provided);
    if (a.length !== b.length) return false;
    return crypto.timingSafeEqual(a, b);
  }

  // ══════════════════════════════════════════════════════════════════════════
  // GUARDS
  // ══════════════════════════════════════════════════════════════════════════

  private async assertDeviceInTenant(
    deviceId: string,
    tenantId: string,
  ): Promise<void> {
    const device = await this.deviceRepo.findOne({
      where: { id: deviceId, tenantId },
    });
    if (!device) throw new NotFoundException('Device not found');
  }

  private async assertDeviceNotClaimed(
    tenantId: string,
    deviceId: string,
    exceptId?: string,
  ): Promise<void> {
    const clash = await this.repo.findOne({
      where: {
        tenantId,
        deviceId,
        ...(exceptId ? { id: Not(exceptId) } : {}),
        deletedAt: IsNull(),
      },
    });
    if (clash) {
      throw new ConflictException(
        'That device already has an NB-IoT SIM record. Edit the existing one ' +
          'rather than adding a second — two records would both claim the same ' +
          'uplinks.',
      );
    }
  }

  /**
   * IMEI / IMSI / ICCID are globally unique identifiers, so a duplicate inside
   * one tenant means a typo. Caught here, where it can still be corrected,
   * rather than at the uplink where it would silently resolve to whichever row
   * the query happened to return first.
   */
  private async assertIdentifiersFree(
    tenantId: string,
    dto: Partial<CreateNbIotDeviceDto>,
    exceptId?: string,
  ): Promise<void> {
    for (const field of ['imei', 'imsi', 'iccid'] as const) {
      const value = dto[field];
      if (!value) continue;
      const clash = await this.repo.findOne({
        where: {
          tenantId,
          [field]: value,
          ...(exceptId ? { id: Not(exceptId) } : {}),
          deletedAt: IsNull(),
        } as any,
      });
      if (clash) {
        throw new ConflictException(
          `${field.toUpperCase()} "${value}" is already registered in this organisation`,
        );
      }
    }
    if (!dto.imei && !dto.imsi && !dto.iccid && !dto.msisdn && !exceptId) {
      throw new BadRequestException(
        'Give at least one of IMEI, IMSI, ICCID or MSISDN — without one the ' +
          'carrier push endpoint has nothing to match the uplink against.',
      );
    }
  }
}
