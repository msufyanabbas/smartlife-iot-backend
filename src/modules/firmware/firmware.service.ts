import {
  Injectable,
  Logger,
  NotFoundException,
  BadRequestException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import type { File as MulterFile } from 'multer';
import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import { Firmware } from './entities/firmware.entity';
import { Device } from '@modules/devices/entities/device.entity';
import {
  FirmwareTargetType,
  FirmwareUpdateStatus,
} from '@common/enums/index.enum';
import { KafkaService } from '@/lib/kafka/kafka.service';
import { CreateFirmwareDto } from './dto/create-firmware.dto';
import { AssignFirmwareDto } from './dto/assign-firmware.dto';
import { OtaStatusDto } from './dto/ota-status.dto';
import { PaginationDto, PaginatedResponseDto } from '@common/dto/pagination.dto';

export const FIRMWARE_UPDATE_TOPIC = 'firmware.update';
export const FIRMWARE_STATUS_TOPIC = 'firmware.status';

@Injectable()
export class FirmwareService {
  private readonly logger = new Logger(FirmwareService.name);
  private readonly storageDir =
    process.env.FIRMWARE_STORAGE_DIR ||
    path.join(process.cwd(), 'uploads', 'firmware');

  constructor(
    @InjectRepository(Firmware)
    private readonly firmwareRepo: Repository<Firmware>,
    @InjectRepository(Device)
    private readonly deviceRepo: Repository<Device>,
    private readonly kafka: KafkaService,
  ) {
    fs.mkdirSync(this.storageDir, { recursive: true });
  }

  // ── Upload / CRUD ───────────────────────────────────────────────────────────

  async create(
    userId: string,
    tenantId: string | undefined,
    customerId: string | null,
    dto: CreateFirmwareDto,
    file: MulterFile,
  ): Promise<Firmware> {
    if (!file || !file.buffer || file.size === 0) {
      throw new BadRequestException('Firmware binary file is required');
    }

    const checksum = crypto
      .createHash('sha256')
      .update(file.buffer)
      .digest('hex');
    const storedName = `${crypto.randomUUID()}.bin`;
    const storagePath = path.join(this.storageDir, storedName);
    await fs.promises.writeFile(storagePath, file.buffer);

    const firmware = this.firmwareRepo.create({
      tenantId,
      customerId: customerId ?? undefined,
      deviceProfileId: dto.deviceProfileId,
      version: dto.version,
      title: dto.title,
      description: dto.description,
      fileName: file.originalname,
      storagePath,
      size: file.size,
      checksum,
      checksumAlgorithm: 'sha256',
      contentType: file.mimetype || 'application/octet-stream',
      isActive: true,
      createdBy: userId,
    });

    const saved = await this.firmwareRepo.save(firmware);
    this.logger.log(
      `Firmware uploaded: ${saved.id} v${saved.version} (${saved.size} bytes, sha256=${checksum.slice(0, 12)}…)`,
    );
    return saved;
  }

  async findAll(tenantId: string | undefined, pagination: PaginationDto) {
    const {
      page = 1,
      limit = 10,
      search,
      sortBy = 'createdAt',
      sortOrder = 'DESC',
    } = pagination;
    const qb = this.firmwareRepo
      .createQueryBuilder('fw')
      .where('fw.tenantId = :tenantId', { tenantId });

    if (search) {
      qb.andWhere('(fw.title ILIKE :s OR fw.version ILIKE :s)', {
        s: `%${search}%`,
      });
    }

    qb.orderBy(`fw.${sortBy}`, sortOrder as 'ASC' | 'DESC')
      .skip((page - 1) * limit)
      .take(limit);

    const [data, total] = await qb.getManyAndCount();
    return PaginatedResponseDto.create(data, page, limit, total);
  }

  async findOne(id: string, tenantId: string | undefined): Promise<Firmware> {
    const fw = await this.firmwareRepo.findOne({ where: { id, tenantId } });
    if (!fw) throw new NotFoundException('Firmware not found');
    return fw;
  }

  async remove(id: string, tenantId: string | undefined): Promise<void> {
    const fw = await this.findOne(id, tenantId);
    await fs.promises
      .unlink(fw.storagePath)
      .catch((err) =>
        this.logger.warn(
          `Could not delete firmware file ${fw.storagePath}: ${err.message}`,
        ),
      );
    await this.firmwareRepo.softRemove(fw);
    this.logger.log(`Firmware removed: ${id}`);
  }

  // ── BUILD 1: Assignment ─────────────────────────────────────────────────────

  async assign(
    id: string,
    tenantId: string | undefined,
    dto: AssignFirmwareDto,
  ): Promise<{ assigned: number; message: string }> {
    const firmware = await this.findOne(id, tenantId);

    let devices: Device[];
    if (dto.targetType === FirmwareTargetType.DEVICE) {
      const device = await this.deviceRepo.findOne({
        where: { id: dto.targetId, tenantId },
      });
      if (!device) throw new NotFoundException('Target device not found');
      devices = [device];
    } else {
      devices = await this.deviceRepo.find({
        where: { deviceProfileId: dto.targetId, tenantId },
      });
      if (devices.length === 0) {
        return {
          assigned: 0,
          message: 'No devices found for the given device profile',
        };
      }
    }

    for (const device of devices) {
      device.pendingFirmwareVersion = firmware.version;
      device.firmwareUpdateStatus = FirmwareUpdateStatus.IDLE;
      device.firmwareUpdateProgress = 0;
      device.firmwareUpdateError = null as any; // clear any prior error (null, not undefined — see reportStatus)
      await this.deviceRepo.save(device);

      await this.kafka.sendMessage(
        FIRMWARE_UPDATE_TOPIC,
        {
          deviceId: device.id,
          firmwareId: firmware.id,
          version: firmware.version,
          downloadUrl: this.buildDownloadUrl(device.deviceKey),
        },
        device.id,
      );
    }

    this.logger.log(
      `Firmware ${firmware.version} assigned to ${devices.length} device(s) via ${dto.targetType}`,
    );
    return {
      assigned: devices.length,
      message: `Firmware ${firmware.version} assigned to ${devices.length} device(s)`,
    };
  }

  // ── BUILD 2: OTA poll ────────────────────────────────────────────────────────

  async checkForDevice(deviceToken: string) {
    const device = await this.findDeviceByToken(deviceToken);
    if (!device) throw new NotFoundException('Device not found');

    if (
      !device.pendingFirmwareVersion ||
      device.pendingFirmwareVersion === device.currentFirmwareVersion
    ) {
      return { updateAvailable: false };
    }

    const firmware = await this.resolvePendingFirmware(device);
    if (!firmware) {
      // pending version set but no matching firmware package on record
      return { updateAvailable: false };
    }

    return {
      updateAvailable: true,
      version: firmware.version,
      size: firmware.size,
      checksum: firmware.checksum,
      checksumAlgorithm: firmware.checksumAlgorithm,
      downloadUrl: this.buildDownloadUrl(device.deviceKey),
    };
  }

  // ── BUILD 2: OTA binary download ─────────────────────────────────────────────

  async getPendingFirmwareFile(
    deviceToken: string,
  ): Promise<{ firmware: Firmware; absolutePath: string }> {
    const device = await this.findDeviceByToken(deviceToken);
    if (!device) throw new NotFoundException('Device not found');

    if (!device.pendingFirmwareVersion) {
      throw new NotFoundException('No pending firmware for this device');
    }

    const firmware = await this.resolvePendingFirmware(device);
    if (!firmware) throw new NotFoundException('Firmware package not found');

    if (!fs.existsSync(firmware.storagePath)) {
      throw new NotFoundException('Firmware binary missing on server');
    }
    return { firmware, absolutePath: firmware.storagePath };
  }

  // ── BUILD 4: Device status reporting ─────────────────────────────────────────

  async reportStatus(
    deviceToken: string,
    dto: OtaStatusDto,
  ): Promise<{ received: true }> {
    const device = await this.findDeviceByToken(deviceToken);
    if (!device) throw new NotFoundException('Device not found');

    switch (dto.status) {
      case FirmwareUpdateStatus.DOWNLOADING:
      case FirmwareUpdateStatus.VERIFYING:
      case FirmwareUpdateStatus.APPLYING:
        device.firmwareUpdateStatus = dto.status;
        if (dto.progress !== undefined)
          device.firmwareUpdateProgress = dto.progress;
        break;

      case FirmwareUpdateStatus.SUCCESS:
        device.currentFirmwareVersion =
          dto.installedVersion ??
          device.pendingFirmwareVersion ??
          device.currentFirmwareVersion;
        device.firmwareVersion = device.currentFirmwareVersion; // keep reported column in sync
        // NOTE: assign `null` (not `undefined`) — TypeORM's save() skips
        // undefined properties, so undefined would leave the old value in place.
        device.pendingFirmwareVersion = null as any;
        device.firmwareUpdateStatus = FirmwareUpdateStatus.SUCCESS;
        device.firmwareUpdateProgress = 100;
        device.firmwareUpdateError = null as any;
        device.firmwareUpdateCompletedAt = new Date();
        break;

      case FirmwareUpdateStatus.FAILED:
        device.firmwareUpdateStatus = FirmwareUpdateStatus.FAILED;
        device.firmwareUpdateError = dto.error ?? 'Unknown error';
        device.firmwareUpdateCompletedAt = new Date();
        break;

      default:
        device.firmwareUpdateStatus = dto.status;
    }

    await this.deviceRepo.save(device);

    if (
      dto.status === FirmwareUpdateStatus.SUCCESS ||
      dto.status === FirmwareUpdateStatus.FAILED
    ) {
      await this.kafka.sendMessage(
        FIRMWARE_STATUS_TOPIC,
        {
          deviceId: device.id,
          deviceKey: device.deviceKey,
          tenantId: device.tenantId,
          status: dto.status,
          installedVersion: device.currentFirmwareVersion,
          error: dto.error ?? null,
          reportedAt: Date.now(),
        },
        device.id,
      );
    }

    this.logger.log(
      `OTA status from ${device.deviceKey}: ${dto.status}` +
        (dto.progress !== undefined ? ` (${dto.progress}%)` : ''),
    );
    return { received: true };
  }

  // ── Helpers ──────────────────────────────────────────────────────────────────

  /** Device token == deviceKey (unique across the platform). */
  async findDeviceByToken(token: string): Promise<Device | null> {
    return this.deviceRepo.findOne({ where: { deviceKey: token } });
  }

  /** Resolve the firmware package matching a device's pending version. */
  private async resolvePendingFirmware(
    device: Device,
  ): Promise<Firmware | null> {
    const version = device.pendingFirmwareVersion!;
    // Prefer a package targeting the device's profile, else any package with
    // that version in the same tenant.
    if (device.deviceProfileId) {
      const scoped = await this.firmwareRepo.findOne({
        where: {
          tenantId: device.tenantId,
          version,
          deviceProfileId: device.deviceProfileId,
        },
        order: { createdAt: 'DESC' },
      });
      if (scoped) return scoped;
    }
    return this.firmwareRepo.findOne({
      where: { tenantId: device.tenantId, version },
      order: { createdAt: 'DESC' },
    });
  }

  private buildDownloadUrl(deviceKey: string): string {
    const base =
      process.env.OTA_PUBLIC_URL ||
      process.env.BACKEND_URL ||
      'http://localhost:5000';
    return `${base.replace(/\/$/, '')}/ota/${deviceKey}/download`;
  }
}
