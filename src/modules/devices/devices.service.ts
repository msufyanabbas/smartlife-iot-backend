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
import { Repository, In, LessThan, DataSource, EntityManager } from 'typeorm';
import { ConfigService } from '@nestjs/config';
import { Asset, Device, DeviceProfile, User } from '@modules/index.entities';
import { DeviceCredentials } from '@modules/devices/entities/device-credentials.entity';
import {
  AlarmStatus,
  DeviceProvisionType,
  DeviceStatus,
  DeviceType,
} from '@common/enums/index.enum';
import {
  BulkResultBuilder,
  BulkResultDto,
} from '@common/dto/bulk-operation.dto';
import {
  BulkDeleteDevicesDto,
  BulkUpdateDevicesDto,
} from '@modules/devices/dto/bulk-device.dto';
import { CreateDeviceDto } from '@modules/devices/dto/create-device.dto';
import { UpdateDeviceDto } from '@modules/devices/dto/update-device.dto';
import { DeviceCredentialsDto } from '@modules/devices/dto/device-credentials.dto';
import { DeviceCredentialsSummaryDto } from '@modules/devices/dto/device-credentials-summary.dto';
import {
  ProvisionDeviceDto,
  ProvisionDeviceResponseDto,
} from '@modules/devices/dto/provision-device.dto';
import { PaginationDto, PaginatedResponseDto } from '@/common/dto/pagination.dto';
import { UserRole } from '@common/enums/index.enum';
import { DeviceCredentialsService } from './device-credentials.service';
import { SubscriptionsService } from '../subscriptions/subscriptions.service';
import { CronExpression } from '@nestjs/schedule';
import { DistributedCron } from '@/lib/cluster/distributed-cron.decorator';
import { UsersService } from '@modules/users/users.service';
import { EventEmitter2 } from '@nestjs/event-emitter';
import * as crypto from 'crypto';
import { CodecRegistryService } from './codecs/codec-registry.service';
import { ProfileAlarmService } from '@modules/profiles/profile-alarm.service';
import {
  applyAccessScope,
  isCustomerScopedRole,
} from '@common/scoping/apply-access-scope';

@Injectable()
export class DevicesService {
  private readonly logger = new Logger(DevicesService.name);

  constructor(
    @InjectRepository(Device)
    private deviceRepository: Repository<Device>,
    @InjectRepository(Asset)
    private assetRepository: Repository<Asset>,
    @InjectRepository(DeviceProfile)
    private deviceProfileRepository: Repository<DeviceProfile>,
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
    @Inject(ProfileAlarmService)
    private profileAlarmService: ProfileAlarmService,
    // Bulk operations run one transaction per item (see bulkDelete) and have
    // to touch tables owned by other modules (floor_plan_devices,
    // customer_devices, user_devices, customers.usageCounters). Taking the
    // DataSource rather than importing four more modules keeps this module's
    // import graph as it is — DevicesModule is already in two forwardRef
    // cycles.
    private readonly dataSource: DataSource,
  ) {}

  /**
   * assetId arrives as a bare UUID from the client, so it has to be checked
   * against the caller's tenant — otherwise a device could be linked to another
   * tenant's asset and would then show up in that asset's floor plan pickers.
   */
  private async assertAssetInTenant(
    assetId: string,
    tenantId?: string,
  ): Promise<void> {
    // A SUPER_ADMIN has no tenantId — existence is all we can check for them.
    const asset = await this.assetRepository.findOne({
      where: tenantId ? { id: assetId, tenantId } : { id: assetId },
    });
    if (!asset) {
      throw new NotFoundException(`Asset ${assetId} not found`);
    }
  }

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

    if (dto.assetId) {
      await this.assertAssetInTenant(dto.assetId, user.tenantId);
    }

    // Resolve the profile up front so an unknown/foreign id fails before the
    // device row (and its credentials) are written.
    let deviceProfile: DeviceProfile | null = null;
    if (dto.deviceProfileId) {
      deviceProfile = await this.deviceProfileRepository.findOne({
        where: { id: dto.deviceProfileId, tenantId: user.tenantId },
      });

      if (!deviceProfile) {
        throw new NotFoundException(
          'Device profile not found for this tenant',
        );
      }
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

    // ── Attributing the device to the creator's customer ───────────────────
    //
    // `userId` and `tenantId` were set from the caller and `customerId` was
    // not, so a device created by a CUSTOMER or CUSTOMER_USER landed with
    // `customerId: null`. Two things followed, and the second is the nasty
    // one:
    //
    //   1. `DeviceCredentialsService.verifyAccess()` runs during credential
    //      issuance and requires `device.customerId === user.customerId` for a
    //      customer-scoped principal. `null` never matches, so the request
    //      answered 403 "Access denied to this device" — about the device the
    //      caller had just created, which reads as a scoping bug in the
    //      guards.
    //
    //   2. The device row is SAVED before credentials are issued, so the 403
    //      left an orphan behind: a device owned by nobody's customer, which
    //      its creator cannot see (read scoping filters on `customerId`) and
    //      cannot delete. Every retry left another.
    //
    // A customer-scoped creator can only ever create within its own customer —
    // `CreateDeviceDto` has no `customerId` field, so there is nothing for a
    // caller to forge here, and this is read from the authenticated principal
    // rather than the body in any case. A tenant admin keeps creating
    // unassigned devices and assigning them afterwards (§4i).
    const creatorCustomerId =
      user.role === UserRole.CUSTOMER || user.role === UserRole.CUSTOMER_USER
        ? user.customerId
        : undefined;

    const device = this.deviceRepository.create({
      ...dto,
      deviceKey,
      userId: user.id,
      tenantId: user.tenantId,
      ...(creatorCustomerId ? { customerId: creatorCustomerId } : {}),
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

    // Materialise the profile's alarm rules as dormant Alarm rows so the
    // device's alarm list shows what is being watched before anything fires.
    // Non-fatal: a device must still be creatable if alarm seeding fails.
    if (deviceProfile) {
      try {
        savedDevice.deviceProfile = deviceProfile;
        await this.profileAlarmService.materialiseProfileAlarms(savedDevice);
      } catch (err) {
        this.logger.error(
          `Failed to materialise profile alarms for ${savedDevice.deviceKey}: ${
            (err as Error).message
          }`,
        );
      }
    }

    // Create credentials — pass the full user object so verifyAccess works
    await this.credentialsService.createCredentials(savedDevice);

    // Build full MQTT config for the response (user is always the creator here)
    const credentials = await this.credentialsService.getMqttConfiguration(
      savedDevice.id,
      user, // full User entity — not a partial object
    );

    // `device.created` has an audit handler in AuditEventsService and, until
    // this change, no emitter anywhere — so device creation was not recorded.
    // The flat `tenantId`/`customerId` are supplied explicitly rather than
    // left to the handler's fallback, so the row is scoped even if the device
    // row's own columns are later reshaped.
    this.eventEmitter.emit('device.created', {
      device: savedDevice,
      createdBy: user,
      tenantId: savedDevice.tenantId,
      customerId: savedDevice.customerId,
    });

    return { device: savedDevice, credentials };
  }

  // ── Find all ──────────────────────────────────────────────────────────────
  // Scoping is applied ONCE, by applyAccessScope(). `tenantId` is retained on
  // the signature for the existing callers and is deliberately no longer
  // read: the only caller passes `user.tenantId`, and taking a tenant from
  // anywhere but the principal is how a scope becomes forgeable. `customerId`
  // is honoured only as a narrowing filter for roles that are not already
  // confined to one customer.

  async findAll(
    _tenantId: string | undefined,
    customerId: string | undefined,
    user: User,
    paginationDto: PaginationDto,
  ): Promise<PaginatedResponseDto<Device>> {
    const { page, limit, search, sortBy, sortOrder } = paginationDto;

    const qb = this.deviceRepository.createQueryBuilder('device');

    // The caller's own scope, from the one shared helper. This block used to
    // be hand-rolled here — a fifth copy of applyAccessFilter() — and it had
    // drifted: `if (effectiveTenantId)` skipped the tenant predicate for a
    // non-SUPER_ADMIN with no tenantId, which is the unscoped read §4g names.
    // The helper denies instead, and denies again for a customer-scoped role
    // with no customerId.
    applyAccessScope(qb, 'device', user);

    // A tenant admin may additionally narrow to one customer (the customer
    // detail page). For a customer-scoped caller this is not a filter but
    // their own scope, which the helper has already pinned — so it is only
    // honoured for the roles that are not confined to a single customer.
    if (customerId && !isCustomerScopedRole(user.role)) {
      qb.andWhere('device.customerId = :filterCustomerId', {
        filterCustomerId: customerId,
      });
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

    if (dto.assetId) {
      await this.assertAssetInTenant(dto.assetId, device.tenantId);
    }

    // Captured BEFORE the assign, and only for the keys the DTO actually
    // carries — a diff of the whole entity would put the device's jsonb
    // configuration into every audit row.
    const before: Record<string, any> = {};
    for (const key of Object.keys(dto)) {
      before[key] = (device as any)[key];
    }

    Object.assign(device, dto);
    const saved = await this.deviceRepository.save(device);

    this.eventEmitter.emit('device.updated', {
      device: saved,
      updatedBy: user,
      tenantId: saved.tenantId,
      customerId: saved.customerId,
      changes: { before, after: { ...dto } },
    });

    return saved;
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

    // Give the quota back. Without this the counter only ever climbs, and a
    // tenant that creates and deletes the same device repeatedly is eventually
    // locked out by SubscriptionLimitGuard despite owning nothing.
    // Non-fatal: the device IS deleted, so a failed counter update must not
    // surface to the caller as a failed delete.
    try {
      await this.subscriptionsService.decrementTenantUsage(
        device.tenantId,
        'devices',
        1,
      );
    } catch (err) {
      this.logger.error(
        `Failed to decrement devices usage for tenant ${device.tenantId}`,
        err,
      );
    }

    this.eventEmitter.emit('device.deleted', {
      deviceId: device.id,
      deviceName: device.name,
      deletedBy: user,
      tenantId: device.tenantId,
      customerId: device.customerId,
    });
  }

  // ── Credentials passthrough ───────────────────────────────────────────────

  /**
   * Masked view — what GET /devices/:id/credentials returns.
   *
   * The full secret is deliberately not reachable through a plain read; it is
   * returned only by create() and regenerateCredentials().
   */
  async getCredentialsSummary(
    id: string,
    user: User,
  ): Promise<DeviceCredentialsSummaryDto> {
    await this.findOne(id, user); // access check
    return this.credentialsService.getMaskedSummary(id, user);
  }

  /**
   * Full MQTT configuration including the live secret, broker topics and
   * copy-paste firmware snippets.
   *
   * Not bound to a read route — it backs the response of device creation and
   * credential rotation, where showing the secret once is the point.
   */
  async getCredentials(id: string, user: User): Promise<DeviceCredentialsDto> {
    await this.findOne(id, user); // access check
    return this.credentialsService.getMqttConfiguration(id, user);
  }

  async regenerateCredentials(id: string, user: User): Promise<DeviceCredentialsDto> {
    await this.findOne(id, user); // access check
    return this.credentialsService.regenerateCredentials(id, user);
  }

  // ── Provisioning (self-registration) ──────────────────────────────────────
  //
  // Backs the @Public() POST /devices/provision. There is no caller identity:
  // the profile's provisionDeviceKey + provisionDeviceSecret pair IS the
  // credential, and the tenant is taken from the profile that owns the key —
  // never from the request — so a caller cannot provision into a tenant they
  // do not hold a key for.
  //
  // Always resolves (never throws) so a constrained device firmware only has
  // to parse one response shape. Failures are deliberately vague: a caller
  // probing keys learns only that the pair was rejected, not which half.

  async provisionDevice(
    dto: ProvisionDeviceDto,
  ): Promise<ProvisionDeviceResponseDto> {
    const fail = (errorMsg: string): ProvisionDeviceResponseDto => ({
      status: 'FAILURE',
      errorMsg,
    });

    const profile = await this.deviceProfileRepository.findOne({
      where: { provisionDeviceKey: dto.provisionDeviceKey },
    });

    // Same message for unknown key and wrong secret — do not confirm that a
    // provision key exists.
    if (
      !profile ||
      !profile.provisionDeviceSecret ||
      profile.provisionDeviceSecret !== dto.provisionDeviceSecret
    ) {
      this.logger.warn(
        `Provisioning rejected for key '${dto.provisionDeviceKey}': invalid credentials`,
      );
      return fail('Invalid provision credentials');
    }

    if (
      !profile.provisionType ||
      profile.provisionType === DeviceProvisionType.DISABLED
    ) {
      return fail('Provisioning is disabled for this device profile');
    }

    // ── Pre-provisioned: the device must already exist ─────────────────────
    if (profile.provisionType === DeviceProvisionType.CHECK_PRE_PROVISIONED_DEVICES) {
      const existing = await this.deviceRepository.findOne({
        where: {
          name: dto.deviceName,
          deviceProfileId: profile.id,
          tenantId: profile.tenantId,
        },
      });

      if (!existing) return fail('Device is not pre-provisioned');

      return this.buildProvisioningSuccess(existing);
    }

    // ── Allow-create-new ───────────────────────────────────────────────────

    // Idempotent re-provision: a device that reboots and re-provisions must
    // get its existing credentials back, not a duplicate row. Without this a
    // crash-looping device would create unbounded devices through a public
    // endpoint.
    const alreadyProvisioned = await this.deviceRepository.findOne({
      where: {
        name: dto.deviceName,
        deviceProfileId: profile.id,
        tenantId: profile.tenantId,
      },
    });

    if (alreadyProvisioned) {
      this.logger.log(
        `Re-provisioning existing device ${alreadyProvisioned.deviceKey}`,
      );
      return this.buildProvisioningSuccess(alreadyProvisioned);
    }

    // The subscription guard cannot run on a public route, so the tenant's
    // device quota is enforced here instead — otherwise provisioning would be
    // an unmetered way past the plan limit.
    const withinQuota = await this.subscriptionsService.canTenantPerformAction(
      profile.tenantId,
      'devices',
    );

    if (!withinQuota) {
      return fail('Device limit reached for this tenant');
    }

    // devices.userId is NOT NULL. A provisioned device has no interactive
    // creator, so it inherits the profile's creator, falling back to a
    // configured service account.
    const ownerUserId = profile.createdBy ?? process.env.SYSTEM_USER_ID;

    if (!ownerUserId) {
      this.logger.error(
        `Cannot provision against profile ${profile.id}: profile has no createdBy ` +
          `and SYSTEM_USER_ID is not set`,
      );
      return fail('Provisioning is not configured for this device profile');
    }

    const deviceKey = `dev_${crypto.randomBytes(8).toString('hex')}`;

    const collision = await this.deviceRepository.findOne({
      where: { deviceKey },
    });

    if (collision) return fail('Device key collision — please retry');

    // INACTIVE (not OFFLINE) on purpose: DeviceListenerService only promotes
    // INACTIVE → ACTIVE on first telemetry, so a device parked in OFFLINE
    // would never come online through the MQTT path.
    const device = this.deviceRepository.create({
      deviceKey,
      name: dto.deviceName,
      type: dto.deviceType ?? DeviceType.SENSOR,
      tenantId: profile.tenantId,
      deviceProfileId: profile.id,
      userId: ownerUserId,
      status: DeviceStatus.INACTIVE,
      metadata: { provisioned: true, provisionedAt: new Date().toISOString() },
    });

    const savedDevice = await this.deviceRepository.save(device);

    void this.subscriptionsService.incrementTenantUsage(
      profile.tenantId as any,
      'devices',
      1,
    );

    // Same post-create side effect as DevicesService.create() — non-fatal.
    try {
      savedDevice.deviceProfile = profile;
      await this.profileAlarmService.materialiseProfileAlarms(savedDevice);
    } catch (err) {
      this.logger.error(
        `Failed to materialise profile alarms for provisioned device ` +
          `${savedDevice.deviceKey}: ${(err as Error).message}`,
      );
    }

    await this.credentialsService.createCredentials(savedDevice);

    this.logger.log(
      `Provisioned device ${savedDevice.deviceKey} on profile ${profile.name}`,
    );

    return this.buildProvisioningSuccess(savedDevice);
  }

  /** Reads back a device's real secret for the provisioning handshake. */
  private async buildProvisioningSuccess(
    device: Device,
  ): Promise<ProvisionDeviceResponseDto> {
    try {
      const { credentialsType, credentialsValue } =
        await this.credentialsService.getProvisioningCredentials(device.id);

      return {
        status: 'SUCCESS',
        credentialsType,
        credentialsValue,
        deviceKey: device.deviceKey,
        deviceId: device.id,
      };
    } catch (err) {
      this.logger.error(
        `Provisioning failed for ${device.deviceKey}: ${(err as Error).message}`,
      );
      return {
        status: 'FAILURE',
        errorMsg: 'Device has no active credentials',
      };
    }
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

  // ── Bulk delete / bulk update (per-id outcomes) ───────────────────────────
  //
  // TRANSACTION GRANULARITY: ONE TRANSACTION PER ITEM, chosen deliberately.
  // A per-batch transaction would roll back 49 good deletes because the 50th
  // id belonged to another tenant, which contradicts the partial-success
  // contract these routes exist to provide. Per item, each device's
  // credentials + placements + assignment rows + counter adjustments + the
  // soft delete itself are all-or-nothing, and a failure is reported against
  // that one id.
  //
  // WHAT CASCADES when a device is soft-deleted:
  //   - device_credentials  — HARD deleted. The DB-level onDelete:'CASCADE' on
  //     DeviceCredentials.deviceId only fires on a hard delete of the device,
  //     and a soft delete leaves the FK row present, so credentials that could
  //     still authenticate an MQTT connection would outlive the device. Same
  //     reasoning and same order as the single-device remove().
  //   - floor_plan_devices  — soft-removed. Its FK is also onDelete:'CASCADE'
  //     and so also does not fire; the entity's own comment says it exists to
  //     stop placements orphaning when a device goes away.
  //   - customer_devices / user_devices — deleted, and the denormalised
  //     counters they feed (customers.usageCounters.devices and
  //     customer_user_limits.usageCounters.devices) are decremented by the
  //     number of rows actually removed. Without this a customer's device
  //     allocation is consumed forever by devices that no longer exist.
  //   - subscriptions.usage.devices — decremented once per tenant for the
  //     number of devices actually deleted, after the loop.
  //
  // WHAT IS RETAINED (deliberately not cascaded): telemetry, attributes,
  // alarms and device_commands. They are the historical record of what the
  // device did; deleting a device is an inventory action, not a request to
  // erase its history. Telemetry in particular is the largest table in the
  // platform and a synchronous cascade of it would make a 100-device delete
  // unbounded in time.
  //
  // WHAT BLOCKS: a device with an ACTIVE or ACKNOWLEDGED alarm. A live
  // incident must be cleared or resolved first — deleting the device would
  // hide an open alarm from every alarm list while leaving the row behind.

  async bulkDelete(dto: BulkDeleteDevicesDto, user: User): Promise<BulkResultDto> {
    const result = new BulkResultBuilder(dto.ids);
    const devices = await this.resolveForBulk(result.ids, user);

    // One query for the block rule rather than one per device.
    const openAlarms = await this.countOpenAlarmsByDevice([...devices.keys()]);

    for (const id of result.ids) {
      const device = devices.get(id);

      if (!device) {
        // Covers "no such device" and "belongs to another tenant" with the
        // same answer — a caller must not learn that a foreign id exists.
        result.notFound(id, 'Device not found in your scope');
        continue;
      }

      const alarmCount = openAlarms.get(id) ?? 0;
      if (alarmCount > 0) {
        result.blocked(
          id,
          `Device has ${alarmCount} active or acknowledged alarm(s); clear or resolve them first`,
        );
        continue;
      }

      try {
        await this.dataSource.transaction(async (manager) => {
          await manager.delete(DeviceCredentials, { deviceId: device.id });
          await this.detachDeviceReferences(manager, device);
          await manager.softRemove(device);
        });
        result.success(id);
      } catch (err) {
        this.logger.error(
          `Bulk delete failed for device ${id}: ${(err as Error).message}`,
        );
        result.failed(id, (err as Error).message);
      }
    }

    await this.releaseDeviceQuota(
      result.successfulIds().map((id) => devices.get(id)!),
    );

    return result.build();
  }

  async bulkUpdate(dto: BulkUpdateDevicesDto, user: User): Promise<BulkResultDto> {
    // `undefined` means "field absent — leave it alone"; an explicit null
    // means "clear it". Testing `!== undefined` is what makes omitting a
    // field safe under the global ValidationPipe's transform.
    //
    // The patch is applied with repository.update(), not save(): TypeORM's
    // save() diffs against the loaded entity and treats a property set to
    // undefined as "unchanged", so assigning `undefined` to clear a column
    // silently does nothing. `null` through update() writes a real NULL,
    // which is what unassigning a customer has to do.
    const patch: Record<string, unknown> = {};
    if (dto.status !== undefined) patch.status = dto.status;
    if (dto.customerId !== undefined) patch.customerId = dto.customerId;
    if (dto.assetId !== undefined) patch.assetId = dto.assetId;

    if (Object.keys(patch).length === 0) {
      throw new BadRequestException({
        message: 'No updatable field supplied',
        errors: [
          'Supply at least one of: status, customerId, assetId',
          'Other device fields are not bulk-updatable by design',
        ],
      });
    }

    // The target customer / asset is one value shared by the whole batch, so a
    // foreign or unknown id is a request-level error (400), not a per-item
    // outcome — nothing in the batch could ever succeed.
    if (dto.customerId) {
      await this.assertCustomerInTenant(dto.customerId, user);
    }
    if (dto.assetId) {
      await this.assertAssetInTenant(dto.assetId, user.tenantId);
    }

    const result = new BulkResultBuilder(dto.ids);
    const devices = await this.resolveForBulk(result.ids, user);

    for (const id of result.ids) {
      const device = devices.get(id);

      if (!device) {
        result.notFound(id, 'Device not found in your scope');
        continue;
      }

      const changes = Object.entries(patch).filter(
        ([key, value]) =>
          (device[key as keyof Device] ?? null) !== (value ?? null),
      );

      if (changes.length === 0) {
        result.skipped(id, 'Already in the requested state');
        continue;
      }

      try {
        await this.dataSource.transaction(async (manager) => {
          const row = { ...patch };
          // Mirror activate(): a device that becomes ACTIVE for the first time
          // gets its activation timestamp, so the bulk path and the
          // single-device route leave the same row behind.
          if (patch.status === DeviceStatus.ACTIVE && !device.activatedAt) {
            row.activatedAt = new Date();
          }
          await manager.update(Device, { id: device.id }, row);
        });
        result.success(id);
      } catch (err) {
        this.logger.error(
          `Bulk update failed for device ${id}: ${(err as Error).message}`,
        );
        result.failed(id, (err as Error).message);
      }
    }

    return result.build();
  }

  // ── Bulk helpers ──────────────────────────────────────────────────────────

  /**
   * Re-resolves every requested id against the caller's own scope, server
   * side. This is the security boundary of the bulk routes: the request body
   * is a bare array of uuids, so nothing but this lookup stops a caller from
   * listing another tenant's device ids.
   */
  private async resolveForBulk(
    ids: string[],
    user: User,
  ): Promise<Map<string, Device>> {
    if (ids.length === 0) return new Map();

    // applyAccessFilter() adds no tenant predicate when user.tenantId is
    // falsy, which is correct for SUPER_ADMIN and a cross-tenant read for
    // anybody else. Deny instead of running an unscoped IN (...) query.
    if (user.role !== UserRole.SUPER_ADMIN && !user.tenantId) {
      this.logger.warn(
        `Bulk request from user ${user.id} with role ${user.role} and no tenantId — denied`,
      );
      return new Map();
    }

    const qb = this.deviceRepository
      .createQueryBuilder('device')
      .where('device.id IN (:...ids)', { ids });

    this.applyAccessFilter(qb, user);

    const rows = await qb.getMany();
    return new Map(rows.map((device) => [device.id, device]));
  }

  /** deviceId → number of alarms still open on it. */
  private async countOpenAlarmsByDevice(
    deviceIds: string[],
  ): Promise<Map<string, number>> {
    if (deviceIds.length === 0) return new Map();

    const rows: Array<{ deviceId: string; count: string }> =
      await this.dataSource.query(
        `SELECT "deviceId", COUNT(*) AS count
           FROM alarms
          WHERE "deviceId" = ANY($1)
            AND status::text = ANY($2)
            AND deleted_at IS NULL
          GROUP BY "deviceId"`,
        [deviceIds, [AlarmStatus.ACTIVE, AlarmStatus.ACKNOWLEDGED]],
      );

    return new Map(rows.map((row) => [row.deviceId, Number(row.count)]));
  }

  private async assertCustomerInTenant(
    customerId: string,
    user: User,
  ): Promise<void> {
    const rows: Array<{ id: string }> = await this.dataSource.query(
      user.tenantId
        ? `SELECT id FROM customers WHERE id = $1 AND "tenantId" = $2 AND deleted_at IS NULL`
        : `SELECT id FROM customers WHERE id = $1 AND deleted_at IS NULL`,
      user.tenantId ? [customerId, user.tenantId] : [customerId],
    );

    if (rows.length === 0) {
      throw new NotFoundException(`Customer ${customerId} not found`);
    }
  }

  /**
   * Removes the rows that point at a device and would otherwise survive its
   * soft delete, keeping the counters they feed honest. Runs inside the
   * caller's per-item transaction.
   *
   * Raw SQL rather than repositories on purpose: these four tables belong to
   * FloorPlansModule and AssignmentsModule, and `AssignmentService` maintains
   * the same jsonb counters with the same statements.
   */
  private async detachDeviceReferences(
    manager: EntityManager,
    device: Device,
  ): Promise<void> {
    // Floor plan placements — soft, like the device itself.
    await manager.query(
      `UPDATE floor_plan_devices
          SET deleted_at = now()
        WHERE "deviceId" = $1 AND deleted_at IS NULL`,
      [device.id],
    );

    // User-level assignments first: their counter lives on
    // customer_user_limits and is keyed by (userId, customerId).
    await manager.query(
      `UPDATE customer_user_limits cul
          SET "usageCounters" = jsonb_set(
                cul."usageCounters",
                '{devices}',
                GREATEST(0, (COALESCE(cul."usageCounters"->>'devices', '0')::int - sub.cnt))::text::jsonb
              )
         FROM (
                SELECT "userId", "customerId", COUNT(*)::int AS cnt
                  FROM user_devices
                 WHERE "deviceId" = $1
                 GROUP BY "userId", "customerId"
              ) AS sub
        WHERE cul."userId" = sub."userId"
          AND cul."customerId" = sub."customerId"`,
      [device.id],
    );
    await manager.query(`DELETE FROM user_devices WHERE "deviceId" = $1`, [
      device.id,
    ]);

    // Customer-level assignments and customers.usageCounters.devices.
    await manager.query(
      `UPDATE customers c
          SET "usageCounters" = jsonb_set(
                c."usageCounters",
                '{devices}',
                GREATEST(0, (COALESCE(c."usageCounters"->>'devices', '0')::int - sub.cnt))::text::jsonb
              )
         FROM (
                SELECT "customerId", COUNT(*)::int AS cnt
                  FROM customer_devices
                 WHERE "deviceId" = $1
                 GROUP BY "customerId"
              ) AS sub
        WHERE c.id = sub."customerId"`,
      [device.id],
    );
    await manager.query(`DELETE FROM customer_devices WHERE "deviceId" = $1`, [
      device.id,
    ]);
  }

  /**
   * Gives the plan quota back, one UPDATE per distinct tenant rather than one
   * per device. Non-fatal for the same reason the single-device remove() is:
   * the devices ARE deleted, so a failed counter write must not be reported
   * as a failed delete. Without it the counter only ever climbs and a tenant
   * that creates and deletes devices is eventually locked out of creating any.
   */
  private async releaseDeviceQuota(devices: Device[]): Promise<void> {
    const perTenant = new Map<string, number>();
    for (const device of devices) {
      if (!device.tenantId) continue;
      perTenant.set(device.tenantId, (perTenant.get(device.tenantId) ?? 0) + 1);
    }

    for (const [tenantId, count] of perTenant) {
      try {
        await this.subscriptionsService.decrementTenantUsage(
          tenantId,
          'devices',
          count,
        );
      } catch (err) {
        this.logger.error(
          `Failed to decrement devices usage for tenant ${tenantId} by ${count}`,
          err,
        );
      }
    }
  }

  // ── Offline cron ──────────────────────────────────────────────────────────

  /**
   * ── Why this one IS locked, despite being a bulk UPDATE ──────────────────
   * The UPDATE on its own is idempotent — ACTIVE+stale → OFFLINE converges,
   * and a second replica finds nothing left to flip. What is not idempotent is
   * the loop underneath it: `handleDeviceOffline()` emits `device.offline` and
   * `device.disconnected`, and `AutomationListener` turns the first into a
   * DEVICE_STATUS automation run while the audit handler turns the second into
   * a log row.
   *
   * Both replicas SELECT before either UPDATEs, so both see the same stale
   * rows and both emit. On three replicas a device going quiet fired every
   * "device went offline" automation three times — including its actions — and
   * wrote three disconnect rows. The read-then-emit is what makes the lock
   * necessary; it would be safe to leave unlocked if it were only the UPDATE.
   */
  @DistributedCron(CronExpression.EVERY_5_MINUTES, {
    name: 'devices-offline-sweep',
    lockTtl: 120,
  })
  async checkOfflineDevices(): Promise<void> {
    const fiveMinutesAgo = new Date(Date.now() - 5 * 60 * 1000);

    const staleDevices = await this.deviceRepository.find({
      where: { status: DeviceStatus.ACTIVE, lastSeenAt: LessThan(fiveMinutesAgo) },
    });

    if (staleDevices.length === 0) return;

    // One UPDATE for the whole sweep. This cron is not tenant-partitioned, so
    // the previous per-device save() was a write per stale device across every
    // tenant, every five minutes.
    await this.deviceRepository.update(
      { id: In(staleDevices.map((d) => d.id)) },
      { status: DeviceStatus.OFFLINE },
    );

    // Owners are looked up once per distinct userId, not once per device —
    // devices in a tenant overwhelmingly share a handful of owners.
    const ownerIds = [...new Set(staleDevices.map((d) => d.userId).filter(Boolean))];
    const owners = new Map<string, User>();

    for (const ownerId of ownerIds) {
      try {
        owners.set(ownerId, await this.userService.findOne(ownerId));
      } catch {
        // A deleted owner must not abort the sweep for every other device —
        // previously the NotFoundException from findOne() did exactly that,
        // leaving the remaining devices stuck in ACTIVE.
        this.logger.warn(`Owner ${ownerId} not found while marking devices offline`);
      }
    }

    for (const device of staleDevices) {
      device.status = DeviceStatus.OFFLINE;
      this.handleDeviceOffline(device, owners.get(device.userId));
    }

    this.logger.log(`Marked ${staleDevices.length} device(s) as offline`);
  }

  // ── Private helpers ───────────────────────────────────────────────────────

  /**
   * Apply tenant / customer filters to any QueryBuilder based on the
   * requesting user's role. Call this once per query — do not add manual
   * andWhere clauses on top of it.
   *
   * The logic used to live here and was copied, with drift, into four other
   * services. It is now `applyAccessScope()` in `@common/scoping`, and this
   * is a one-line forwarder kept so the call sites in this file read the same
   * as before. Behaviour is unchanged: falsy tenantId denies, falsy
   * customerId on a customer-scoped role denies, SUPER_ADMIN is unscoped.
   */
  private applyAccessFilter(
    qb: ReturnType<Repository<Device>['createQueryBuilder']>,
    user: User,
  ): void {
    applyAccessScope(qb, 'device', user);
  }

  private assertAdmin(user: User): void {
    if (
      user.role !== UserRole.SUPER_ADMIN &&
      user.role !== UserRole.TENANT_ADMIN
    ) {
      throw new ForbiddenException('Only admins can perform this action');
    }
  }

  private handleDeviceOffline(device: Device, user?: User): void {
    this.eventEmitter.emit('device.offline', { device, user });
    // `device.offline` is what AutomationListener and the gateway listen for.
    // The audit handler is named `device.disconnected` and had no emitter at
    // all, so a device dropping off was never recorded. Both names are emitted
    // rather than renaming either: the automation side is a published contract
    // and the audit side is the one with the handler.
    this.eventEmitter.emit('device.disconnected', {
      deviceId: device.id,
      deviceName: device.name,
      tenantId: device.tenantId,
      customerId: device.customerId,
      reason: 'lastSeenAt stale — marked offline by checkOfflineDevices()',
    });
    this.logger.warn(`Device offline: ${device.name} (${device.id})`);
  }

  private handleDeviceOnline(device: Device, user: User): void {
    // The audit handler reads a flat shape; `{ device, user }` alone left
    // `tenantId` undefined, which is a NOT NULL violation on audit_logs.
    this.eventEmitter.emit('device.connected', {
      device,
      user,
      deviceId: device.id,
      deviceName: device.name,
      tenantId: device.tenantId,
      customerId: device.customerId,
    });
    this.logger.log(`Device online: ${device.name} (${device.id})`);
  }
}