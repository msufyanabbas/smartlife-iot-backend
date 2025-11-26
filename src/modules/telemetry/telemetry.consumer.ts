// src/modules/telemetry/telemetry.consumer.ts
// This runs SEPARATELY from your main app
// It listens to Kafka messages and processes them

import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Telemetry } from './entities/telemetry.entity';
import { kafkaService } from '@/lib/kafka/kafka.service';

@Injectable()
export class TelemetryConsumer {
  constructor(
    @InjectRepository(Telemetry)
    private telemetryRepository: Repository<Telemetry>,
  ) {}

  /**
   * Start consuming telemetry messages from Kafka
   * This method should be called when your app starts
   */
  async start(): Promise<void> {
    console.log('🚀 Starting Telemetry Consumer...');

    await kafkaService.createConsumer(
      'telemetry-processor-group', // Consumer group name
      ['telemetry.device.raw'], // Topics to listen to
      async ({ message }) => {
        try {
          const data = JSON.parse(message.value!.toString());
          console.log(`📥 Processing telemetry for device: ${data.deviceId}`);

          // 1. Validate the data
          if (!data.deviceId) {
            throw new Error('Missing deviceId');
          }

          // 2. Store in database (async - doesn't block the API)
          // await this.telemetryRepository.save({
          //   deviceId: data.deviceId,
          //   deviceKey: data.deviceKey,
          //   tenantId: data.tenantId,
          //   data: data.data,
          //   temperature: data.temperature,
          //   humidity: data.humidity,
          //   pressure: data.pressure,
          //   batteryLevel: data.batteryLevel,
          //   timestamp: new Date(data.receivedAt),
          // });

          // 3. Publish to validated topic (for rule engine to process)
          await kafkaService.sendMessage(
            'telemetry.device.validated',
            {
              ...data,
              validated: true,
              processedAt: Date.now(),
            },
            data.deviceId,
          );

          // 4. Send to rule engine
          await kafkaService.sendMessage(
            'rules.input',
            {
              entityId: data.deviceId,
              entityType: 'DEVICE',
              eventType: 'TELEMETRY',
              data: {
                temperature: data.temperature,
                humidity: data.humidity,
                pressure: data.pressure,
              },
              timestamp: Date.now(),
            },
            data.deviceId,
          );

          console.log(`✅ Telemetry processed for device: ${data.deviceId}`);
        } catch (error: any) {
          console.error(`❌ Failed to process telemetry:`, error);

          // Send to dead letter queue for manual review
          await kafkaService.sendMessage('telemetry.device.invalid', {
            originalMessage: message.value?.toString(),
            error: error.message,
            failedAt: Date.now(),
          });
        }
      },
    );

    console.log('✅ Telemetry Consumer started successfully');
  }

  /**
   * Stop the consumer (called when app shuts down)
   */
  async stop(): Promise<void> {
    console.log('🛑 Stopping Telemetry Consumer...');
    // Kafka service handles cleanup
  }
}
