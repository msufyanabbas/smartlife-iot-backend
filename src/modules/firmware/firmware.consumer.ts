import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Firmware } from './entities/firmware.entity';
import { Device } from '@modules/devices/entities/device.entity';
import { FirmwareUpdateStatus } from '@common/enums/index.enum';
import { KafkaService } from '@/lib/kafka/kafka.service';
import { MQTTService } from '@/lib/mqtt/mqtt.service';
import { FIRMWARE_UPDATE_TOPIC } from './firmware.service';

const CHUNK_SIZE = 16384; // 16 KiB — device-side download chunking hint

@Injectable()
export class FirmwareConsumer implements OnModuleInit {
  private readonly logger = new Logger(FirmwareConsumer.name);

  constructor(
    private readonly kafka: KafkaService,
    private readonly mqtt: MQTTService,
    @InjectRepository(Firmware)
    private readonly firmwareRepo: Repository<Firmware>,
    @InjectRepository(Device)
    private readonly deviceRepo: Repository<Device>,
  ) {}

  async onModuleInit(): Promise<void> {
    this.logger.log('Starting firmware update consumer...');

    try {
      await this.kafka.createConsumer(
        'firmware-update-group',
        [FIRMWARE_UPDATE_TOPIC],
        this.handleMessage.bind(this),
      );
      this.logger.log(
        `Firmware consumer subscribed to ${FIRMWARE_UPDATE_TOPIC}`,
      );
    } catch (error) {
      this.logger.error(
        `Failed to start firmware consumer: ${(error as Error).message}`,
      );
    }
  }

  private async handleMessage({ message }: any): Promise<void> {
    try {
      const payload = JSON.parse(message.value.toString());
      const { deviceId, firmwareId, version, downloadUrl } = payload;

      if (!deviceId || !firmwareId) {
        this.logger.warn(
          'firmware.update message missing deviceId/firmwareId — skipping',
        );
        return;
      }

      const device = await this.deviceRepo.findOne({ where: { id: deviceId } });
      if (!device) {
        this.logger.error(`firmware.update: device ${deviceId} not found`);
        return;
      }

      const firmware = await this.firmwareRepo.findOne({
        where: { id: firmwareId },
      });
      if (!firmware) {
        this.logger.error(`firmware.update: firmware ${firmwareId} not found`);
        return;
      }

      // ── Push the update notification to the device over MQTT ────────────────
      const totalChunks = Math.ceil(firmware.size / CHUNK_SIZE);
      const topic = `v1/${device.deviceKey}/fw/update`;
      const fwMessage = {
        version: version ?? firmware.version,
        size: firmware.size,
        checksum: firmware.checksum,
        checksumAlgorithm: firmware.checksumAlgorithm,
        chunkSize: CHUNK_SIZE,
        totalChunks,
        downloadUrl,
      };

      try {
        await this.mqtt.publish(topic, fwMessage);
        this.logger.log(
          `Pushed firmware v${fwMessage.version} to ${device.deviceKey} via MQTT ${topic} ` +
            `(${firmware.size} bytes, ${totalChunks} chunks)`,
        );
      } catch (mqttError) {
        // MQTT may be down (e.g. broker unreachable) — record the attempt but
        // still mark PUSHING so the device can pick it up via HTTP/CoAP polling.
        this.logger.warn(
          `MQTT push to ${device.deviceKey} failed (${(mqttError as Error).message}); ` +
            `device can still poll /ota/${device.deviceKey}`,
        );
      }

      // ── Mark the device as PUSHING ──────────────────────────────────────────
      device.firmwareUpdateStatus = FirmwareUpdateStatus.PUSHING;
      device.firmwareUpdateStartedAt = new Date();
      device.firmwareUpdateProgress = 0;
      await this.deviceRepo.save(device);
    } catch (error) {
      this.logger.error(
        `Error processing firmware.update message: ${(error as Error).message}`,
      );
    }
  }
}
