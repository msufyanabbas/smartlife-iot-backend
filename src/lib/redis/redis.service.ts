// src/lib/redis/redis.service.ts
import Redis, { Pipeline, ChainableCommander } from 'ioredis';

export class RedisService {
  public client: Redis;
  private isConnected = false;

  constructor() {
    this.client = new Redis({
      host: process.env.REDIS_HOST || 'localhost',
      port: parseInt(process.env.REDIS_PORT || '6379'),
      password: process.env.REDIS_PASSWORD,
      db: parseInt(process.env.REDIS_DB || '0'),
      retryStrategy: (times) => {
        const delay = Math.min(times * 50, 2000);
        return delay;
      },
      maxRetriesPerRequest: Number(process.env.REDIS_MAX_RETRIES) || 3,
      lazyConnect: true,
    });

    this.setupEventHandlers();
  }

  private setupEventHandlers(): void {
    this.client.on('connect', () => {
      console.log('✅ Redis connected');
      this.isConnected = true;
    });
    this.client.on('error', (error) => {
      console.error('❌ Redis error:', error);
      this.isConnected = false;
    });
    this.client.on('ready', () => console.log('✅ Redis ready'));
    this.client.on('close', () => {
      console.log('🔌 Redis connection closed');
      this.isConnected = false;
    });
    this.client.on('reconnecting', () => {
      console.log('🔄 Redis reconnecting...');
    });
  }

  async connect(): Promise<void> {
    if (!this.isConnected) {
      await this.client.connect();
    }
  }

  async disconnect(): Promise<void> {
    await this.client.quit();
    this.isConnected = false;
  }

  // ============ STRING OPERATIONS ============
  async set(key: string, value: string, ttl?: number): Promise<void> {
    if (ttl) {
      await this.client.setex(key, ttl, value);
    } else {
      await this.client.set(key, value);
    }
  }

  async get(key: string): Promise<string | null> {
    return await this.client.get(key);
  }

  async mget(...keys: string[]): Promise<(string | null)[]> {
    return await this.client.mget(...keys);
  }

  async mset(data: Record<string, string>): Promise<void> {
    const pairs: string[] = [];
    Object.entries(data).forEach(([key, value]) => {
      pairs.push(key, value);
    });
    if (pairs.length > 0) {
      await this.client.mset(...pairs);
    }
  }

  async increment(key: string, by: number = 1): Promise<number> {
    if (by === 1) {
      return await this.client.incr(key);
    }
    return await this.client.incrby(key, by);
  }

  async decrement(key: string, by: number = 1): Promise<number> {
    if (by === 1) {
      return await this.client.decr(key);
    }
    return await this.client.decrby(key, by);
  }

  async incrby(key: string, increment: number): Promise<number> {
    return await this.client.incrby(key, increment);
  }

  async decrby(key: string, decrement: number): Promise<number> {
    return await this.client.decrby(key, decrement);
  }

  // ============ HASH OPERATIONS ============
  async hset(key: string, field: string, value: string): Promise<void> {
    await this.client.hset(key, field, value);
  }

  async hget(key: string, field: string): Promise<string | null> {
    return await this.client.hget(key, field);
  }

  async hgetall(key: string): Promise<Record<string, string>> {
    return await this.client.hgetall(key);
  }

  async hmset(key: string, data: Record<string, any>): Promise<void> {
    const stringData: Record<string, string> = {};
    Object.entries(data).forEach(([k, v]) => {
      stringData[k] = String(v);
    });
    await this.client.hmset(key, stringData);
  }

  async hmget(key: string, ...fields: string[]): Promise<(string | null)[]> {
    return await this.client.hmget(key, ...fields);
  }

  async hdel(key: string, ...fields: string[]): Promise<void> {
    await this.client.hdel(key, ...fields);
  }

  async hexists(key: string, field: string): Promise<boolean> {
    const result = await this.client.hexists(key, field);
    return result === 1;
  }

  async hlen(key: string): Promise<number> {
    return await this.client.hlen(key);
  }

  async hkeys(key: string): Promise<string[]> {
    return await this.client.hkeys(key);
  }

  async hvals(key: string): Promise<string[]> {
    return await this.client.hvals(key);
  }

  // ✅ FIXED: Hash increment operations
  async hincrby(key: string, field: string, increment: number): Promise<number> {
    return await this.client.hincrby(key, field, increment);
  }

  async hincrbyfloat(key: string, field: string, increment: number): Promise<string> {
    return await this.client.hincrbyfloat(key, field, increment);
  }

  // ============ SET OPERATIONS ============
  async sadd(key: string, ...members: string[]): Promise<void> {
    if (members.length > 0) {
      await this.client.sadd(key, ...members);
    }
  }

  async srem(key: string, ...members: string[]): Promise<void> {
    if (members.length > 0) {
      await this.client.srem(key, ...members);
    }
  }

  async smembers(key: string): Promise<string[]> {
    return await this.client.smembers(key);
  }

  async sismember(key: string, member: string): Promise<boolean> {
    const result = await this.client.sismember(key, member);
    return result === 1;
  }

  async scard(key: string): Promise<number> {
    return await this.client.scard(key);
  }

  async spop(key: string, count?: number): Promise<string | string[] | null> {
    if (count) {
      return await this.client.spop(key, count);
    }
    return await this.client.spop(key);
  }

  async srandmember(key: string, count?: number): Promise<string | string[] | null> {
    if (count) {
      return await this.client.srandmember(key, count);
    }
    return await this.client.srandmember(key);
  }

  // ============ SORTED SET OPERATIONS ============
  async zadd(key: string, score: number, member: string): Promise<void> {
    await this.client.zadd(key, score, member);
  }

  async zrem(key: string, ...members: string[]): Promise<void> {
    if (members.length > 0) {
      await this.client.zrem(key, ...members);
    }
  }

  async zrange(key: string, start: number, stop: number, withScores?: boolean): Promise<string[]> {
    if (withScores) {
      return await this.client.zrange(key, start, stop, 'WITHSCORES');
    }
    return await this.client.zrange(key, start, stop);
  }

  async zrevrange(key: string, start: number, stop: number, withScores?: boolean): Promise<string[]> {
    if (withScores) {
      return await this.client.zrevrange(key, start, stop, 'WITHSCORES');
    }
    return await this.client.zrevrange(key, start, stop);
  }

  async zrangebyscore(key: string, min: number | string, max: number | string): Promise<string[]> {
    return await this.client.zrangebyscore(key, min, max);
  }

  async zcard(key: string): Promise<number> {
    return await this.client.zcard(key);
  }

  async zscore(key: string, member: string): Promise<string | null> {
    return await this.client.zscore(key, member);
  }

  async zincrby(key: string, increment: number, member: string): Promise<string> {
    return await this.client.zincrby(key, increment, member);
  }

  // ============ LIST OPERATIONS ============
  async lpush(key: string, ...values: string[]): Promise<void> {
    if (values.length > 0) {
      await this.client.lpush(key, ...values);
    }
  }

  async rpush(key: string, ...values: string[]): Promise<void> {
    if (values.length > 0) {
      await this.client.rpush(key, ...values);
    }
  }

  async lpop(key: string): Promise<string | null> {
    return await this.client.lpop(key);
  }

  async rpop(key: string): Promise<string | null> {
    return await this.client.rpop(key);
  }

  async lrange(key: string, start: number, stop: number): Promise<string[]> {
    return await this.client.lrange(key, start, stop);
  }

  async llen(key: string): Promise<number> {
    return await this.client.llen(key);
  }

  async lindex(key: string, index: number): Promise<string | null> {
    return await this.client.lindex(key, index);
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

  // ============ KEY OPERATIONS ============
  async del(...keys: string[]): Promise<void> {
    if (keys.length > 0) {
      await this.client.del(...keys);
    }
  }

  async exists(...keys: string[]): Promise<number> {
    return await this.client.exists(...keys);
  }

  async expire(key: string, seconds: number): Promise<void> {
    await this.client.expire(key, seconds);
  }

  async expireat(key: string, timestamp: number): Promise<void> {
    await this.client.expireat(key, timestamp);
  }

  async ttl(key: string): Promise<number> {
    return await this.client.ttl(key);
  }

  async persist(key: string): Promise<void> {
    await this.client.persist(key);
  }

  async keys(pattern: string): Promise<string[]> {
    return await this.client.keys(pattern);
  }

  // ✅ FIXED: Scan method with proper typing
  async scan(
    cursor: number,
    pattern?: string,
    count?: number,
  ): Promise<[string, string[]]> {
    if (pattern && count) {
      return await this.client.scan(cursor, 'MATCH', pattern, 'COUNT', count);
    } else if (pattern) {
      return await this.client.scan(cursor, 'MATCH', pattern);
    } else if (count) {
      return await this.client.scan(cursor, 'COUNT', count);
    } else {
      return await this.client.scan(cursor);
    }
  }

  async rename(oldKey: string, newKey: string): Promise<void> {
    await this.client.rename(oldKey, newKey);
  }

  async type(key: string): Promise<string> {
    return await this.client.type(key);
  }

  // ✅ FIXED: Transaction operations with proper typing
  async multi(): Promise<ChainableCommander> {
    return this.client.multi();
  }

  async exec(pipeline: ChainableCommander): Promise<[Error | null, any][] | null> {
    return await pipeline.exec();
  }

  // ============ PUB/SUB OPERATIONS ============
  async publish(channel: string, message: string): Promise<number> {
    return await this.client.publish(channel, message);
  }

  async subscribe(channel: string, callback: (message: string) => void): Promise<void> {
    const subscriber = this.client.duplicate();
    await subscriber.subscribe(channel);
    subscriber.on('message', (chan, msg) => {
      if (chan === channel) {
        callback(msg);
      }
    });
  }

  // ============ CACHE HELPERS ============
  async cache<T>(
    key: string,
    fetchFn: () => Promise<T>,
    ttl: number = 300,
  ): Promise<T> {
    const cached = await this.get(key);

    if (cached) {
      try {
        return JSON.parse(cached);
      } catch {
        // If parse fails, fetch fresh data
        await this.del(key);
      }
    }

    const data = await fetchFn();
    await this.set(key, JSON.stringify(data), ttl);

    return data;
  }

  async invalidateCache(pattern: string): Promise<void> {
    const keys = await this.keys(pattern);
    if (keys.length > 0) {
      await this.del(...keys);
    }
  }

  // ============ RATE LIMITING ============
  async checkRateLimit(
    key: string,
    limit: number,
    window: number,
  ): Promise<{ allowed: boolean; remaining: number; resetAt: number }> {
    const current = await this.increment(key);

    if (current === 1) {
      await this.expire(key, window);
    }

    const ttl = await this.ttl(key);
    const resetAt = Date.now() + (ttl * 1000);

    return {
      allowed: current <= limit,
      remaining: Math.max(0, limit - current),
      resetAt,
    };
  }

  async resetRateLimit(key: string): Promise<void> {
    await this.del(key);
  }

  // ============ SESSION MANAGEMENT ============
  async setSession(sessionId: string, data: any, ttl: number = 3600): Promise<void> {
    await this.set(`session:${sessionId}`, JSON.stringify(data), ttl);
  }

  async getSession(sessionId: string): Promise<any | null> {
    const session = await this.get(`session:${sessionId}`);
    return session ? JSON.parse(session) : null;
  }

  async deleteSession(sessionId: string): Promise<void> {
    await this.del(`session:${sessionId}`);
  }

  async refreshSession(sessionId: string, ttl: number = 3600): Promise<void> {
    await this.expire(`session:${sessionId}`, ttl);
  }

  // ============ DISTRIBUTED LOCK ============
  async acquireLock(
    lockKey: string,
    ttl: number = 10,
    retries: number = 3,
  ): Promise<boolean> {
    for (let i = 0; i < retries; i++) {
      const result = await this.client.set(lockKey, '1', 'EX', ttl, 'NX');
      if (result === 'OK') {
        return true;
      }
      // Wait before retry
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    return false;
  }

  async releaseLock(lockKey: string): Promise<void> {
    await this.del(lockKey);
  }

  // ============ HEALTH CHECK ============
  async ping(): Promise<boolean> {
    try {
      const result = await this.client.ping();
      return result === 'PONG';
    } catch {
      return false;
    }
  }

  async info(section?: string): Promise<string> {
    if (section) {
      return await this.client.info(section);
    }
    return await this.client.info();
  }

  async dbsize(): Promise<number> {
    return await this.client.dbsize();
  }

  async flushdb(): Promise<void> {
    await this.client.flushdb();
  }

  async flushall(): Promise<void> {
    await this.client.flushall();
  }

  // ============ HELPER METHODS ============
  isHealthy(): boolean {
    return this.isConnected;
  }

  getClient(): Redis {
    return this.client;
  }
}