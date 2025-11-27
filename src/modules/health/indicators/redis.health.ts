// src/modules/health/indicators/redis.health.ts
import { Injectable } from '@nestjs/common';
import { HealthIndicator, HealthIndicatorResult, HealthCheckError } from '@nestjs/terminus';
import { ConfigService } from '@nestjs/config';
import Redis from 'ioredis';

@Injectable()
export class RedisHealthIndicator extends HealthIndicator {
  private redis: Redis;

  constructor(private configService: ConfigService) {
    super();
    
    // Create dedicated Redis connection for health checks
    this.redis = new Redis({
      host: this.configService.get('REDIS_HOST'),
      port: this.configService.get('REDIS_PORT'),
      password: this.configService.get('REDIS_PASSWORD'),
      db: this.configService.get('REDIS_DB', 0),
      lazyConnect: true,
      retryStrategy: () => null, // Don't retry for health checks
    });
  }

  async isHealthy(key: string): Promise<HealthIndicatorResult> {
    try {
      // Ensure connection
      if (this.redis.status !== 'ready') {
        await this.redis.connect();
      }

      const startTime = Date.now();
      const pong = await this.redis.ping();
      const responseTime = Date.now() - startTime;

      if (pong === 'PONG') {
        return this.getStatus(key, true, {
          responseTime: `${responseTime}ms`,
          status: 'connected',
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

  async onModuleDestroy() {
    try {
      await this.redis.quit();
    } catch (error) {
      // Ignore errors on cleanup
    }
  }
}