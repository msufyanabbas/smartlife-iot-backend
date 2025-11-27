// src/health/indicators/redis.health.ts
import { Injectable } from '@nestjs/common';
import { HealthIndicator, HealthIndicatorResult, HealthCheckError } from '@nestjs/terminus';
import { InjectRedis } from '@nestjs-modules/ioredis';
import Redis from 'ioredis';

@Injectable()
export class RedisHealthIndicator extends HealthIndicator {
  constructor(@InjectRedis() private readonly redis: Redis) {
    super();
  }

  async isHealthy(key: string): Promise<HealthIndicatorResult> {
    try {
      const startTime = Date.now();
      const pong = await this.redis.ping();
      const responseTime = Date.now() - startTime;

      if (pong === 'PONG') {
        // Get Redis info
        const info = await this.redis.info('server');
        const memory = await this.redis.info('memory');
        
        const uptime = this.extractValue(info, 'uptime_in_seconds');
        const usedMemory = this.extractValue(memory, 'used_memory_human');

        return this.getStatus(key, true, {
          responseTime: `${responseTime}ms`,
          uptime: `${uptime}s`,
          memory: usedMemory,
        });
      }

      throw new HealthCheckError('Redis check failed', {
        redis: { status: 'down' },
      });
    } catch (error) {
      throw new HealthCheckError('Redis check failed', {
        redis: { status: 'down', error: error.message },
      });
    }
  }

  private extractValue(info: string, key: string): string {
    const match = info.match(new RegExp(`${key}:(.+)`));
    return match ? match[1].trim() : 'unknown';
  }
}