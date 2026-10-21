import { Injectable, Logger, OnApplicationShutdown } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Redis, { ChainableCommander } from 'ioredis';
import type { RedisConfig } from '@common/interfaces/common.interface';

@Injectable()
export class RedisService implements OnApplicationShutdown {
  private readonly logger = new Logger(RedisService.name);

  public readonly client: Redis;
  private isConnected = false;

  // Track subscriber clients so they can be cleaned up on shutdown.
  // A new duplicate connection is created per subscribe() call — this is
  // required by Redis (a client in subscribe mode cannot run regular commands).
  // We keep references here to close them properly.
  private readonly subscribers: Redis[] = [];

  /** Kept so duplicate() connections for pub/sub inherit the same settings. */
  private readonly settings: RedisConfig;

  constructor(private readonly configService: ConfigService) {
    // redis.config.ts already declared keyPrefix, the two timeouts, retryDelay,
    // enableReadyCheck and enableOfflineQueue — but nothing consumed the
    // namespace, so every one of those variables was inert. Reading the whole
    // namespace here makes them take effect.
    this.settings = this.configService.get<RedisConfig>('redis')!;

    this.client = new Redis({
      host: this.settings.host,
      port: this.settings.port,
      password: this.settings.password,
      db: this.settings.db,
      keyPrefix: this.settings.keyPrefix,
      connectTimeout: this.settings.connectTimeout,
      commandTimeout: this.settings.commandTimeout,
      // Backoff is capped so a long outage does not turn into an unbounded
      // wait; REDIS_RETRY_DELAY sets the ceiling.
      retryStrategy: (times) =>
        Math.min(times * 50, this.settings.retryDelay ?? 2000),
      maxRetriesPerRequest: this.settings.maxRetriesPerRequest,
      enableReadyCheck: this.settings.enableReadyCheck,
      enableOfflineQueue: this.settings.enableOfflineQueue,
      lazyConnect: true,
    });

    this.client.on('connect', () => {
      this.logger.log('Redis connected');
      this.isConnected = true;
    });
    this.client.on('ready', () => this.logger.log('Redis ready'));
    this.client.on('error', (err) => {
      this.logger.error(`Redis error: ${err.message}`);
      this.isConnected = false;
    });
    this.client.on('close', () => {
      this.logger.warn('Redis connection closed');
      this.isConnected = false;
    });
    this.client.on('reconnecting', () =>
      this.logger.log('Redis reconnecting...'),
    );
  }

  /**
   * ── Redis must not decide whether the platform boots either ───────────────
   *
   * This used to `await this.client.connect()` from `RedisModule`'s factory.
   * With `lazyConnect: true` that call is what opens the socket, so a Redis
   * that was down at boot rejected the factory, Nest aborted the DI graph and
   * the process exited — the same shape of failure `KafkaModule` had, and
   * with the same consequence: no HTTP server, no `/health`, nothing that
   * named the cause.
   *
   * It is now fire-and-forget. ioredis owns the reconnect (`retryStrategy`,
   * capped by REDIS_RETRY_DELAY) and reconnects by itself, so Redis coming
   * back needs no restart.
   *
   * ── What a Redis outage means at runtime, deliberately ────────────────────
   *
   * The platform **fails closed** on anything Redis is authoritative for, and
   * degrades for anything Redis only caches:
   *
   *   • Sessions (`session:*`) and the token blacklist live ONLY in Redis.
   *     Redis down therefore means no new logins and no session refresh —
   *     and that is the correct behaviour, not an accident: failing open
   *     would mean accepting a token the blacklist exists to reject, so a
   *     logout or a compromised-token revocation would stop being enforced
   *     exactly when the infrastructure is least observable.
   *   • Caches (permissions, subscriptions, device credentials, latest
   *     telemetry) fail OPEN to their source of truth: every read is wrapped
   *     so a Redis error falls through to Postgres. A slow platform is the
   *     right failure mode for a cache miss.
   *
   * `enableOfflineQueue` (REDIS_OFFLINE_QUEUE, default true) is what makes the
   * second half work: a command issued during a brief reconnect is queued
   * rather than rejected, so a blip does not surface as an error at all.
   */
  connect(): void {
    if (this.isConnected) return;

    this.client.connect().catch((error: Error) => {
      this.logger.error(
        `Redis initial connect failed (${this.settings.host}:${this.settings.port}): ` +
          `${error.message}. ioredis will keep retrying. The application stays ` +
          `up: cached reads fall through to Postgres, but logins and session ` +
          `refresh will fail until Redis is reachable.`,
      );
    });
  }

  async onApplicationShutdown(): Promise<void> {
    // Every quit is guarded. `quit()` on a client that never reached a
    // connected state rejects with "Connection is closed" — which was
    // unreachable while the boot could not complete without Redis, and is now
    // the normal case: the app boots with Redis down, so shutdown has to cope
    // with a client that never connected. An unhandled rejection in
    // onApplicationShutdown turns a clean SIGTERM into a non-zero exit and,
    // worse, skips the shutdown hooks registered after this one.
    for (const sub of this.subscribers) {
      await sub.quit().catch(() => undefined);
    }
    this.subscribers.length = 0;
    await this.client.quit().catch(() => undefined);
    this.isConnected = false;
    this.logger.log('Redis disconnected');
  }

  // ── String ────────────────────────────────────────────────────────────────

  async set(key: string, value: string, ttl?: number): Promise<void> {
    if (ttl) {
      await this.client.setex(key, ttl, value);
    } else {
      await this.client.set(key, value);
    }
  }

  async get(key: string): Promise<string | null> {
    return this.client.get(key);
  }

  async mget(...keys: string[]): Promise<(string | null)[]> {
    return this.client.mget(...keys);
  }

  async mset(data: Record<string, string>): Promise<void> {
    const pairs = Object.entries(data).flat();
    if (pairs.length > 0) await this.client.mset(...pairs);
  }

  async increment(key: string, by = 1): Promise<number> {
    return by === 1 ? this.client.incr(key) : this.client.incrby(key, by);
  }

  async decrement(key: string, by = 1): Promise<number> {
    return by === 1 ? this.client.decr(key) : this.client.decrby(key, by);
  }

  async incrby(key: string, increment: number): Promise<number> {
    return this.client.incrby(key, increment);
  }

  async decrby(key: string, decrement: number): Promise<number> {
    return this.client.decrby(key, decrement);
  }

  // ── Hash ──────────────────────────────────────────────────────────────────

  async hset(key: string, field: string, value: string): Promise<void> {
    await this.client.hset(key, field, value);
  }

  async hget(key: string, field: string): Promise<string | null> {
    return this.client.hget(key, field);
  }

  async hgetall(key: string): Promise<Record<string, string>> {
    return this.client.hgetall(key);
  }

  async hmset(key: string, data: Record<string, any>): Promise<void> {
    const stringData: Record<string, string> = {};
    for (const [k, v] of Object.entries(data)) stringData[k] = String(v);
    await this.client.hmset(key, stringData);
  }

  async hmget(key: string, ...fields: string[]): Promise<(string | null)[]> {
    return this.client.hmget(key, ...fields);
  }

  async hdel(key: string, ...fields: string[]): Promise<void> {
    await this.client.hdel(key, ...fields);
  }

  async hexists(key: string, field: string): Promise<boolean> {
    return (await this.client.hexists(key, field)) === 1;
  }

  async hlen(key: string): Promise<number> {
    return this.client.hlen(key);
  }

  async hkeys(key: string): Promise<string[]> {
    return this.client.hkeys(key);
  }

  async hvals(key: string): Promise<string[]> {
    return this.client.hvals(key);
  }

  async hincrby(
    key: string,
    field: string,
    increment: number,
  ): Promise<number> {
    return this.client.hincrby(key, field, increment);
  }

  async hincrbyfloat(
    key: string,
    field: string,
    increment: number,
  ): Promise<string> {
    return this.client.hincrbyfloat(key, field, increment);
  }

  // ── Set ───────────────────────────────────────────────────────────────────

  async sadd(key: string, ...members: string[]): Promise<void> {
    if (members.length > 0) await this.client.sadd(key, ...members);
  }

  async srem(key: string, ...members: string[]): Promise<void> {
    if (members.length > 0) await this.client.srem(key, ...members);
  }

  async smembers(key: string): Promise<string[]> {
    return this.client.smembers(key);
  }

  async sismember(key: string, member: string): Promise<boolean> {
    return (await this.client.sismember(key, member)) === 1;
  }

  async scard(key: string): Promise<number> {
    return this.client.scard(key);
  }

  async spop(key: string, count?: number): Promise<string | string[] | null> {
    return count ? this.client.spop(key, count) : this.client.spop(key);
  }

  async srandmember(
    key: string,
    count?: number,
  ): Promise<string | string[] | null> {
    return count
      ? this.client.srandmember(key, count)
      : this.client.srandmember(key);
  }

  // ── Sorted set ────────────────────────────────────────────────────────────

  async zadd(key: string, score: number, member: string): Promise<void> {
    await this.client.zadd(key, score, member);
  }

  async zrem(key: string, ...members: string[]): Promise<void> {
    if (members.length > 0) await this.client.zrem(key, ...members);
  }

  async zrange(
    key: string,
    start: number,
    stop: number,
    withScores?: boolean,
  ): Promise<string[]> {
    return withScores
      ? this.client.zrange(key, start, stop, 'WITHSCORES')
      : this.client.zrange(key, start, stop);
  }

  async zrevrange(
    key: string,
    start: number,
    stop: number,
    withScores?: boolean,
  ): Promise<string[]> {
    return withScores
      ? this.client.zrevrange(key, start, stop, 'WITHSCORES')
      : this.client.zrevrange(key, start, stop);
  }

  async zrangebyscore(
    key: string,
    min: number | string,
    max: number | string,
  ): Promise<string[]> {
    return this.client.zrangebyscore(key, min, max);
  }

  async zcard(key: string): Promise<number> {
    return this.client.zcard(key);
  }

  async zscore(key: string, member: string): Promise<string | null> {
    return this.client.zscore(key, member);
  }

  async zincrby(
    key: string,
    increment: number,
    member: string,
  ): Promise<string> {
    return this.client.zincrby(key, increment, member);
  }

  // ── List ──────────────────────────────────────────────────────────────────

  async lpush(key: string, ...values: string[]): Promise<void> {
    if (values.length > 0) await this.client.lpush(key, ...values);
  }

  async rpush(key: string, ...values: string[]): Promise<void> {
    if (values.length > 0) await this.client.rpush(key, ...values);
  }

  async lpop(key: string): Promise<string | null> {
    return this.client.lpop(key);
  }

  async rpop(key: string): Promise<string | null> {
    return this.client.rpop(key);
  }

  async lrange(key: string, start: number, stop: number): Promise<string[]> {
    return this.client.lrange(key, start, stop);
  }

  async llen(key: string): Promise<number> {
    return this.client.llen(key);
  }

  async lindex(key: string, index: number): Promise<string | null> {
    return this.client.lindex(key, index);
  }

  async lset(key: string, index: number, value: string): Promise<void> {
    await this.client.lset(key, index, value);
  }

  async ltrim(key: string, start: number, stop: number): Promise<void> {
    await this.client.ltrim(key, start, stop);
  }

  async lrem(key: string, count: number, value: string): Promise<void> {
    await this.client.lrem(key, count, value);
  }

  // ── Keys ──────────────────────────────────────────────────────────────────

  async del(...keys: string[]): Promise<void> {
    if (keys.length > 0) await this.client.del(...keys);
  }

  async exists(...keys: string[]): Promise<number> {
    return this.client.exists(...keys);
  }

  async expire(key: string, seconds: number): Promise<void> {
    await this.client.expire(key, seconds);
  }

  async expireat(key: string, timestamp: number): Promise<void> {
    await this.client.expireat(key, timestamp);
  }

  async ttl(key: string): Promise<number> {
    return this.client.ttl(key);
  }

  async persist(key: string): Promise<void> {
    await this.client.persist(key);
  }

  /**
   * ── The keyPrefix asymmetry, which made this method silently useless ──────
   *
   * ioredis applies `keyPrefix` to arguments it knows are KEYS, derived from
   * the Redis command table. `KEYS` and `SCAN` take a *pattern*, not a key, so
   * Redis reports them as having no key arguments and ioredis does NOT prefix
   * them — while the keys that come back in the reply ARE returned with the
   * prefix still attached, because ioredis only strips prefixes it added.
   *
   * The result was a method that was wrong in both directions at once:
   *
   *   keys('session:*')  → asked the server for literal `session:*`
   *                        → matched nothing, because every key on this
   *                          connection is stored as `smartlife:session:*`
   *   the reply          → would have been `['smartlife:session:abc']`
   *                        → fed back into del(), which prefixes again
   *                        → DEL smartlife:smartlife:session:abc
   *
   * So a pattern delete could not match, and if it had matched it would have
   * deleted the wrong keys. `invalidateCache()` is built on this and therefore
   * never invalidated anything — it reported success every time.
   *
   * Both halves are corrected here: the pattern is prefixed on the way out and
   * the prefix is stripped on the way back, so a caller passes and receives
   * logical keys and never has to know the prefix exists.
   */
  async keys(pattern: string): Promise<string[]> {
    const prefix = this.settings.keyPrefix ?? '';
    const found = await this.client.keys(`${prefix}${pattern}`);
    return found.map((k) => (k.startsWith(prefix) ? k.slice(prefix.length) : k));
  }

  async scan(
    cursor: number,
    pattern?: string,
    count?: number,
  ): Promise<[string, string[]]> {
    const prefix = this.settings.keyPrefix ?? '';
    const match = pattern === undefined ? undefined : `${prefix}${pattern}`;

    const [next, found] = await (match && count
      ? this.client.scan(cursor, 'MATCH', match, 'COUNT', count)
      : match
        ? this.client.scan(cursor, 'MATCH', match)
        : count
          ? this.client.scan(cursor, 'COUNT', count)
          : this.client.scan(cursor));

    return [
      next,
      found.map((k) => (k.startsWith(prefix) ? k.slice(prefix.length) : k)),
    ];
  }

  async rename(oldKey: string, newKey: string): Promise<void> {
    await this.client.rename(oldKey, newKey);
  }

  async type(key: string): Promise<string> {
    return this.client.type(key);
  }

  // ── Transactions ──────────────────────────────────────────────────────────

  multi(): ChainableCommander {
    return this.client.multi();
  }

  // ── Pub/Sub ───────────────────────────────────────────────────────────────

  async publish(channel: string, message: string): Promise<number> {
    return this.client.publish(channel, message);
  }

  // Each call creates one tracked duplicate connection.
  // All are closed cleanly in onApplicationShutdown().
  async subscribe(
    channel: string,
    callback: (message: string) => void,
  ): Promise<void> {
    const sub = this.client.duplicate();
    this.subscribers.push(sub);

    await sub.subscribe(channel);
    sub.on('message', (chan, msg) => {
      if (chan === channel) callback(msg);
    });
  }

  // ── Cache helpers ─────────────────────────────────────────────────────────

  async cache<T>(
    key: string,
    fetchFn: () => Promise<T>,
    ttl = 300,
  ): Promise<T> {
    const cached = await this.get(key);
    if (cached) {
      try {
        return JSON.parse(cached) as T;
      } catch {
        await this.del(key);
      }
    }
    const data = await fetchFn();
    await this.set(key, JSON.stringify(data), ttl);
    return data;
  }

  /**
   * Delete every key matching a pattern.
   *
   * Uses SCAN, not KEYS: `KEYS` is O(n) over the entire keyspace and blocks
   * the single-threaded server for the whole scan. On a database that also
   * holds this platform's cache entries that is a stall for every other
   * client, and it grows with the number of devices.
   *
   * Prefer an explicit key or a version bump (see `PermissionCacheService`)
   * over a pattern delete. This exists for the cases where the key set is not
   * enumerable, and it is deliberately not on any hot path.
   */
  async invalidateCache(pattern: string): Promise<number> {
    let cursor = 0;
    let deleted = 0;

    do {
      const [next, batch] = await this.scan(cursor, pattern, 500);
      cursor = Number(next);
      if (batch.length > 0) {
        await this.del(...batch);
        deleted += batch.length;
      }
    } while (cursor !== 0);

    return deleted;
  }

  // ── Rate limiting ─────────────────────────────────────────────────────────

  async checkRateLimit(
    key: string,
    limit: number,
    window: number,
  ): Promise<{ allowed: boolean; remaining: number; resetAt: number }> {
    const current = await this.increment(key);
    if (current === 1) await this.expire(key, window);

    const ttlSeconds = await this.ttl(key);
    return {
      allowed: current <= limit,
      remaining: Math.max(0, limit - current),
      resetAt: Date.now() + ttlSeconds * 1000,
    };
  }

  async resetRateLimit(key: string): Promise<void> {
    await this.del(key);
  }

  // ── Sessions ──────────────────────────────────────────────────────────────

  async setSession(sessionId: string, data: any, ttl = 3600): Promise<void> {
    await this.set(`session:${sessionId}`, JSON.stringify(data), ttl);
  }

  async getSession<T = any>(sessionId: string): Promise<T | null> {
    const raw = await this.get(`session:${sessionId}`);
    return raw ? (JSON.parse(raw) as T) : null;
  }

  async deleteSession(sessionId: string): Promise<void> {
    await this.del(`session:${sessionId}`);
  }

  async refreshSession(sessionId: string, ttl = 3600): Promise<void> {
    await this.expire(`session:${sessionId}`, ttl);
  }

  // ── Distributed lock ──────────────────────────────────────────────────────

  /**
   * `SET key <owner> EX ttl NX` — the claim one replica wins and the others
   * lose.
   *
   * `owner` defaults to '1' for backwards compatibility, but every caller that
   * intends to *release* the lock must pass a unique token and release with
   * `releaseLockIfOwner()`. Releasing by key alone (`releaseLock`) is only safe
   * when the holder is certain it still owns the lock: if a job overruns its
   * TTL, the key has already expired and been re-acquired by another replica,
   * and a blind DEL then unlocks that replica's work mid-run.
   */
  async acquireLock(
    lockKey: string,
    ttl = 10,
    retries = 3,
    owner = '1',
  ): Promise<boolean> {
    for (let i = 0; i < retries; i++) {
      const result = await this.client.set(lockKey, owner, 'EX', ttl, 'NX');
      if (result === 'OK') return true;
      if (i < retries - 1) await new Promise((r) => setTimeout(r, 100));
    }
    return false;
  }

  /**
   * Unconditional release. Prefer `releaseLockIfOwner()` — see above.
   */
  async releaseLock(lockKey: string): Promise<void> {
    await this.del(lockKey);
  }

  /** Compare-and-delete: only the token that set the lock can clear it. */
  async releaseLockIfOwner(lockKey: string, owner: string): Promise<boolean> {
    const released = await this.client.eval(
      `if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('del', KEYS[1]) else return 0 end`,
      1,
      lockKey,
      owner,
    );
    return released === 1;
  }

  /**
   * Push the expiry out while the holder is still working, so a lock TTL can be
   * sized for a *typical* run instead of the worst imaginable one. Returns
   * false when the lock is gone or owned by somebody else, which is the signal
   * that this holder has lost it.
   */
  async extendLockIfOwner(
    lockKey: string,
    owner: string,
    ttl: number,
  ): Promise<boolean> {
    const extended = await this.client.eval(
      `if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('expire', KEYS[1], ARGV[2]) else return 0 end`,
      1,
      lockKey,
      owner,
      String(ttl),
    );
    return extended === 1;
  }

  // ── Health ────────────────────────────────────────────────────────────────

  async ping(): Promise<boolean> {
    try {
      return (await this.client.ping()) === 'PONG';
    } catch {
      return false;
    }
  }

  async info(section?: string): Promise<string> {
    return section ? this.client.info(section) : this.client.info();
  }

  async dbsize(): Promise<number> {
    return this.client.dbsize();
  }

  async flushdb(): Promise<void> {
    await this.client.flushdb();
  }

  async flushall(): Promise<void> {
    await this.client.flushall();
  }

  isHealthy(): boolean {
    return this.isConnected;
  }

  getClient(): Redis {
    return this.client;
  }
}
