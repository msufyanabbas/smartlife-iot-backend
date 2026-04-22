import { Injectable, Logger, OnApplicationShutdown } from '@nestjs/common';
import Redis, { ChainableCommander } from 'ioredis';

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

  constructor() {
    this.client = new Redis({
      host: process.env.REDIS_HOST || 'localhost',
      port: parseInt(process.env.REDIS_PORT || '6379', 10),
      password: process.env.REDIS_PASSWORD,
      db: parseInt(process.env.REDIS_DB || '0', 10),
      retryStrategy: (times) => Math.min(times * 50, 2000),
      maxRetriesPerRequest: parseInt(process.env.REDIS_MAX_RETRIES || '3', 10),
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
    this.client.on('reconnecting', () => this.logger.log('Redis reconnecting...'));
  }

  async connect(): Promise<void> {
    if (!this.isConnected) {
      await this.client.connect();
    }
  }

  async onApplicationShutdown(): Promise<void> {
    for (const sub of this.subscribers) {
      await sub.quit();
    }
    this.subscribers.length = 0;
    await this.client.quit();
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

  async hincrby(key: string, field: string, increment: number): Promise<number> {
    return this.client.hincrby(key, field, increment);
  }

  async hincrbyfloat(key: string, field: string, increment: number): Promise<string> {
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

  async srandmember(key: string, count?: number): Promise<string | string[] | null> {
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

  async zrange(key: string, start: number, stop: number, withScores?: boolean): Promise<string[]> {
    return withScores
      ? this.client.zrange(key, start, stop, 'WITHSCORES')
      : this.client.zrange(key, start, stop);
  }

  async zrevrange(key: string, start: number, stop: number, withScores?: boolean): Promise<string[]> {
    return withScores
      ? this.client.zrevrange(key, start, stop, 'WITHSCORES')
      : this.client.zrevrange(key, start, stop);
  }

  async zrangebyscore(key: string, min: number | string, max: number | string): Promise<string[]> {
    return this.client.zrangebyscore(key, min, max);
  }

  async zcard(key: string): Promise<number> {
    return this.client.zcard(key);
  }

  async zscore(key: string, member: string): Promise<string | null> {
    return this.client.zscore(key, member);
  }

  async zincrby(key: string, increment: number, member: string): Promise<string> {
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

  async keys(pattern: string): Promise<string[]> {
    return this.client.keys(pattern);
  }

  async scan(cursor: number, pattern?: string, count?: number): Promise<[string, string[]]> {
    if (pattern && count) return this.client.scan(cursor, 'MATCH', pattern, 'COUNT', count);
    if (pattern) return this.client.scan(cursor, 'MATCH', pattern);
    if (count) return this.client.scan(cursor, 'COUNT', count);
    return this.client.scan(cursor);
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
  async subscribe(channel: string, callback: (message: string) => void): Promise<void> {
    const sub = this.client.duplicate();
    this.subscribers.push(sub);

    await sub.subscribe(channel);
    sub.on('message', (chan, msg) => {
      if (chan === channel) callback(msg);
    });
  }

  // ── Cache helpers ─────────────────────────────────────────────────────────

  async cache<T>(key: string, fetchFn: () => Promise<T>, ttl = 300): Promise<T> {
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

  async invalidateCache(pattern: string): Promise<void> {
    const matched = await this.keys(pattern);
    if (matched.length > 0) await this.del(...matched);
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

  async acquireLock(lockKey: string, ttl = 10, retries = 3): Promise<boolean> {
    for (let i = 0; i < retries; i++) {
      const result = await this.client.set(lockKey, '1', 'EX', ttl, 'NX');
      if (result === 'OK') return true;
      await new Promise((r) => setTimeout(r, 100));
    }
    return false;
  }

  async releaseLock(lockKey: string): Promise<void> {
    await this.del(lockKey);
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