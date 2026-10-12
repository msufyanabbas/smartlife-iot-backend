// src/modules/protocols/lwm2m/lwm2m.service.ts
//
// LwM2M Registration + client-initiated reporting, on top of the existing
// CoAP server (UDP 5683, CoAPAdapter).
//
// ─── SCOPE — read this before assuming anything works ─────────────────────
// Implemented:  Register (POST /rd), Update (POST /rd/:id),
//               De-register (DELETE /rd/:id), Send (POST /dp, SenML JSON),
//               registration-lifetime expiry marking the device offline.
// NOT here:     Observe/Notify, server-initiated Read/Write/Execute/Create/
//               Delete/Discover, Bootstrap, DTLS (coaps://), SenML CBOR/TLV,
//               Queue Mode.
// The authoritative, frontend-consumable version of that list is
// `lwm2m.scope.ts` (served by `GET /lwm2m/capabilities`). Keep the two in sync.
//
// Nothing in this file ever sends a request *to* a client. That is the single
// line that separates what is built from what is not.

import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { randomUUID } from 'crypto';
import { Device } from '@modules/devices/entities/device.entity';
import { DeviceStatus } from '@common/enums/index.enum';
import { StandardTelemetry } from '@common/interfaces/standard-telemetry.interface';
import { DeviceListenerService } from '@/modules/protocols/device-listener.service';
import { LWM2M_SERVER_VERSION } from './lwm2m.scope';

/** One object/instance the client advertised in its registration payload. */
export interface Lwm2mObjectLink {
  /** e.g. "/3/0" or "/3303/0" */
  path: string;
  /** Link-format attributes, e.g. { ct: '110', rt: 'oma.lwm2m' } */
  attributes: Record<string, string>;
}

/** A live LwM2M client registration. */
export interface Lwm2mRegistration {
  registrationId: string;
  /** LwM2M endpoint name == the platform's deviceKey. */
  endpoint: string;
  deviceId: string;
  tenantId?: string;
  customerId?: string;
  /** Seconds. */
  lifetime: number;
  /** "U" | "UQ" | "T" | … — recorded, not acted on (Queue Mode is out of scope). */
  binding: string;
  lwm2mVersion: string;
  objectLinks: Lwm2mObjectLink[];
  /** Source address of the registration, for /dp identification without DTLS. */
  address?: string;
  port?: number;
  registeredAt: Date;
  lastUpdateAt: Date;
  /** registeredAt/lastUpdateAt + lifetime + grace. */
  expiresAt: Date;
}

/** Public, serialisable view — what the controller and frontend see. */
export interface Lwm2mRegistrationView
  extends Omit<Lwm2mRegistration, 'registeredAt' | 'lastUpdateAt' | 'expiresAt'> {
  registeredAt: string;
  lastUpdateAt: string;
  expiresAt: string;
  secondsUntilExpiry: number;
}

/** Result of a registration attempt, mapped to a CoAP code by the adapter. */
export type Lwm2mResult<T = void> =
  | { ok: true; value: T }
  | { ok: false; code: '4.00' | '4.03' | '4.04' | '5.00'; error: string };

export interface RegisterParams {
  /** `ep` query parameter. Required. */
  endpoint?: string;
  /** `lt` query parameter, seconds. */
  lifetime?: number;
  /** `b` query parameter. */
  binding?: string;
  /** `lwm2m` query parameter. */
  version?: string;
  /** CoRE Link Format body, e.g. `</1/0>,</3/0>,</3303/0>`. */
  payload?: string;
  address?: string;
  port?: number;
}

export interface UpdateParams {
  lifetime?: number;
  binding?: string;
  payload?: string;
  address?: string;
  port?: number;
}

/**
 * Per-device / per-profile LwM2M resource → telemetry key mapping.
 *
 * `Lwm2mTransportConfig` in `@common/interfaces/device-profile.interface`
 * describes object IDs and observe settings but has no key mapping, and that
 * interface belongs to another area of the codebase. Mappings are therefore
 * read from an additional `resourceMappings` array on the same `lwm2m`
 * sub-object (or from `Device.configuration.lwm2m`), documented here:
 *
 *   "lwm2m": {
 *     "resourceMappings": [
 *       { "path": "/3303/0/5700", "key": "temperature" },
 *       { "path": "/3/0/9",       "key": "batteryLevel" }
 *     ]
 *   }
 */
export interface Lwm2mResourceMapping {
  path: string;
  key: string;
}

/**
 * Default mapping for the OMA resources almost every client reports, so a
 * device produces recognisable telemetry before anyone configures anything.
 * Keys deliberately match the columns DeviceListenerService promotes
 * (temperature, humidity, pressure, batteryLevel).
 */
const DEFAULT_RESOURCE_MAPPINGS: Record<string, string> = {
  '3303/0/5700': 'temperature',
  '3304/0/5700': 'humidity',
  '3315/0/5700': 'pressure',
  '3323/0/5700': 'pressure',
  '3325/0/5700': 'concentration',
  '3328/0/5700': 'power',
  '3330/0/5700': 'distance',
  '3331/0/5700': 'energy',
  '3/0/9': 'batteryLevel',
  '3/0/7': 'voltage',
  '3/0/8': 'current',
  '3/0/13': 'deviceTime',
  '3/0/3': 'firmwareVersion',
  '4/0/2': 'signalStrength',
};

/**
 * Grace period added to a registration lifetime before it is considered
 * expired. UDP loses packets and clients drift; expiring at exactly `lifetime`
 * would flap devices offline on a single missed update.
 */
const DEFAULT_GRACE_SECONDS = 30;

const MIN_LIFETIME_SECONDS = 30;
const DEFAULT_LIFETIME_SECONDS = 300;

@Injectable()
export class Lwm2mService implements OnModuleDestroy {
  private readonly logger = new Logger(Lwm2mService.name);

  private readonly registrations = new Map<string, Lwm2mRegistration>();
  /** endpoint name → registrationId, so a re-register replaces the old one. */
  private readonly byEndpoint = new Map<string, string>();

  private readonly graceSeconds: number;
  private readonly sweepIntervalMs: number;
  private sweepTimer: NodeJS.Timeout | null = null;

  constructor(
    private readonly deviceListener: DeviceListenerService,
    @InjectRepository(Device)
    private readonly deviceRepository: Repository<Device>,
    private readonly configService: ConfigService,
  ) {
    this.graceSeconds = Number(
      this.configService.get<string>('LWM2M_LIFETIME_GRACE_SECONDS') ??
        DEFAULT_GRACE_SECONDS,
    );
    this.sweepIntervalMs =
      Number(
        this.configService.get<string>('LWM2M_EXPIRY_SWEEP_SECONDS') ?? 15,
      ) * 1000;
  }

  onModuleDestroy(): void {
    this.stopExpirySweep();
  }

  // ── Lifetime tracking ─────────────────────────────────────────────────────
  //
  // Started by CoAPAdapter when the CoAP server comes up, because a
  // registration registry is meaningless without a listening socket — and
  // stopped with it, so COAP_ENABLED=false leaves no stray timer.

  startExpirySweep(): void {
    if (this.sweepTimer) return;
    this.sweepTimer = setInterval(() => {
      void this.expireStaleRegistrations().catch((error) =>
        this.logger.error(
          `LwM2M expiry sweep failed: ${(error as Error).message}`,
        ),
      );
    }, this.sweepIntervalMs);
    this.sweepTimer.unref?.();
    this.logger.log(
      `LwM2M registration expiry sweep every ${this.sweepIntervalMs / 1000}s (grace ${this.graceSeconds}s)`,
    );
  }

  stopExpirySweep(): void {
    if (this.sweepTimer) {
      clearInterval(this.sweepTimer);
      this.sweepTimer = null;
    }
  }

  /**
   * Drop registrations whose lifetime has elapsed and mark their devices
   * offline. Returns the endpoints that expired, so a test can assert on it
   * without waiting for a log line.
   */
  async expireStaleRegistrations(now: Date = new Date()): Promise<string[]> {
    const expired: Lwm2mRegistration[] = [];
    for (const registration of this.registrations.values()) {
      if (registration.expiresAt <= now) expired.push(registration);
    }

    for (const registration of expired) {
      this.forget(registration);
      await this.markDeviceOffline(registration);
      this.logger.warn(
        `LwM2M registration expired — endpoint: ${registration.endpoint}, ` +
          `lifetime: ${registration.lifetime}s, no update since ${registration.lastUpdateAt.toISOString()} — device marked offline`,
      );
    }

    return expired.map((r) => r.endpoint);
  }

  // ── Register (POST /rd) ───────────────────────────────────────────────────

  async register(
    params: RegisterParams,
  ): Promise<Lwm2mResult<Lwm2mRegistration>> {
    const endpoint = params.endpoint?.trim();
    if (!endpoint) {
      return {
        ok: false,
        code: '4.00',
        error: 'Missing endpoint name — expected ?ep=<endpointName>',
      };
    }

    // ── Device identity ─────────────────────────────────────────────────────
    // The endpoint name IS the deviceKey, exactly as the CoAP adapter treats
    // its path token. An endpoint with no matching device is REJECTED.
    //
    // Auto-provisioning here would be a quota exhaustion hole: /rd is reachable
    // by anything that can send a UDP datagram to 5683 and the endpoint name is
    // attacker-chosen, so a loop of registrations with random names would
    // create devices until the tenant's device limit was gone (CLAUDE.md §4e).
    const device = await this.deviceRepository.findOne({
      where: { deviceKey: endpoint },
    });

    if (!device) {
      this.logger.warn(
        `LwM2M registration rejected — unknown endpoint '${endpoint}'. ` +
          'Devices are never auto-provisioned from a registration; create the ' +
          'device with this deviceKey first.',
      );
      return {
        ok: false,
        code: '4.03',
        error:
          `Unknown endpoint '${endpoint}'. The endpoint name must match an ` +
          'existing device key; this server does not auto-provision devices.',
      };
    }

    const lifetime = this.normaliseLifetime(params.lifetime);
    const now = new Date();

    // A client that re-registers (reboot, IP change) must not accumulate
    // registrations — replace the previous one for this endpoint.
    const previousId = this.byEndpoint.get(endpoint);
    if (previousId) {
      const previous = this.registrations.get(previousId);
      if (previous) {
        this.forget(previous);
        this.logger.log(
          `LwM2M re-registration for '${endpoint}' — previous registration ${previousId} replaced`,
        );
      }
    }

    const registration: Lwm2mRegistration = {
      registrationId: randomUUID().replace(/-/g, '').slice(0, 16),
      endpoint,
      deviceId: device.id,
      tenantId: device.tenantId,
      customerId: device.customerId,
      lifetime,
      binding: params.binding?.trim() || 'U',
      lwm2mVersion: params.version?.trim() || LWM2M_SERVER_VERSION,
      objectLinks: this.parseLinkFormat(params.payload),
      address: params.address,
      port: params.port,
      registeredAt: now,
      lastUpdateAt: now,
      expiresAt: new Date(now.getTime() + (lifetime + this.graceSeconds) * 1000),
    };

    this.registrations.set(registration.registrationId, registration);
    this.byEndpoint.set(endpoint, registration.registrationId);

    await this.touchDevice(device.id);

    this.logger.log(
      `LwM2M registered — endpoint: ${endpoint}, id: ${registration.registrationId}, ` +
        `lifetime: ${lifetime}s, binding: ${registration.binding}, ` +
        `objects: [${registration.objectLinks.map((l) => l.path).join(', ')}]`,
    );

    return { ok: true, value: registration };
  }

  // ── Update (POST /rd/:id) ─────────────────────────────────────────────────

  async update(
    registrationId: string,
    params: UpdateParams,
  ): Promise<Lwm2mResult<Lwm2mRegistration>> {
    const registration = this.registrations.get(registrationId);
    if (!registration) {
      // Per RFC 7252 / LwM2M, an update against an unknown (likely expired)
      // registration is 4.04 — the client is expected to register again.
      return {
        ok: false,
        code: '4.04',
        error:
          `Unknown registration '${registrationId}'. It may have expired — ` +
          'send a new Register (POST /rd).',
      };
    }

    if (params.lifetime !== undefined) {
      registration.lifetime = this.normaliseLifetime(params.lifetime);
    }
    if (params.binding) registration.binding = params.binding.trim();
    if (params.payload) {
      const links = this.parseLinkFormat(params.payload);
      if (links.length > 0) registration.objectLinks = links;
    }
    if (params.address) registration.address = params.address;
    if (params.port !== undefined) registration.port = params.port;

    const now = new Date();
    registration.lastUpdateAt = now;
    registration.expiresAt = new Date(
      now.getTime() + (registration.lifetime + this.graceSeconds) * 1000,
    );

    await this.touchDevice(registration.deviceId);

    this.logger.log(
      `LwM2M registration updated — endpoint: ${registration.endpoint}, ` +
        `id: ${registrationId}, next expiry: ${registration.expiresAt.toISOString()}`,
    );

    return { ok: true, value: registration };
  }

  // ── De-register (DELETE /rd/:id) ──────────────────────────────────────────

  async deregister(registrationId: string): Promise<Lwm2mResult> {
    const registration = this.registrations.get(registrationId);
    if (!registration) {
      return {
        ok: false,
        code: '4.04',
        error: `Unknown registration '${registrationId}'`,
      };
    }

    this.forget(registration);
    await this.markDeviceOffline(registration);

    this.logger.log(
      `LwM2M de-registered — endpoint: ${registration.endpoint}, id: ${registrationId} — device marked offline`,
    );

    return { ok: true, value: undefined };
  }

  // ── Send (POST /dp) ───────────────────────────────────────────────────────

  /**
   * Client-initiated reporting.
   *
   * Identity, in order of preference:
   *   1. `?ep=<endpointName>` on the request — explicit, and what the CoAP
   *      adapter's token mapping is equivalent to.
   *   2. The source address/port of a live registration. Without DTLS there is
   *      no cryptographic client identity, so this is a convenience for
   *      clients that follow the spec and send no `ep` on /dp — it is NOT an
   *      authentication mechanism (see lwm2m.scope.ts, Security row).
   *
   * An endpoint that is not a known device is rejected; it is never provisioned.
   */
  async handleSend(args: {
    endpoint?: string;
    payload?: Buffer | string;
    contentFormat?: number | string;
    address?: string;
    port?: number;
  }): Promise<
    Lwm2mResult<{ endpoint: string; values: Record<string, any> }>
  > {
    const registration = this.resolveSender(args);
    if (!registration) {
      return {
        ok: false,
        code: '4.03',
        error:
          'Could not identify the sending client. Pass ?ep=<endpointName> on ' +
          'POST /dp, and register (POST /rd) before sending.',
      };
    }

    const raw =
      typeof args.payload === 'string'
        ? args.payload
        : (args.payload?.toString('utf8') ?? '');

    if (!raw.trim()) {
      return { ok: false, code: '4.00', error: 'Empty Send payload' };
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return {
        ok: false,
        code: '4.00',
        error:
          'Send payload is not JSON. SenML JSON (content-format 110) is the ' +
          'only supported format; SenML CBOR (112) and TLV are not parsed.',
      };
    }

    // deviceProfile is joined because resolveMappings() reads the profile's
    // lwm2m.resourceMappings; without the relation every profile-level mapping
    // would be silently ignored.
    const device = await this.deviceRepository.findOne({
      where: { id: registration.deviceId },
      relations: ['deviceProfile'],
    });
    if (!device) {
      // The device row was deleted while registered.
      this.forget(registration);
      return {
        ok: false,
        code: '4.03',
        error: `Device for endpoint '${registration.endpoint}' no longer exists`,
      };
    }

    const mappings = this.resolveMappings(device);
    const values = Array.isArray(parsed)
      ? this.parseSenml(parsed, mappings)
      : this.parsePlainJson(parsed as Record<string, any>, mappings);

    if (Object.keys(values).length === 0) {
      return {
        ok: false,
        code: '4.00',
        error:
          'No usable values in the Send payload. Expected a SenML JSON array ' +
          'of records with a name (n/bn) and a value (v/vs/vb).',
      };
    }

    // Refresh liveness — a Send proves the client is alive, but per the spec it
    // does NOT extend the registration lifetime; only an Update does. We touch
    // the device's activity timestamps (handleTelemetry does this too) and
    // leave expiresAt alone so lifetime tracking stays truthful.
    await this.deviceListener.handleTelemetry(
      this.toStandardTelemetry(registration, device, values),
    );

    this.logger.log(
      `LwM2M Send accepted — endpoint: ${registration.endpoint}, keys: [${Object.keys(values).join(', ')}]`,
    );

    return {
      ok: true,
      value: { endpoint: registration.endpoint, values },
    };
  }

  // ── SenML parsing ─────────────────────────────────────────────────────────

  /**
   * SenML JSON (RFC 8428) → telemetry keys.
   *
   * Handles base fields (bn, bt, bv, bu) and the per-record value variants
   * v (number), vs (string), vb (boolean), vd (base64 data). `s` (sum) and
   * `u`/`t` are read for completeness; `t` is relative to `bt` per the RFC.
   * Records with no resolvable name or no value are skipped.
   */
  parseSenml(
    records: any[],
    mappings: Record<string, string> = {},
  ): Record<string, any> {
    const values: Record<string, any> = {};
    let baseName = '';
    let baseTime = 0;
    let baseValue = 0;
    let baseUnit: string | undefined;

    for (const record of records) {
      if (!record || typeof record !== 'object') continue;

      // Base fields are sticky from the record that declares them onwards.
      if (typeof record.bn === 'string') baseName = record.bn;
      if (typeof record.bt === 'number') baseTime = record.bt;
      if (typeof record.bv === 'number') baseValue = record.bv;
      if (typeof record.bu === 'string') baseUnit = record.bu;

      const name = `${baseName}${typeof record.n === 'string' ? record.n : ''}`;
      if (!name) continue;

      let value: any;
      if (typeof record.v === 'number') value = record.v + baseValue;
      else if (typeof record.vs === 'string') value = record.vs;
      else if (typeof record.vb === 'boolean') value = record.vb;
      else if (typeof record.vd === 'string') {
        // Opaque data — kept base64 rather than guessed at.
        value = record.vd;
      } else if (typeof record.s === 'number') value = record.s;
      else continue;

      const key = this.toTelemetryKey(name, mappings);
      values[key] = value;

      // Unit and per-record time are surfaced as sibling keys only when the
      // client actually sent them, so they do not pollute every payload.
      const unit = typeof record.u === 'string' ? record.u : baseUnit;
      if (unit) values[`${key}_unit`] = unit;
      if (typeof record.t === 'number' && (record.t !== 0 || baseTime !== 0)) {
        values[`${key}_ts`] = this.senmlTime(baseTime, record.t);
      }
    }

    return values;
  }

  /**
   * SenML times are Unix seconds when >= 2^28, otherwise relative to the base
   * time (RFC 8428 §4.5.3). Returned in epoch milliseconds.
   */
  private senmlTime(baseTime: number, t: number): number {
    const absolute = t >= 2 ** 28 ? t : baseTime + t;
    return Math.round(absolute * 1000);
  }

  /**
   * Fallback for clients that POST a plain `{ "temperature": 21.5 }` object to
   * /dp instead of SenML. Not part of LwM2M, but harmless to accept and it
   * saves a class of firmware from being silently unusable.
   */
  private parsePlainJson(
    payload: Record<string, any>,
    mappings: Record<string, string>,
  ): Record<string, any> {
    if (!payload || typeof payload !== 'object') return {};
    const values: Record<string, any> = {};
    for (const [name, value] of Object.entries(payload)) {
      if (value === null || typeof value === 'object') continue;
      values[this.toTelemetryKey(name, mappings)] = value;
    }
    return values;
  }

  /**
   * SenML name (`/3303/0/5700`, `3303/0/5700`, or already a friendly name)
   * → telemetry key.
   *
   * Priority: explicit per-device/profile mapping → built-in OMA defaults →
   * a sanitised form of the name itself. The last case means an unmapped
   * resource still produces visible telemetry (`3346_0_5700`) rather than
   * being dropped, which is what makes a new device debuggable.
   */
  private toTelemetryKey(
    name: string,
    mappings: Record<string, string>,
  ): string {
    const normalised = name.replace(/^\/+/, '').replace(/\/+$/, '');

    if (mappings[normalised]) return mappings[normalised];
    if (mappings[`/${normalised}`]) return mappings[`/${normalised}`];
    if (DEFAULT_RESOURCE_MAPPINGS[normalised])
      return DEFAULT_RESOURCE_MAPPINGS[normalised];

    // Not an object path at all — a client that sends readable names.
    if (!/^\d/.test(normalised)) return normalised.replace(/[^\w.]+/g, '_');

    return normalised.replace(/\//g, '_');
  }

  /** Explicit mappings from the device, then its profile. */
  private resolveMappings(device: Device): Record<string, string> {
    const collect = (raw: unknown): Record<string, string> => {
      if (!Array.isArray(raw)) return {};
      const out: Record<string, string> = {};
      for (const entry of raw as Lwm2mResourceMapping[]) {
        if (!entry?.path || !entry?.key) continue;
        out[entry.path.replace(/^\/+/, '')] = entry.key;
      }
      return out;
    };

    const profileLwm2m = (device.deviceProfile?.transportConfiguration
      ?.lwm2m ?? {}) as { resourceMappings?: Lwm2mResourceMapping[] };
    const deviceLwm2m = (device.configuration?.lwm2m ?? {}) as {
      resourceMappings?: Lwm2mResourceMapping[];
    };

    // Device-level wins over profile-level.
    return {
      ...collect(profileLwm2m.resourceMappings),
      ...collect(deviceLwm2m.resourceMappings),
    };
  }

  // ── CoRE Link Format parsing ──────────────────────────────────────────────

  /**
   * `</1/0>,</3/0>;ct=110,</3303/0>` → object links.
   *
   * Only the parts a registration actually carries are modelled: the target
   * path and its `;key=value` attributes. Deliberately tolerant — a link it
   * cannot parse is skipped rather than failing the whole registration, since
   * the object list is recorded for visibility and nothing depends on it
   * (server-initiated operations being out of scope).
   */
  parseLinkFormat(payload?: string): Lwm2mObjectLink[] {
    if (!payload) return [];
    const links: Lwm2mObjectLink[] = [];

    // Split on commas that are not inside <> or a quoted string.
    for (const part of payload.split(/,(?![^<]*>)/)) {
      const segments = part.split(';').map((s) => s.trim());
      const target = segments.shift();
      if (!target) continue;

      const match = /^<([^>]*)>$/.exec(target);
      if (!match) continue;

      const attributes: Record<string, string> = {};
      for (const segment of segments) {
        if (!segment) continue;
        const eq = segment.indexOf('=');
        if (eq === -1) {
          attributes[segment] = '';
        } else {
          attributes[segment.slice(0, eq)] = segment
            .slice(eq + 1)
            .replace(/^"|"$/g, '');
        }
      }

      links.push({ path: match[1], attributes });
    }

    return links;
  }

  // ── Registry access (for the controller / verification scripts) ───────────

  listRegistrations(tenantId?: string): Lwm2mRegistrationView[] {
    const now = Date.now();
    return [...this.registrations.values()]
      .filter((r) => !tenantId || r.tenantId === tenantId)
      .map((r) => ({
        ...r,
        registeredAt: r.registeredAt.toISOString(),
        lastUpdateAt: r.lastUpdateAt.toISOString(),
        expiresAt: r.expiresAt.toISOString(),
        secondsUntilExpiry: Math.max(
          0,
          Math.round((r.expiresAt.getTime() - now) / 1000),
        ),
      }));
  }

  getRegistration(registrationId: string): Lwm2mRegistration | undefined {
    return this.registrations.get(registrationId);
  }

  getRegistrationByEndpoint(endpoint: string): Lwm2mRegistration | undefined {
    const id = this.byEndpoint.get(endpoint);
    return id ? this.registrations.get(id) : undefined;
  }

  /** Test seam: force a registration to look stale without waiting. */
  expireRegistrationNow(registrationId: string): boolean {
    const registration = this.registrations.get(registrationId);
    if (!registration) return false;
    registration.expiresAt = new Date(Date.now() - 1000);
    return true;
  }

  // ── Internals ─────────────────────────────────────────────────────────────

  private resolveSender(args: {
    endpoint?: string;
    address?: string;
    port?: number;
  }): Lwm2mRegistration | undefined {
    if (args.endpoint) {
      return this.getRegistrationByEndpoint(args.endpoint.trim());
    }
    if (!args.address) return undefined;
    for (const registration of this.registrations.values()) {
      if (
        registration.address === args.address &&
        (args.port === undefined || registration.port === args.port)
      ) {
        return registration;
      }
    }
    return undefined;
  }

  /** Both maps, always together — a half-removed registration would leak. */
  private forget(registration: Lwm2mRegistration): void {
    this.registrations.delete(registration.registrationId);
    if (this.byEndpoint.get(registration.endpoint) === registration.registrationId) {
      this.byEndpoint.delete(registration.endpoint);
    }
  }

  private normaliseLifetime(raw?: number): number {
    const lifetime = Number(raw);
    if (!Number.isFinite(lifetime) || lifetime <= 0)
      return DEFAULT_LIFETIME_SECONDS;
    return Math.max(MIN_LIFETIME_SECONDS, Math.floor(lifetime));
  }

  private async touchDevice(deviceId: string): Promise<void> {
    try {
      await this.deviceRepository.update(
        { id: deviceId },
        { lastSeenAt: new Date(), lastActivityAt: new Date() },
      );
    } catch (error) {
      // A registration is still valid even if the activity write failed.
      this.logger.error(
        `Failed to update activity for device ${deviceId}: ${(error as Error).message}`,
      );
    }
  }

  private async markDeviceOffline(
    registration: Lwm2mRegistration,
  ): Promise<void> {
    try {
      await this.deviceRepository.update(
        { id: registration.deviceId },
        { status: DeviceStatus.OFFLINE },
      );
    } catch (error) {
      this.logger.error(
        `Failed to mark device ${registration.endpoint} offline: ${(error as Error).message}`,
      );
    }
  }

  private toStandardTelemetry(
    registration: Lwm2mRegistration,
    device: Device,
    values: Record<string, any>,
  ): StandardTelemetry {
    return {
      deviceId: device.id,
      deviceKey: device.deviceKey,
      tenantId: device.tenantId,
      customerId: device.customerId,
      data: values,
      temperature: values.temperature,
      humidity: values.humidity,
      pressure: values.pressure,
      batteryLevel: values.batteryLevel,
      signalStrength: values.signalStrength,
      timestamp: new Date().toISOString(),
      receivedAt: Date.now(),
      // See the note in snmp.adapter.ts: StandardTelemetry.protocol is a closed
      // literal union owned by @common/interfaces, so 'lwm2m' is cast. The
      // value stored and published is 'lwm2m'.
      protocol: 'lwm2m' as StandardTelemetry['protocol'],
      metadata: {
        coapPath: '/dp',
        coapMethod: 'POST',
        lwm2mEndpoint: registration.endpoint,
        lwm2mRegistrationId: registration.registrationId,
        lwm2mBinding: registration.binding,
        codecId: device.metadata?.codecId as string | undefined,
        manufacturer:
          (device.metadata?.manufacturer as string | undefined) ??
          device.manufacturer,
        model: (device.metadata?.model as string | undefined) ?? device.model,
      },
      rawPayload: values,
    };
  }
}
