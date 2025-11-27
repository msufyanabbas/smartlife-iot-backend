// src/health/indicators/kafka.health.ts
import { Injectable } from '@nestjs/common';
import { HealthIndicator, HealthIndicatorResult, HealthCheckError } from '@nestjs/terminus';
import { Kafka, Admin } from 'kafkajs';
import { ConfigService } from '@nestjs/config';

@Injectable()
export class KafkaHealthIndicator extends HealthIndicator {
  private kafka: Kafka;
  private admin: Admin;

  constructor(private configService: ConfigService) {
    super();
    this.kafka = new Kafka({
      clientId: 'health-check',
      brokers: this.configService.get('KAFKA_BROKERS', 'kafka:9092').split(','),
    });
    this.admin = this.kafka.admin();
  }

  async isHealthy(key: string): Promise<HealthIndicatorResult> {
    try {
      await this.admin.connect();
      const cluster = await this.admin.describeCluster();
      await this.admin.disconnect();

      const isHealthy = cluster.brokers.length > 0;

      if (isHealthy) {
        return this.getStatus(key, true, {
          brokers: cluster.brokers.length,
          controller: cluster.controller,
        });
      }

      throw new HealthCheckError('Kafka check failed', {
        kafka: { status: 'down', reason: 'No brokers available' },
      });
    } catch (error) {
      // Make sure to disconnect even on error
      try {
        await this.admin.disconnect();
      } catch (disconnectError) {
        // Ignore disconnect errors
      }

      throw new HealthCheckError('Kafka check failed', {
        kafka: { status: 'down', error: error.message },
      });
    }
  }
}