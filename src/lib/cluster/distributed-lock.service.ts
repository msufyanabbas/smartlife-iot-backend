// src/lib/cluster/distributed-lock.service.ts
//
// One job, one runner — across however many replicas are up.
//
// ── The defect this exists to remove ────────────────────────────────────────
// `@Cron` is a per-process timer. @nestjs/schedule registers it once per
// application instance, so with `--scale app=3` every cron body runs three
// times, concurrently, on three different processes. For an idempotent bulk
// UPDATE that is merely wasteful. For the jobs that *act* — generating a
// report and emailing it, dispatching a scheduled automation (which can
// publish a device command), sweeping subscription expiry, polling a
// rate-limited vendor API — it is duplicated side effects: three copies of
// every scheduled notification, three identical report emails, a device
// commanded three times.
//
// `RedisService.acquireLock()` had been written for exactly this and had ZERO
// callers. This is the wrapper that gives it some.
//
// ── The three properties a lock like this has to have ──────────────────────
//
//   1. **Released on completion.** Otherwise the next tick of a per-minute
//      cron finds the lock still held and the job silently stops running
//      until the TTL expires. Release is a compare-and-delete against a
//      per-run token (`releaseLockIfOwner`), never a blind DEL: a job that
//      overran its TTL no longer owns the key, and deleting it would unlock
//      another replica's in-flight run.
//
//   2. **Survives a crash via TTL.** If the holder is SIGKILLed mid-run the
//      key still expires, so the job is not wedged until a human notices. That
//      is why the lock is a Redis key with an EX and not a row with a flag.
//
//   3. **A TTL longer than the worst-case runtime.** If the TTL is shorter
//      than the run, a second replica acquires the key while the first is
//      still working and both execute — the lock then costs a round trip and
//      buys nothing. Rather than asking every call site to guess its own worst
//      case, the holder RENEWS: a watchdog re-arms the TTL every third of it
//      for as long as the body is running. So `ttl` only has to exceed the
//      renewal interval plus one Redis round trip, and an overrun is covered
//      automatically while the process is alive.
//
// ── Fail-closed, on purpose ─────────────────────────────────────────────────
// If Redis cannot be reached, the lock cannot be claimed and the job is
// SKIPPED, not run. Running it would reintroduce the duplication the lock
// exists to prevent, on every replica at once, which is strictly worse than
// one missed tick — and `RedisModule` awaits a connection at boot anyway, so
// "Redis is down" already means "the application is down". Set
// `CLUSTER_LOCKS_ENABLED=false` to bypass locking entirely on a deliberately
// single-process deployment.

import { Injectable, Logger } from '@nestjs/common';
import { randomUUID } from 'crypto';
import { RedisService } from '@/lib/redis/redis.service';
import { envBoolean } from '@/config/env.utils';

/** Namespace for every cluster lock key, under the global REDIS_KEY_PREFIX. */
const LOCK_PREFIX = 'cluster:lock:';

/** Floor on the TTL. Below this the renewal interval stops making sense. */
const MIN_TTL_SECONDS = 5;

export interface LockOptions {
  /** Seconds. See the class comment — renewal means this is a floor, not a cap. */
  ttlSeconds?: number;
  /**
   * Keep re-arming the TTL while the body runs. Default true. Turn it off only
   * for a body whose duration is genuinely bounded and short.
   */
  renew?: boolean;
}

export type LockSkipReason = 'not-acquired' | 'disabled-no-redis';

export type LockOutcome<T> =
  | { ran: true; result: T }
  | { ran: false; reason: LockSkipReason };

@Injectable()
export class DistributedLockService {
  private readonly logger = new Logger(DistributedLockService.name);

  /**
   * The one instance, exposed statically so `@DistributedCron` can reach it.
   *
   * A method decorator runs at class-definition time and has no DI container,
   * so the alternative is making every service that owns a cron inject this
   * service and thread it through — a constructor change in six modules, two
   * of which are being edited by other people right now. The holder is set
   * once, by Nest, when the @Global ClusterModule instantiates the provider.
   */
  static instance: DistributedLockService | undefined;

  /** Identifies this process in lock values and log lines. */
  readonly nodeId = `${process.env.HOSTNAME ?? 'node'}-${process.pid}`;

  private readonly enabled = envBoolean(
    process.env.CLUSTER_LOCKS_ENABLED,
    true,
  );

  constructor(private readonly redis: RedisService) {
    DistributedLockService.instance = this;
    this.logger.log(
      this.enabled
        ? `Distributed cron locks ENABLED (node ${this.nodeId}) — one replica runs each tick`
        : 'Distributed cron locks DISABLED by CLUSTER_LOCKS_ENABLED=false — ' +
            'every replica will run every cron. Only correct on a single-process deployment.',
    );
  }

  /**
   * Run `work` on at most one replica.
   *
   * Returns `{ran: false}` when another replica holds the lock — which is the
   * normal, expected outcome on every replica but one, so it is logged at
   * debug level and is not an error.
   */
  async withLock<T>(
    name: string,
    work: () => Promise<T>,
    options: LockOptions = {},
  ): Promise<LockOutcome<T>> {
    if (!this.enabled) {
      return { ran: true, result: await work() };
    }

    const ttl = Math.max(MIN_TTL_SECONDS, Math.floor(options.ttlSeconds ?? 60));
    const key = `${LOCK_PREFIX}${name}`;
    const token = `${this.nodeId}:${randomUUID()}`;

    let acquired = false;
    try {
      // retries = 1: a cron tick must not sit waiting for a lock another
      // replica legitimately holds. Losing the race IS the correct outcome.
      acquired = await this.redis.acquireLock(key, ttl, 1, token);
    } catch (error) {
      this.logger.error(
        `Could not reach Redis to claim "${name}" — SKIPPING this run rather ` +
          `than risking a duplicate: ${(error as Error).message}. ` +
          `This work is not happening on any replica while Redis is ` +
          `unreachable; see /health/cluster. On a deliberately ` +
          `single-process deployment set CLUSTER_LOCKS_ENABLED=false so ticks ` +
          `run without a lock.`,
      );
      this.recordSkip(name, 'disabled-no-redis');
      return { ran: false, reason: 'disabled-no-redis' };
    }

    if (!acquired) {
      this.logger.debug(`"${name}" is held by another replica — skipping`);
      this.recordSkip(name, 'not-acquired');
      return { ran: false, reason: 'not-acquired' };
    }

    const watchdog =
      options.renew === false ? undefined : this.startWatchdog(key, token, ttl);

    try {
      return { ran: true, result: await work() };
    } finally {
      if (watchdog) clearInterval(watchdog);
      try {
        await this.redis.releaseLockIfOwner(key, token);
      } catch (error) {
        // Not fatal: the TTL releases it. Worst case is one skipped tick.
        this.logger.warn(
          `Failed to release lock "${name}": ${(error as Error).message} — ` +
            `it will expire within ${ttl}s`,
        );
      }
    }
  }

  /**
   * Re-arm the TTL every ttl/3 seconds. `unref()` so a renewal timer can never
   * hold the process open during shutdown.
   */
  private startWatchdog(
    key: string,
    token: string,
    ttl: number,
  ): NodeJS.Timeout {
    const intervalMs = Math.max(1000, Math.floor((ttl * 1000) / 3));
    const timer = setInterval(() => {
      void this.redis.extendLockIfOwner(key, token, ttl).catch(() => false);
    }, intervalMs);
    timer.unref?.();
    return timer;
  }

  /** Is a named lock currently held? Introspection for ops and the guard script. */
  async isHeld(name: string): Promise<boolean> {
    return (await this.redis.exists(`${LOCK_PREFIX}${name}`)) > 0;
  }

  get locksEnabled(): boolean {
    return this.enabled;
  }

  /**
   * ── Why skipping has to be observable ──────────────────────────────────
   *
   * When Redis cannot be reached, `withLock` returns `{ran: false}` and the
   * cron body does not run. That is the right call — a lock that cannot be
   * claimed might be held by another replica, and duplicating a billing sweep
   * is worse than deferring it — but the consequence deserves stating plainly:
   *
   *   nine crons are locked. Report delivery, scheduled notifications,
   *   automation schedules, Tuya polling, subscription expiry, usage sync,
   *   the monthly usage reset, scheduled downgrades and the device-offline
   *   sweep ALL stop while Redis is unreachable.
   *
   * Nothing throws, no request fails, and no probe turns red. The only trace
   * was one error line per tick in a log nobody reads during an incident, so
   * "reports stopped going out three days ago" would have been diagnosed from
   * scratch.
   *
   * These counters make it answerable. They are per-process and reset on
   * restart, which is the honest scope: this is "what has this replica
   * skipped", not a cluster-wide total.
   */
  private readonly skips = new Map<
    string,
    { noRedis: number; notAcquired: number; lastNoRedisAt?: Date }
  >();

  private recordSkip(name: string, reason: LockSkipReason): void {
    const entry =
      this.skips.get(name) ?? { noRedis: 0, notAcquired: 0 };
    if (reason === 'disabled-no-redis') {
      entry.noRedis++;
      entry.lastNoRedisAt = new Date();
    } else {
      entry.notAcquired++;
    }
    this.skips.set(name, entry);
  }

  /**
   * A summary for the health endpoint.
   *
   * `notAcquired` is normal and healthy on more than one replica — exactly one
   * winner per tick means the losers report it. `noRedis` is not: it means the
   * work did not happen anywhere.
   */
  stats(): {
    nodeId: string;
    locksEnabled: boolean;
    degraded: boolean;
    crons: Array<{
      name: string;
      skippedNoRedis: number;
      skippedNotAcquired: number;
      lastNoRedisAt?: string;
    }>;
  } {
    const crons = [...this.skips.entries()].map(([name, entry]) => ({
      name,
      skippedNoRedis: entry.noRedis,
      skippedNotAcquired: entry.notAcquired,
      ...(entry.lastNoRedisAt
        ? { lastNoRedisAt: entry.lastNoRedisAt.toISOString() }
        : {}),
    }));

    return {
      nodeId: this.nodeId,
      locksEnabled: this.enabled,
      // Degraded means scheduled work is being dropped platform-wide, not that
      // this replica merely lost a race.
      degraded: crons.some((c) => c.skippedNoRedis > 0),
      crons,
    };
  }
}
