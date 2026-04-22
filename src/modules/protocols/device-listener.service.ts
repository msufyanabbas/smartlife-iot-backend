import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Device } from '@modules/devices/entities/device.entity';
import { DeviceProtocol } from '@modules/devices/entities/device.entity';
import { DeviceConnectionType, DeviceStatus, DeviceType } from '@common/enums/index.enum';
import { StandardTelemetry } from '@common/interfaces/standard-telemetry.interface';
import { CodecRegistryService } from '@modules/devices/codecs/codec-registry.service';
import { KafkaService } from '@/lib/kafka/kafka.service';

@Injectable()
export class DeviceListenerService {
  private readonly logger = new Logger(DeviceListenerService.name);

  constructor(
    @InjectRepository(Device)
    private readonly deviceRepository: Repository<Device>,
    private readonly codecRegistry: CodecRegistryService,
    private readonly kafkaService: KafkaService,
  ) {}

  // ── Unified entry point ───────────────────────────────────────────────────
  // Called by ALL protocol paths:
  //   - lib/mqtt/MQTTService  (MQTT uplinks from EMQX)
  //   - HTTPAdapter           (REST ingestion endpoint)
  //   - CoAPAdapter           (CoAP uplinks)
  //   - ModbusAdapter         (polled Modbus registers)
  //   - BLEAdapter            (BLE advertisements)
  //   - ZigbeeAdapter         (Zigbee messages)
  //
  // Responsibilities:
  //   1. Find or auto-register the device
  //   2. Decode payload via CodecRegistryService
  //   3. Update device.lastSeenAt / messageCount / status
  //   4. Publish decoded telemetry to Kafka → TelemetryConsumer picks it up

  async handleTelemetry(standardTelemetry: StandardTelemetry): Promise<void> {
    try {
      this.logger.log(
        `Telemetry from ${standardTelemetry.protocol.toUpperCase()} — device: ${standardTelemetry.deviceKey}`,
      );

      // ── 1. Find or auto-register device ───────────────────────────────────
      let device = await this.deviceRepository.findOne({
        where: { deviceKey: standardTelemetry.deviceKey },
      });

      if (!device) {
        if (process.env.AUTO_REGISTER_DEVICES === 'true') {
          device = await this.autoRegisterDevice(standardTelemetry);
        } else {
          this.logger.warn(`Device not found and auto-register is off: ${standardTelemetry.deviceKey}`);
          return;
        }
      }

      // ── 2. Decode payload ─────────────────────────────────────────────────
      // Use metadata from StandardTelemetry (set by MQTTService / HTTPAdapter).
      // CodecRegistryService handles: JSON pass-through, hex decode, auto-detect.
     const codecMeta = {
      // Priority: message metadata → device metadata
      codecId:      standardTelemetry.metadata?.codecId      as string | undefined
                    ?? device.metadata?.codecId              as string | undefined,
      manufacturer: standardTelemetry.metadata?.manufacturer as string | undefined
                    ?? device.metadata?.manufacturer         as string | undefined
                    ?? device.manufacturer,   // ← dedicated column (new)
      model:        standardTelemetry.metadata?.model        as string | undefined
                    ?? device.metadata?.model                as string | undefined
                    ?? device.model,          // ← dedicated column (new)
      fPort:        standardTelemetry.metadata?.fPort        as number | undefined,
    };

      this.logger.log(`standardTelemetry.data type: ${typeof standardTelemetry.data}, value: ${JSON.stringify(standardTelemetry.data).substring(0, 200)}`);
const decodedData = this.codecRegistry.decode(standardTelemetry.data, codecMeta);

      // Merge decoded fields with any top-level fields from StandardTelemetry
    const finalData: Record<string, any> = {
      // ① Everything the codec decoded (device-specific + standard fields)
      ...decodedData,
      // ② Standard fields from StandardTelemetry override only if defined
      ...(standardTelemetry.temperature  !== undefined && { temperature:   standardTelemetry.temperature  }),
      ...(standardTelemetry.humidity     !== undefined && { humidity:      standardTelemetry.humidity     }),
      ...(standardTelemetry.pressure     !== undefined && { pressure:      standardTelemetry.pressure     }),
      ...(standardTelemetry.batteryLevel !== undefined && { batteryLevel:  standardTelemetry.batteryLevel }),
      ...(standardTelemetry.signalStrength !== undefined && { signalStrength: standardTelemetry.signalStrength }),
    };

      // ── 3. Update device activity ──────────────────────────────────────────
      await this.deviceRepository.update(
        { id: device.id },
        {
          lastSeenAt: new Date(),
          lastActivityAt: new Date(),
          messageCount: () => '"messageCount" + 1',
          status: device.status === DeviceStatus.INACTIVE
            ? DeviceStatus.ACTIVE
            : device.status,
          activatedAt: device.activatedAt ?? (
            device.status === DeviceStatus.INACTIVE ? new Date() : undefined
          ),
        },
      );

      this.logger.log(`finalData: ${JSON.stringify(finalData)}`);

      // ── 4. Publish to Kafka ────────────────────────────────────────────────
      // TelemetryConsumer subscribes to 'telemetry.device.raw' and persists
      // the record to the database, then publishes to WebSocket subscribers.
      await this.kafkaService.sendMessage(
        'telemetry.device.raw',
        {
          deviceId: device.id,
          deviceKey: device.deviceKey,
          tenantId: device.tenantId,
          customerId: device.customerId ?? null,
          protocol: standardTelemetry.protocol,
          data: finalData,
          timestamp: standardTelemetry.timestamp,
          receivedAt: standardTelemetry.receivedAt,
          metadata: standardTelemetry.metadata,
        },
        device.deviceKey, // partition key — all messages from one device → same partition
      );

      this.logger.log(`Published to Kafka — device: ${device.deviceKey}`);
    } catch (error) {
      this.logger.error(
        `Error handling telemetry for ${standardTelemetry.deviceKey}: ${(error as Error).message}`,
      );
    }
  }

  // ── Auto-register ─────────────────────────────────────────────────────────
  // Creates a minimal device record when AUTO_REGISTER_DEVICES=true.
  // The device gets no userId / tenantId from a real user — instead we use a
  // well-known system tenant. In production, set AUTO_REGISTER_DEVICES=false
  // and provision devices through the API.

  private async autoRegisterDevice(telemetry: StandardTelemetry): Promise<Device> {
    const systemTenantId = process.env.SYSTEM_TENANT_ID;

    if (!systemTenantId) {
      throw new Error(
        'AUTO_REGISTER_DEVICES is true but SYSTEM_TENANT_ID is not set. ' +
        'Set SYSTEM_TENANT_ID to the tenant that should own auto-registered devices.',
      );
    }

    const device = this.deviceRepository.create({
      deviceKey: telemetry.deviceKey,
      name: `${telemetry.protocol.toUpperCase()} ${telemetry.deviceKey}`,
      type: DeviceType.SENSOR,
      status: DeviceStatus.ACTIVE,
      connectionType: this.mapProtocolToConnectionType(telemetry.protocol),
      protocol: this.mapProtocolStringToEnum(telemetry.protocol),
      // userId is required by the FK — use a system service account user ID.
      // Set SYSTEM_USER_ID to the UUID of a dedicated "system" user in your DB.
      userId: process.env.SYSTEM_USER_ID ?? systemTenantId,
      tenantId: telemetry.tenantId ?? systemTenantId,
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

    const saved = await this.deviceRepository.save(device);
    this.logger.log(`Auto-registered device: ${saved.deviceKey} (${saved.id})`);
    return saved;
  }

  private mapProtocolToConnectionType(protocol: string): DeviceConnectionType {
    const map: Record<string, DeviceConnectionType> = {
      mqtt: DeviceConnectionType.WIFI,
      http: DeviceConnectionType.WIFI,
      lorawan: DeviceConnectionType.LORA,
      zigbee: DeviceConnectionType.ZIGBEE,
      bluetooth: DeviceConnectionType.BLUETOOTH,
      ble: DeviceConnectionType.BLUETOOTH,
      modbus: DeviceConnectionType.ETHERNET,
      coap: DeviceConnectionType.WIFI,
    };
    return map[protocol] ?? DeviceConnectionType.WIFI;
  }

  private mapProtocolStringToEnum(protocol: string): DeviceProtocol {
    const map: Record<string, DeviceProtocol> = {
      mqtt: DeviceProtocol.GENERIC_MQTT,
      http: DeviceProtocol.HTTP,
      coap: DeviceProtocol.COAP,
      lorawan: DeviceProtocol.LORAWAN_MILESIGHT, // default LoRaWAN to Milesight
    };
    return map[protocol] ?? DeviceProtocol.GENERIC_MQTT;
  }
}