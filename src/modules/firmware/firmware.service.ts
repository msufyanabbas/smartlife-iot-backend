import {
  Injectable,
  Logger,
  NotFoundException,
  BadRequestException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
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
import { UpdateFirmwareDto } from './dto/update-firmware.dto';
import {
  QueryFirmwareDto,
  FIRMWARE_SORT_FIELDS,
  type FirmwareSortField,
} from './dto/query-firmware.dto';
import {
  QueryOtaRolloutDto,
  OTA_SORT_FIELDS,
  OtaRolloutState,
  type OtaSortField,
} from './dto/ota-rollout.dto';
import { PaginatedResponseDto } from '@common/dto/pagination.dto';

export const FIRMWARE_UPDATE_TOPIC = 'firmware.update';
export const FIRMWARE_STATUS_TOPIC = 'firmware.status';

@Injectable()
export class FirmwareService {
  private readonly logger = new Logger(FirmwareService.name);
  private readonly storageDir: string;
  private readonly otaBaseUrl: string;

  constructor(
    @InjectRepository(Firmware)
    private readonly firmwareRepo: Repository<Firmware>,
    @InjectRepository(Device)
    private readonly deviceRepo: Repository<Device>,
    private readonly kafka: KafkaService,
    private readonly configService: ConfigService,
  ) {
    // Derived from UPLOAD_PATH so firmware lands on the same mounted volume as
    // every other upload. Previously it hardcoded ./uploads/firmware while
    // UPLOAD_PATH could point elsewhere — on a deploy with a volume mounted at
    // a different path, firmware binaries were written to ephemeral container
    // storage and vanished on restart.
    const uploadRoot =
      this.configService.get<string>('UPLOAD_PATH') ?? './uploads';
    this.storageDir =
      this.configService.get<string>('FIRMWARE_STORAGE_DIR') ??
      path.resolve(process.cwd(), uploadRoot, 'firmware');

    // The download URL is embedded in the OTA command sent to devices. A
    // localhost fallback produces a URL no device can reach, and the failure
    // only shows up as OTA jobs stuck in progress.
    const otaBase =
      this.configService.get<string>('OTA_PUBLIC_URL') ??
      this.configService.get<string>('BACKEND_URL');
    if (!otaBase) {
      throw new Error(
        'OTA_PUBLIC_URL (or BACKEND_URL) must be configured — it builds the firmware download URL sent to devices',
      );
    }
    this.otaBaseUrl = otaBase.replace(/\/+$/, '');

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

  async findAll(tenantId: string | undefined, query: QueryFirmwareDto) {
    const {
      page = 1,
      limit = 10,
      search,
      sortBy = 'createdAt',
      sortOrder = 'DESC',
      deviceProfileId,
      isActive,
    } = query;

    // sortBy is constrained by @IsIn(FIRMWARE_SORT_FIELDS) on the DTO, but it is
    // interpolated into SQL below and TypeORM does not parameterise orderBy, so
    // it is re-checked here. A validation pipe that is ever reconfigured,
    // bypassed, or called from another service must not be the only thing
    // standing between a query string and the SQL text.
    const orderColumn: FirmwareSortField = FIRMWARE_SORT_FIELDS.includes(
      sortBy as FirmwareSortField,
    )
      ? (sortBy as FirmwareSortField)
      : 'createdAt';

    const qb = this.firmwareRepo
      .createQueryBuilder('fw')
      .leftJoinAndSelect('fw.deviceProfile', 'profile')
      .where('fw.tenantId = :tenantId', { tenantId });

    if (search) {
      qb.andWhere('(fw.title ILIKE :s OR fw.version ILIKE :s)', {
        s: `%${search}%`,
      });
    }
    if (deviceProfileId) {
      qb.andWhere('fw.deviceProfileId = :deviceProfileId', { deviceProfileId });
    }
    if (isActive !== undefined) {
      qb.andWhere('fw.isActive = :isActive', { isActive: isActive === 'true' });
    }

    qb.orderBy(`fw.${orderColumn}`, sortOrder as 'ASC' | 'DESC')
      .skip((page - 1) * limit)
      .take(limit);

    const [rows, total] = await qb.getManyAndCount();

    // How many devices each package is currently rolling out to. The list is the
    // page an operator deletes from, and "delete the package 40 devices are
    // mid-update on" needs to be visible before the click, not after.
    const data = await Promise.all(
      rows.map(async (fw) => ({
        ...fw,
        deviceProfileName: fw.deviceProfile?.name ?? null,
        assignedDeviceCount: await this.deviceRepo.count({
          where: { tenantId, pendingFirmwareVersion: fw.version },
        }),
        installedDeviceCount: await this.deviceRepo.count({
          where: { tenantId, currentFirmwareVersion: fw.version },
        }),
      })),
    );

    return PaginatedResponseDto.create(data, page, limit, total);
  }

  async update(
    id: string,
    tenantId: string | undefined,
    userId: string,
    dto: UpdateFirmwareDto,
  ): Promise<Firmware> {
    const firmware = await this.findOne(id, tenantId);

    if (dto.deviceProfileId !== undefined) {
      // null means "clear the target profile". Assigned as null rather than
      // undefined because TypeORM's save() SKIPS undefined properties — setting
      // it to undefined would leave the old profile in the database and the
      // clear would silently do nothing.
      firmware.deviceProfileId = dto.deviceProfileId ?? (null as any);
    }
    if (dto.title !== undefined) firmware.title = dto.title;
    if (dto.description !== undefined) firmware.description = dto.description;
    if (dto.isActive !== undefined) firmware.isActive = dto.isActive;
    firmware.updatedBy = userId;

    const saved = await this.firmwareRepo.save(firmware);
    this.logger.log(`Firmware updated: ${id}`);
    return saved;
  }

  /**
   * Operator-facing download of a package, for verifying what was uploaded.
   *
   * Distinct from getPendingFirmwareFile(): that one authenticates by device
   * token and only serves a device's own pending version. This one is
   * tenant-scoped and serves any package the tenant owns, assigned or not.
   */
  async getFileForOperator(
    id: string,
    tenantId: string | undefined,
  ): Promise<{ firmware: Firmware; absolutePath: string }> {
    const firmware = await this.findOne(id, tenantId);
    if (!fs.existsSync(firmware.storagePath)) {
      throw new NotFoundException(
        'Firmware binary is missing on the server — the package row exists but its file is gone',
      );
    }
    return { firmware, absolutePath: firmware.storagePath };
  }

  async findOne(id: string, tenantId: string | undefined): Promise<Firmware> {
    const fw = await this.firmwareRepo.findOne({ where: { id, tenantId } });
    if (!fw) throw new NotFoundException('Firmware not found');
    return fw;
  }

  async remove(
    id: string,
    tenantId: string | undefined,
    force = false,
  ): Promise<void> {
    const fw = await this.findOne(id, tenantId);

    // Deleting a package that devices are still waiting on strands them: the
    // pending version stays set, resolvePendingFirmware() finds nothing, and
    // checkForDevice() answers `updateAvailable: false` forever — a silent dead
    // end with no error surfaced anywhere. Refuse unless the caller says they
    // mean it, and unassign for them when they do.
    const pendingCount = await this.deviceRepo.count({
      where: { tenantId, pendingFirmwareVersion: fw.version },
    });
    if (pendingCount > 0) {
      if (!force) {
        throw new BadRequestException(
          `${pendingCount} device(s) are still waiting on version ${fw.version}. ` +
            'Unassign the package first, or delete with ?force=true to clear them.',
        );
      }
      await this.unassign(id, tenantId);
    }

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
      // Stamped at assignment, not at first device contact: the rollout table
      // sorts on this, and a device that never polls would otherwise have no
      // timestamp at all and sort as though it had never been targeted.
      device.firmwareUpdateStartedAt = new Date();
      device.firmwareUpdateCompletedAt = null as any;
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

  // ── OTA rollout, operator side ──────────────────────────────────────────────

  /**
   * SQL fragment that derives OtaRolloutState from the device's columns.
   *
   * There is no stored rollout-state column, and there should not be: the state
   * is a function of (pendingFirmwareVersion, currentFirmwareVersion,
   * firmwareUpdateStatus), all three of which are written by different code
   * paths — assign() sets pending, the device's own status reports set the rest.
   * A fourth denormalised column would be a fourth thing to keep in sync and the
   * first to go stale.
   *
   * Ordered most-specific first; CASE short-circuits.
   */
  private readonly rolloutStateSql = `
    CASE
      WHEN d."pendingFirmwareVersion" IS NOT NULL
           AND d."firmwareUpdateStatus" = '${FirmwareUpdateStatus.FAILED}'
        THEN '${OtaRolloutState.FAILED}'
      WHEN d."pendingFirmwareVersion" IS NOT NULL
           AND d."firmwareUpdateStatus" IN (
             '${FirmwareUpdateStatus.PUSHING}',
             '${FirmwareUpdateStatus.DOWNLOADING}',
             '${FirmwareUpdateStatus.VERIFYING}',
             '${FirmwareUpdateStatus.APPLYING}'
           )
        THEN '${OtaRolloutState.IN_PROGRESS}'
      WHEN d."pendingFirmwareVersion" IS NOT NULL
        THEN '${OtaRolloutState.PENDING}'
      WHEN d."firmwareUpdateStatus" = '${FirmwareUpdateStatus.SUCCESS}'
        THEN '${OtaRolloutState.UPDATED}'
      ELSE '${OtaRolloutState.UP_TO_DATE}'
    END
  `;

  /**
   * Per-device rollout view — the OTA Updates page's table.
   *
   * A FAILED device still carries its pendingFirmwareVersion, deliberately:
   * clearing it on failure would lose what was being attempted and make retry
   * impossible without re-assigning. That is why FAILED is tested before
   * IN_PROGRESS and PENDING above.
   */
  async getRollout(tenantId: string | undefined, query: QueryOtaRolloutDto) {
    const {
      page = 1,
      limit = 10,
      search,
      sortBy = 'firmwareUpdateStartedAt',
      sortOrder = 'DESC',
      state,
      status,
      deviceProfileId,
      version,
    } = query;

    const orderColumn: OtaSortField = OTA_SORT_FIELDS.includes(
      sortBy as OtaSortField,
    )
      ? (sortBy as OtaSortField)
      : 'firmwareUpdateStartedAt';

    const qb = this.deviceRepo
      .createQueryBuilder('d')
      .where('d.tenantId = :tenantId', { tenantId })
      .addSelect(`(${this.rolloutStateSql})`, 'rolloutState');

    if (search) {
      qb.andWhere('(d.name ILIKE :s OR d.deviceKey ILIKE :s)', {
        s: `%${search}%`,
      });
    }
    if (deviceProfileId) {
      qb.andWhere('d.deviceProfileId = :deviceProfileId', { deviceProfileId });
    }
    if (status) {
      qb.andWhere('d.firmwareUpdateStatus = :status', { status });
    }
    if (version) {
      qb.andWhere(
        '(d.pendingFirmwareVersion = :version OR d.currentFirmwareVersion = :version)',
        { version },
      );
    }
    if (state) {
      // Compared as raw SQL rather than against a column — the state is derived,
      // so there is nothing to put on the left of a normal `andWhere`.
      qb.andWhere(`(${this.rolloutStateSql}) = :state`, { state });
    }

    qb.orderBy(`d.${orderColumn}`, sortOrder as 'ASC' | 'DESC')
      // Secondary key so paging is stable: firmwareUpdateStartedAt is NULL for
      // every device that has never been targeted, and Postgres gives no
      // guaranteed order among equal keys — without this, the same device can
      // appear on page 1 and page 2 of the same listing.
      .addOrderBy('d.id', 'ASC')
      .skip((page - 1) * limit)
      .take(limit);

    const { entities, raw } = await qb.getRawAndEntities();
    const total = await qb.getCount();

    const data = entities.map((device, index) => ({
      id: device.id,
      name: device.name,
      deviceKey: device.deviceKey,
      deviceProfileId: device.deviceProfileId ?? null,
      status: device.status,
      lastSeenAt: device.lastSeenAt ?? null,
      currentFirmwareVersion: device.currentFirmwareVersion ?? null,
      pendingFirmwareVersion: device.pendingFirmwareVersion ?? null,
      firmwareUpdateStatus:
        device.firmwareUpdateStatus ?? FirmwareUpdateStatus.IDLE,
      firmwareUpdateProgress: device.firmwareUpdateProgress ?? 0,
      firmwareUpdateError: device.firmwareUpdateError ?? null,
      firmwareUpdateStartedAt: device.firmwareUpdateStartedAt ?? null,
      firmwareUpdateCompletedAt: device.firmwareUpdateCompletedAt ?? null,
      rolloutState:
        (raw[index]?.rolloutState as OtaRolloutState) ??
        OtaRolloutState.UP_TO_DATE,
    }));

    return PaginatedResponseDto.create(data, page, limit, total);
  }

  /** Counts per rollout state — the stat cards above the OTA table. */
  async getRolloutSummary(tenantId: string | undefined) {
    const rows: Array<{ state: string; count: string }> = await this.deviceRepo
      .createQueryBuilder('d')
      .select(`(${this.rolloutStateSql})`, 'state')
      .addSelect('COUNT(*)', 'count')
      .where('d.tenantId = :tenantId', { tenantId })
      .groupBy(`(${this.rolloutStateSql})`)
      .getRawMany();

    // Every state is present even at zero, so the cards do not reflow as
    // devices move between buckets.
    const summary: Record<OtaRolloutState, number> = {
      [OtaRolloutState.UP_TO_DATE]: 0,
      [OtaRolloutState.PENDING]: 0,
      [OtaRolloutState.IN_PROGRESS]: 0,
      [OtaRolloutState.UPDATED]: 0,
      [OtaRolloutState.FAILED]: 0,
    };
    let totalDevices = 0;
    for (const row of rows) {
      const count = Number(row.count) || 0;
      totalDevices += count;
      if (row.state in summary) {
        summary[row.state as OtaRolloutState] = count;
      }
    }

    return { ...summary, totalDevices };
  }

  /** Devices this package is assigned to or already installed on. */
  async getFirmwareDevices(id: string, tenantId: string | undefined) {
    const firmware = await this.findOne(id, tenantId);
    const devices = await this.deviceRepo.find({
      where: [
        { tenantId, pendingFirmwareVersion: firmware.version },
        { tenantId, currentFirmwareVersion: firmware.version },
      ],
      order: { name: 'ASC' },
    });

    return devices.map((device) => ({
      id: device.id,
      name: device.name,
      deviceKey: device.deviceKey,
      status: device.status,
      currentFirmwareVersion: device.currentFirmwareVersion ?? null,
      pendingFirmwareVersion: device.pendingFirmwareVersion ?? null,
      firmwareUpdateStatus:
        device.firmwareUpdateStatus ?? FirmwareUpdateStatus.IDLE,
      firmwareUpdateProgress: device.firmwareUpdateProgress ?? 0,
      firmwareUpdateError: device.firmwareUpdateError ?? null,
      installed: device.currentFirmwareVersion === firmware.version,
    }));
  }

  /**
   * Cancel a pending update on one device.
   *
   * Clears the pending version so the next poll answers `updateAvailable: false`.
   * A device already mid-download will finish its HTTP request — there is no
   * channel to abort one — but will find nothing pending afterwards, so nothing
   * is flashed.
   */
  async cancelDeviceUpdate(
    deviceId: string,
    tenantId: string | undefined,
  ): Promise<{ cancelled: boolean; message: string }> {
    const device = await this.deviceRepo.findOne({
      where: { id: deviceId, tenantId },
    });
    if (!device) throw new NotFoundException('Device not found');

    if (!device.pendingFirmwareVersion) {
      return {
        cancelled: false,
        message: 'Device has no pending firmware update',
      };
    }

    const cancelledVersion = device.pendingFirmwareVersion;
    // null, not undefined — TypeORM's save() skips undefined properties, so
    // undefined would leave the pending version in the database and the "cancel"
    // would silently do nothing. Same trap as reportStatus().
    device.pendingFirmwareVersion = null as any;
    device.firmwareUpdateStatus = FirmwareUpdateStatus.IDLE;
    device.firmwareUpdateProgress = 0;
    device.firmwareUpdateError = null as any;
    await this.deviceRepo.save(device);

    this.logger.log(
      `OTA cancelled for ${device.deviceKey} (was targeting ${cancelledVersion})`,
    );
    return {
      cancelled: true,
      message: `Cancelled pending update to ${cancelledVersion}`,
    };
  }

  /**
   * Retry a failed update on one device.
   *
   * Re-publishes the Kafka command and resets the error, keeping the same target
   * version. Requires a pending version to still be set — which is exactly why
   * reportStatus() does not clear it on FAILED.
   */
  async retryDeviceUpdate(
    deviceId: string,
    tenantId: string | undefined,
  ): Promise<{ retried: boolean; message: string }> {
    const device = await this.deviceRepo.findOne({
      where: { id: deviceId, tenantId },
    });
    if (!device) throw new NotFoundException('Device not found');

    if (!device.pendingFirmwareVersion) {
      throw new BadRequestException(
        'Device has no firmware assigned — assign a package before retrying',
      );
    }

    const firmware = await this.resolvePendingFirmware(device);
    if (!firmware) {
      throw new NotFoundException(
        `No firmware package found for version ${device.pendingFirmwareVersion} — it may have been deleted`,
      );
    }

    device.firmwareUpdateStatus = FirmwareUpdateStatus.IDLE;
    device.firmwareUpdateProgress = 0;
    device.firmwareUpdateError = null as any;
    device.firmwareUpdateStartedAt = new Date();
    device.firmwareUpdateCompletedAt = null as any;
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

    this.logger.log(
      `OTA retry queued for ${device.deviceKey} → v${firmware.version}`,
    );
    return { retried: true, message: `Retrying update to ${firmware.version}` };
  }

  /** Clear the pending update on every device targeted with this package. */
  async unassign(
    id: string,
    tenantId: string | undefined,
  ): Promise<{ unassigned: number; message: string }> {
    const firmware = await this.findOne(id, tenantId);
    const devices = await this.deviceRepo.find({
      where: { tenantId, pendingFirmwareVersion: firmware.version },
    });

    for (const device of devices) {
      device.pendingFirmwareVersion = null as any;
      device.firmwareUpdateStatus = FirmwareUpdateStatus.IDLE;
      device.firmwareUpdateProgress = 0;
      device.firmwareUpdateError = null as any;
      await this.deviceRepo.save(device);
    }

    this.logger.log(
      `Firmware ${firmware.version} unassigned from ${devices.length} device(s)`,
    );
    return {
      unassigned: devices.length,
      message: `Cleared pending update on ${devices.length} device(s)`,
    };
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
    return `${this.otaBaseUrl}/ota/${deviceKey}/download`;
  }
}
