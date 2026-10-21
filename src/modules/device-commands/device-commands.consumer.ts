import {
  Injectable,
  OnModuleInit,
  Logger,
  Inject,
  forwardRef,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { KafkaService } from '@/lib/kafka/kafka.service';
import { DeviceCommandsService } from './device-commands.service';
import { GatewayService } from '@modules/gateway/gateway.service';
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
    private readonly kafkaService: KafkaService,
    private readonly commandsService: DeviceCommandsService,
    // GatewayService is the single owner of downlink MQTT operations.
    // MQTTAdapter has been removed — do not re-add it here.
    //
    // forwardRef: GatewayModule imports DeviceCommandsModule (to persist a
    // two-way RPC's outcome) and DeviceCommandsModule imports GatewayModule,
    // so the token has to be resolved lazily at both ends.
    @Inject(forwardRef(() => GatewayService))
    private readonly gatewayService: GatewayService,
    @InjectRepository(Device)
    private readonly deviceRepository: Repository<Device>,
  ) {}

  async onModuleInit(): Promise<void> {
    this.logger.log('Starting device commands consumer...');

    await this.kafkaService.createConsumer(
      'device-commands-consumer-group',
      ['device.commands', 'device.commands.retry'],
      this.handleMessage.bind(this),
    );

    this.logger.log('Device commands consumer started');
  }

  private async handleMessage({ message }: any): Promise<void> {
    try {
      const command: DeviceCommandMessage = JSON.parse(
        message.value?.toString() || '{}',
      );

      this.logger.log(`Processing command: ${command.commandType} for ${command.deviceKey}`);

      if (command.scheduledFor && command.scheduledFor > Date.now()) {
        this.logger.log(`Command scheduled for ${new Date(command.scheduledFor).toISOString()}`);
        await this.scheduleCommand(command);
        return;
      }

      await this.processCommand(command);
    } catch (error) {
      // Rethrow so KafkaService retries and then dead-letters to
      // `device.commands.dlq`. Only *unexpected* failures reach here —
      // a command the device rejected is handled by processCommand(), which
      // marks the row FAILED or requeues it and returns normally. What this
      // catches is a malformed message or a database that is down, and
      // swallowing those was how a command could vanish with no row update and
      // no trace: the operator saw PENDING forever.
      this.logger.error(`Failed to process command: ${(error as Error).message}`);
      throw error;
    }
  }

  private async processCommand(command: DeviceCommandMessage): Promise<void> {
    const device = await this.deviceRepository.findOne({
      where: { id: command.deviceId },
    });

    if (!device) {
      await this.commandsService.updateCommandStatus(command.id, 'FAILED', 'Device not found');
      return;
    }

    try {
      await this.commandsService.updateCommandStatus(command.id, 'SENDING');

      // Route through GatewayService — it resolves the correct topic and
      // encoding (generic MQTT vs Milesight LoRaWAN vs ChirpStack) based on
      // device.protocol, then publishes via MQTTService.
      await this.gatewayService.sendCommand(device.deviceKey, {
        method: command.commandType,
        params: command.params,
      });

      await this.commandsService.updateCommandStatus(command.id, 'DELIVERED', 'Command sent successfully');
      this.logger.log(`Command delivered: ${command.commandType} → ${device.deviceKey}`);
    } catch (error) {
      await this.handleCommandFailure(command, (error as Error).message);
    }
  }

  private async handleCommandFailure(command: DeviceCommandMessage, error: string): Promise<void> {
    const retriesLeft = command.retries - 1;

    if (retriesLeft > 0) {
      this.logger.log(`Retrying command (${retriesLeft} retries left)...`);

      // Exponential backoff: 1s, 2s, 4s for 3 → 2 → 1 retries remaining
      const retryDelay = Math.pow(2, 3 - retriesLeft) * 1000;

      // Keyed by deviceKey for the same reason as the primary produce in
      // DeviceCommandsService.create() — a retry that lands on a different
      // partition from the command that follows it reorders the pair.
      //
      // The .catch() is required: this runs inside a setTimeout, so a produce
      // rejection (an unreachable broker — sendMessage now throws rather than
      // buffering silently) would be an unhandled rejection with no caller to
      // receive it. The command row is left RETRYING and the sweep picks it up.
      setTimeout(() => {
        void this.kafkaService
          .sendMessage(
            'device.commands.retry',
            { ...command, retries: retriesLeft },
            command.deviceKey,
          )
          .catch((err) =>
            this.logger.error(
              `Could not requeue retry for command ${command.id}: ${(err as Error).message}`,
            ),
          );
      }, retryDelay);

      await this.commandsService.updateCommandStatus(
        command.id,
        'RETRYING',
        `Retry scheduled in ${retryDelay}ms`,
      );
    } else {
      await this.commandsService.updateCommandStatus(command.id, 'FAILED', error);
      this.logger.error(`Command exhausted retries: ${command.commandType} → ${command.deviceKey}`);
    }
  }

  private async scheduleCommand(command: DeviceCommandMessage): Promise<void> {
    const delay = command.scheduledFor! - Date.now();

    setTimeout(() => {
      void this.kafkaService
        .sendMessage(
          'device.commands',
          { ...command, scheduledFor: undefined },
          command.deviceKey,
        )
        .catch((err) =>
          this.logger.error(
            `Could not release scheduled command ${command.id}: ${(err as Error).message}`,
          ),
        );
    }, delay);
  }
}