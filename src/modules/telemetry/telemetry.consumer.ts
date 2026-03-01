// src/modules/telemetry/telemetry.consumer.ts
import { Injectable, Logger, OnModuleInit, Inject } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Telemetry } from '@modules/index.entities';
import { KafkaService } from '@/lib/kafka/kafka.service';
import { AutomationProcessor } from '@modules/automation/automation.processor';
import { WebsocketGateway } from '@modules/websocket/websocket.gateway';

@Injectable()
export class TelemetryConsumer implements OnModuleInit {
  private readonly logger = new Logger(TelemetryConsumer.name);

  constructor(
    @Inject('KAFKA_SERVICE')
    private kafka: KafkaService,
    @InjectRepository(Telemetry)
    private telemetryRepo: Repository<Telemetry>,
    private automationProcessor: AutomationProcessor,  
    private websocketGateway: WebsocketGateway, 
  ) {}

  async onModuleInit() {
    this.logger.log('🎧 Starting Telemetry Consumer...');

    try {
      await this.kafka.createConsumer(
        'telemetry-processor-group',
        ['telemetry.device.raw'],
        this.handleMessage.bind(this),
      );

      this.logger.log('✅ Telemetry Consumer started successfully');
    } catch (error: any) {
      this.logger.error('❌ Failed to start Telemetry Consumer:', error.message);
    }
  }

  /**
   * Handle incoming telemetry from Kafka
   */
  private async handleMessage({ message }: any): Promise<void> {
    try {
      const payload = JSON.parse(message.value.toString());
      
      this.logger.debug(`📥 Received telemetry for device: ${payload.deviceId}`);

      // ══════════════════════════════════════════════════════════════════════
      // STEP 1: Validate
      // ══════════════════════════════════════════════════════════════════════
      
      if (!payload.deviceId) {
        throw new Error('Missing deviceId in telemetry payload');
      }

      if (!payload.tenantId) {
        throw new Error('Missing tenantId in telemetry payload');
      }

      // ══════════════════════════════════════════════════════════════════════
      // STEP 2: Store in database
      // ══════════════════════════════════════════════════════════════════════
      
      const telemetry = await this.storeTelemetry(payload);

      // ══════════════════════════════════════════════════════════════════════
      // STEP 3: Process automations (NEW!)
      // ══════════════════════════════════════════════════════════════════════
      
      try {
        await this.automationProcessor.processTelemetry(telemetry);
      } catch (automationError: any) {
        // Log but don't fail the whole pipeline
        this.logger.error(`Automation processing failed: ${automationError.message}`);
      }

      // ══════════════════════════════════════════════════════════════════════
      // BROADCAST VIA WEBSOCKET (NEW!)
      // ══════════════════════════════════════════════════════════════════════
      
      this.websocketGateway.broadcastDeviceTelemetry(
        payload.deviceId,
        telemetry
      );

      // ══════════════════════════════════════════════════════════════════════
      // STEP 4: Publish to validated topic (for other consumers)
      // ══════════════════════════════════════════════════════════════════════
      
      await this.kafka.sendMessage(
        'telemetry.device.validated',
        {
          ...payload,
          telemetryId: telemetry.id,
          validated: true,
          processedAt: Date.now(),
        },
        payload.deviceId,  // Partition key
      );

      // ══════════════════════════════════════════════════════════════════════
      // STEP 5: Send to rule engine (if you have one)
      // ══════════════════════════════════════════════════════════════════════
      
      await this.kafka.sendMessage(
        'rules.input',
        {
          entityId: payload.deviceId,
          entityType: 'DEVICE',
          eventType: 'TELEMETRY',
          data: payload.data,
          timestamp: Date.now(),
        },
        payload.deviceId,
      );

      this.logger.log(`✅ Telemetry processed successfully: ${telemetry.id}`);
    } catch (error: any) {
      this.logger.error(`❌ Failed to process telemetry:`, error.message);

      // Send to dead letter queue
      try {
        await this.kafka.sendMessage('telemetry.device.invalid', {
          originalMessage: message.value.toString(),
          error: error.message,
          errorStack: error.stack,
          failedAt: Date.now(),
        });
      } catch (dlqError: any) {
        this.logger.error(`Failed to send to DLQ: ${dlqError.message}`);
      }

      // Don't throw - let Kafka continue processing other messages
    }
  }

  /**
   * Store telemetry in database
   */
  private async storeTelemetry(payload: any): Promise<Telemetry> {
    const telemetry = this.telemetryRepo.create({
      tenantId: payload.tenantId,
      deviceId: payload.deviceId,
      deviceKey: payload.deviceKey,
      timestamp: new Date(payload.timestamp || payload.receivedAt || Date.now()),
      data: payload.data,
      
      // Denormalize common fields for fast queries
      temperature: payload.data?.temperature || payload.temperature,
      humidity: payload.data?.humidity || payload.humidity,
      pressure: payload.data?.pressure || payload.pressure,
      latitude: payload.data?.latitude || payload.latitude,
      longitude: payload.data?.longitude || payload.longitude,
      batteryLevel: payload.data?.battery || payload.data?.batteryLevel || payload.batteryLevel,
      signalStrength: payload.data?.rssi || payload.data?.signalStrength || payload.signalStrength,
      
      metadata: payload.metadata || {
        source: 'mqtt',
        receivedAt: payload.receivedAt,
      },
    });

    return await this.telemetryRepo.save(telemetry);
  }
}