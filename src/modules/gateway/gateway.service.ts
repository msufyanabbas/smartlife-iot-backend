import {
  Injectable,
  Logger,
  OnModuleInit,
  OnModuleDestroy,
  Inject,
} from '@nestjs/common';
import type { ConfigType } from '@nestjs/config';
import * as mqtt from 'mqtt';
import { MqttClient } from 'mqtt';
import { EventEmitter2 } from '@nestjs/event-emitter';
import mqttConfig from '../../config/mqtt.config';

export interface DeviceMessage {
  deviceKey: string;
  timestamp: Date;
  data: Record<string, any>;
  messageType: 'telemetry' | 'attributes' | 'rpc_request' | 'rpc_response';
}

export interface DeviceCommand {
  deviceKey: string;
  method: string;
  params?: Record<string, any>;
}

@Injectable()
export class GatewayService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(GatewayService.name);
  private client: MqttClient;
  private isConnected = false;

  constructor(
    @Inject(mqttConfig.KEY)
    private config: ConfigType<typeof mqttConfig>,
    private eventEmitter: EventEmitter2,
  ) {}

  async onModuleInit() {
    await this.connectToBroker();
    this.setupMessageHandlers();
  }

  async onModuleDestroy() {
    await this.disconnect();
  }

  /**
   * Connect to MQTT broker
   */
  private async connectToBroker(): Promise<void> {
    try {
      this.logger.log(`Connecting to MQTT broker: ${this.config.brokerUrl}`);

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
        this.logger.error('MQTT connection error:', error);
      });

      this.client.on('disconnect', () => {
        this.isConnected = false;
        this.logger.warn('Disconnected from MQTT broker');
      });

      this.client.on('reconnect', () => {
        this.logger.log('Reconnecting to MQTT broker...');
      });

      this.client.on('offline', () => {
        this.isConnected = false;
        this.logger.warn('MQTT client is offline');
      });
    } catch (error) {
      this.logger.error('Failed to connect to MQTT broker:', error);
      throw error;
    }
  }

  /**
   * Subscribe to device topics
   */
  private subscribeToTopics(): void {
    const topics: any = [
      this.config.topics.telemetry,
      this.config.topics.status,
      this.config.topics.alerts,
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
  }

  /**
   * Setup message handlers
   */
  private setupMessageHandlers(): void {
    this.client.on('message', (topic, payload) => {
      try {
        const message = payload.toString();
        this.logger.debug(
          `📨 Received on ${topic}: ${message.substring(0, 100)}`,
        );

        // Extract device key from topic (e.g., devices/device123/telemetry)
        const deviceKey = this.extractDeviceKey(topic);

        if (!deviceKey) {
          this.logger.warn(`Could not extract device key from topic: ${topic}`);
          return;
        }

        const data = JSON.parse(message);

        // Determine message type based on topic
        const messageType = this.getMessageType(topic);

        const deviceMessage: DeviceMessage = {
          deviceKey,
          timestamp: new Date(),
          data,
          messageType,
        };

        // Emit event for other services to handle
        this.eventEmitter.emit(`device.${messageType}`, deviceMessage);
        this.eventEmitter.emit('device.message', deviceMessage);
      } catch (error) {
        this.logger.error('Error processing message:', error);
      }
    });
  }

  /**
   * Extract device key from topic
   */
  private extractDeviceKey(topic: string): string | null {
    // Topic format: devices/{deviceKey}/telemetry
    const parts = topic.split('/');
    if (parts.length >= 2 && parts[0] === 'devices') {
      return parts[1];
    }
    return null;
  }

  /**
   * Get message type from topic
   */
  private getMessageType(topic: string): DeviceMessage['messageType'] {
    if (topic.includes('telemetry')) return 'telemetry';
    if (topic.includes('attributes')) return 'attributes';
    if (topic.includes('rpc')) {
      return topic.includes('request') ? 'rpc_request' : 'rpc_response';
    }
    return 'telemetry';
  }

  /**
   * Send command to device
   */
  async sendCommand(deviceKey: string, command: DeviceCommand): Promise<void> {
    if (!this.isConnected) {
      throw new Error('MQTT client is not connected');
    }

    const topic = `devices/${deviceKey}/commands`;
    const payload = JSON.stringify(command);

    return new Promise((resolve, reject) => {
      this.client.publish(
        topic,
        payload,
        { qos: this.config.qos, retain: this.config.retainMessages },
        (err) => {
          if (err) {
            this.logger.error(`Failed to send command to ${deviceKey}:`, err);
            reject(err);
          } else {
            this.logger.log(
              `✅ Command sent to ${deviceKey}: ${command.method}`,
            );
            resolve();
          }
        },
      );
    });
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
    };
  }
}
