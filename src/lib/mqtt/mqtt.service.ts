// src/lib/mqtt/mqtt.service.ts
import * as mqtt from 'mqtt';
import { kafkaService } from '../kafka/kafka.service';

class MQTTService {
  private client: mqtt.MqttClient | null = null;
  private isConnected = false;

  /**
   * Connect to MQTT broker
   */
  async connect(): Promise<void> {
    try {
      this.client = mqtt.connect(process.env.MQTT_BROKER as string, {
        clientId: process.env.MQTT_CLIENT_ID,
        username: process.env.MQTT_USERNAME,
        password: process.env.MQTT_PASSWORD,
        clean: true,
        reconnectPeriod: 5000,
      });

      this.client.on('connect', () => {
        console.log('✅ MQTT Broker connected');
        this.isConnected = true;
        this.subscribeToTopics();
      });

      this.client.on('error', (error) => {
        console.error('❌ MQTT Error:', error);
        this.isConnected = false;
      });

      this.client.on('message', async (topic, message) => {
        await this.handleMessage(topic, message);
      });

      this.client.on('close', () => {
        console.log('⚠️  MQTT connection closed');
        this.isConnected = false;
      });
    } catch (error) {
      console.error('❌ Failed to connect to MQTT:', error);
      throw error;
    }
  }

  /**
   * Subscribe to device topics
   */
  private subscribeToTopics(): void {
    const topics = [
      process.env.MQTT_TOPIC_TELEMETRY,
      process.env.MQTT_TOPIC_COMMANDS,
      process.env.MQTT_TOPIC_STATUS,
      process.env.MQTT_TOPIC_ALERTS,
    ];

    topics.forEach((topic) => {
      this.client?.subscribe(topic as any, (err) => {
        if (err) {
          console.error(`❌ Failed to subscribe to ${topic}:`, err);
        } else {
          console.log(`✅ Subscribed to MQTT topic: ${topic}`);
        }
      });
    });
  }

  /**
   * Handle incoming MQTT messages
   */
  private async handleMessage(topic: string, message: Buffer): Promise<void> {
    try {
      console.log(`📨 MQTT message received on ${topic}`);

      const payload = JSON.parse(message.toString());
      console.log('📦 Payload:', payload);

      // Extract device ID from topic
      // Example: lorawan/ws202-001/data → deviceId: ws202-001
      const deviceId = this.extractDeviceId(topic);

      // Parse based on topic pattern
      let telemetryData: any;
      if (topic.startsWith('lorawan/')) {
        telemetryData = this.parseLoRaWANPayload(payload, deviceId);
      } else if (topic.startsWith('devices/')) {
        telemetryData = payload; // Already in correct format
      }

      // Publish to Kafka (same flow as HTTP!)
      await kafkaService.sendMessage(
        'telemetry.device.raw',
        {
          deviceId: deviceId,
          deviceKey: deviceId,
          tenantId: 'default',
          ...telemetryData,
          receivedAt: Date.now(),
          source: 'mqtt',
          topic: topic,
        },
        deviceId,
      );

      console.log(`✅ MQTT message forwarded to Kafka for device: ${deviceId}`);
    } catch (error: any) {
      console.error('❌ Failed to handle MQTT message:', error);
    }
  }

  /**
   * Extract device ID from topic
   */
  private extractDeviceId(topic: string): string {
    // lorawan/ws202-001/data → ws202-001
    const parts = topic.split('/');
    return parts[1] || 'unknown';
  }

  /**
   * Parse LoRaWAN payload
   */
  private parseLoRaWANPayload(payload: any, deviceId: string): any {
    // Decode hex data
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
          case 0x67:
            result.temperature = (value / 10).toFixed(1);
            break;
          case 0x68:
            result.humidity = (value / 2).toFixed(1);
            break;
          case 0x75:
            result.battery = value;
            break;
        }

        offset += 4;
      }

      return result;
    } catch (error) {
      console.error('Failed to decode WS202 data:', error);
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
          console.error(`❌ Failed to publish to ${topic}:`, err);
          reject(err);
        } else {
          console.log(`📤 Published to MQTT topic: ${topic}`);
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
      console.log('✅ MQTT disconnected');
    }
  }
}

export const mqttService = new MQTTService();
