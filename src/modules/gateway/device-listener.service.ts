// src/modules/gateway/device-listener.service.ts
// UPDATED WITH CODEC SUPPORT

import { Injectable, Logger } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import {
  Device,
  DeviceStatus,
  DeviceType,
  DeviceConnectionType,
} from '../devices/entities/device.entity';
import { WebsocketGateway } from '../websocket/websocket.gateway';
import { StandardTelemetry } from '@/common/interfaces/standard-telemetry.interface';
import { TelemetryService } from '../telemetry/telemetry.service';
import { CodecRegistryService } from '../devices/codecs/codec-registry.service';

export interface DeviceMessage {
  deviceKey: string;
  timestamp: Date;
  data: Record<string, any>;
  messageType:
    | 'telemetry'
    | 'attributes'
    | 'rpc_request'
    | 'rpc_response'
    | 'status'
    | 'alerts';
}

@Injectable()
export class DeviceListenerService {
  private readonly logger = new Logger(DeviceListenerService.name);

  constructor(
    @InjectRepository(Device)
    private deviceRepository: Repository<Device>,
    private websocketGateway: WebsocketGateway,
    private eventEmitter: EventEmitter2,
    private telemetryService: TelemetryService,
    private codecRegistry: CodecRegistryService, // 🆕 INJECT CODEC REGISTRY
  ) {}

  // ============================================
  // NEW METHOD - Called by Protocol Adapters
  // ============================================

  /**
   * Handle telemetry from protocol adapters (MQTT/HTTP/CoAP)
   * This is the UNIFIED entry point
   */
  async handleTelemetry(standardTelemetry: StandardTelemetry): Promise<void> {
    try {
      this.logger.log(`\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
      this.logger.log(`📡 PROTOCOL ADAPTER → Device Listener`);
      this.logger.log(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
      this.logger.log(
        `🔌 Protocol: ${standardTelemetry.protocol.toUpperCase()}`,
      );
      this.logger.log(`📱 Device Key: ${standardTelemetry.deviceKey}`);
      
      // 🆕 DECODE PAYLOAD IF NEEDED
      const device = await this.deviceRepository.findOne({
        where: { deviceKey: standardTelemetry.deviceKey },
      });
      
      let decodedData = standardTelemetry.data;
      
      // If device has codec metadata, use it for decoding
      if (device?.metadata?.codecId || device?.metadata?.manufacturer) {
        this.logger.log(`🔧 Attempting to decode payload...`);
        
        decodedData = this.codecRegistry.decode(
          standardTelemetry.data,
          {
            codecId: device.metadata?.codecId,
            manufacturer: device.metadata?.manufacturer,
            model: device.metadata?.model,
            fPort: standardTelemetry.metadata?.fPort,
            devEUI: device.metadata?.devEUI,
            gatewayType: device.metadata?.gatewayType,
          },
        );
        
        this.logger.log(`✅ Payload decoded successfully!`);
        this.logger.log(`📦 Decoded Keys: ${Object.keys(decodedData).join(', ')}`);
      }
      
      // Merge decoded data with standard telemetry
      const finalData = {
        ...decodedData,
        temperature: decodedData.temperature ?? standardTelemetry.temperature,
        humidity: decodedData.humidity ?? standardTelemetry.humidity,
        pressure: decodedData.pressure ?? standardTelemetry.pressure,
        latitude: decodedData.latitude ?? standardTelemetry.latitude,
        longitude: decodedData.longitude ?? standardTelemetry.longitude,
        batteryLevel: decodedData.batteryLevel ?? standardTelemetry.batteryLevel,
        signalStrength: decodedData.signalStrength ?? standardTelemetry.signalStrength,
      };
      
      if (finalData.temperature)
        this.logger.log(`🌡️  Temperature: ${finalData.temperature}°C`);
      if (finalData.humidity)
        this.logger.log(`💧 Humidity: ${finalData.humidity}%`);
      this.logger.log(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n`);

      // Convert StandardTelemetry to DeviceMessage format
      const deviceMessage: DeviceMessage = {
        messageType: 'telemetry',
        deviceKey: standardTelemetry.deviceKey,
        timestamp: new Date(standardTelemetry.timestamp),
        data: {
          ts: standardTelemetry.receivedAt || Date.now(),
          values: finalData,
          protocol: standardTelemetry.protocol,
          metadata: standardTelemetry.metadata,
        },
      };

      // Emit event
      this.logger.log(`📤 Emitting event: device.telemetry`);
      this.eventEmitter.emit('device.telemetry', deviceMessage);
      this.logger.log(`✅ Event emitted successfully\n`);
    } catch (error) {
      this.logger.error('❌ Error in protocol adapter handler:', error);
      if (error instanceof Error) {
        this.logger.error(error.stack);
      }
    }
  }

  // ============================================
  // EVENT HANDLER - Processes Telemetry
  // ============================================

  @OnEvent('device.telemetry')
  async handleTelemetryEvent(message: DeviceMessage): Promise<void> {
    try {
      this.logger.log(
        `\n🔄 Processing telemetry from device: ${message.deviceKey}`,
      );

      // Find or auto-register device
      let device = await this.deviceRepository.findOne({
        where: { deviceKey: message.deviceKey },
      });

      if (!device) {
        if (process.env.AUTO_REGISTER_DEVICES === 'true') {
          this.logger.log(
            `📝 Auto-registering new device: ${message.deviceKey}`,
          );
          device = await this.autoRegisterDevice(message);
        } else {
          this.logger.warn(`❌ Device not found: ${message.deviceKey}`);
          this.logger.warn(
            `💡 Set AUTO_REGISTER_DEVICES=true in .env to auto-register`,
          );
          return;
        }
      }

      this.logger.log(`✅ Found device: ${device.name} (ID: ${device.id})`);

      // Update device status
      device.lastSeenAt = new Date();
      device.lastActivityAt = new Date();
      device.messageCount = (device.messageCount || 0) + 1;

      if (device.status === DeviceStatus.INACTIVE) {
        device.status = DeviceStatus.ACTIVE;
        device.activatedAt = new Date();
        this.logger.log(`🟢 Device ${device.name} activated`);
      }

      await this.deviceRepository.save(device);

      // Extract telemetry data
      const telemetryData = message.data.values || message.data;

      // Create telemetry DTO
      const telemetryDto = {
        data: telemetryData,
        temperature: telemetryData.temperature,
        humidity: telemetryData.humidity,
        pressure: telemetryData.pressure,
        latitude: telemetryData.latitude,
        longitude: telemetryData.longitude,
        batteryLevel: telemetryData.batteryLevel,
        signalStrength: telemetryData.signalStrength,
        metadata: message.data.metadata,
        timestamp: message.data.ts
          ? new Date(message.data.ts)
          : message.timestamp,
      };

      this.logger.log(`💾 Saving telemetry (Kafka + Redis + PostgreSQL)...`);
      await this.telemetryService.create(device.deviceKey, telemetryDto as any);
      this.logger.log(`✅ Telemetry saved successfully!`);

      // Prepare broadcast data
      const broadcastData = {
        deviceId: device.id,
        deviceKey: device.deviceKey,
        deviceName: device.name,
        timestamp: message.timestamp,
        data: telemetryData,
        temperature: telemetryData.temperature,
        humidity: telemetryData.humidity,
        pressure: telemetryData.pressure,
        batteryLevel: telemetryData.batteryLevel,
      };

      // Broadcast via WebSocket
      this.websocketGateway.broadcastDeviceTelemetry(device.id, broadcastData);

      if (device.userId) {
        this.websocketGateway.sendToUser(
          device.userId,
          'device:telemetry',
          broadcastData,
        );
      }

      this.logger.log(`📡 WebSocket broadcast sent\n`);
    } catch (error) {
      this.logger.error('❌ Error handling telemetry:', error);
      if (error instanceof Error) {
        this.logger.error(error.stack);
      }
    }
  }

  // ============================================
  // AUTO-REGISTRATION (FIXED)
  // ============================================

  private async autoRegisterDevice(message: DeviceMessage): Promise<Device> {
    try {
      const protocol = message.data.protocol || 'unknown';
      const detectedType = this.detectDeviceType(message.data);

      const device = this.deviceRepository.create({
        deviceKey: message.deviceKey,
        name: `${detectedType} ${message.deviceKey}`,
        type: this.mapToDeviceType(detectedType),
        status: DeviceStatus.ACTIVE,
        connectionType: this.mapProtocolToConnectionType(protocol),

        // Required fields
        userId: 'system',
        tenantId: 'default',

        // Optional fields
        description: `Auto-registered device via ${protocol}`,
        messageCount: 0,
        errorCount: 0,

        // Timestamps
        lastSeenAt: new Date(),
        lastActivityAt: new Date(),
        activatedAt: new Date(),

        // Metadata
        metadata: {
          autoRegistered: true,
          firstSeenAt: new Date().toISOString(),
          protocol: protocol,
          detectedType: detectedType,
          ...message.data.metadata,
        },
      });

      const saved = await this.deviceRepository.save(device);
      this.logger.log(`✅ Device auto-registered: ${saved.id}`);

      this.eventEmitter.emit('device.created', {
        deviceId: saved.id,
        deviceKey: saved.deviceKey,
        autoRegistered: true,
      });

      return saved;
    } catch (error) {
      this.logger.error('Failed to auto-register device:', error);
      throw error;
    }
  }

  private detectDeviceType(data: any): string {
    const values = data.values || data;

    const hasTemp = values.temperature !== undefined;
    const hasHumidity = values.humidity !== undefined;
    const hasPressure = values.pressure !== undefined;
    const hasMotion = values.motion !== undefined;
    const hasGPS = values.latitude !== undefined;

    if (hasTemp && hasHumidity && hasPressure) return 'Environmental Sensor';
    if (hasTemp && hasHumidity) return 'Temperature & Humidity Sensor';
    if (hasTemp) return 'Temperature Sensor';
    if (hasMotion) return 'Motion Sensor';
    if (hasGPS) return 'GPS Tracker';
    if (hasPressure) return 'Pressure Sensor';

    return 'Generic IoT Device';
  }

  private mapToDeviceType(detectedType: string): DeviceType {
    if (detectedType.includes('Sensor')) return DeviceType.SENSOR;
    if (detectedType.includes('Tracker')) return DeviceType.TRACKER;
    if (detectedType.includes('Camera')) return DeviceType.CAMERA;
    if (detectedType.includes('Gateway')) return DeviceType.GATEWAY;
    return DeviceType.SENSOR;
  }

  private mapProtocolToConnectionType(protocol: string): DeviceConnectionType {
    switch (protocol.toLowerCase()) {
      case 'mqtt':
      case 'http':
        return DeviceConnectionType.WIFI;
      case 'lorawan':
      case 'lora':
        return DeviceConnectionType.LORA;
      case 'zigbee':
        return DeviceConnectionType.ZIGBEE;
      case 'bluetooth':
        return DeviceConnectionType.BLUETOOTH;
      default:
        return DeviceConnectionType.WIFI;
    }
  }

  // ============================================
  // OTHER EVENT HANDLERS
  // ============================================

  @OnEvent('device.status')
  async handleStatus(message: DeviceMessage): Promise<void> {
    try {
      this.logger.log(`Processing status from device: ${message.deviceKey}`);

      const device = await this.deviceRepository.findOne({
        where: { deviceKey: message.deviceKey },
      });

      if (!device) return;

      const statusData = message.data;

      if (statusData.status) device.status = statusData.status;
      if (statusData.firmwareVersion)
        device.firmwareVersion = statusData.firmwareVersion;
      if (statusData.ipAddress) device.ipAddress = statusData.ipAddress;

      device.lastSeenAt = new Date();
      await this.deviceRepository.save(device);

      this.websocketGateway.broadcastDeviceStatus(device.id, {
        deviceId: device.id,
        deviceKey: device.deviceKey,
        status: device.status,
        lastSeenAt: device.lastSeenAt,
        isOnline: device.isOnline(),
      });
    } catch (error) {
      this.logger.error('Error handling status:', error);
    }
  }

  @OnEvent('device.alerts')
  async handleAlert(message: DeviceMessage): Promise<void> {
    try {
      this.logger.log(`Processing alert from device: ${message.deviceKey}`);

      const device = await this.deviceRepository.findOne({
        where: { deviceKey: message.deviceKey },
      });

      if (!device) return;

      const alert = {
        deviceId: device.id,
        deviceKey: device.deviceKey,
        deviceName: device.name,
        timestamp: message.timestamp,
        severity: message.data.severity || 'warning',
        message: message.data.message,
        type: message.data.type,
        data: message.data,
      };

      this.websocketGateway.broadcastAlert(alert);

      if (device.userId) {
        this.websocketGateway.sendToUser(device.userId, 'device:alert', alert);
      }

      this.logger.warn(
        `⚠️  Alert from ${device.name}: ${message.data.message}`,
      );
    } catch (error) {
      this.logger.error('Error handling alert:', error);
    }
  }

  @OnEvent('device.rpc_request')
  async handleRpcRequest(message: DeviceMessage): Promise<void> {
    try {
      this.logger.log(`RPC request from device: ${message.deviceKey}`);

      const device = await this.deviceRepository.findOne({
        where: { deviceKey: message.deviceKey },
      });

      if (!device || !device.userId) return;

      this.websocketGateway.sendToUser(device.userId, 'device:rpc_request', {
        deviceId: device.id,
        requestId: message.data.id,
        method: message.data.method,
        params: message.data.params,
      });
    } catch (error) {
      this.logger.error('Error handling RPC request:', error);
    }
  }
}