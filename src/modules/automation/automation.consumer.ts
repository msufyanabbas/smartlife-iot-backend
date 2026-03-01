// src/modules/automations/automation.consumer.ts
import { Injectable, Logger, OnModuleInit, Inject } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Telemetry } from '@modules/index.entities';
import { AutomationProcessor } from './automation.processor';
import { KafkaService } from '@/lib/kafka/kafka.service';

@Injectable()
export class AutomationConsumer implements OnModuleInit {
  private readonly logger = new Logger(AutomationConsumer.name);

  constructor(
    @Inject('KAFKA_SERVICE')
    private kafka: KafkaService,
    @InjectRepository(Telemetry)
    private telemetryRepo: Repository<Telemetry>,
    private automationProcessor: AutomationProcessor,
  ) {}

  /**
   * Start listening to Kafka when module initializes
   */
  async onModuleInit() {
    this.logger.log('🎧 Starting Automation Consumer...');

    try {
      await this.kafka.createConsumer(
        'automation-processor-group',  // Consumer group
        ['telemetry.device.validated'], // Topics to listen to
        this.handleMessage.bind(this),  // Message handler
      );

      this.logger.log('✅ Automation Consumer started successfully');
    } catch (error: any) {
      this.logger.error('❌ Failed to start Automation Consumer:', error.message);
    }
  }

  /**
   * Handle incoming Kafka messages
   */
  private async handleMessage({ message }: any): Promise<void> {
    try {
      const payload = JSON.parse(message.value.toString());
      this.logger.debug(`Received telemetry message: ${JSON.stringify(payload)}`);

      // Get full telemetry record from database
      const telemetry = await this.telemetryRepo.findOne({
        where: { 
          deviceId: payload.deviceId,
          timestamp: payload.timestamp,
        },
      });

      if (!telemetry) {
        this.logger.warn(`Telemetry not found in database: ${payload.deviceId}`);
        return;
      }

      // Process telemetry through automation engine
      await this.automationProcessor.processTelemetry(telemetry);
    } catch (error: any) {
      this.logger.error('Error processing automation message:', error.message);
      // Don't throw - let Kafka continue processing other messages
    }
  }
}