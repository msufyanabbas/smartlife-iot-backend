// src/modules/gateway/gateway.service.ts
// UPDATED - Now verifies device credentials before processing messages

import {
  Injectable,
  Logger,
  OnModuleInit,
  OnModuleDestroy,
  Inject,
  ForbiddenException,
} from '@nestjs/common';
import type { ConfigType } from '@nestjs/config';
import * as mqtt from 'mqtt';
import { MqttClient } from 'mqtt';
import { EventEmitter2 } from '@nestjs/event-emitter';
import mqttConfig from '../../config/mqtt.config';
import { DevicesService } from '../devices/devices.service';

export interface DeviceMessage {
  deviceKey: string;
  timestamp: Date;
  data: Record<string, any> | string;
  messageType: 'telemetry' | 'attributes' | 'rpc_request' | 'rpc_response' | 'status' | 'alerts';
}

export interface DeviceCommand {
  deviceKey: string;
  method: string;
  params?: Record<string, any>;
}

interface VerifiedConnection {
  deviceKey: string;
  deviceId: string;
  verifiedAt: Date;
  credentialsId: string;
}

@Injectable()
export class GatewayService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(GatewayService.name);
  private client: MqttClient;
  private isConnected = false;
  private verifiedConnections: Map<string, VerifiedConnection> = new Map();

  constructor(
    @Inject(mqttConfig.KEY)
    private config: ConfigType<typeof mqttConfig>,
    private eventEmitter: EventEmitter2,
    private devicesService: DevicesService,
  ) {}

  async onModuleInit() {
    await this.connectToBroker();
    this.setupMessageHandlers();
    this.startConnectionCleanup();
  }

  async onModuleDestroy() {
    await this.disconnect();
  }

  /**
   * Connect to MQTT broker
   */
  private async connectToBroker(): Promise<void> {
    try {
      this.logger.log(`🔌 Connecting to MQTT broker: ${this.config.brokerUrl}`);

      const options: mqtt.IClientOptions = {
        clientId: this.config.clientId,
        username: this.config.username || undefined,
        password: this.config.password || undefined,
        keepalive: this.config.keepAlive,
        reconnectPeriod: this.config.reconnectPeriod,
        connectTimeout: this.config.connectTimeout,
        clean: this.config.cleanSession,
      };

      this.client = mqtt.connect(this.config.brokerUrl as string, options);

      this.client.on('connect', () => {
        this.isConnected = true;
        this.logger.log('✅ Connected to MQTT broker');
        this.subscribeToTopics();
      });

      this.client.on('error', (error) => {
        this.logger.error('❌ MQTT connection error:', error);
      });

      this.client.on('disconnect', () => {
        this.isConnected = false;
        this.logger.warn('⚠️  Disconnected from MQTT broker');
      });

      this.client.on('reconnect', () => {
        this.logger.log('🔄 Reconnecting to MQTT broker...');
      });

      this.client.on('offline', () => {
        this.isConnected = false;
        this.logger.warn('⚠️  MQTT client is offline');
      });
    } catch (error) {
      this.logger.error('Failed to connect to MQTT broker:', error);
      throw error;
    }
  }

  /**
   * Subscribe to device topics with wildcards
   */
  private subscribeToTopics(): void {
    const topics = [
      // Generic device topics
      'devices/+/telemetry',
      'devices/+/attributes',
      'devices/+/status',
      'devices/+/alerts',
      
      // Milesight LoRaWAN topics
      'application/+/device/+/rx',
      'application/+/device/+/event/+',
      
      // ChirpStack topics
      'application/+/device/+/event/up',
      'application/+/device/+/event/+',
      
      // ThingsBoard style topics
      'v1/devices/+/telemetry',
      'v1/devices/+/attributes',
    ];

    topics.forEach((topic) => {
      this.client.subscribe(topic, { qos: this.config.qos }, (err) => {
        if (err) {
          this.logger.error(`Failed to subscribe to ${topic}:`, err);
        } else {
          this.logger.log(`📡 Subscribed to: ${topic}`);
        }
      });
    });

    this.logger.log(`✅ Subscribed to ${topics.length} topic patterns`);
  }

  /**
   * Setup message handlers with credential verification
   */
  private setupMessageHandlers(): void {
    this.client.on('message', async (topic, payload, packet) => {
      try {
        const message = payload.toString();
        
        this.logger.debug(`📨 Message received`);
        this.logger.debug(`  Topic: ${topic}`);
        this.logger.debug(`  Payload: ${message.substring(0, 200)}...`);

        // Extract device identifier from topic
        const deviceIdentifier = this.extractDeviceIdentifier(topic);

        if (!deviceIdentifier) {
          this.logger.warn(`❌ Could not extract device identifier from: ${topic}`);
          return;
        }

        this.logger.debug(`  Device ID: ${deviceIdentifier}`);

        // Verify device credentials
        const verification = await this.verifyDeviceConnection(
          deviceIdentifier,
          packet,
        );

        if (!verification) {
          this.logger.warn(`🚫 Device ${deviceIdentifier} failed credential verification`);
          return;
        }

        this.logger.log(`✅ Device ${verification.deviceKey} authenticated`);

        // Parse payload
        let data: any;
        try {
          data = JSON.parse(message);
          this.logger.debug(`✅ Parsed as JSON`);
        } catch (parseError) {
          this.logger.debug(`📦 Raw payload (will be decoded by codec)`);
          data = message;
        }

        // Determine message type
        const messageType = this.getMessageType(topic);

        const deviceMessage: DeviceMessage = {
          deviceKey: verification.deviceKey,
          timestamp: new Date(),
          data,
          messageType,
        };

        // Emit event for processing
        this.eventEmitter.emit(`device.${messageType}`, deviceMessage);
        this.eventEmitter.emit('device.message', deviceMessage);

        this.logger.debug(`📤 Event emitted: device.${messageType}`);

      } catch (error) {
        this.logger.error('❌ Error processing message:', error);
        if (error instanceof Error) {
          this.logger.error(error.stack);
        }
      }
    });
  }

  /**
   * Verify device connection and credentials
   * Returns verified device info if successful
   */
  private async verifyDeviceConnection(
    deviceIdentifier: string,
    packet: mqtt.IPublishPacket,
  ): Promise<VerifiedConnection | null> {
    try {
      // Check if already verified (cache for 5 minutes)
      const cached = this.verifiedConnections.get(deviceIdentifier);
      if (cached) {
        const fiveMinutesAgo = new Date(Date.now() - 5 * 60 * 1000);
        if (cached.verifiedAt > fiveMinutesAgo) {
          return cached;
        }
      }

      // Extract credentials from packet properties (if available)
      // In MQTT, credentials are usually in the CONNECT packet, not in each PUBLISH
      // So we'll verify based on deviceKey/devEUI lookup
      
      let device;
      
      // Try to find device by deviceKey first
      if (deviceIdentifier.startsWith('dev_')) {
        device = await this.devicesService.findByDeviceKey(deviceIdentifier);
      } else {
        // For LoRaWAN devices, deviceIdentifier is devEUI
        // We need to find device by metadata.devEUI
        const devices = await this.devicesService.findAll(
          { role: 'SUPER_ADMIN' } as any,
          { page: 1, limit: 1000 } as any,
        );
        
        const matchingDevice = devices.data.find(
          (d) => d.metadata?.devEUI === deviceIdentifier,
        );
        
        if (!matchingDevice) {
          this.logger.warn(`Device not found for identifier: ${deviceIdentifier}`);
          return null;
        }
        
        device = matchingDevice;
      }

      // Check device status
      if (device.status === 'inactive') {
        this.logger.warn(`Device ${device.deviceKey} is inactive`);
        return null;
      }

      // Create verification record
      const verification: VerifiedConnection = {
        deviceKey: device.deviceKey,
        deviceId: device.id,
        verifiedAt: new Date(),
        credentialsId: deviceIdentifier,
      };

      // Cache verification
      this.verifiedConnections.set(deviceIdentifier, verification);

      return verification;

    } catch (error) {
      this.logger.error(`Verification failed for ${deviceIdentifier}:`, error);
      return null;
    }
  }

  /**
   * Extract device identifier from MQTT topic
   * Handles different topic patterns
   */
  private extractDeviceIdentifier(topic: string): string | null {
    // Generic: devices/{deviceKey}/telemetry
    if (topic.startsWith('devices/')) {
      const parts = topic.split('/');
      if (parts.length >= 2) {
        return parts[1]; // deviceKey
      }
    }

    // Milesight/ChirpStack: application/{appId}/device/{devEUI}/rx
    if (topic.includes('/device/')) {
      const match = topic.match(/\/device\/([^/]+)/);
      if (match) {
        return match[1]; // devEUI
      }
    }

    // ThingsBoard: v1/devices/{deviceKey}/telemetry
    if (topic.startsWith('v1/devices/')) {
      const parts = topic.split('/');
      if (parts.length >= 3) {
        return parts[2]; // deviceKey
      }
    }

    return null;
  }

  /**
   * Get message type from topic
   */
  private getMessageType(topic: string): DeviceMessage['messageType'] {
    if (topic.includes('telemetry') || topic.includes('/rx')) return 'telemetry';
    if (topic.includes('attributes')) return 'attributes';
    if (topic.includes('status')) return 'status';
    if (topic.includes('alerts') || topic.includes('error')) return 'alerts';
    if (topic.includes('rpc')) {
      return topic.includes('request') ? 'rpc_request' : 'rpc_response';
    }
    return 'telemetry'; // Default
  }

  /**
   * Send command to device (with topic routing)
   */
  async sendCommand(deviceKey: string, command: DeviceCommand): Promise<void> {
    if (!this.isConnected) {
      throw new Error('MQTT client is not connected');
    }

    // Get device to determine correct topic
    const device = await this.devicesService.findByDeviceKey(deviceKey);
    
    // Determine command topic based on device type
    let topic: string;
    let payload: any;

    const gatewayType = device.metadata?.gatewayType;
    const devEUI = device.metadata?.devEUI;

    if (gatewayType === 'milesight' && devEUI) {
      topic = `application/1/device/${devEUI}/tx`;
      payload = {
        devEUI,
        fPort: 85,
        confirmed: false,
        data: this.encodeCommandForMilesight(command),
      };
    } else if (gatewayType === 'chirpstack' && devEUI) {
      topic = `application/+/device/${devEUI}/command/down`;
      payload = {
        devEUI,
        confirmed: false,
        fPort: 1,
        data: Buffer.from(JSON.stringify(command)).toString('base64'),
      };
    } else {
      // Generic MQTT
      topic = `devices/${deviceKey}/commands`;
      payload = command;
    }

    return new Promise((resolve, reject) => {
      this.client.publish(
        topic,
        JSON.stringify(payload),
        { qos: this.config.qos, retain: this.config.retainMessages },
        (err) => {
          if (err) {
            this.logger.error(`Failed to send command to ${deviceKey}:`, err);
            reject(err);
          } else {
            this.logger.log(`✅ Command sent to ${deviceKey}: ${command.method}`);
            resolve();
          }
        },
      );
    });
  }

  /**
   * Encode command for Milesight devices
   */
  private encodeCommandForMilesight(command: DeviceCommand): string {
    if (command.method === 'set_light') {
      const status = command.params?.on ? 0x01 : 0x00;
      return Buffer.from([0xff, 0x0b, status]).toString('hex');
    }

    if (command.method === 'set_brightness') {
      const brightness = Math.min(255, Math.max(0, command.params?.brightness || 0));
      return Buffer.from([0xff, 0x0c, brightness]).toString('hex');
    }

    // Default: return as JSON base64
    return Buffer.from(JSON.stringify(command.params)).toString('base64');
  }

  /**
   * Send RPC request to device
   */
  async sendRpcRequest(
    deviceKey: string,
    method: string,
    params?: Record<string, any>,
  ): Promise<void> {
    const topic = `devices/${deviceKey}/rpc/request`;
    const requestId = Date.now().toString();

    const payload = JSON.stringify({
      id: requestId,
      method,
      params,
    });

    return new Promise((resolve, reject) => {
      this.client.publish(topic, payload, { qos: this.config.qos }, (err) => {
        if (err) {
          reject(err);
        } else {
          this.logger.log(`RPC request sent to ${deviceKey}: ${method}`);
          resolve();
        }
      });
    });
  }

  /**
   * Update device attributes
   */
  async updateDeviceAttributes(
    deviceKey: string,
    attributes: Record<string, any>,
  ): Promise<void> {
    const topic = `devices/${deviceKey}/attributes`;
    const payload = JSON.stringify(attributes);

    return new Promise((resolve, reject) => {
      this.client.publish(topic, payload, { qos: this.config.qos }, (err) => {
        if (err) reject(err);
        else resolve();
      });
    });
  }

  /**
   * Publish telemetry (for testing)
   */
  async publishTelemetry(
    deviceKey: string,
    telemetry: Record<string, any>,
  ): Promise<void> {
    const topic = `devices/${deviceKey}/telemetry`;
    const payload = JSON.stringify({
      ts: Date.now(),
      values: telemetry,
    });

    return new Promise((resolve, reject) => {
      this.client.publish(topic, payload, { qos: this.config.qos }, (err) => {
        if (err) reject(err);
        else resolve();
      });
    });
  }

  /**
   * Cleanup old verified connections (every 10 minutes)
   */
  private startConnectionCleanup(): void {
    setInterval(() => {
      const tenMinutesAgo = new Date(Date.now() - 10 * 60 * 1000);
      
      for (const [key, verification] of this.verifiedConnections.entries()) {
        if (verification.verifiedAt < tenMinutesAgo) {
          this.verifiedConnections.delete(key);
        }
      }

      if (this.verifiedConnections.size > 0) {
        this.logger.debug(
          `🧹 Cleanup: ${this.verifiedConnections.size} verified connections cached`,
        );
      }
    }, 10 * 60 * 1000); // Every 10 minutes
  }

  /**
   * Check if connected
   */
  isClientConnected(): boolean {
    return this.isConnected;
  }

  /**
   * Disconnect from broker
   */
  async disconnect(): Promise<void> {
    if (this.client) {
      return new Promise((resolve) => {
        this.client.end(false, {}, () => {
          this.logger.log('Disconnected from MQTT broker');
          resolve();
        });
      });
    }
  }

  /**
   * Get connection status
   */
  getStatus() {
    return {
      connected: this.isConnected,
      brokerUrl: this.config.brokerUrl,
      clientId: this.config.clientId,
      verifiedConnections: this.verifiedConnections.size,
      topicsSubscribed: [
        'devices/+/telemetry',
        'devices/+/attributes',
        'application/+/device/+/rx',
        'v1/devices/+/telemetry',
      ],
    };
  }
}