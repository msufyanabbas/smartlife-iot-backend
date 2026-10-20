// src/modules/protocols/lwm2m/lwm2m.service.ts
//
// LwM2M Registration + client-initiated reporting, on top of the existing
// CoAP server (UDP 5683, CoAPAdapter).
//
// ─── SCOPE — read this before assuming anything works ─────────────────────
// Implemented:  Register (POST /rd), Update (POST /rd/:id),
//               De-register (DELETE /rd/:id), Send (POST /dp, SenML JSON),
//               registration-lifetime expiry marking the device offline,
//               credential-checked registration, durable registrations.
// NOT here:     Observe/Notify, server-initiated Read/Write/Execute/Create/
//               Delete/Discover, Bootstrap, DTLS (coaps://), SenML CBOR/TLV,
//               Queue Mode.
// The authoritative, frontend-consumable version of that list is
// `lwm2m.scope.ts` (served by `GET /lwm2m/capabilities`). Keep the two in sync.
//
// Nothing in this file ever sends a request *to* a client. That is the single
// line that separates what is built from what is not.
//
// ─── Persistence ──────────────────────────────────────────────────────────
// Registrations used to live in two in-process `Map`s, so every one was lost
// on restart (a client with a long lifetime would not re-register for hours,
// and in the meantime its Update was answered 4.04 and its Send 4.03) and
// nothing was shared between replicas. `lwm2m_registrations` is now
// AUTHORITATIVE; the maps below are a cache in front of it, rehydrated on boot.
//
// ─── Authentication, and its hard limit ───────────────────────────────────
// Registration now requires a credential, resolved through `DeviceAuthService`
// exactly as the HTTP and CoAP adapters do. The credential is the LwM2M
// endpoint name (`?ep=`), which is how a client without DTLS presents one.
//
// Be clear about what that buys: **there is no DTLS/PSK in this stack**, so
// the token travels in CLEAR TEXT over UDP 5683 and is replayable by anyone on
// the path. It stops the previous behaviour — any datagram naming any device
// key got a registration — but it is not transport security. The port belongs
// on a private APN or behind a DTLS terminator. `lwm2m.scope.ts` says so, and
// so does this comment, rather than letting "authentication" imply more than
// it is.

import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { IsNull, LessThanOrEqual, Repository } from 'typeorm';
import { createHash, randomUUID } from 'crypto';
import { Device } from '@modules/devices/entities/device.entity';
import { DeviceStatus } from '@common/enums/index.enum';
import { StandardTelemetry } from '@common/interfaces/standard-telemetry.interface';
import { DeviceListenerService } from '@/modules/protocols/device-listener.service';
import { DeviceAuthService } from '@modules/device-auth/device-auth.service';
import { LWM2M_SERVER_VERSION } from './lwm2m.scope';
import { Lwm2mRegistration as Lwm2mRegistrationRow } from './entities/lwm2m-registration.entity';

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
  /**
   * Display endpoint — the authenticated device's key.
   *
   * NOT the raw endpoint name the client sent, which is the credential. The
   * raw name is only ever held as `endpointHash`.
   */
  endpoint: string;
  /** SHA-256 of the endpoint name as presented. The lookup key. */
  endpointHash: string;
  deviceId: string;
  tenantId?: string;
  customerId?: string;
  /** False when accepted with no credential because enforcement is off. */
  authenticated: boolean;
  credentialsType?: string | null;
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
  /** `ep` query parameter. Required. Also the credential — see the header. */
  endpoint?: string;
  /**
   * An explicitly-supplied credential, preferred over `endpoint` when present.
   *
   * Nothing passes this yet: `CoAPAdapter.handleLwm2mRegistration` forwards
   * only `ep`, `lt`, `b` and `lwm2m`. It is here so a deployment whose
   * firmware carries a separate token query parameter can be wired up without
   * reworking this service — the adapter is the only file that has to change.
   */
  credential?: string;
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
export class Lwm2mService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(Lwm2mService.name);

  // ── Cache, not storage ──────────────────────────────────────────────────
  //
  // `lwm2m_registrations` is authoritative. These maps exist so the hot path
  // (a Send, which arrives at the device's reporting frequency) does not take
  // a database round trip per datagram. Every write goes to the table first;
  // a cache miss falls back to the table.
  private readonly registrations = new Map<string, Lwm2mRegistration>();
  /** SHA-256(endpoint as presented) → registrationId. The identity index. */
  private readonly byEndpointHash = new Map<string, string>();
  /** deviceKey → registrationId. Display/convenience lookups only. */
  private readonly byDeviceKey = new Map<string, string>();

  private readonly graceSeconds: number;
  private readonly sweepIntervalMs: number;
  private sweepTimer: NodeJS.Timeout | null = null;

  constructor(
    private readonly deviceListener: DeviceListenerService,
    @InjectRepository(Device)
    private readonly deviceRepository: Repository<Device>,
    private readonly configService: ConfigService,
    @InjectRepository(Lwm2mRegistrationRow)
    private readonly registrationRepository: Repository<Lwm2mRegistrationRow>,
    private readonly deviceAuth: DeviceAuthService,
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

  /**
   * Rehydrate the cache from the table.
   *
   * This is the whole point of the table: after a restart (or a new replica
   * coming up) the registrations a client made minutes ago are still valid, so
   * its next Update is answered 2.04 instead of 4.04 and its next Send lands.
   *
   * Expired rows are swept here too, so a process that was down longer than a
   * fleet's lifetime marks those devices offline on the way up rather than
   * leaving them "registered" until the first sweep tick.
   */
  async onModuleInit(): Promise<void> {
    try {
      const rows = await this.registrationRepository.find({
        where: { deletedAt: IsNull() },
      });

      let live = 0;
      for (const row of rows) {
        if (row.isExpired()) continue;
        this.cache(this.toRegistration(row));
        live += 1;
      }

      this.logger.log(
        `LwM2M registry rehydrated — ${live} live registration(s) of ` +
          `${rows.length} row(s) loaded from lwm2m_registrations`,
      );

      // Anything already past its lifetime is swept now, not at the first tick.
      if (rows.length > live) await this.expireStaleRegistrations();
    } catch (error) {
      // A missing table (migration not applied yet) must not stop the app
      // booting. The service then behaves as it did before — in-memory only —
      // and says so once.
      this.logger.error(
        'Could not rehydrate LwM2M registrations; continuing with an empty ' +
          `registry (is the lwm2m_registrations migration applied?): ${
            (error as Error).message
          }`,
      );
    }
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
   *
   * **Works off the table**, not the cache. That matters for the case the
   * cache cannot see: a registration made by another replica, or one made
   * before this process started. Scanning memory meant such a registration
   * was never expired by anyone and its device stayed "online" forever.
   */
  async expireStaleRegistrations(now: Date = new Date()): Promise<string[]> {
    let rows: Lwm2mRegistrationRow[] = [];

    try {
      rows = await this.registrationRepository.find({
        where: { expiresAt: LessThanOrEqual(now), deletedAt: IsNull() },
      });
    } catch (error) {
      // Fall back to the cache so expiry still happens when the table is
      // unavailable — degraded, but better than devices stuck online.
      this.logger.error(
        `LwM2M expiry sweep could not read the table (${
          (error as Error).message
        }); falling back to the in-process cache`,
      );
      const stale = [...this.registrations.values()].filter(
        (r) => r.expiresAt <= now,
      );
      for (const registration of stale) {
        this.forget(registration);
        await this.markDeviceOffline(registration);
      }
      return stale.map((r) => r.endpoint);
    }

    const expired: string[] = [];

    for (const row of rows) {
      const registration = this.toRegistration(row);
      this.forget(registration);

      try {
        await this.registrationRepository.softRemove(row);
      } catch (error) {
        this.logger.error(
          `Failed to remove expired LwM2M registration ${row.registrationId}: ${
            (error as Error).message
          }`,
        );
      }

      await this.markDeviceOffline(registration);
      expired.push(registration.endpoint);

      this.logger.warn(
        `LwM2M registration expired — endpoint: ${registration.endpoint}, ` +
          `lifetime: ${registration.lifetime}s, no update since ` +
          `${registration.lastUpdateAt.toISOString()} — device marked offline`,
      );
    }

    return expired;
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

    // ── Device identity — a CREDENTIAL, not a name ───────────────────────────
    //
    // The endpoint name used to be treated as a plain deviceKey: any datagram
    // naming a real device key got a registration, and a deviceKey appears in
    // URLs, logs, topics and support tickets. So /rd had, in effect, no
    // authentication.
    //
    // It is now resolved through `DeviceAuthService`, the same path the HTTP
    // and CoAP adapters use. A deviceKey alone is accepted only while
    // `DEVICE_AUTH_ENFORCED=false`, and that path warns every time.
    //
    // Auto-provisioning is still refused outright, whatever the credential
    // says: /rd is reachable by anything that can send a UDP datagram to 5683
    // and the endpoint name is attacker-chosen, so a loop of registrations
    // with random names would create devices until the tenant's device limit
    // was gone (CLAUDE.md §4e).
    const credential = params.credential?.trim() || endpoint;
    const endpointHash = Lwm2mService.hashEndpoint(credential);

    const authed = await this.deviceAuth.authenticate({
      kind: 'token',
      token: credential,
    });

    let device: Device | null = authed?.device ?? null;
    let authenticated = true;
    let credentialsType: string | null = authed?.credentialsType ?? null;

    if (!device) {
      if (this.deviceAuth.isEnforced) {
        // 4.03 and a single message for both "no such credential" and "that
        // is a device key, not a credential": distinguishing them would tell
        // an attacker which endpoint names exist.
        this.logger.warn(
          'LwM2M registration rejected — the endpoint name did not resolve ' +
            'to a valid device credential. Issue an ACCESS_TOKEN credential ' +
            'and use it as the LwM2M endpoint name.',
        );
        return {
          ok: false,
          code: '4.03',
          error:
            'Registration refused: the endpoint name is not a valid device ' +
            'credential. The LwM2M endpoint name must be the device access ' +
            'token; this server does not auto-provision devices.',
        };
      }

      // Enforcement off — the legacy behaviour, loudly.
      const fallback = await this.deviceAuth.authenticate({
        kind: 'deviceKey',
        deviceKey: credential,
      });
      device = fallback?.device ?? null;
      authenticated = false;
      credentialsType = null;

      if (!device) {
        return {
          ok: false,
          code: '4.03',
          error:
            `Unknown endpoint '${endpoint}'. The endpoint name must match an ` +
            'existing device credential or key; this server does not ' +
            'auto-provision devices.',
        };
      }

      this.logger.warn(
        `LwM2M registration for device ${device.deviceKey} accepted with NO ` +
          'credential because DEVICE_AUTH_ENFORCED=false. Anything that can ' +
          'reach UDP 5683 and knows this device key can register as it.',
      );
    }

    const lifetime = this.normaliseLifetime(params.lifetime);
    const now = new Date();

    // A client that re-registers (reboot, IP change) must not accumulate
    // registrations — replace the previous one for this endpoint. The previous
    // one is looked up by hash, so it is found whether it is in this process's
    // cache or only in the table (another replica made it).
    await this.forgetByEndpointHash(endpointHash, 'replaced by re-registration');

    const row = this.registrationRepository.create({
      registrationId: randomUUID().replace(/-/g, '').slice(0, 16),
      // The DISPLAY endpoint is the device key, never the credential — see the
      // entity's comment. The credential is only ever held as a hash.
      endpoint: device.deviceKey,
      endpointHash,
      deviceId: device.id,
      tenantId: device.tenantId,
      customerId: device.customerId ?? null,
      lifetime,
      bindingMode: params.binding?.trim() || 'U',
      lwm2mVersion: params.version?.trim() || LWM2M_SERVER_VERSION,
      objects: this.parseLinkFormat(params.payload),
      address: params.address ?? null,
      port: params.port ?? null,
      registeredAt: now,
      lastUpdateAt: now,
      expiresAt: new Date(now.getTime() + (lifetime + this.graceSeconds) * 1000),
      authenticated,
      credentialsType,
    });

    const registration = this.toRegistration(await this.persist(row));
    this.cache(registration);

    await this.touchDevice(device.id);

    this.logger.log(
      `LwM2M registered — device: ${registration.endpoint}, ` +
        `id: ${registration.registrationId}, lifetime: ${lifetime}s, ` +
        `binding: ${registration.binding}, authenticated: ${authenticated}, ` +
        `objects: [${registration.objectLinks.map((l) => l.path).join(', ')}]`,
    );

    return { ok: true, value: registration };
  }

  // ── Update (POST /rd/:id) ─────────────────────────────────────────────────

  /**
   * An Update is authenticated by possession of the registration id, which
   * this server issued and returned in Location-Path. The row is the authority
   * for which device it belongs to — the endpoint name is NOT re-resolved
   * here, so a client cannot update one registration into pointing at another
   * tenant's device by changing `?ep=`.
   */
  async update(
    registrationId: string,
    params: UpdateParams,
  ): Promise<Lwm2mResult<Lwm2mRegistration>> {
    // Table-backed, so an Update that lands on a different replica than the
    // Register — or after a restart — is answered 2.04 rather than 4.04.
    const row = await this.loadRow(registrationId);

    if (!row || row.isExpired()) {
      // Per RFC 7252 / LwM2M, an update against an unknown (likely expired)
      // registration is 4.04 — the client is expected to register again.
      if (row) await this.forgetRow(row, 'expired on update');
      return {
        ok: false,
        code: '4.04',
        error:
          `Unknown registration '${registrationId}'. It may have expired — ` +
          'send a new Register (POST /rd).',
      };
    }

    if (params.lifetime !== undefined) {
      row.lifetime = this.normaliseLifetime(params.lifetime);
    }
    if (params.binding) row.bindingMode = params.binding.trim();
    if (params.payload) {
      const links = this.parseLinkFormat(params.payload);
      if (links.length > 0) row.objects = links;
    }
    if (params.address) row.address = params.address;
    if (params.port !== undefined) row.port = params.port;

    const now = new Date();
    row.lastUpdateAt = now;
    row.expiresAt = new Date(
      now.getTime() + (row.lifetime + this.graceSeconds) * 1000,
    );

    const registration = this.toRegistration(await this.persist(row));
    this.cache(registration);

    await this.touchDevice(registration.deviceId);

    this.logger.log(
      `LwM2M registration updated — device: ${registration.endpoint}, ` +
        `id: ${registrationId}, next expiry: ${registration.expiresAt.toISOString()}`,
    );

    return { ok: true, value: registration };
  }

  // ── De-register (DELETE /rd/:id) ──────────────────────────────────────────

  async deregister(registrationId: string): Promise<Lwm2mResult> {
    const row = await this.loadRow(registrationId);
    if (!row) {
      return {
        ok: false,
        code: '4.04',
        error: `Unknown registration '${registrationId}'`,
      };
    }

    const registration = this.toRegistration(row);
    await this.forgetRow(row, 'de-registered by the client');
    await this.markDeviceOffline(registration);

    this.logger.log(
      `LwM2M de-registered — device: ${registration.endpoint}, ` +
        `id: ${registrationId} — device marked offline`,
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
    const registration = await this.resolveSender(args);
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
      // The device row was deleted while registered. Drop the registration
      // from the table too, or it would be rehydrated on the next boot and
      // keep answering for a device that no longer exists.
      await this.forgetByRegistrationId(
        registration.registrationId,
        'its device row was deleted',
      );
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

  /**
   * Every registration for a tenant, read from the TABLE.
   *
   * Async and database-backed because this is the endpoint an operator uses to
   * answer "is my fleet connected?". Reading the local cache made the answer
   * depend on which replica served the request, and empty after a restart,
   * while the registrations themselves were still live.
   *
   * `tenantId` is undefined only for SUPER_ADMIN; the controller decides, and
   * never takes it from a query parameter.
   */
  async listRegistrations(tenantId?: string): Promise<Lwm2mRegistrationView[]> {
    const now = Date.now();
    const where = tenantId
      ? { tenantId, deletedAt: IsNull() }
      : { deletedAt: IsNull() };

    const rows = await this.registrationRepository.find({
      where,
      order: { lastUpdateAt: 'DESC' },
    });

    return rows.map((row) => {
      const registration = this.toRegistration(row);
      return {
        ...registration,
        registeredAt: registration.registeredAt.toISOString(),
        lastUpdateAt: registration.lastUpdateAt.toISOString(),
        expiresAt: registration.expiresAt.toISOString(),
        secondsUntilExpiry: Math.max(
          0,
          Math.round((registration.expiresAt.getTime() - now) / 1000),
        ),
      };
    });
  }

  /** Cache-first, table as the authority. */
  async getRegistration(
    registrationId: string,
  ): Promise<Lwm2mRegistration | undefined> {
    const row = await this.loadRow(registrationId);
    return row ? this.toRegistration(row) : undefined;
  }

  /**
   * Find a registration by the endpoint name a client presents, or by the
   * device key shown in the UI.
   *
   * Both are accepted because they are different strings now: the presented
   * name is a credential and is only ever stored hashed, while `endpoint`
   * holds the device key. A caller should not have to know which one it has.
   */
  async getRegistrationByEndpoint(
    endpoint: string,
  ): Promise<Lwm2mRegistration | undefined> {
    const name = endpoint?.trim();
    if (!name) return undefined;

    const hash = Lwm2mService.hashEndpoint(name);

    const cachedId =
      this.byEndpointHash.get(hash) ?? this.byDeviceKey.get(name);
    if (cachedId) {
      const cached = this.registrations.get(cachedId);
      if (cached && cached.expiresAt > new Date()) return cached;
    }

    const row =
      (await this.registrationRepository.findOne({
        where: { endpointHash: hash, deletedAt: IsNull() },
      })) ??
      (await this.registrationRepository.findOne({
        where: { endpoint: name, deletedAt: IsNull() },
      }));

    if (!row) return undefined;

    const registration = this.toRegistration(row);
    this.cache(registration);
    return registration;
  }

  /**
   * Test seam: force a registration to look stale without waiting.
   *
   * Writes `expiresAt` into the TABLE, because `expireStaleRegistrations()`
   * now sweeps the table — mutating the cached object would have no effect on
   * the sweep.
   */
  async expireRegistrationNow(registrationId: string): Promise<boolean> {
    const row = await this.loadRow(registrationId);
    if (!row) return false;
    row.expiresAt = new Date(Date.now() - 1000);
    const registration = this.toRegistration(await this.persist(row));
    this.cache(registration);
    return true;
  }

  // ── Internals ─────────────────────────────────────────────────────────────

  /**
   * Which registration sent this /dp payload.
   *
   * 1. `?ep=` — explicit, and the credential the client registered with.
   * 2. The source address/port of a live registration. Without DTLS there is
   *    no cryptographic client identity, so this is a convenience for clients
   *    that follow the spec and send no `ep` on /dp — it is NOT an
   *    authentication mechanism, and a UDP source address is trivially
   *    spoofed (see lwm2m.scope.ts, Security row).
   */
  private async resolveSender(args: {
    endpoint?: string;
    address?: string;
    port?: number;
  }): Promise<Lwm2mRegistration | undefined> {
    if (args.endpoint) {
      return this.getRegistrationByEndpoint(args.endpoint.trim());
    }
    if (!args.address) return undefined;

    // Cache first — this is the hot path for a client that sends no ep.
    for (const registration of this.registrations.values()) {
      if (
        registration.address === args.address &&
        (args.port === undefined || registration.port === args.port) &&
        registration.expiresAt > new Date()
      ) {
        return registration;
      }
    }

    const row = await this.registrationRepository.findOne({
      where: {
        address: args.address,
        ...(args.port === undefined ? {} : { port: args.port }),
        deletedAt: IsNull(),
      },
      order: { lastUpdateAt: 'DESC' },
    });

    if (!row || row.isExpired()) return undefined;

    const registration = this.toRegistration(row);
    this.cache(registration);
    return registration;
  }

  // ── Cache and table plumbing ──────────────────────────────────────────────

  /** SHA-256, hex. The endpoint name is a credential; it is never stored raw. */
  private static hashEndpoint(endpoint: string): string {
    return createHash('sha256').update(endpoint).digest('hex');
  }

  private toRegistration(row: Lwm2mRegistrationRow): Lwm2mRegistration {
    return {
      registrationId: row.registrationId,
      endpoint: row.endpoint,
      endpointHash: row.endpointHash,
      deviceId: row.deviceId,
      tenantId: row.tenantId,
      customerId: row.customerId ?? undefined,
      authenticated: row.authenticated,
      credentialsType: row.credentialsType ?? null,
      lifetime: row.lifetime,
      binding: row.bindingMode,
      lwm2mVersion: row.lwm2mVersion ?? LWM2M_SERVER_VERSION,
      objectLinks: Array.isArray(row.objects) ? row.objects : [],
      address: row.address ?? undefined,
      port: row.port ?? undefined,
      // TypeORM hands back Date objects, but a rehydrated row that came
      // through a driver without date parsing would be a string — and
      // `'…' <= now` compares lexicographically, which silently never expires.
      registeredAt: new Date(row.registeredAt),
      lastUpdateAt: new Date(row.lastUpdateAt),
      expiresAt: new Date(row.expiresAt),
    };
  }

  /** All three maps, always together — a half-cached registration leaks. */
  private cache(registration: Lwm2mRegistration): void {
    this.registrations.set(registration.registrationId, registration);
    this.byEndpointHash.set(
      registration.endpointHash,
      registration.registrationId,
    );
    this.byDeviceKey.set(registration.endpoint, registration.registrationId);
  }

  /** Drop from the cache only. The table is handled by the caller. */
  private forget(registration: Lwm2mRegistration): void {
    this.registrations.delete(registration.registrationId);
    if (
      this.byEndpointHash.get(registration.endpointHash) ===
      registration.registrationId
    ) {
      this.byEndpointHash.delete(registration.endpointHash);
    }
    if (
      this.byDeviceKey.get(registration.endpoint) ===
      registration.registrationId
    ) {
      this.byDeviceKey.delete(registration.endpoint);
    }
  }

  /**
   * Load a row by registration id.
   *
   * The cache is consulted first, but the ROW is always fetched — the cached
   * object is a plain interface, and an Update has to save an entity. The
   * cache still earns its place on the Send path, which needs no row.
   */
  private async loadRow(
    registrationId: string,
  ): Promise<Lwm2mRegistrationRow | null> {
    if (!registrationId) return null;
    try {
      return await this.registrationRepository.findOne({
        where: { registrationId, deletedAt: IsNull() },
      });
    } catch (error) {
      this.logger.error(
        `Could not read LwM2M registration ${registrationId}: ${
          (error as Error).message
        }`,
      );
      return null;
    }
  }

  private async persist(
    row: Lwm2mRegistrationRow,
  ): Promise<Lwm2mRegistrationRow> {
    try {
      return await this.registrationRepository.save(row);
    } catch (error) {
      // A registration that cannot be persisted is still served from memory
      // for this process's lifetime — degraded, but a client is not refused
      // because of a storage problem. It will not survive a restart, which is
      // exactly the old behaviour and is logged as such.
      this.logger.error(
        `Could not persist LwM2M registration ${row.registrationId}; it will ` +
          `not survive a restart: ${(error as Error).message}`,
      );
      return row;
    }
  }

  private async forgetRow(
    row: Lwm2mRegistrationRow,
    reason: string,
  ): Promise<void> {
    this.forget(this.toRegistration(row));
    try {
      await this.registrationRepository.softRemove(row);
    } catch (error) {
      this.logger.error(
        `Could not remove LwM2M registration ${row.registrationId} (${reason}): ${
          (error as Error).message
        }`,
      );
    }
  }

  private async forgetByRegistrationId(
    registrationId: string,
    reason: string,
  ): Promise<void> {
    const row = await this.loadRow(registrationId);
    if (row) await this.forgetRow(row, reason);
  }

  /** Replace whatever registration currently holds this endpoint hash. */
  private async forgetByEndpointHash(
    endpointHash: string,
    reason: string,
  ): Promise<void> {
    let row: Lwm2mRegistrationRow | null = null;
    try {
      row = await this.registrationRepository.findOne({
        where: { endpointHash, deletedAt: IsNull() },
      });
    } catch {
      // Fall through to the cache-only path below.
    }

    if (row) {
      await this.forgetRow(row, reason);
      this.logger.log(
        `LwM2M re-registration — previous registration ${row.registrationId} ${reason}`,
      );
      return;
    }

    const cachedId = this.byEndpointHash.get(endpointHash);
    const cached = cachedId ? this.registrations.get(cachedId) : undefined;
    if (cached) this.forget(cached);
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
