import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DeepPartial, Repository } from 'typeorm';
import { RedisService } from '@lib/redis/redis.service';
import { Telemetry } from './entities/telemetry.entity';

/**
 * ─────────────────────────────────────────────────────────────────────────────
 * The latest reading per device, cached — one owner for one key
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * ## Why this is a service and not two lines in each writer
 *
 * `GET /telemetry/:deviceId/latest` is the hottest read on the platform: every
 * dashboard tile, floor-plan marker and device header polls it, so a tenant
 * with 100 devices on screen issues 100 `ORDER BY timestamp DESC LIMIT 1`
 * queries over the largest table in the schema per refresh. It is the single
 * best caching candidate here.
 *
 * But there are **two** ingest paths that produce the value:
 *
 *   • HTTP — `TelemetryService.create()` writes the row itself.
 *   • Kafka — `TelemetryConsumer.storeTelemetry()` writes it through its own
 *     repository, bypassing `TelemetryService` entirely. This covers MQTT,
 *     CoAP, Modbus, SNMP, BACnet, OPC UA and LwM2M: most devices.
 *
 * The previous cache was written by the HTTP path only, so for most devices it
 * held nothing or a stale reading — and its read was commented out, which is
 * the only reason that never surfaced as a bug. A cache with two producers and
 * one of them missing is not slow, it is wrong, so the key has one owner here
 * and both paths call it.
 *
 * ## Invalidation
 *
 * There is nothing to invalidate on write: every reading is a full overwrite,
 * so the newest value replaces the previous one by construction. Telemetry
 * rows are append-only — no endpoint updates one — so the only way the cached
 * row can stop reflecting the database is deletion, and the only thing that
 * deletes telemetry is the retention sweep (§4h). That sweep removes *old*
 * rows, so it can only orphan this key for a device silent for longer than its
 * plan's retention. `TELEMETRY_LATEST_CACHE_TTL` (default 300s) bounds that,
 * and is also the ceiling on staleness if a write-through ever fails.
 *
 * ## Failure behaviour
 *
 * Reads return null on any error, so the caller falls through to Postgres.
 * Writes are awaited by callers that then swallow the rejection: the row is
 * already committed by the time this is called, and a Redis outage must never
 * turn a persisted reading into a failed ingest.
 */
@Injectable()
export class TelemetryLatestCacheService {
  private readonly logger = new Logger(TelemetryLatestCacheService.name);

  private readonly ttlSeconds = Number(
    process.env.TELEMETRY_LATEST_CACHE_TTL ?? 300,
  );

  private readonly enabled = this.ttlSeconds > 0;

  constructor(
    private readonly redis: RedisService,
    // Only for `create()`, to rehydrate a plain object into a real entity.
    // No query is ever issued through it from here.
    @InjectRepository(Telemetry)
    private readonly telemetryRepository: Repository<Telemetry>,
  ) {
    if (!this.enabled) {
      this.logger.warn(
        'TELEMETRY_LATEST_CACHE_TTL=0 — every latest-reading request will ' +
          'query Postgres.',
      );
    }
  }

  static key(deviceId: string): string {
    return `telemetry:latest:${deviceId}`;
  }

  /** Write-through. Called by both ingest paths. */
  async write(deviceId: string, telemetry: Telemetry): Promise<void> {
    if (!this.enabled) return;
    await this.redis.set(
      TelemetryLatestCacheService.key(deviceId),
      JSON.stringify(telemetry),
      this.ttlSeconds,
    );
  }

  /**
   * Read and rehydrate, or null.
   *
   * Rehydrated through the repository so the result is a real `Telemetry`
   * instance, and `timestamp` is converted back to a `Date` — JSON leaves it
   * as an ISO string, and a response serialiser or a `.getTime()` on a string
   * is how a cache becomes an intermittent 500 that only happens on a cache
   * hit.
   */
  async read(deviceId: string): Promise<Telemetry | null> {
    if (!this.enabled) return null;

    try {
      const raw = await this.redis.get(
        TelemetryLatestCacheService.key(deviceId),
      );
      if (!raw) return null;

      const parsed = JSON.parse(raw);
      if (!parsed || typeof parsed !== 'object' || !parsed.timestamp) {
        return null;
      }

      // The cast picks the single-entity `create()` overload. Spreading an
      // `any` leaves TypeScript free to resolve the array overload instead,
      // which types the result as `Telemetry[]` and would have been returned
      // as the response body.
      const plain: DeepPartial<Telemetry> = {
        ...parsed,
        timestamp: new Date(parsed.timestamp),
      };
      return this.telemetryRepository.create(plain);
    } catch (error) {
      this.logger.debug(
        `latest-telemetry cache read failed for ${deviceId}: ${(error as Error).message}`,
      );
      return null;
    }
  }

  getTtlSeconds(): number {
    return this.ttlSeconds;
  }
}
