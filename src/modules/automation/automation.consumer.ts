import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Telemetry } from '@modules/index.entities';
import { AutomationProcessor } from './automation.processor';
import { KafkaService } from '@/lib/kafka/kafka.service';

@Injectable()
export class AutomationConsumer implements OnModuleInit {
  private readonly logger = new Logger(AutomationConsumer.name);

  constructor(
    private readonly kafka: KafkaService,
    @InjectRepository(Telemetry)
    private readonly telemetryRepo: Repository<Telemetry>,
    private readonly automationProcessor: AutomationProcessor,
  ) {}

  async onModuleInit(): Promise<void> {
    this.logger.log('Starting automation consumer...');

    try {
      await this.kafka.createConsumer(
        'automation-processor-group',
        ['telemetry.device.validated'],
        this.handleMessage.bind(this),
      );
      this.logger.log('Automation consumer started');
    } catch (error) {
      this.logger.error(
        `Failed to start automation consumer: ${(error as Error).message}`,
      );
    }
  }

  private async handleMessage({ message }: any): Promise<void> {
    try {
      const payload = JSON.parse(message.value.toString());

      if (!payload.telemetryId) {
        this.logger.warn(
          `No telemetryId in payload for device ${payload.deviceId} — skipping`,
        );
        return;
      }

      const telemetry = await this.telemetryRepo.findOne({
        where: { id: payload.telemetryId },
      });

      if (!telemetry) {
        this.logger.error(
          `Telemetry ${payload.telemetryId} not found for device ${payload.deviceId}`,
        );
        return;
      }

      await this.automationProcessor.processTelemetry(telemetry);
    } catch (error) {
      this.logger.error(
        `Error processing automation message: ${(error as Error).message}`,
      );
    }
  }
}