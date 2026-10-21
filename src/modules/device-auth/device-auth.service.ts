import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import * as crypto from 'crypto';

import { RedisService } from '@lib/redis/redis.service';
import { Device } from '@modules/devices/entities/device.entity';
import {
  DeviceCredentials,
  CredentialsType,
} from '@modules/devices/entities/device-credentials.entity';
import { Edge } from '@modules/edge/entities/edge.entity';

/**
 * ─────────────────────────────────────────────────────────────────────────────
 * Device authentication — the thing that was modelled but never enforced
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * THE BUG THIS FIXES
 *
 * `device_credentials` has supported ACCESS_TOKEN, MQTT_BASIC and
 * X509_CERTIFICATE since the schema was written. `credentialsId` even carries
 * a unique index described in the entity as "used for fast auth lookup".
 *
 * Nothing ever looked anything up. Every ingestion path — HTTP, CoAP, MQTT,
 * LwM2M — resolved the device with `findOne({ where: { deviceKey } })` and
 * accepted whatever arrived. The HTTP adapter said so in its own comment:
 * "Anyone who learns a deviceKey can post telemetry as that device."
 *
 * A deviceKey is an IDENTIFIER. It appears in URLs, in MQTT topics, in logs,
 * in the UI and in support tickets. Treating it as a secret means the
 * platform had, in practice, no device authentication at all: anyone who saw
 * one could forge that device's readings, drive its alarm rules, and poison
 * the telemetry its automations act on.
 *
 * `DeviceCredentialsService.verifyCredentials()` existed and was correct, and
 * had no caller anywhere in the codebase.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHY THIS IS A STANDALONE MODULE
 *
 * `DevicesModule` already imports `ProtocolsModule`, so the protocol adapters
 * cannot import `DevicesModule` back without a cycle. This module registers
 * the two repositories directly with `TypeOrmModule.forFeature`, which is the
 * pattern the rest of this codebase uses for exactly this reason (see
 * CLAUDE.md §4a). It depends on no other feature module, so anything may
 * import it.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * DESIGN NOTES
 *
 * • **Constant-time comparison.** The previous `verifyCredentials` compared
 *   passwords with `!==`, which returns as soon as two bytes differ and so
 *   leaks the length of the matching prefix. Every secret comparison here
 *   goes through `safeEqual`.
 *
 * • **Cached, including negatives.** Telemetry is the highest-volume path in
 *   the platform; a database round trip per message would make authentication
 *   the bottleneck that gets switched off again. Successful lookups are
 *   cached briefly, and so are failures — without negative caching, a flood
 *   of bad tokens becomes a flood of database queries, which turns
 *   authentication into an amplification vector.
 *
 * • **Fails closed.** Any error resolving a credential denies the request.
 *   The one exception is the explicit `DEVICE_AUTH_ENFORCED=false` escape
 *   hatch, which logs loudly at boot and on every bypass.
 */

/** How long a successful credential lookup is cached. */
const POSITIVE_TTL_SECONDS = 60;

/**
 * How long a failed lookup is cached. Shorter than the positive TTL so a
 * freshly provisioned device starts working quickly, long enough that a
 * brute-force attempt cannot turn one request into one query.
 */
const NEGATIVE_TTL_SECONDS = 15;

const CACHE_PREFIX = 'devauth:';

export interface AuthenticatedDevice {
  device: Device;
  credentialsType: CredentialsType;
  /** True when enforcement is off and the device was resolved by key alone. */
  unauthenticated?: boolean;
}

export type DeviceAuthAttempt =
  | { kind: 'token'; token: string }
  | { kind: 'basic'; username: string; password?: string }
  | { kind: 'x509'; commonName?: string; fingerprint?: string }
  | { kind: 'deviceKey'; deviceKey: string };

@Injectable()
export class DeviceAuthService {
  private readonly logger = new Logger(DeviceAuthService.name);

  /**
   * Enforcement is ON unless explicitly disabled.
   *
   * Turning this off is a deliberate, temporary migration aid for a
   * deployment whose devices have not been issued credentials yet. It is read
   * once so it cannot be flipped at runtime by a mutated environment.
   */
  private readonly enforced = process.env.DEVICE_AUTH_ENFORCED !== 'false';

  constructor(
    @InjectRepository(DeviceCredentials)
    private readonly credentialsRepository: Repository<DeviceCredentials>,
    @InjectRepository(Device)
    private readonly deviceRepository: Repository<Device>,
    @InjectRepository(Edge)
    private readonly edgeRepository: Repository<Edge>,
    private readonly redis: RedisService,
  ) {
    if (!this.enforced) {
      this.logger.error(
        'DEVICE_AUTH_ENFORCED=false — device authentication is DISABLED. ' +
          'Any client that knows a deviceKey can publish telemetry as that ' +
          'device. This is a migration aid only; set it to true (or remove ' +
          'it) as soon as every device has been issued credentials. Run ' +
          '`npm run backfill:device-credentials` to issue them.',
      );
    }
  }

  get isEnforced(): boolean {
    return this.enforced;
  }

  /**
   * Length-safe constant-time comparison.
   *
   * `timingSafeEqual` throws when the buffers differ in length, and the throw
   * itself is an early exit that leaks length. Both sides are hashed to a
   * fixed 32 bytes first, so the comparison is always over equal lengths and
   * reveals nothing about the real secret.
   */
  private static safeEqual(a?: string | null, b?: string | null): boolean {
    if (typeof a !== 'string' || typeof b !== 'string') return false;
    const ha = crypto.createHash('sha256').update(a).digest();
    const hb = crypto.createHash('sha256').update(b).digest();
    return crypto.timingSafeEqual(ha, hb);
  }

  /**
   * Resolve and verify a credential, returning the device it belongs to.
   *
   * Throws nothing — callers get `null` on failure and decide the protocol's
   * own rejection code (4.04 for CoAP, 401 for HTTP, a deny verdict for the
   * MQTT broker). Throwing would force every adapter to translate exceptions.
   */
  async authenticate(
    attempt: DeviceAuthAttempt,
  ): Promise<AuthenticatedDevice | null> {
    try {
      switch (attempt.kind) {
        case 'token':
          return await this.byCredentialsId(attempt.token, undefined, [
            CredentialsType.ACCESS_TOKEN,
            CredentialsType.TUYA,
          ]);

        case 'basic':
          return await this.byCredentialsId(
            attempt.username,
            attempt.password,
            [CredentialsType.MQTT_BASIC, CredentialsType.ACCESS_TOKEN],
          );

        case 'x509': {
          // The CN is the identifier; the fingerprint is the secret. A
          // certificate presenting a known CN with the wrong fingerprint is a
          // forgery, so the fingerprint must match when one is recorded.
          const id = attempt.commonName ?? attempt.fingerprint;
          if (!id) return null;
          return await this.byCredentialsId(id, attempt.fingerprint, [
            CredentialsType.X509_CERTIFICATE,
          ]);
        }

        case 'deviceKey':
          return await this.byDeviceKeyUnauthenticated(attempt.deviceKey);
      }
    } catch (error) {
      // Fail closed. An authentication path that falls open on an unexpected
      // error is worse than one that rejects a legitimate device.
      this.logger.error(
        `Device authentication error: ${(error as Error).message}`,
      );
      return null;
    }
  }

  /**
   * The compatibility path: resolve by deviceKey with no secret at all.
   *
   * Only reachable while `DEVICE_AUTH_ENFORCED=false`. Kept as an explicit,
   * named, logged method rather than an `if` buried in each adapter, so there
   * is exactly one place where an unauthenticated device can enter the
   * platform and it is obvious in a grep.
   */
  private async byDeviceKeyUnauthenticated(
    deviceKey: string,
  ): Promise<AuthenticatedDevice | null> {
    if (this.enforced) return null;

    const device = await this.deviceRepository.findOne({ where: { deviceKey } });
    if (!device) return null;

    this.logger.warn(
      `Unauthenticated ingest accepted for ${deviceKey} ` +
        '(DEVICE_AUTH_ENFORCED=false)',
    );
    return {
      device,
      credentialsType: CredentialsType.ACCESS_TOKEN,
      unauthenticated: true,
    };
  }

  private async byCredentialsId(
    credentialsId: string,
    secret: string | undefined,
    allowedTypes: CredentialsType[],
  ): Promise<AuthenticatedDevice | null> {
    if (!credentialsId) return null;

    const cacheKey =
      CACHE_PREFIX + crypto.createHash('sha256').update(credentialsId).digest('hex');

    // ── Cache ─────────────────────────────────────────────────────────────
    // The cached entry stores the device id and a hash of the expected
    // secret, never the secret itself: Redis is shared with Bull and is not
    // the right place to hold device passwords in clear.
    const cached = await this.redis.get(cacheKey).catch(() => null);
    if (cached === 'MISS') return null;
    if (cached) {
      try {
        const parsed = JSON.parse(cached) as {
          deviceId: string;
          type: CredentialsType;
          secretHash: string | null;
        };
        if (!allowedTypes.includes(parsed.type)) return null;
        if (parsed.secretHash !== null) {
          const given = secret
            ? crypto.createHash('sha256').update(secret).digest('hex')
            : '';
          if (!DeviceAuthService.safeEqual(given, parsed.secretHash)) return null;
        }
        const device = await this.deviceRepository.findOne({
          where: { id: parsed.deviceId },
        });
        if (device) return { device, credentialsType: parsed.type };
      } catch {
        // A corrupt cache entry must not authenticate anyone; fall through to
        // the database.
      }
    }

    // ── Database ──────────────────────────────────────────────────────────
    const credentials = await this.credentialsRepository
      .createQueryBuilder('creds')
      .addSelect('creds.credentialsValue')
      .leftJoinAndSelect('creds.device', 'device')
      .where('creds.credentialsId = :credentialsId', { credentialsId })
      .getOne();

    if (!credentials || !credentials.isValid() || !credentials.device) {
      await this.redis
        .set(cacheKey, 'MISS', NEGATIVE_TTL_SECONDS)
        .catch(() => undefined);
      return null;
    }

    if (!allowedTypes.includes(credentials.credentialsType)) {
      // A valid MQTT_BASIC username presented as a bearer token is not a
      // valid bearer token. Credential types are not interchangeable.
      return null;
    }

    // ── Secret ────────────────────────────────────────────────────────────
    // ACCESS_TOKEN is self-contained: the token IS credentialsId, so there is
    // no second factor to check. Every other type carries a secret that must
    // match.
    const needsSecret =
      credentials.credentialsType === CredentialsType.MQTT_BASIC ||
      credentials.credentialsType === CredentialsType.X509_CERTIFICATE ||
      credentials.credentialsType === CredentialsType.TUYA;

    if (needsSecret) {
      if (!DeviceAuthService.safeEqual(secret, credentials.credentialsValue)) {
        await this.redis
          .set(cacheKey, 'MISS', NEGATIVE_TTL_SECONDS)
          .catch(() => undefined);
        return null;
      }
    }

    await this.redis
      .set(
        cacheKey,
        JSON.stringify({
          deviceId: credentials.device.id,
          type: credentials.credentialsType,
          secretHash: needsSecret
            ? crypto
                .createHash('sha256')
                .update(credentials.credentialsValue ?? '')
                .digest('hex')
            : null,
        }),
        POSITIVE_TTL_SECONDS,
      )
      .catch(() => undefined);

    // Fire and forget: recording usage must not slow the hot path.
    void this.credentialsRepository
      .update(credentials.id, { lastUsedAt: new Date() })
      .catch(() => undefined);

    return {
      device: credentials.device,
      credentialsType: credentials.credentialsType,
    };
  }

  /**
   * Authenticate an EDGE GATEWAY, and authorise it for one of its devices.
   *
   * ─────────────────────────────────────────────────────────────────────────
   * WHY THIS EXISTS
   *
   * An edge agent legitimately speaks for many devices: it sits on a plant
   * network, collects from Modbus panels and local MQTT, and forwards on
   * their behalf. It cannot hold every device's access token, and it should
   * not — a gateway compromised on one site would then hold credentials for
   * every device it has ever seen.
   *
   * Before this, the agent forwarded with nothing but the platform-wide
   * `x-api-key`, which identifies no one. With device authentication enforced
   * that is simply rejected, so the agent could not deliver a single reading.
   * The honest fix is not to weaken device auth; it is to give the gateway an
   * identity of its own and bound what that identity may speak for.
   *
   * ─────────────────────────────────────────────────────────────────────────
   * THE BOUND
   *
   * An edge may ingest for a device only when `device.edgeId` is this edge
   * AND the tenants match. That is the gateway-to-child-device model this
   * platform previously lacked — `POST /v1/ingestion/batch` had to fall back
   * to a whole-tenant bound for want of it.
   *
   * The edge's secret is stored as a SHA-256 hash (`select: false`), so the
   * comparison is hash-to-hash and constant time.
   */
  async authenticateEdgeForDevice(
    edgeKey: string,
    edgeSecret: string,
    deviceKey: string,
  ): Promise<Device | null> {
    if (!edgeKey || !edgeSecret || !deviceKey) return null;

    const edge = await this.edgeRepository
      .createQueryBuilder('e')
      .addSelect('e.edgeSecret')
      .where('e.edgeKey = :edgeKey', { edgeKey })
      .getOne();

    if (!edge) return null;

    const presented = crypto
      .createHash('sha256')
      .update(edgeSecret)
      .digest('hex');

    if (!DeviceAuthService.safeEqual(presented, (edge as any).edgeSecret)) {
      return null;
    }

    const device = await this.deviceRepository.findOne({
      where: { deviceKey },
    });
    if (!device) return null;

    // Both predicates matter. The tenant check alone would let an edge speak
    // for any device in its tenant; the edgeId check alone would be
    // meaningless if edgeIds were ever reused across tenants.
    if (device.edgeId !== edge.id || device.tenantId !== (edge as any).tenantId) {
      return null;
    }

    return device;
  }

  /**
   * Plain lookup by deviceKey. **This is not authentication.**
   *
   * It exists for the one case where a caller has ALREADY authenticated and
   * now needs to check whether some other device is in scope — the batch
   * ingest route resolving each entry so it can compare tenants.
   *
   * Named and documented this bluntly on purpose. `authenticate()` returns
   * null for a bare deviceKey whenever enforcement is on, which is correct;
   * the risk is that someone hits that, finds it inconvenient, and weakens
   * `authenticate()` instead of reaching for this. Any new call site should
   * be read as "I have already proven who is asking".
   */
  async lookupByDeviceKey(deviceKey: string): Promise<Device | null> {
    if (!deviceKey) return null;
    return this.deviceRepository.findOne({ where: { deviceKey } });
  }

  /**
   * Invalidate a cached credential.
   *
   * Without this, revoking or rotating a credential would leave the old one
   * working for up to the positive TTL — which is the difference between a
   * revocation and a suggestion.
   */
  async invalidate(credentialsId: string): Promise<void> {
    const cacheKey =
      CACHE_PREFIX + crypto.createHash('sha256').update(credentialsId).digest('hex');
    await this.redis.del(cacheKey).catch(() => undefined);
  }
}
