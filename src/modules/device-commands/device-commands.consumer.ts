// src/modules/device-commands/device-commands.consumer.ts
import { Injectable, OnModuleInit, Logger, Inject } from '@nestjs/common';
import { DeviceCommandsService } from './device-commands.service';
import { KafkaService } from '@/lib/kafka/kafka.service';
import { MQTTAdapter } from '@modules/protocols/adapters/mqtt.adapter';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Device } from '@modules/devices/entities/device.entity';

export interface DeviceCommandMessage {
  id: string;
  deviceId: string;
  deviceKey: string;
  tenantId: string;
  userId: string;
  commandType: string;
  params: any;
  priority: 'LOW' | 'NORMAL' | 'HIGH' | 'URGENT';
  timeout: number;
  retries: number;
  createdAt: number;
  scheduledFor?: number;
}

@Injectable()
export class DeviceCommandsConsumer implements OnModuleInit {
  private readonly logger = new Logger(DeviceCommandsConsumer.name);

  constructor(
    @Inject('KAFKA_SERVICE')
    private kafkaService: KafkaService,
    private commandsService: DeviceCommandsService,
    private mqttAdapter: MQTTAdapter,
    @InjectRepository(Device)
    private deviceRepository: Repository<Device>,
  ) {}

  async onModuleInit() {
    this.logger.log('📤 Starting Device Commands Consumer...');

    await this.kafkaService.createConsumer(
      'device-commands-consumer-group',
      ['device.commands', 'device.commands.retry'],
      this.handleMessage.bind(this),
    );

    this.logger.log('✅ Device Commands Consumer started');
  }

  private async handleMessage({ message }: any): Promise<void> {
    try {
      const command: DeviceCommandMessage = JSON.parse(
        message.value?.toString() || '{}',
      );

      this.logger.log(`📤 Processing command: ${command.commandType} for ${command.deviceKey}`);

      // Check if scheduled for future
      if (command.scheduledFor && command.scheduledFor > Date.now()) {
        this.logger.log(`⏰ Command scheduled for ${new Date(command.scheduledFor)}`);
        await this.scheduleCommand(command);
        return;
      }

      // Process immediately
      await this.processCommand(command);
    } catch (error: any) {
      this.logger.error('❌ Failed to process command:', error);
      throw error;
    }
  }

  private async processCommand(command: DeviceCommandMessage): Promise<void> {
    try {
      // Get device info
      const device = await this.deviceRepository.findOne({
        where: { id: command.deviceId },
      });

      if (!device) {
        await this.commandsService.updateCommandStatus(
          command.id,
          'FAILED',
          'Device not found',
        );
        return;
      }

      // Update status to SENDING
      await this.commandsService.updateCommandStatus(command.id, 'SENDING');

      // Send via MQTT adapter
      this.logger.log(`📡 Sending via MQTT...`);
      
      await this.mqttAdapter.sendCommand(device.deviceKey, {
        method: command.commandType,
        params: command.params,
      });

      // Update status to DELIVERED
      await this.commandsService.updateCommandStatus(
        command.id,
        'DELIVERED',
        'Command sent successfully',
      );

      this.logger.log(`✅ Command delivered`);
    } catch (error: any) {
      this.logger.error('❌ Command failed:', error);
      await this.handleCommandFailure(command, error.message);
    }
  }

  private async handleCommandFailure(
    command: DeviceCommandMessage,
    error: string,
  ): Promise<void> {
    const retriesLeft = command.retries - 1;

    if (retriesLeft > 0) {
      this.logger.log(`🔄 Retrying (${retriesLeft} retries left)...`);
      
      command.retries = retriesLeft;

      const retryDelay = Math.pow(2, 3 - retriesLeft) * 1000;
      
      setTimeout(async () => {
        await this.kafkaService.sendMessage('device.commands.retry', command);
      }, retryDelay);

      await this.commandsService.updateCommandStatus(
        command.id,
        'RETRYING',
        `Retry in ${retryDelay}ms`,
      );
    } else {
      await this.commandsService.updateCommandStatus(
        command.id,
        'FAILED',
        error,
      );
    }
  }

  private async scheduleCommand(command: DeviceCommandMessage): Promise<void> {
    const delay = command.scheduledFor! - Date.now();

    setTimeout(async () => {
      await this.kafkaService.sendMessage('device.commands', {
        ...command,
        scheduledFor: undefined,
      });
    }, delay);
  }
}