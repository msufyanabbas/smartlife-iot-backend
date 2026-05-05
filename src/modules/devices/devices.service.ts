import {
  Injectable,
  NotFoundException,
  ConflictException,
  BadRequestException,
  ForbiddenException,
  Logger,
  Inject,
  forwardRef,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, In, LessThan } from 'typeorm';
import { ConfigService } from '@nestjs/config';
import { Device, User } from '@modules/index.entities';
import { DeviceStatus } from '@common/enums/index.enum';
import { CreateDeviceDto } from '@modules/devices/dto/create-device.dto';
import { UpdateDeviceDto } from '@modules/devices/dto/update-device.dto';
import { DeviceCredentialsDto } from '@modules/devices/dto/device-credentials.dto';
import { PaginationDto, PaginatedResponseDto } from '@/common/dto/pagination.dto';
import { UserRole } from '@common/enums/index.enum';
import { DeviceCredentialsService } from './device-credentials.service';
import { SubscriptionsService } from '../subscriptions/subscriptions.service';
import { Cron, CronExpression } from '@nestjs/schedule';
import { UsersService } from '@modules/users/users.service';
import { EventEmitter2 } from '@nestjs/event-emitter';
import * as crypto from 'crypto';
import { CodecRegistryService } from './codecs/codec-registry.service';

@Injectable()
export class DevicesService {
  private readonly logger = new Logger(DevicesService.name);

  constructor(
    @InjectRepository(Device)
    private deviceRepository: Repository<Device>,
    @Inject(ConfigService)
    private configService: ConfigService,
     @Inject(forwardRef(() => UsersService))
    private userService: UsersService,
    @Inject(EventEmitter2)
    private eventEmitter: EventEmitter2,
    @Inject(DeviceCredentialsService)
    private credentialsService: DeviceCredentialsService,
    @Inject(CodecRegistryService)
    private codecRegistry: CodecRegistryService,
    @Inject(SubscriptionsService)
    private subscriptionsService: SubscriptionsService,
  ) {}

  // ── Create ────────────────────────────────────────────────────────────────

  async create(
    user: User,
    dto: CreateDeviceDto,
  ): Promise<{ device: Device; credentials: DeviceCredentialsDto }> {
    const deviceKey = `dev_${crypto.randomBytes(8).toString('hex')}`;

    const collision = await this.deviceRepository.findOne({ where: { deviceKey } });
    if (collision) {
      throw new ConflictException('Device key collision — please retry');
    }

    // ── Resolve codecId from manufacturer + model ─────────────────────────
    // If the caller supplied both fields we can look up the exact codec.
    // The resolved codecId is stored in metadata so the decode pipeline can
    // reach it directly (O(1) map lookup) on every incoming message.
    let resolvedCodecId: string | undefined = dto.metadata?.codecId as string | undefined;
 
    if (dto.manufacturer && dto.model && !resolvedCodecId) {
      resolvedCodecId = this.codecRegistry.resolveCodecId(dto.manufacturer, dto.model);
 
      if (!resolvedCodecId) {
        // Don't hard-fail — just log a warning. The device is still created;
        // incoming payloads will fall back to auto-detection.
        this.logger.warn(
          `No codec found for ${dto.manufacturer} / ${dto.model}. ` +
          `Device will be created but payloads may not decode correctly.`,
        );
      }
    }

    const device = this.deviceRepository.create({
      ...dto,
      deviceKey,
      userId: user.id,
      tenantId: user.tenantId,
      status: DeviceStatus.INACTIVE,
      manufacturer: dto.manufacturer,
      model: dto.model,
      // protocol comes directly from the DTO (validated enum)
      protocol: dto.protocol,
   metadata: {
        ...(dto.metadata ?? {}),
        // Always keep codecId in metadata — it's the fast-path for the decode pipeline
        ...(resolvedCodecId ? { codecId: resolvedCodecId } : {}),
        // Also store manufacturer/model in metadata for the MQTTService
        // buildStandardTelemetry() which reads from device.metadata
        ...(dto.manufacturer ? { manufacturer: dto.manufacturer } : {}),
        ...(dto.model ? { model: dto.model } : {}),
      },
    });

    const savedDevice = await this.deviceRepository.save(device);

    // Increment subscription usage (fire and forget)
    void this.subscriptionsService.incrementTenantUsage(
      user.tenantId as any,
      'devices',
      1,
    );

    // Create credentials — pass the full user object so verifyAccess works
    await this.credentialsService.createCredentials(savedDevice);

    // Build full MQTT config for the response (user is always the creator here)
    const credentials = await this.credentialsService.getMqttConfiguration(
      savedDevice.id,
      user, // full User entity — not a partial object
    );

    return { device: savedDevice, credentials };
  }

  // ── Find all ──────────────────────────────────────────────────────────────
  // Filtering logic is applied once, in priority order:
  //   1. Guard-resolved tenantId (from JwtAuthGuard / TenantIsolationGuard)
  //   2. Guard-resolved customerId (from CustomerAccessGuard)
  //   3. Role-based fallback for CUSTOMER_USER
  // We do NOT double-apply filters.

  async findAll(
    tenantId: string | undefined,
    customerId: string | undefined,
    user: User,
    paginationDto: PaginationDto,
  ): Promise<PaginatedResponseDto<Device>> {
    const { page, limit, search, sortBy, sortOrder } = paginationDto;

    const qb = this.deviceRepository.createQueryBuilder('device');

    // SUPER_ADMIN sees everything; all other roles are tenant-scoped
    if (user.role !== UserRole.SUPER_ADMIN) {
      const effectiveTenantId = tenantId ?? user.tenantId;
      if (effectiveTenantId) {
        qb.andWhere('device.tenantId = :tenantId', { tenantId: effectiveTenantId });
      }
    }

    // CUSTOMER_USER / CUSTOMER are additionally scoped to their customer
    if (
      user.role === UserRole.CUSTOMER_USER ||
      user.role === UserRole.CUSTOMER
    ) {
      const effectiveCustomerId = customerId ?? user.customerId;
      if (!effectiveCustomerId) {
        return PaginatedResponseDto.create([], page, limit, 0);
      }
      qb.andWhere('device.customerId = :customerId', {
        customerId: effectiveCustomerId,
      });
    } else if (customerId) {
      // Admin explicitly filtering by customer (e.g. customer detail page)
      qb.andWhere('device.customerId = :customerId', { customerId });
    }

    if (search) {
      qb.andWhere(
        '(device.name ILIKE :search OR device.description ILIKE :search OR device.deviceKey ILIKE :search)',
        { search: `%${search}%` },
      );
    }

    qb.orderBy(`device.${sortBy ?? 'createdAt'}`, sortOrder ?? 'DESC');
    qb.skip((page - 1) * limit).take(limit);

    const [devices, total] = await qb.getManyAndCount();
    return PaginatedResponseDto.create(devices, page, limit, total);
  }

  // ── Find one ──────────────────────────────────────────────────────────────

  async findOne(id: string, user: User): Promise<Device> {
    const qb = this.deviceRepository
      .createQueryBuilder('device')
      .where('device.id = :id', { id });

    this.applyAccessFilter(qb, user);

    const device = await qb.getOne();

    if (!device) {
      throw new NotFoundException(`Device ${id} not found`);
    }

    return device;
  }

  // ── Find by deviceKey ─────────────────────────────────────────────────────

  async findByDeviceKey(deviceKey: string, user: User): Promise<Device> {
    const qb = this.deviceRepository
      .createQueryBuilder('device')
      .where('device.deviceKey = :deviceKey', { deviceKey });

    this.applyAccessFilter(qb, user);

    const device = await qb.getOne();

    if (!device) {
      throw new NotFoundException(`Device ${deviceKey} not found`);
    }

    return device;
  }

  // ── Update ────────────────────────────────────────────────────────────────

  async update(id: string, user: User, dto: UpdateDeviceDto): Promise<Device> {
    const device = await this.findOne(id, user);
    Object.assign(device, dto);
    return this.deviceRepository.save(device);
  }

  // ── Activate / deactivate ─────────────────────────────────────────────────

  async activate(id: string, user: User): Promise<Device> {
    const device = await this.findOne(id, user);

    if (device.status === DeviceStatus.ACTIVE) {
      throw new BadRequestException('Device is already active');
    }

    device.status = DeviceStatus.ACTIVE;
    device.activatedAt = new Date();
    return this.deviceRepository.save(device);
  }

  async deactivate(id: string, user: User): Promise<Device> {
    const device = await this.findOne(id, user);
    device.status = DeviceStatus.INACTIVE;
    return this.deviceRepository.save(device);
  }

  // ── Remove ────────────────────────────────────────────────────────────────
  // Order: delete credentials first (explicit), THEN soft-remove the device.
  // The DB-level onDelete:'CASCADE' on DeviceCredentials.deviceId would fire
  // on a HARD delete, but soft-remove only nulls the deletedAt column so the
  // FK row is still present — the CASCADE would not fire. We therefore always
  // delete credentials explicitly.

  async remove(id: string, user: User): Promise<void> {
    const device = await this.findOne(id, user);

    // Delete credentials first — explicit, avoids relying on cascade behaviour
    await this.credentialsService.deleteByDeviceId(device.id);

    await this.deviceRepository.softRemove(device);
  }

  // ── Credentials passthrough ───────────────────────────────────────────────

  async getCredentials(id: string, user: User): Promise<DeviceCredentialsDto> {
    await this.findOne(id, user); // access check
    return this.credentialsService.getMqttConfiguration(id, user);
  }

  async regenerateCredentials(id: string, user: User): Promise<DeviceCredentialsDto> {
    await this.findOne(id, user); // access check
    return this.credentialsService.regenerateCredentials(id, user);
  }

  // ── Activity ──────────────────────────────────────────────────────────────

  async updateActivity(deviceKey: string): Promise<void> {
    await this.deviceRepository.increment({ deviceKey }, 'messageCount', 1);
    await this.deviceRepository.update(
      { deviceKey },
      { lastActivityAt: new Date(), lastSeenAt: new Date() },
    );
  }

  async updateLastSeen(deviceKey: string, user: User): Promise<void> {
    const device = await this.findByDeviceKey(deviceKey, user);
    const wasOffline = device.status === DeviceStatus.OFFLINE;

    await this.deviceRepository.update(
      { deviceKey },
      { lastSeenAt: new Date(), status: DeviceStatus.ACTIVE },
    );

    if (wasOffline) {
      const deviceUser = await this.userService.findOne(device.userId);
      this.handleDeviceOnline(device, deviceUser);
    }
  }

  // ── Verify credentials (called by MQTT gateway auth hook) ─────────────────

  async verifyCredentials(
    credentialsId: string,
    credentialsValue?: string,
  ): Promise<Device> {
    const { device } = await this.credentialsService.verifyCredentials(
      credentialsId,
      credentialsValue,
    );
    return device;
  }

  // ── Statistics ────────────────────────────────────────────────────────────

  async getStatistics(user: User): Promise<any> {
    const qb = this.deviceRepository.createQueryBuilder('device');
    this.applyAccessFilter(qb, user);

    const [total, active, inactive, offline] = await Promise.all([
      qb.getCount(),
      qb.clone().andWhere('device.status = :s', { s: DeviceStatus.ACTIVE }).getCount(),
      qb.clone().andWhere('device.status = :s', { s: DeviceStatus.INACTIVE }).getCount(),
      qb.clone().andWhere('device.status = :s', { s: DeviceStatus.OFFLINE }).getCount(),
    ]);

    const fiveMinutesAgo = new Date(Date.now() - 5 * 60 * 1000);
    const online = await qb
      .clone()
      .andWhere('device.lastSeenAt > :ts', { ts: fiveMinutesAgo })
      .getCount();

    return {
      totalDevices: total,
      activeDevices: active,
      inactiveDevices: inactive,
      offlineDevices: offline,
      onlineDevices: online,
      devicesByStatus: { active, inactive, offline },
    };
  }

  // ── Customer assignment ───────────────────────────────────────────────────

  async assignToCustomer(
    deviceId: string,
    customerId: string,
    user: User,
  ): Promise<Device> {
    this.assertAdmin(user);
    const device = await this.findOne(deviceId, user);
    device.customerId = customerId;
    return this.deviceRepository.save(device);
  }

  async unassignFromCustomer(deviceId: string, user: User): Promise<Device> {
    this.assertAdmin(user);
    const device = await this.findOne(deviceId, user);
    device.customerId = undefined;
    return this.deviceRepository.save(device);
  }

  async findByCustomer(customerId: string, user: User): Promise<Device[]> {
    if (
      (user.role === UserRole.CUSTOMER_USER || user.role === UserRole.CUSTOMER) &&
      user.customerId !== customerId
    ) {
      throw new ForbiddenException('Access denied to this customer');
    }

    return this.deviceRepository.find({
      where: { customerId },
      order: { name: 'ASC' },
    });
  }

  // ── Bulk operations ───────────────────────────────────────────────────────

  async bulkUpdateStatus(
    deviceIds: string[],
    userId: string,
    status: DeviceStatus,
  ): Promise<void> {
    const devices = await this.deviceRepository.find({
      where: { id: In(deviceIds), userId },
    });

    if (devices.length !== deviceIds.length) {
      throw new BadRequestException(
        'Some devices not found or do not belong to this user',
      );
    }

    await this.deviceRepository.update({ id: In(deviceIds) }, { status });
  }

  // ── Offline cron ──────────────────────────────────────────────────────────

  @Cron(CronExpression.EVERY_5_MINUTES)
  async checkOfflineDevices(): Promise<void> {
    const fiveMinutesAgo = new Date(Date.now() - 5 * 60 * 1000);

    const staleDevices = await this.deviceRepository.find({
      where: { status: DeviceStatus.ACTIVE, lastSeenAt: LessThan(fiveMinutesAgo) },
    });

    for (const device of staleDevices) {
      device.status = DeviceStatus.OFFLINE;
      await this.deviceRepository.save(device);

      const user = await this.userService.findOne(device.userId);
      this.handleDeviceOffline(device, user);
    }

    if (staleDevices.length > 0) {
      this.logger.log(`Marked ${staleDevices.length} device(s) as offline`);
    }
  }

  // ── Private helpers ───────────────────────────────────────────────────────

  /**
   * Apply tenant / customer filters to any QueryBuilder based on the
   * requesting user's role. Call this once per query — do not add manual
   * andWhere clauses on top of it.
   */
  private applyAccessFilter(
    qb: ReturnType<Repository<Device>['createQueryBuilder']>,
    user: User,
  ): void {
    if (user.role === UserRole.SUPER_ADMIN) return;

    if (user.tenantId) {
      qb.andWhere('device.tenantId = :tenantId', { tenantId: user.tenantId });
    }

    if (
      user.role === UserRole.CUSTOMER_USER ||
      user.role === UserRole.CUSTOMER
    ) {
      if (!user.customerId) {
        // Force zero results — user has no customer assignment
        qb.andWhere('1 = 0');
        return;
      }
      qb.andWhere('device.customerId = :customerId', {
        customerId: user.customerId,
      });
    }
  }

  private assertAdmin(user: User): void {
    if (
      user.role !== UserRole.SUPER_ADMIN &&
      user.role !== UserRole.TENANT_ADMIN
    ) {
      throw new ForbiddenException('Only admins can perform this action');
    }
  }

  private handleDeviceOffline(device: Device, user: User): void {
    this.eventEmitter.emit('device.offline', { device, user });
    this.logger.warn(`Device offline: ${device.name} (${device.id})`);
  }

  private handleDeviceOnline(device: Device, user: User): void {
    this.eventEmitter.emit('device.connected', { device, user });
    this.logger.log(`Device online: ${device.name} (${device.id})`);
  }
}