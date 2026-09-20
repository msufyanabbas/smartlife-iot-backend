import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { KafkaService } from '@/lib/kafka/kafka.service';
import { AutomationService } from './automation.service';

/**
 * Drives TELEMETRY-trigger automations for the Kafka ingestion path
 * (MQTT / CoAP / DeviceListenerService -> telemetry.device.raw ->
 * TelemetryConsumer -> telemetry.device.validated).
 *
 * The HTTP ingestion path does NOT pass through Kafka; TelemetryService calls
 * AutomationService.evaluateTelemetryTriggers() directly instead. The two are
 * mutually exclusive, so an automation never fires twice for one frame.
 */
@Injectable()
export class AutomationConsumer implements OnModuleInit {
  private readonly logger = new Logger(AutomationConsumer.name);

  constructor(
    private readonly kafka: KafkaService,
    private readonly automationService: AutomationService,
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

      if (!payload.deviceId || !payload.tenantId) {
        this.logger.warn(
          `Skipping message without deviceId/tenantId (telemetryId: ${payload.telemetryId ?? 'none'})`,
        );
        return;
      }

      // The payload already carries the decoded frame, so there is no need to
      // re-SELECT the Telemetry row that TelemetryConsumer just wrote.
      await this.automationService.evaluateTelemetryTriggers(
        payload.deviceId,
        payload.tenantId,
        payload.data ?? {},
      );
    } catch (error) {
      this.logger.error(
        `Error processing automation message: ${(error as Error).message}`,
      );
    }
  }
}
