// src/modules/protocols/device-listener.service.ts
import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Device } from '@modules/devices/entities/device.entity';
import { DeviceConnectionType, DeviceStatus, DeviceType } from '@common/enums/index.enum';
import { StandardTelemetry } from '@common/interfaces/standard-telemetry.interface';
import { CodecRegistryService } from '@modules/devices/codecs/codec-registry.service';
import { KafkaService } from '@/lib/kafka/kafka.service';

@Injectable()
export class DeviceListenerService {
  private readonly logger = new Logger(DeviceListenerService.name);

  constructor(
    @InjectRepository(Device)
    private deviceRepository: Repository<Device>,
    private codecRegistry: CodecRegistryService,
    private kafkaService: KafkaService,  // ← Publish to Kafka
  ) { }

  /**
   * UNIFIED ENTRY POINT
   * Called by ALL protocol adapters (MQTT, HTTP, CoAP, etc.)
   */
  async handleTelemetry(standardTelemetry: StandardTelemetry): Promise<void> {
    try {
      this.logger.log(`📡 Telemetry from ${standardTelemetry.protocol.toUpperCase()}`);
      this.logger.log(`📱 Device: ${standardTelemetry.deviceKey}`);

      // 1. Find or auto-register device
      let device = await this.deviceRepository.findOne({
        where: { deviceKey: standardTelemetry.deviceKey },
      });

      if (!device) {
        if (process.env.AUTO_REGISTER_DEVICES === 'true') {
          device = await this.autoRegisterDevice(standardTelemetry);
        } else {
          this.logger.warn(`Device not found: ${standardTelemetry.deviceKey}`);
          return;
        }
      }

      // 2. Decode payload if needed (using codec)
      let decodedData = standardTelemetry.data;

      if (device.metadata?.codecId || device.metadata?.manufacturer) {
        decodedData = this.codecRegistry.decode(
          standardTelemetry.data,
          {
            codecId: device.metadata?.codecId,
            manufacturer: device.metadata?.manufacturer,
            model: device.metadata?.model,
            fPort: standardTelemetry.metadata?.fPort,
          },
        );
        this.logger.log(`✅ Payload decoded`);
      }

      // 3. Merge decoded data
      const finalData = {
        ...decodedData,
        temperature: decodedData.temperature ?? standardTelemetry.temperature,
        humidity: decodedData.humidity ?? standardTelemetry.humidity,
        pressure: decodedData.pressure ?? standardTelemetry.pressure,
        batteryLevel: decodedData.batteryLevel ?? standardTelemetry.batteryLevel,
      };

      // 4. Update device status
      device.lastSeenAt = new Date();
      device.lastActivityAt = new Date();
      device.messageCount = (device.messageCount || 0) + 1;

      if (device.status === DeviceStatus.INACTIVE) {
        device.status = DeviceStatus.ACTIVE;
        device.activatedAt = new Date();
      }

      await this.deviceRepository.save(device);

      // 5. Publish to Kafka (TelemetryConsumer will pick it up)
      await this.kafkaService.sendMessage(
        'telemetry.device.raw',
        {
          deviceId: device.id,
          deviceKey: device.deviceKey,
          tenantId: device.tenantId,
          customerId: device.customerId,
          data: finalData,
          timestamp: standardTelemetry.timestamp,
          receivedAt: standardTelemetry.receivedAt,
          protocol: standardTelemetry.protocol,
          metadata: standardTelemetry.metadata,
        },
        device.deviceKey,
      );

      this.logger.log(`✅ Published to Kafka`);
    } catch (error: any) {
      this.logger.error('❌ Error handling telemetry:', error);
    }
  }

  private async autoRegisterDevice(telemetry: StandardTelemetry): Promise<Device> {
    const device = this.deviceRepository.create({
      deviceKey: telemetry.deviceKey,
      name: `${telemetry.protocol.toUpperCase()} ${telemetry.deviceKey}`,
      type: DeviceType.SENSOR,
      status: DeviceStatus.ACTIVE,
      connectionType: this.mapProtocolToConnection(telemetry.protocol),
      userId: 'system',
      tenantId: telemetry.tenantId || 'default',
      messageCount: 0,
      errorCount: 0,
      lastSeenAt: new Date(),
      lastActivityAt: new Date(),
      activatedAt: new Date(),
      metadata: {
        autoRegistered: true,
        protocol: telemetry.protocol,
        firstSeenAt: new Date().toISOString(),
      },
    });

    const saved: any = await this.deviceRepository.save(device);
    this.logger.log(`✅ Device auto-registered: ${saved.id}`);
    return saved;
  }

  private mapProtocolToConnection(protocol: string): DeviceConnectionType {
    switch (protocol) {
      case 'mqtt': return DeviceConnectionType.WIFI;
      case 'http': return DeviceConnectionType.WIFI;
      case 'lorawan': return DeviceConnectionType.LORA;
      case 'zigbee': return DeviceConnectionType.ZIGBEE;
      case 'bluetooth': return DeviceConnectionType.BLUETOOTH;
      case 'modbus': return DeviceConnectionType.ETHERNET;
      default: return DeviceConnectionType.WIFI;
    }
  }
}