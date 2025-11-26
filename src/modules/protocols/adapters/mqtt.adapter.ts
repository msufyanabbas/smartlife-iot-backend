import * as mqtt from 'mqtt';
import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import {
  StandardTelemetry,
  IProtocolAdapter,
} from '@/common/interfaces/standard-telemetry.interface';
import { DeviceListenerService } from '@/modules/gateway/device-listener.service';
import { DeviceCredentials } from '@/modules/devices/entities/device-credentials.entity';

@Injectable()
export class MQTTAdapter implements IProtocolAdapter {
  protocol = 'mqtt';
  private client: mqtt.MqttClient | null = null;
  private isConnected = false;

  // Map of MQTT clientId → deviceId (from credentials)
  private authenticatedDevices = new Map<string, string>();

  constructor(
    private readonly deviceListener: DeviceListenerService,
    @InjectRepository(DeviceCredentials)
    private credentialsRepository: Repository<DeviceCredentials>,
  ) {}

  async start(): Promise<void> {
    try {
      console.log('🚀 Starting MQTT Adapter...');

      this.client = mqtt.connect(
        process.env.MQTT_BROKER || 'mqtt://localhost:1883',
        {
          clientId: `smartlife-mqtt-${Math.random().toString(16).substr(2, 8)}`,
          username: process.env.MQTT_USERNAME,
          password: process.env.MQTT_PASSWORD,
          clean: true,
          reconnectPeriod: 5000,
        },
      );

      this.client.on('connect', () => {
        console.log('✅ MQTT Broker connected');
        this.isConnected = true;
        this.subscribeToTopics();
      });

      this.client.on('message', async (topic, message) => {
        await this.handleMessage(topic, message);
      });

      // Handle device authentication
      this.client.on('connect', async (packet) => {
        await this.handleDeviceAuthentication(packet);
      });
    } catch (error) {
      console.error('❌ Failed to start MQTT Adapter:', error);
      throw error;
    }
  }

  /**
   * Subscribe to topics
   * Now includes ThingsBoard-style generic topics!
   */
  private subscribeToTopics(): void {
    const topics = [
      // ===== THINGSBOARD-STYLE (SINGLE TOPICS) =====
      'v1/devices/me/telemetry', // ThingsBoard compatible
      'v1/devices/telemetry', // Alternative
      'telemetry', // Simple version

      // ===== YOUR STYLE (DEVICE-SPECIFIC TOPICS) =====
      'devices/+/telemetry', // devices/{deviceId}/telemetry
      'devices/+/data',
      'sensors/+/data',
      'lorawan/+/uplink',

      // ===== MILESIGHT =====
      'milesight/+/data',

      // Add custom topics from env
      ...(process.env.MQTT_CUSTOM_TOPICS?.split(',') || []),
    ].filter(Boolean);

    topics.forEach((topic) => {
      this.client?.subscribe(topic, { qos: 1 }, (err) => {
        if (err) {
          console.error(`❌ Failed to subscribe to ${topic}:`, err);
        } else {
          console.log(`✅ Subscribed to MQTT topic: ${topic}`);
        }
      });
    });
  }

  /**
   * Handle device authentication (for single topic approach)
   */
  private async handleDeviceAuthentication(packet: any): Promise<void> {
    try {
      // Extract credentials from MQTT connection
      const username = packet.username; // This is the access token or username
      const clientId = packet.clientId;

      if (!username) return; // Anonymous connection

      // Look up device by credentials
      const credentials = await this.credentialsRepository.findOne({
        where: { credentialsId: username },
        relations: ['device'],
      });

      if (credentials) {
        // Store mapping: MQTT clientId → deviceId
        this.authenticatedDevices.set(clientId, credentials.device.id);
        console.log(
          `✅ Device authenticated: ${credentials.device.deviceKey} (${clientId})`,
        );
      } else {
        console.warn(`⚠️  Unknown credentials: ${username}`);
      }
    } catch (error) {
      console.error('Failed to authenticate device:', error);
    }
  }

  /**
   * Handle incoming MQTT message
   * UPDATED: Supports both approaches!
   */
  private async handleMessage(topic: string, message: Buffer): Promise<void> {
    try {
      console.log(`\n📨 MQTT Message`);
      console.log(`📍 Topic: ${topic}`);

      const rawPayload = JSON.parse(message.toString());
      console.log(`📦 Payload:`, rawPayload);

      // Determine device ID (two approaches)
      let deviceId: string;

      // Approach 1: Extract from topic (your current approach)
      if (topic.includes('+') === false) {
        // Generic topic (v1/devices/telemetry)
        // Use authenticated device from connection
        // Note: In real MQTT broker, you'd get clientId from packet
        // For now, try to extract from payload
        deviceId =
          rawPayload.deviceId ||
          rawPayload.device ||
          rawPayload.deviceKey ||
          'unknown';
      } else {
        // Topic-based: devices/DEVICE-123/telemetry
        deviceId = this.extractDeviceIdFromTopic(topic);
      }

      console.log(`🔍 Detected device: ${deviceId}`);

      // Convert to standard format
      const standardTelemetry = this.parse(rawPayload, { topic, deviceId });

      // Send to device listener
      await this.deviceListener.handleTelemetry(standardTelemetry);

      console.log(`✅ MQTT message processed\n`);
    } catch (error: any) {
      console.error('❌ Failed to handle MQTT message:', error);
    }
  }

  /**
   * Parse - UPDATED to handle ANY format!
   */
  parse(
    rawPayload: any,
    context?: { topic: string; deviceId: string },
  ): StandardTelemetry {
    const deviceId = context?.deviceId || rawPayload.deviceId || 'unknown';

    // AUTO-DETECT format and extract data
    const extractedData = this.extractTelemetryData(rawPayload);

    return {
      deviceId: deviceId,
      deviceKey: deviceId,
      tenantId: rawPayload.tenantId || 'default',

      // Original data preserved
      data: rawPayload,

      // Extracted common fields (if they exist)
      temperature: extractedData.temperature,
      humidity: extractedData.humidity,
      pressure: extractedData.pressure,
      batteryLevel: extractedData.battery,
      signalStrength: extractedData.rssi,
      latitude: extractedData.latitude,
      longitude: extractedData.longitude,

      timestamp: rawPayload.timestamp || new Date().toISOString(),
      receivedAt: Date.now(),
      protocol: 'mqtt',
      metadata: {
        topic: context?.topic,
        qos: 1,
      },
      rawPayload: rawPayload,
    };
  }

  /**
   * SMART EXTRACTION - Works with ANY format!
   * This is the key to handling unknown formats
   */
  private extractTelemetryData(payload: any): any {
    const result: any = {};

    // Recursive function to find common field names
    const findFields = (obj: any, prefix: string = '') => {
      for (const [key, value] of Object.entries(obj)) {
        const lowerKey = key.toLowerCase();

        // Temperature
        if (lowerKey.includes('temp') || lowerKey === 't') {
          result.temperature =
            typeof value === 'number' ? value : parseFloat(value as string);
        }
        // Humidity
        else if (lowerKey.includes('hum') || lowerKey === 'h') {
          result.humidity =
            typeof value === 'number' ? value : parseFloat(value as string);
        }
        // Pressure
        else if (lowerKey.includes('press') || lowerKey === 'p') {
          result.pressure =
            typeof value === 'number' ? value : parseFloat(value as string);
        }
        // Battery
        else if (lowerKey.includes('batt') || lowerKey.includes('bat')) {
          result.battery =
            typeof value === 'number' ? value : parseFloat(value as string);
        }
        // RSSI
        else if (lowerKey === 'rssi' || lowerKey.includes('signal')) {
          result.rssi =
            typeof value === 'number' ? value : parseFloat(value as string);
        }
        // GPS
        else if (lowerKey === 'lat' || lowerKey === 'latitude') {
          result.latitude =
            typeof value === 'number' ? value : parseFloat(value as string);
        } else if (
          lowerKey === 'lon' ||
          lowerKey === 'lng' ||
          lowerKey === 'longitude'
        ) {
          result.longitude =
            typeof value === 'number' ? value : parseFloat(value as string);
        }
        // Nested objects (recursive)
        else if (
          typeof value === 'object' &&
          value !== null &&
          !Array.isArray(value)
        ) {
          findFields(value, key);
        }
      }
    };

    findFields(payload);
    return result;
  }

  /**
   * Extract device ID from topic
   */
  private extractDeviceIdFromTopic(topic: string): string {
    const parts = topic.split('/');
    if (parts.length >= 2) {
      return parts[1]; // devices/{deviceId}/telemetry
    }
    return 'unknown';
  }

  async stop(): Promise<void> {
    if (this.client) {
      await this.client.end();
      console.log('✅ MQTT Adapter stopped');
    }
  }

  async sendCommand(deviceId: string, command: any): Promise<void> {
    if (!this.client || !this.isConnected) {
      throw new Error('MQTT client not connected');
    }

    const topic = `devices/${deviceId}/commands`;

    return new Promise((resolve, reject) => {
      this.client!.publish(
        topic,
        JSON.stringify(command),
        { qos: 1 },
        (err) => {
          if (err) reject(err);
          else resolve();
        },
      );
    });
  }
}
