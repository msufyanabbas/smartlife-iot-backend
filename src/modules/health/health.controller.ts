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
  @HealthCheck()
  checkLiveness() {
    // Simple check - is the app running?
    return this.health.check([
      () => this.memory.checkHeap('memory_heap', 400 * 1024 * 1024),
    ]);
  }

  @Get('readiness')
  @HealthCheck()
  checkReadiness() {
    // Can the app serve requests?
    return this.health.check([
      () => this.db.pingCheck('database'),
      () => this.redisHealth.isHealthy('redis'),
    ]);
  }

  @Get('database')
  @HealthCheck()
  checkDatabase() {
    return this.health.check([
      () => this.db.pingCheck('database'),
      () => this.databaseHealth.isHealthy('database_detailed'),
    ]);
  }

  @Get('cache')
  @HealthCheck()
  checkCache() {
    return this.health.check([() => this.redisHealth.isHealthy('redis')]);
  }

  @Get('messaging')
  @HealthCheck()
  checkMessaging() {
    return this.health.check([
      () => this.kafkaHealth.isHealthy('kafka'),
      () => this.mqttHealth.isHealthy('mqtt'),
    ]);
  }
}