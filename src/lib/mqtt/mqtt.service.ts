// src/lib/mqtt/mqtt.service.ts
import * as mqtt from 'mqtt';
import { Injectable, Logger, OnModuleInit, OnModuleDestroy } from '@nestjs/common';
import { KafkaService } from '../kafka/kafka.service';

@Injectable()
export class MQTTService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(MQTTService.name);
  private client: mqtt.MqttClient | null = null;
  private isConnected = false;

  constructor(
    // ✅ Inject KafkaService via DI instead of importing singleton
    private readonly kafka: KafkaService,
  ) {}

  /**
   * Auto-connects when NestJS starts
   */
  async onModuleInit() {
    this.logger.log('🚀 Connecting to MQTT Broker...');
    await this.connect();
  }

  /**
   * Auto-disconnects when NestJS stops
   */
  async onModuleDestroy() {
    this.logger.log('🛑 Disconnecting from MQTT...');
    await this.disconnect();
  }

  /**
   * Connect to MQTT broker
   */
  async connect(): Promise<void> {
    try {
      this.client = mqtt.connect(process.env.MQTT_BROKER_URL!, {
        clientId: process.env.MQTT_CLIENT_ID || `smartlife-${Date.now()}`,
        username: process.env.MQTT_USERNAME,
        password: process.env.MQTT_PASSWORD,
        clean: true,
        reconnectPeriod: 5000,
      });

      this.client.on('connect', () => {
        this.logger.log('✅ MQTT Broker connected');
        this.isConnected = true;
        this.subscribeToTopics();
      });

      this.client.on('error', (error) => {
        this.logger.error('❌ MQTT Error:', error);
        this.isConnected = false;
      });

      this.client.on('message', async (topic, message) => {
        await this.handleMessage(topic, message);
      });

      this.client.on('close', () => {
        this.logger.warn('⚠️  MQTT connection closed');
        this.isConnected = false;
      });
    } catch (error) {
      this.logger.error('❌ Failed to connect to MQTT:', error);
      throw error;
    }
  }

  /**
   * Subscribe to device topics
   */
  private subscribeToTopics(): void {
    const topics = [
      process.env.MQTT_TOPIC_TELEMETRY || 'devices/+/telemetry',
      process.env.MQTT_TOPIC_COMMANDS || 'devices/+/commands',
      process.env.MQTT_TOPIC_STATUS || 'devices/+/status',
      process.env.MQTT_TOPIC_ALERTS || 'devices/+/alerts',
      'lorawan/+/data',  // LoRaWAN devices
    ].filter(Boolean);

    topics.forEach((topic) => {
      this.client?.subscribe(topic, (err) => {
        if (err) {
          this.logger.error(`❌ Failed to subscribe to ${topic}:`, err);
        } else {
          this.logger.log(`✅ Subscribed to MQTT topic: ${topic}`);
        }
      });
    });
  }

  /**
   * Handle incoming MQTT messages
   */
  private async handleMessage(topic: string, message: Buffer): Promise<void> {
    try {
      this.logger.log(`📨 MQTT message received on ${topic}`);

      const payload = JSON.parse(message.toString());
      this.logger.debug('📦 Payload:', payload);

      // Extract device ID from topic
      const deviceId = this.extractDeviceId(topic);

      // Parse based on topic pattern
      let telemetryData: any;
      if (topic.startsWith('lorawan/')) {
        telemetryData = this.parseLoRaWANPayload(payload, deviceId);
      } else if (topic.startsWith('devices/')) {
        telemetryData = payload;
      } else {
        telemetryData = payload;
      }

      // ✅ Use injected KafkaService instead of singleton
      await this.kafka.sendMessage(
        'telemetry.device.raw',
        {
          deviceId,
          deviceKey: deviceId,
          tenantId: 'default',  // TODO: Extract from device credentials
          ...telemetryData,
          receivedAt: Date.now(),
          source: 'mqtt',
          topic,
        },
        deviceId,
      );

      this.logger.log(`✅ MQTT message forwarded to Kafka for device: ${deviceId}`);
    } catch (error: any) {
      this.logger.error('❌ Failed to handle MQTT message:', error);
    }
  }

  /**
   * Extract device ID from topic
   */
  private extractDeviceId(topic: string): string {
    // devices/ws202-001/telemetry → ws202-001
    // lorawan/ws202-001/data → ws202-001
    const parts = topic.split('/');
    return parts[1] || 'unknown';
  }

  /**
   * Parse LoRaWAN payload
   */
  private parseLoRaWANPayload(payload: any, deviceId: string): any {
    const decoded = this.decodeWS202Data(payload.data);

    return {
      data: {
        raw: payload.data,
        deveui: payload.deveui,
        fcnt: payload.fcnt,
        ...decoded,
      },
      temperature: decoded.temperature,
      humidity: decoded.humidity,
      batteryLevel: decoded.battery,
      signalStrength: payload.rssi,
      metadata: {
        rssi: payload.rssi,
        snr: payload.snr,
        frequency: payload.freq,
      },
    };
  }

  /**
   * Decode WS202 hex data
   */
  private decodeWS202Data(hexData: string): any {
    try {
      const buffer = Buffer.from(hexData, 'hex');
      const result: any = {};

      let offset = 0;
      while (offset < buffer.length) {
        const channel = buffer.readUInt8(offset);
        const type = buffer.readUInt8(offset + 1);
        const value = buffer.readUInt16BE(offset + 2);

        switch (type) {
          case 0x67: // Temperature
            result.temperature = (value / 10).toFixed(1);
            break;
          case 0x68: // Humidity
            result.humidity = (value / 2).toFixed(1);
            break;
          case 0x75: // Battery
            result.battery = value;
            break;
        }

        offset += 4;
      }

      return result;
    } catch (error) {
      this.logger.error('Failed to decode WS202 data:', error);
      return {};
    }
  }

  /**
   * Publish message to MQTT (for downlink commands)
   */
  async publish(topic: string, message: any): Promise<void> {
    if (!this.client || !this.isConnected) {
      throw new Error('MQTT client not connected');
    }

    return new Promise((resolve, reject) => {
      this.client!.publish(topic, JSON.stringify(message), (err) => {
        if (err) {
          this.logger.error(`❌ Failed to publish to ${topic}:`, err);
          reject(err);
        } else {
          this.logger.log(`📤 Published to MQTT topic: ${topic}`);
          resolve();
        }
      });
    });
  }

  /**
   * Disconnect from MQTT
   */
  async disconnect(): Promise<void> {
    if (this.client) {
      await this.client.end();
      this.isConnected = false;
      this.logger.log('✅ MQTT disconnected');
    }
  }

  /**
   * Check if MQTT is connected
   */
  isClientConnected(): boolean {
    return this.isConnected;
  }
}