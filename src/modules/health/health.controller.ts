// src/health/health.controller.ts
import { Controller, Get } from '@nestjs/common';
import {
  HealthCheck,
  HealthCheckService,
  TypeOrmHealthIndicator,
  MemoryHealthIndicator,
  DiskHealthIndicator,
} from '@nestjs/terminus';
import { DatabaseHealthIndicator } from './indicators/database.health';
import { RedisHealthIndicator } from './indicators/redis.health';
import { KafkaHealthIndicator } from './indicators/kafka.health';
import { MqttHealthIndicator } from './indicators/mqtt.health';
import { Public } from '@/common/decorators/public.decorator';
// Read through the static holder rather than injected, exactly as
// @DistributedCron does: HealthModule must not depend on ClusterModule, and
// the interesting failure to report IS "the holder is empty".
import { DistributedLockService } from '@/lib/cluster/distributed-lock.service';

@Controller('health')
export class HealthController {
  constructor(
    private health: HealthCheckService,
    private db: TypeOrmHealthIndicator,
    private memory: MemoryHealthIndicator,
    private disk: DiskHealthIndicator,
    private databaseHealth: DatabaseHealthIndicator,
    private redisHealth: RedisHealthIndicator,
    private kafkaHealth: KafkaHealthIndicator,
    private mqttHealth: MqttHealthIndicator,
  ) {}

  @Get()
  @Public()
  @HealthCheck()
  check() {
    return this.health.check([
      // Basic health check
      () => this.db.pingCheck('database'),
      () => this.memory.checkHeap('memory_heap', 300 * 1024 * 1024), // 300MB
      () => this.memory.checkRSS('memory_rss', 500 * 1024 * 1024), // 500MB
    ]);
  }

  @Get('full')
  @Public()
  @HealthCheck()
  checkFull() {
    return this.health.check([
      // Database
      () => this.db.pingCheck('database'),
      () => this.databaseHealth.isHealthy('database_detailed'),

      // Redis
      () => this.redisHealth.isHealthy('redis'),

      // Kafka
      () => this.kafkaHealth.isHealthy('kafka'),

      // MQTT
      () => this.mqttHealth.isHealthy('mqtt'),

      // Memory
      () => this.memory.checkHeap('memory_heap', 300 * 1024 * 1024),
      () => this.memory.checkRSS('memory_rss', 500 * 1024 * 1024),

      // Disk
      () =>
        this.disk.checkStorage('disk', {
          path: '/',
          thresholdPercent: 0.9, // 90%
        }),
    ]);
  }

  @Get('liveness')
  @Public()
  @HealthCheck()
  checkLiveness() {
    // Simple check - is the app running?
    return this.health.check([
      () => this.memory.checkHeap('memory_heap', 400 * 1024 * 1024),
    ]);
  }

  @Get('readiness')
  @Public()
  @HealthCheck()
  checkReadiness() {
    // Can the app serve requests?
    return this.health.check([
      () => this.db.pingCheck('database'),
      () => this.redisHealth.isHealthy('redis'),
    ]);
  }

  @Get('database')
  @Public()
  @HealthCheck()
  checkDatabase() {
    return this.health.check([
      () => this.db.pingCheck('database'),
      () => this.databaseHealth.isHealthy('database_detailed'),
    ]);
  }

  @Get('cache')
  @Public()
  @HealthCheck()
  checkCache() {
    return this.health.check([() => this.redisHealth.isHealthy('redis')]);
  }

  @Get('messaging')
  @Public()
  @HealthCheck()
  checkMessaging() {
    return this.health.check([
      () => this.kafkaHealth.isHealthy('kafka'),
      () => this.mqttHealth.isHealthy('mqtt'),
    ]);
  }

  /**
   * Scheduled work: is this replica running its crons, or skipping them?
   *
   * Nine crons hold a distributed lock so that only one replica runs each
   * tick. When Redis cannot be reached the lock cannot be claimed and the
   * tick is skipped — correct, because a duplicated billing sweep is worse
   * than a deferred one, but it means report delivery, scheduled
   * notifications, subscription expiry and the device-offline sweep stop
   * happening ANYWHERE, with nothing thrown and no other probe turning red.
   *
   * This is the probe that shows it. `skippedNotAcquired` is healthy on more
   * than one replica — exactly one winner per tick means the losers count a
   * skip. `skippedNoRedis` above zero means scheduled work is being dropped.
   *
   * Deliberately not a @HealthCheck(): a replica that is losing lock races is
   * perfectly healthy, and reporting it as "down" would make an orchestrator
   * restart the replicas that are behaving correctly. `degraded` carries the
   * judgement; an alert should read that field.
   */
  @Get('cluster')
  @Public()
  checkCluster() {
    const lock = DistributedLockService.instance;

    if (!lock) {
      // ClusterModule not registered: @DistributedCron has nothing to ask, so
      // every locked cron is being skipped outright.
      return {
        status: 'error',
        locksEnabled: null,
        degraded: true,
        message:
          'ClusterModule is not registered, so every locked cron is skipped. ' +
          'Add ClusterModule to featureModules.',
      };
    }

    const stats = lock.stats();
    return {
      status: stats.degraded ? 'degraded' : 'ok',
      ...stats,
    };
  }
}