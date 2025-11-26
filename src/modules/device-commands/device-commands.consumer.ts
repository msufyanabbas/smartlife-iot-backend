// src/modules/device-commands/device-commands.consumer.ts
// FIXED - Device Commands Consumer - Compatible with your services

import { Pool } from 'pg';
import { kafkaService } from '@/lib/kafka/kafka.service';
import { redisService } from '@/lib/redis/redis.service';
import { EachMessagePayload } from 'kafkajs';

export interface DeviceCommand {
  id: string;
  deviceId: string;
  deviceKey: string;
  tenantId: string;
  userId: string;
  commandType: string;
  params: any;
  priority: 'LOW' | 'NORMAL' | 'HIGH' | 'URGENT';
  timeout: number; // milliseconds
  retries: number;
  createdAt: number;
  scheduledFor?: number;
}

export class DeviceCommandsConsumer {
  private groupId = 'device-commands-consumer-group';
  private topics = ['device.commands', 'device.commands.retry'];

  // Protocol adapters registry
  private adapters: Map<string, any> = new Map();

  constructor(
    private db: Pool,
    adapters?: {
      mqtt?: any;
      http?: any;
      coap?: any;
      modbus?: any;
    },
  ) {
    // Register available adapters
    if (adapters?.mqtt) this.adapters.set('mqtt', adapters.mqtt);
    if (adapters?.http) this.adapters.set('http', adapters.http);
    if (adapters?.coap) this.adapters.set('coap', adapters.coap);
    if (adapters?.modbus) this.adapters.set('modbus', adapters.modbus);
  }

  async start(): Promise<void> {
    console.log('📤 Starting Device Commands Consumer...');

    // Use your kafkaService.createConsumer method
    await kafkaService.createConsumer(
      this.groupId,
      this.topics,
      async (payload: EachMessagePayload) => {
        try {
          const command: DeviceCommand = JSON.parse(
            payload.message.value?.toString() || '{}',
          );

          console.log(`\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
          console.log(`📤 DEVICE COMMAND`);
          console.log(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
          console.log(`📱 Device: ${command.deviceKey}`);
          console.log(`🎯 Command: ${command.commandType}`);
          console.log(`⚡ Priority: ${command.priority}`);
          console.log(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n`);

          // Check if command is scheduled for future
          if (command.scheduledFor && command.scheduledFor > Date.now()) {
            console.log(
              `⏰ Command scheduled for: ${new Date(command.scheduledFor)}`,
            );
            await this.scheduleCommand(command);
            return;
          }

          // Process command immediately
          await this.processCommand(command);
        } catch (error) {
          console.error('❌ Failed to process command:', error);
          throw error; // Let Kafka handle retry
        }
      },
    );

    console.log('✅ Device Commands Consumer started');
    console.log(`📊 Subscribed to topics: ${this.topics.join(', ')}\n`);
  }

  /**
   * Process device command
   */
  private async processCommand(command: DeviceCommand): Promise<void> {
    try {
      // 1. Get device info
      const device = await this.getDevice(command.deviceId);

      if (!device) {
        console.error(`❌ Device not found: ${command.deviceId}`);
        await this.updateCommandStatus(
          command.id,
          'FAILED',
          'Device not found',
        );
        return;
      }

      // 2. Check if device is online
      if (!device.is_online && command.priority !== 'URGENT') {
        console.log(`⚠️  Device offline, queueing command...`);
        await this.queueCommand(command);
        return;
      }

      // 3. Get protocol adapter
      const adapter = this.adapters.get(device.protocol);

      if (!adapter) {
        console.error(`❌ No adapter for protocol: ${device.protocol}`);
        await this.updateCommandStatus(
          command.id,
          'FAILED',
          `No ${device.protocol} adapter`,
        );
        return;
      }

      // 4. Update status to SENDING
      await this.updateCommandStatus(command.id, 'SENDING');

      // 5. Send command via appropriate adapter
      console.log(`📡 Sending command via ${device.protocol.toUpperCase()}...`);

      const result = await this.sendViaAdapter(adapter, device, command);

      // 6. Update status based on result
      if (result.success) {
        await this.updateCommandStatus(command.id, 'DELIVERED', result.message);
        console.log(`✅ Command delivered successfully`);

        // Wait for acknowledgment (if supported)
        if (device.metadata?.supportsAck) {
          await this.waitForAcknowledgment(command);
        }
      } else {
        await this.handleCommandFailure(
          command,
          result.error || 'Unknown error',
        );
      }
    } catch (error: any) {
      console.error('❌ Command processing failed:', error);
      await this.handleCommandFailure(command, error.message);
    }
  }

  /**
   * Send command via protocol adapter
   */
  private async sendViaAdapter(
    adapter: any,
    device: any,
    command: DeviceCommand,
  ): Promise<{ success: boolean; message?: string; error?: string }> {
    try {
      // Format command based on device type
      const formattedCommand = this.formatCommand(device, command);

      // Send via adapter
      await adapter.sendCommand(device.device_key, formattedCommand);

      return {
        success: true,
        message: 'Command sent to device',
      };
    } catch (error: any) {
      return {
        success: false,
        error: error.message,
      };
    }
  }

  /**
   * Format command for specific device/protocol
   */
  private formatCommand(device: any, command: DeviceCommand): any {
    switch (device.protocol) {
      case 'mqtt':
        return {
          command: command.commandType,
          params: command.params,
          timestamp: Date.now(),
          requestId: command.id,
        };

      case 'http':
        return {
          method: command.commandType,
          data: command.params,
          requestId: command.id,
        };

      case 'modbus':
        return {
          function: command.commandType,
          address: command.params.address,
          value: command.params.value,
        };

      default:
        return command.params;
    }
  }

  /**
   * Handle command failure with retry logic
   */
  private async handleCommandFailure(
    command: DeviceCommand,
    error: string,
  ): Promise<void> {
    console.error(`❌ Command failed: ${error}`);

    const retriesLeft = command.retries - 1;

    if (retriesLeft > 0) {
      console.log(`🔄 Retrying command (${retriesLeft} retries left)...`);

      // Update retry count
      command.retries = retriesLeft;

      // Schedule retry with exponential backoff
      const retryDelay = Math.pow(2, 3 - retriesLeft) * 1000; // 2s, 4s, 8s

      setTimeout(async () => {
        await kafkaService.sendMessage('device.commands.retry', command);
      }, retryDelay);

      await this.updateCommandStatus(
        command.id,
        'RETRYING',
        `Retry in ${retryDelay}ms`,
      );
    } else {
      console.error(`💀 Command failed permanently: ${error}`);
      await this.updateCommandStatus(command.id, 'FAILED', error);

      // Create alarm for failed critical command
      if (command.priority === 'URGENT') {
        await this.createCommandFailureAlarm(command, error);
      }
    }
  }

  /**
   * Wait for device acknowledgment
   */
  private async waitForAcknowledgment(command: DeviceCommand): Promise<void> {
    console.log('⏳ Waiting for device acknowledgment...');

    const timeout = command.timeout || 30000; // 30 seconds default
    const ackKey = `command:${command.id}:ack`;

    // Poll Redis for acknowledgment
    const startTime = Date.now();

    while (Date.now() - startTime < timeout) {
      const ack = await redisService.get(ackKey);

      if (ack) {
        const ackData = JSON.parse(ack);
        console.log(`✅ Device acknowledged: ${ackData.status}`);

        await this.updateCommandStatus(
          command.id,
          'COMPLETED',
          `Acknowledged: ${ackData.status}`,
        );

        await redisService.del(ackKey);
        return;
      }

      await new Promise((resolve) => setTimeout(resolve, 1000)); // Check every second
    }

    console.log(`⚠️  No acknowledgment received within ${timeout}ms`);
    await this.updateCommandStatus(command.id, 'DELIVERED', 'No ACK (timeout)');
  }

  /**
   * Queue command for offline device
   */
  private async queueCommand(command: DeviceCommand): Promise<void> {
    await redisService.lpush(
      `device:${command.deviceId}:command_queue`,
      JSON.stringify(command),
    );

    await this.updateCommandStatus(command.id, 'QUEUED', 'Device offline');
    console.log(`📋 Command queued for device: ${command.deviceKey}`);
  }

  /**
   * Schedule command for future execution
   */
  private async scheduleCommand(command: DeviceCommand): Promise<void> {
    const delay = command.scheduledFor! - Date.now();

    console.log(`⏰ Scheduling command for ${new Date(command.scheduledFor!)}`);

    setTimeout(async () => {
      await kafkaService.sendMessage('device.commands', {
        ...command,
        scheduledFor: undefined, // Clear schedule flag
      });
    }, delay);

    await this.updateCommandStatus(
      command.id,
      'SCHEDULED',
      `Will execute at ${new Date(command.scheduledFor!)}`,
    );
  }

  /**
   * Update command status in database
   */
  private async updateCommandStatus(
    commandId: string,
    status: string,
    message?: string,
  ): Promise<void> {
    try {
      await this.db.query(
        `UPDATE device_command 
         SET status = $1, 
             status_message = $2,
             updated_at = NOW()
         WHERE id = $3`,
        [status, message || '', commandId],
      );

      // Also cache in Redis for fast lookup
      await redisService.hset(`command:${commandId}`, 'status', status);

      if (message) {
        await redisService.hset(`command:${commandId}`, 'message', message);
      }
    } catch (error) {
      console.error('Failed to update command status:', error);
    }
  }

  /**
   * Get device info
   */
  private async getDevice(deviceId: string): Promise<any> {
    // Check cache first
    const cached = await redisService.get(`device:${deviceId}`);
    if (cached) {
      return JSON.parse(cached);
    }

    // Get from database
    const result = await this.db.query(
      `SELECT id, device_key, protocol, metadata, last_seen_at,
              (EXTRACT(EPOCH FROM (NOW() - last_seen_at)) < 300) as is_online
       FROM device 
       WHERE id = $1`,
      [deviceId],
    );

    const device = result.rows[0];

    if (device) {
      // Cache for 5 minutes
      await redisService.set(`device:${deviceId}`, JSON.stringify(device), 300);
    }

    return device;
  }

  /**
   * Create alarm for failed critical command
   */
  private async createCommandFailureAlarm(
    command: DeviceCommand,
    error: string,
  ): Promise<void> {
    await kafkaService.sendMessage('alarms.created', {
      id: `cmd-fail-${command.id}`,
      deviceId: command.deviceId,
      deviceKey: command.deviceKey,
      tenantId: command.tenantId,
      userId: command.userId,
      severity: 'MAJOR',
      type: 'COMMAND_FAILURE',
      title: 'Critical Command Failed',
      message: `Failed to execute ${command.commandType}: ${error}`,
      timestamp: Date.now(),
      metadata: {
        commandId: command.id,
        commandType: command.commandType,
        error: error,
      },
    });
  }

  /**
   * Process queued commands when device comes online
   */
  async processQueuedCommands(deviceId: string): Promise<void> {
    const queueKey = `device:${deviceId}:command_queue`;

    // Get all queued commands
    const queuedCommands = await redisService.lrange(queueKey, 0, -1);

    if (queuedCommands.length === 0) return;

    console.log(
      `📋 Processing ${queuedCommands.length} queued commands for device ${deviceId}`,
    );

    for (const commandStr of queuedCommands) {
      const command: DeviceCommand = JSON.parse(commandStr);

      // Send to Kafka for processing
      await kafkaService.sendMessage('device.commands', command);
    }

    // Clear queue
    await redisService.del(queueKey);
    console.log(`✅ Queued commands sent`);
  }

  /**
   * Stop consumer
   */
  async stop(): Promise<void> {
    console.log('🛑 Stopping Device Commands Consumer...');
    // Kafka service handles consumer cleanup
    console.log('✅ Device Commands Consumer stopped');
  }
}
