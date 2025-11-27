// src/health/indicators/mqtt.health.ts
import { Injectable } from '@nestjs/common';
import { HealthIndicator, HealthIndicatorResult, HealthCheckError } from '@nestjs/terminus';
import { ConfigService } from '@nestjs/config';
import * as mqtt from 'mqtt';

@Injectable()
export class MqttHealthIndicator extends HealthIndicator {
  constructor(private configService: ConfigService) {
    super();
  }

  async isHealthy(key: string): Promise<HealthIndicatorResult> {
    return new Promise((resolve, reject) => {
      const brokerUrl = this.configService.get('MQTT_BROKER_URL', 'mqtt://emqx:1883');
      const timeout = setTimeout(() => {
        client?.end();
        reject(
          new HealthCheckError('MQTT check failed', {
            mqtt: { status: 'down', reason: 'Connection timeout' },
          }),
        );
      }, 5000);

      const client = mqtt.connect(brokerUrl, {
        clientId: `health-check-${Date.now()}`,
        clean: true,
        connectTimeout: 4000,
      });

      client.on('connect', () => {
        clearTimeout(timeout);
        client.end();
        resolve(
          this.getStatus(key, true, {
            broker: brokerUrl,
            status: 'connected',
          }),
        );
      });

      client.on('error', (error) => {
        clearTimeout(timeout);
        client?.end();
        reject(
          new HealthCheckError('MQTT check failed', {
            mqtt: { status: 'down', error: error.message },
          }),
        );
      });
    });
  }
}