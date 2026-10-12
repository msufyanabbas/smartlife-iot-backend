// src/modules/protocols/adapters/snmp.adapter.ts
// SNMP Protocol Adapter — a real polling loop for devices whose profile
// declares transportType = SNMP.

import {
  Injectable,
  OnModuleInit,
  OnModuleDestroy,
  Logger,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { IsNull, Repository } from 'typeorm';
import {
  StandardTelemetry,
  IProtocolAdapter,
} from '@/common/interfaces/standard-telemetry.interface';
import { DeviceListenerService } from '@/modules/protocols/device-listener.service';
import { Device } from '@modules/devices/entities/device.entity';
import { DeviceProfile } from '@modules/profiles/entities/device-profile.entity';
import { DeviceTransportType } from '@common/enums/index.enum';
import type { SnmpTransportConfig } from '@common/interfaces/device-profile.interface';
import * as snmp from 'net-snmp';

/**
 * SNMPv3 user-based security parameters.
 *
 * `SnmpTransportConfig` in `@common/interfaces/device-profile.interface` models
 * v1/v2c (a community string) but has no v3 fields, and that interface belongs
 * to another area of the codebase. The jsonb column is structurally typed, so
 * v3 settings are read from an additional `v3` object on the same `snmp`
 * sub-object and described here instead of widening the shared interface.
 *
 * Shape expected under `transportConfiguration.snmp.v3`:
 *   {
 *     "username":      "monitor",
 *     "securityLevel": "authPriv",       // noAuthNoPriv | authNoPriv | authPriv
 *     "authProtocol":  "sha",            // md5 | sha | sha224 | sha256 | sha384 | sha512
 *     "authKey":       "…",
 *     "privProtocol":  "aes",            // des | aes | aes256b | aes256r
 *     "privKey":       "…",
 *     "context":       ""                // optional SNMPv3 context name
 *   }
 */
export interface SnmpV3Config {
  username?: string;
  securityLevel?: 'noAuthNoPriv' | 'authNoPriv' | 'authPriv';
  authProtocol?: 'md5' | 'sha' | 'sha224' | 'sha256' | 'sha384' | 'sha512';
  authKey?: string;
  privProtocol?: 'des' | 'aes' | 'aes256b' | 'aes256r';
  privKey?: string;
  context?: string;
}

/** The profile's `snmp` block, plus the v3 extension described above. */
export type SnmpDeviceConfig = SnmpTransportConfig & {
  v3?: SnmpV3Config;
  /** Agent address override. Normally taken from `Device.ipAddress`. */
  host?: string;
};

/** One OID → telemetry-key mapping, after defaults have been applied. */
interface ResolvedOidMapping {
  oid: string;
  key: string;
  dataType: 'string' | 'number' | 'boolean';
}

/** Everything needed to poll one device, resolved once per refresh. */
interface SnmpTarget {
  deviceId: string;
  deviceKey: string;
  tenantId?: string;
  customerId?: string;
  host: string;
  port: number;
  version: 'v1' | 'v2c' | 'v3';
  community: string;
  v3?: SnmpV3Config;
  timeoutMs: number;
  retries: number;
  pollPeriodMs: number;
  oidMappings: ResolvedOidMapping[];
  /** Codec hints carried through to DeviceListenerService. */
  codecId?: string;
  manufacturer?: string;
  model?: string;
}

/** Per-device scheduler state. */
interface ScheduledPoll {
  target: SnmpTarget;
  timer: NodeJS.Timeout | null;
  /** A poll already in flight — the next tick is skipped rather than queued. */
  inFlight: boolean;
  /** Set when the scheduler is torn down, so a late callback does not reschedule. */
  cancelled: boolean;
  consecutiveFailures: number;
}

/** Outcome of one device poll, returned so tests can assert on it. */
export interface SnmpPollResult {
  deviceKey: string;
  ok: boolean;
  /** Telemetry keys → values that were handed to DeviceListenerService. */
  values: Record<string, any>;
  error?: string;
  durationMs: number;
}

const DEFAULT_PORT = 161;
const DEFAULT_VERSION: 'v2c' = 'v2c';
const DEFAULT_COMMUNITY = 'public';
const DEFAULT_POLL_PERIOD_SECONDS = 60;
const DEFAULT_TIMEOUT_MS = 5000;
const DEFAULT_RETRIES = 2;

/** Floor on the poll period, so a mis-typed `1` cannot become a packet flood. */
const MIN_POLL_PERIOD_SECONDS = 5;

/**
 * Hard ceiling on one poll, independent of the SNMP library's own timeout.
 * `session.get()` is callback-based: if the socket errors in a way that never
 * invokes the callback, the promise would never settle and the device's
 * scheduler would stop forever. This bounds that.
 */
const POLL_WALL_CLOCK_MARGIN_MS = 2000;

/**
 * SNMP Adapter — polling, not listening
 *
 * Every other transport in this platform is push: the device connects and
 * sends. SNMP inverts that — the platform reaches out to an agent and reads
 * OIDs — so this adapter is a scheduler rather than a server.
 *
 * ── What drives a poll ────────────────────────────────────────────────────
 * A device is polled when it has a `deviceProfileId` whose profile has
 * `transportType = 'SNMP'`. The profile's `transportConfiguration.snmp` block
 * supplies the OID list, version, credentials and poll period;
 * `Device.configuration.snmp` may override `host`, `port`, `community` and
 * `pollPeriodSeconds` per device. The agent address is `Device.ipAddress`
 * unless overridden — a device with no address is skipped and logged, never
 * guessed at.
 *
 * ── Where readings go ─────────────────────────────────────────────────────
 * Straight into `DeviceListenerService.handleTelemetry()`, the same unified
 * entry point MQTT, HTTP and CoAP use. That is deliberate: it is what gives
 * SNMP readings the codec decode, the device-activity update, the Kafka
 * publish and therefore alarm evaluation and WebSocket broadcast. Writing
 * telemetry rows directly from here would reproduce the Tuya bug where a
 * second persistence path silently skipped alarms (CLAUDE.md §4d).
 *
 * ── Isolation between devices ─────────────────────────────────────────────
 * There is no shared poll loop. Each device gets its own self-rescheduling
 * timer and its own SNMP session, and every poll is wrapped in a wall-clock
 * timeout. A dead agent therefore costs exactly one device its reading; it
 * cannot delay or stall any other device's schedule.
 *
 * ── Environment ───────────────────────────────────────────────────────────
 *   SNMP_ENABLED=false            disable entirely — nothing is scheduled and
 *                                 no DB query runs
 *   SNMP_REFRESH_SECONDS=60       how often the target list is reloaded
 *   SNMP_MAX_DEVICES=500          safety cap on concurrently polled devices
 */
@Injectable()
export class SnmpAdapter
  implements IProtocolAdapter, OnModuleInit, OnModuleDestroy
{
  protocol = 'snmp';
  private readonly logger = new Logger(SnmpAdapter.name);

  private readonly enabled: boolean;
  private readonly refreshIntervalMs: number;
  private readonly maxDevices: number;

  private readonly scheduled = new Map<string, ScheduledPoll>();
  private refreshTimer: NodeJS.Timeout | null = null;
  private isStarted = false;

  constructor(
    private readonly deviceListener: DeviceListenerService,
    @InjectRepository(Device)
    private readonly deviceRepository: Repository<Device>,
    @InjectRepository(DeviceProfile)
    private readonly profileRepository: Repository<DeviceProfile>,
    private readonly configService: ConfigService,
  ) {
    // Consistent with COAP_ENABLED: on unless explicitly switched off.
    this.enabled = this.configService.get<string>('SNMP_ENABLED') !== 'false';
    this.refreshIntervalMs =
      Number(this.configService.get<string>('SNMP_REFRESH_SECONDS') ?? 60) *
      1000;
    this.maxDevices = Number(
      this.configService.get<string>('SNMP_MAX_DEVICES') ?? 500,
    );
  }

  // ── Lifecycle ─────────────────────────────────────────────────────────────

  async onModuleInit(): Promise<void> {
    if (!this.enabled) {
      // Deliberately the only thing that happens when disabled: no refresh
      // timer, no device query, no sockets.
      this.logger.warn('SNMP poller disabled (SNMP_ENABLED=false)');
      return;
    }
    await this.start();
  }

  async onModuleDestroy(): Promise<void> {
    await this.stop();
  }

  async start(): Promise<void> {
    if (this.isStarted) {
      this.logger.warn('SNMP poller already started');
      return;
    }
    this.isStarted = true;

    await this.refreshTargets();

    this.refreshTimer = setInterval(() => {
      void this.refreshTargets().catch((error) =>
        this.logger.error(
          `SNMP target refresh failed: ${(error as Error).message}`,
        ),
      );
    }, this.refreshIntervalMs);
    // Do not hold the event loop open purely for the refresh tick.
    this.refreshTimer.unref?.();

    this.logger.log(
      `SNMP poller started — ${this.scheduled.size} device(s), refresh every ${this.refreshIntervalMs / 1000}s`,
    );
  }

  async stop(): Promise<void> {
    if (this.refreshTimer) {
      clearInterval(this.refreshTimer);
      this.refreshTimer = null;
    }
    for (const entry of this.scheduled.values()) {
      entry.cancelled = true;
      if (entry.timer) clearTimeout(entry.timer);
      entry.timer = null;
    }
    this.scheduled.clear();
    this.isStarted = false;
    this.logger.log('SNMP poller stopped');
  }

  // ── Target discovery ──────────────────────────────────────────────────────

  /**
   * Reload the set of SNMP devices and reconcile the schedulers:
   * new devices start polling, removed devices are cancelled, and a device
   * whose config changed is rescheduled on its new period.
   *
   * Exposed (rather than private) so a verification script can drive one
   * refresh without waiting for the interval.
   */
  async refreshTargets(): Promise<SnmpTarget[]> {
    const profiles = await this.profileRepository.find({
      where: { transportType: DeviceTransportType.SNMP, deletedAt: IsNull() },
    });

    if (profiles.length === 0) {
      this.reconcile([]);
      return [];
    }

    const byProfileId = new Map(profiles.map((p) => [p.id, p]));

    const devices = await this.deviceRepository
      .createQueryBuilder('device')
      .where('device.deviceProfileId IN (:...profileIds)', {
        profileIds: [...byProfileId.keys()],
      })
      .andWhere('device.deletedAt IS NULL')
      .take(this.maxDevices)
      .getMany();

    const targets: SnmpTarget[] = [];
    for (const device of devices) {
      const profile = byProfileId.get(device.deviceProfileId!);
      if (!profile) continue;
      const target = this.resolveTarget(device, profile);
      if (target) targets.push(target);
    }

    this.reconcile(targets);
    return targets;
  }

  /**
   * Merge profile config with per-device overrides into a pollable target, or
   * return null (with a reason logged) when the device cannot be polled.
   */
  resolveTarget(device: Device, profile: DeviceProfile): SnmpTarget | null {
    const profileSnmp = (profile.transportConfiguration?.snmp ??
      {}) as SnmpDeviceConfig;
    const deviceSnmp = (device.configuration?.snmp ?? {}) as SnmpDeviceConfig;

    const oidMappings = this.resolveOidMappings(
      deviceSnmp.oidMappings ?? profileSnmp.oidMappings,
    );
    if (oidMappings.length === 0) {
      this.logger.warn(
        `SNMP device ${device.deviceKey} skipped — profile '${profile.name}' declares no oidMappings`,
      );
      return null;
    }

    const host = deviceSnmp.host ?? device.ipAddress;
    if (!host) {
      this.logger.warn(
        `SNMP device ${device.deviceKey} skipped — no agent address. Set the device's ipAddress or configuration.snmp.host.`,
      );
      return null;
    }

    const version = (deviceSnmp.version ??
      profileSnmp.version ??
      DEFAULT_VERSION) as 'v1' | 'v2c' | 'v3';

    const v3 = deviceSnmp.v3 ?? profileSnmp.v3;
    if (version === 'v3' && !v3?.username) {
      this.logger.warn(
        `SNMP device ${device.deviceKey} skipped — version is v3 but no transportConfiguration.snmp.v3.username is set`,
      );
      return null;
    }

    const pollPeriodSeconds = Math.max(
      MIN_POLL_PERIOD_SECONDS,
      Number(
        deviceSnmp.pollPeriodSeconds ??
          profileSnmp.pollPeriodSeconds ??
          DEFAULT_POLL_PERIOD_SECONDS,
      ),
    );

    return {
      deviceId: device.id,
      deviceKey: device.deviceKey,
      tenantId: device.tenantId,
      customerId: device.customerId,
      host,
      port: Number(deviceSnmp.port ?? profileSnmp.port ?? DEFAULT_PORT),
      version,
      community:
        deviceSnmp.community ?? profileSnmp.community ?? DEFAULT_COMMUNITY,
      v3,
      timeoutMs: Number(
        deviceSnmp.timeoutMs ?? profileSnmp.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      ),
      retries: Number(
        deviceSnmp.retries ?? profileSnmp.retries ?? DEFAULT_RETRIES,
      ),
      pollPeriodMs: pollPeriodSeconds * 1000,
      oidMappings,
      codecId: device.metadata?.codecId as string | undefined,
      manufacturer:
        (device.metadata?.manufacturer as string | undefined) ??
        device.manufacturer,
      model: (device.metadata?.model as string | undefined) ?? device.model,
    };
  }

  private resolveOidMappings(
    raw: SnmpTransportConfig['oidMappings'],
  ): ResolvedOidMapping[] {
    if (!Array.isArray(raw)) return [];
    return raw
      .filter((m) => m && typeof m.oid === 'string' && m.oid.length > 0)
      .map((m) => ({
        oid: m.oid.trim(),
        // A mapping without a key is useless as telemetry; fall back to the
        // OID itself so the reading is at least visible rather than dropped.
        key: m.key && m.key.length > 0 ? m.key : m.oid.trim(),
        dataType: m.dataType ?? 'number',
      }));
  }

  // ── Scheduling ────────────────────────────────────────────────────────────

  private reconcile(targets: SnmpTarget[]): void {
    const seen = new Set<string>();

    for (const target of targets) {
      seen.add(target.deviceId);
      const existing = this.scheduled.get(target.deviceId);

      if (!existing) {
        const entry: ScheduledPoll = {
          target,
          timer: null,
          inFlight: false,
          cancelled: false,
          consecutiveFailures: 0,
        };
        this.scheduled.set(target.deviceId, entry);
        // Stagger first polls so N devices do not all fire on the same tick.
        this.arm(entry, Math.floor(Math.random() * 1000));
        continue;
      }

      const periodChanged = existing.target.pollPeriodMs !== target.pollPeriodMs;
      existing.target = target;
      if (periodChanged && existing.timer) {
        clearTimeout(existing.timer);
        this.arm(existing, target.pollPeriodMs);
      }
    }

    for (const [deviceId, entry] of this.scheduled) {
      if (seen.has(deviceId)) continue;
      entry.cancelled = true;
      if (entry.timer) clearTimeout(entry.timer);
      this.scheduled.delete(deviceId);
      this.logger.log(
        `SNMP polling stopped for ${entry.target.deviceKey} (no longer an SNMP device)`,
      );
    }
  }

  /**
   * Arm one device's next poll.
   *
   * Each device re-arms itself only *after* its own poll has settled, so a
   * slow agent stretches its own interval and nothing else. There is no shared
   * `setInterval` whose tick could be blocked by another device.
   */
  private arm(entry: ScheduledPoll, delayMs: number): void {
    if (entry.cancelled) return;
    entry.timer = setTimeout(() => {
      void this.tick(entry);
    }, delayMs);
    entry.timer.unref?.();
  }

  private async tick(entry: ScheduledPoll): Promise<void> {
    if (entry.cancelled) return;

    if (entry.inFlight) {
      // Should not happen (re-arm is post-settle) but is cheap insurance
      // against a double-armed timer polling the same agent twice at once.
      this.arm(entry, entry.target.pollPeriodMs);
      return;
    }

    entry.inFlight = true;
    let result: SnmpPollResult;
    try {
      result = await this.pollTarget(entry.target);
    } finally {
      entry.inFlight = false;
    }

    if (result.ok) {
      entry.consecutiveFailures = 0;
    } else {
      entry.consecutiveFailures += 1;
      // Log the first few failures at warn, then back off to debug so one
      // permanently dead agent cannot dominate the log.
      const message = `SNMP poll failed for ${entry.target.deviceKey} (${entry.target.host}:${entry.target.port}): ${result.error}`;
      if (entry.consecutiveFailures <= 3) this.logger.warn(message);
      else this.logger.debug(`${message} [x${entry.consecutiveFailures}]`);
    }

    this.arm(entry, entry.target.pollPeriodMs);
  }

  // ── Polling one device ────────────────────────────────────────────────────

  /**
   * Poll one target once and, on success, hand the readings to
   * `DeviceListenerService.handleTelemetry()`.
   *
   * Never throws: a failure is reported in the returned result so the caller's
   * scheduler keeps running. Exposed for the verification script.
   */
  async pollTarget(target: SnmpTarget): Promise<SnmpPollResult> {
    const startedAt = Date.now();
    let varbinds: snmp.Varbind[];

    try {
      varbinds = await this.snmpGet(target);
    } catch (error) {
      return {
        deviceKey: target.deviceKey,
        ok: false,
        values: {},
        error: (error as Error).message,
        durationMs: Date.now() - startedAt,
      };
    }

    const values = this.mapVarbinds(target, varbinds);

    if (Object.keys(values).length === 0) {
      return {
        deviceKey: target.deviceKey,
        ok: false,
        values,
        error: 'agent answered but every requested OID errored',
        durationMs: Date.now() - startedAt,
      };
    }

    // The unified path — codec decode, activity update, Kafka, alarms, WS.
    await this.deviceListener.handleTelemetry(this.parse(values, target));

    this.logger.log(
      `SNMP poll ok — device: ${target.deviceKey}, keys: [${Object.keys(values).join(', ')}]`,
    );

    return {
      deviceKey: target.deviceKey,
      ok: true,
      values,
      durationMs: Date.now() - startedAt,
    };
  }

  /**
   * One SNMP GET, promisified, with a wall-clock guard and guaranteed session
   * close. The guard exists because `session.get()` is callback-based and a
   * socket-level failure can leave the callback uncalled — without it the
   * device's scheduler would never re-arm.
   */
  private snmpGet(target: SnmpTarget): Promise<snmp.Varbind[]> {
    return new Promise<snmp.Varbind[]>((resolve, reject) => {
      const options: snmp.SessionOptions = {
        port: target.port,
        timeout: target.timeoutMs,
        retries: target.retries,
        version: this.toSnmpVersion(target.version),
      };

      let session: snmp.Session;
      try {
        session =
          target.version === 'v3'
            ? snmp.createV3Session(
                target.host,
                this.toV3User(target.v3!),
                target.v3?.context
                  ? { ...options, context: target.v3.context }
                  : options,
              )
            : snmp.createSession(target.host, target.community, options);
      } catch (error) {
        reject(error as Error);
        return;
      }

      let settled = false;
      const finish = (error: Error | null, result?: snmp.Varbind[]) => {
        if (settled) return;
        settled = true;
        clearTimeout(wallClock);
        try {
          session.close();
        } catch {
          // Closing an already-torn-down session is not interesting.
        }
        if (error) reject(error);
        else resolve(result ?? []);
      };

      // (timeout + 1) * (retries + 1) is net-snmp's own worst case; the margin
      // covers scheduling jitter.
      const budget =
        target.timeoutMs * (target.retries + 1) + POLL_WALL_CLOCK_MARGIN_MS;
      const wallClock = setTimeout(
        () =>
          finish(
            new Error(
              `no response within ${budget}ms (timeout ${target.timeoutMs}ms x ${target.retries + 1} attempts)`,
            ),
          ),
        budget,
      );
      wallClock.unref?.();

      // net-snmp emits 'error' on the session for socket-level problems that
      // do not route through the get() callback.
      session.on('error', (error: Error) => finish(error));

      try {
        session.get(
          target.oidMappings.map((m) => m.oid),
          (error, result) => finish(error, result),
        );
      } catch (error) {
        finish(error as Error);
      }
    });
  }

  /** Varbinds → telemetry keys, dropping (and logging) per-OID errors. */
  private mapVarbinds(
    target: SnmpTarget,
    varbinds: snmp.Varbind[],
  ): Record<string, any> {
    const values: Record<string, any> = {};

    varbinds.forEach((varbind, index) => {
      // net-snmp returns varbinds in request order, so index maps the mapping.
      const mapping = target.oidMappings[index];
      if (!mapping) return;

      if (snmp.isVarbindError(varbind)) {
        this.logger.debug(
          `SNMP ${target.deviceKey} OID ${mapping.oid} (${mapping.key}): ${snmp.varbindError(varbind)}`,
        );
        return;
      }

      const coerced = this.coerce(varbind.value, mapping.dataType);
      if (coerced !== undefined) values[mapping.key] = coerced;
    });

    return values;
  }

  /**
   * SNMP values arrive as Buffers (OctetString), numbers, or BigInt
   * (Counter64). Coerce to the declared telemetry type; an un-coercible value
   * is dropped rather than stored as NaN.
   */
  private coerce(
    value: any,
    dataType: 'string' | 'number' | 'boolean',
  ): any | undefined {
    const asString = Buffer.isBuffer(value)
      ? value.toString('utf8')
      : typeof value === 'bigint'
        ? value.toString()
        : value;

    switch (dataType) {
      case 'string':
        return asString === null || asString === undefined
          ? undefined
          : String(asString);
      case 'boolean':
        if (typeof asString === 'boolean') return asString;
        if (typeof asString === 'number') return asString !== 0;
        if (typeof asString === 'string') {
          const lowered = asString.trim().toLowerCase();
          if (['1', 'true', 'up', 'on', 'yes'].includes(lowered)) return true;
          if (['0', 'false', 'down', 'off', 'no'].includes(lowered))
            return false;
        }
        return undefined;
      case 'number':
      default: {
        const numeric =
          typeof asString === 'number' ? asString : Number(asString);
        return Number.isFinite(numeric) ? numeric : undefined;
      }
    }
  }

  private toSnmpVersion(version: 'v1' | 'v2c' | 'v3'): number {
    switch (version) {
      case 'v1':
        return snmp.Version1;
      case 'v3':
        return snmp.Version3;
      case 'v2c':
      default:
        return snmp.Version2c;
    }
  }

  private toV3User(v3: SnmpV3Config): snmp.V3User {
    const level =
      snmp.SecurityLevel[v3.securityLevel ?? 'noAuthNoPriv'] ??
      snmp.SecurityLevel.noAuthNoPriv;

    const user: snmp.V3User = { name: v3.username!, level };
    if (v3.authProtocol) user.authProtocol = snmp.AuthProtocols[v3.authProtocol];
    if (v3.authKey) user.authKey = v3.authKey;
    if (v3.privProtocol) user.privProtocol = snmp.PrivProtocols[v3.privProtocol];
    if (v3.privKey) user.privKey = v3.privKey;
    return user;
  }

  // ── StandardTelemetry mapping ─────────────────────────────────────────────

  parse(rawPayload: any, context?: any): StandardTelemetry {
    const target: Partial<SnmpTarget> = context ?? {};
    const payload: Record<string, any> = rawPayload ?? {};

    return {
      deviceId: target.deviceId ?? '',
      deviceKey: target.deviceKey ?? '',
      tenantId: target.tenantId,
      customerId: target.customerId,
      data: payload,
      temperature: payload.temperature ?? payload.temp,
      humidity: payload.humidity ?? payload.hum,
      pressure: payload.pressure,
      batteryLevel: payload.battery ?? payload.batteryLevel ?? payload.bat,
      signalStrength: payload.rssi ?? payload.signalStrength,
      timestamp: new Date().toISOString(),
      receivedAt: Date.now(),
      // StandardTelemetry.protocol is a closed literal union declared in
      // @common/interfaces/standard-telemetry.interface, which this module does
      // not own. 'snmp' is the honest value and is what reaches Kafka and the
      // telemetry row; the cast only satisfies that union. Adding
      // 'snmp' | 'lwm2m' to it is the real fix — see this agent's report.
      protocol: 'snmp' as StandardTelemetry['protocol'],
      metadata: {
        snmpHost: target.host,
        snmpPort: target.port,
        snmpVersion: target.version,
        polled: true,
        codecId: target.codecId,
        manufacturer: target.manufacturer,
        model: target.model,
      },
      rawPayload: payload,
    };
  }

  // ── Introspection (used by the verification script and by ops) ────────────

  /** Device keys currently scheduled, with their effective poll period. */
  getScheduledTargets(): Array<{
    deviceKey: string;
    host: string;
    port: number;
    version: string;
    pollPeriodSeconds: number;
    oids: string[];
    consecutiveFailures: number;
  }> {
    return [...this.scheduled.values()].map((entry) => ({
      deviceKey: entry.target.deviceKey,
      host: entry.target.host,
      port: entry.target.port,
      version: entry.target.version,
      pollPeriodSeconds: entry.target.pollPeriodMs / 1000,
      oids: entry.target.oidMappings.map((m) => m.oid),
      consecutiveFailures: entry.consecutiveFailures,
    }));
  }

  isEnabled(): boolean {
    return this.enabled;
  }
}
