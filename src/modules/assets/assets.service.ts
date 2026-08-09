import {
  Injectable,
  NotFoundException,
  ConflictException,
  BadRequestException,
  ForbiddenException,
  Logger,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, Like, In, IsNull } from 'typeorm';
import { EventEmitter2 } from '@nestjs/event-emitter';
import {
  Alarm,
  Asset,
  AssetProfile,
  Device,
  Telemetry,
  User,
  FloorPlan,
  FloorPlanDevice,
} from '@modules/index.entities';
import { AlarmStatus, AssetType } from '@common/enums/index.enum';
import type {
  FloorConfig,
  ProfileField,
} from '@common/interfaces/index.interface';
import {
  AssetAlarmsQueryDto,
  CreateAssetDto,
  UpdateAssetDto,
  QueryAssetsDto,
  UpdateAttributesDto,
} from './dto/assets.dto';
import { UserRole } from '@common/enums/index.enum';
import { PaginatedResponseDto, PaginationDto, SortOrder } from '@/common/dto/pagination.dto';
import { SubscriptionsService } from '@modules/subscriptions/subscriptions.service';

@Injectable()
export class AssetsService {
  private readonly logger = new Logger(AssetsService.name);

  constructor(
    @InjectRepository(Asset)
    private assetRepository: Repository<Asset>,
    @InjectRepository(Device)
    private deviceRepository: Repository<Device>,
    // Repositories are injected directly rather than importing FloorPlansModule —
    // FloorPlansModule already depends on the Asset repository, so a module-level
    // import in this direction would create a cycle.
    @InjectRepository(FloorPlan)
    private floorPlanRepository: Repository<FloorPlan>,
    @InjectRepository(FloorPlanDevice)
    private floorPlanDeviceRepository: Repository<FloorPlanDevice>,
    // Registered directly rather than importing ProfilesModule — ProfilesModule
    // already depends on the Asset repository, so importing it here would cycle.
    @InjectRepository(AssetProfile)
    private assetProfileRepository: Repository<AssetProfile>,
    // Read-only, for the asset roll-ups. Registered as repositories rather
    // than by importing TelemetryModule / AlarmsModule — see assets.module.ts
    // for why that direction would cycle.
    @InjectRepository(Telemetry)
    private telemetryRepository: Repository<Telemetry>,
    @InjectRepository(Alarm)
    private alarmRepository: Repository<Alarm>,
    private eventEmitter: EventEmitter2,
    // SubscriptionsModule is @Global(), so no module import is needed here —
    // which also keeps this free of the cycles described above.
    private subscriptionsService: SubscriptionsService,
  ) {}

  /**
   * Create a new asset
   */
  async create(createAssetDto: CreateAssetDto, user: User): Promise<Asset> {
    // Check if parent asset exists
    if (createAssetDto.parentAssetId) {
      const parentAsset = await this.assetRepository.findOne({
        where: { id: createAssetDto.parentAssetId, tenantId: user.tenantId },
      });

      if (!parentAsset) {
        throw new NotFoundException('Parent asset not found');
      }

      // Validate hierarchy (prevent circular references)
      const isCircular = await this.wouldCreateCircularReference(
        null,
        createAssetDto.parentAssetId,
      );

      if (isCircular) {
        throw new BadRequestException('Cannot create circular asset hierarchy');
      }

      if (user.role === UserRole.CUSTOMER_USER) {
        if (parentAsset.customerId !== user.customerId) {
          throw new ForbiddenException(
            'Cannot create asset under another customer\'s asset',
          );
        }
      }
    }

    // Reject the asset if its configuration does not satisfy the profile schema.
    await this.assertConfigurationValid(
      createAssetDto.assetProfileId,
      createAssetDto.configuration,
      user.tenantId,
    );

    const asset = this.assetRepository.create(
      {
        ...createAssetDto,
        tenantId: user.tenantId,
        customerId: user.role === UserRole.CUSTOMER_USER ? user.customerId : createAssetDto.customerId
      }
    );
    const savedAsset = await this.assetRepository.save(asset);

    // Keep subscription.usage.assets honest — it is what
    // SubscriptionLimitGuard and GET /subscriptions/usage both read.
    // Non-fatal: the asset exists, so a counter failure must not fail the
    // request.
    try {
      await this.subscriptionsService.incrementTenantUsage(
        savedAsset.tenantId,
        'assets',
        1,
      );
    } catch (err) {
      this.logger.error(
        `Failed to increment assets usage for tenant ${savedAsset.tenantId}`,
        err,
      );
    }

    // Emit event
    this.eventEmitter.emit('asset.created', { asset: savedAsset });

    return savedAsset;
  }

  /**
   * Find all assets with filters and pagination
   */
  /**
 * Find all assets with filters and pagination
 */
private static readonly ALLOWED_SORT_FIELDS: Record<string, string> = {
  name: 'asset.name',
  createdAt: 'asset.createdAt',
  updatedAt: 'asset.updatedAt',
  type: 'asset.type',
  label: 'asset.label',
};

async findAll(
  user: User,
  customerId: string | undefined,
  queryDto: QueryAssetsDto,
): Promise<PaginatedResponseDto<Asset>> {
  const { page, limit, skip, take, search, sortBy, sortOrder } = queryDto;

  const qb = this.assetRepository.createQueryBuilder('asset');

  // ── Tenant scoping ────────────────────────────────────────────────────────
  if (user.role === UserRole.SUPER_ADMIN) {
    // SUPER_ADMIN: optionally filter by tenantId query param, otherwise sees all
    if (user.tenantId) {
      qb.andWhere('asset.tenantId = :tenantId', { tenantId: user.tenantId });
    }
  } else {
    // All other roles are always scoped to their own tenant via JWT claim
    qb.andWhere('asset.tenantId = :tenantId', { tenantId: user.tenantId });
  }

  // ── Customer scoping ──────────────────────────────────────────────────────
  if (
    user.role === UserRole.CUSTOMER_USER ||
    user.role === UserRole.CUSTOMER
  ) {
    // Trust JWT claim first, fall back to resolved decorator value
    const effectiveCustomerId = user.customerId ?? customerId;
    if (!effectiveCustomerId) {
      return PaginatedResponseDto.create([], page, limit, 0);
    }
    qb.andWhere('asset.customerId = :customerId', {
      customerId: effectiveCustomerId,
    });
  } else if (customerId) {
    // Tenant admin/user filtering by a specific customer (e.g. customer detail page)
    qb.andWhere('asset.customerId = :customerId', { customerId });
  }

  // ── Optional filters ──────────────────────────────────────────────────────
  if (search) {
    qb.andWhere(
      '(asset.name ILIKE :search OR asset.label ILIKE :search OR asset.description ILIKE :search)',
      { search: `%${search}%` },
    );
  }

  if (queryDto.type) {
    qb.andWhere('asset.type = :type', { type: queryDto.type });
  }

  if (queryDto.assetProfileId) {
    qb.andWhere('asset.assetProfileId = :assetProfileId', {
      assetProfileId: queryDto.assetProfileId,
    });
  }

  if (queryDto.parentAssetId) {
    qb.andWhere('asset.parentAssetId = :parentAssetId', {
      parentAssetId: queryDto.parentAssetId,
    });
  }

  if (queryDto.active !== undefined) {
    qb.andWhere('asset.active = :active', { active: queryDto.active });
  }

  if (queryDto.tags?.length) {
    qb.andWhere('asset.tags && :tags', { tags: queryDto.tags });
  }

  // ── Sorting & pagination ──────────────────────────────────────────────────
  const sortColumn =
    AssetsService.ALLOWED_SORT_FIELDS[sortBy ?? ''] ?? 'asset.createdAt';

  qb.leftJoinAndSelect('asset.parentAsset', 'parentAsset')
    .orderBy(sortColumn, sortOrder ?? SortOrder.DESC)
    .skip(skip)
    .take(take);

  const [assets, total] = await qb.getManyAndCount();
  return PaginatedResponseDto.create(assets, page, limit, total);
}

  /**
   * Find one asset by ID
   */
   async findOne(id: string, user: User): Promise<Asset> {
    const queryBuilder = this.assetRepository
      .createQueryBuilder('asset')
      .leftJoinAndSelect('asset.parentAsset', 'parentAsset')
      // Always join the profile: the frontend renders `configuration` against
      // `assetProfile.schema`, so the schema must travel with the asset.
      .leftJoinAndSelect('asset.assetProfile', 'assetProfile')
      .where('asset.id = :id', { id });

    // Apply customer filtering
    if (user.role === UserRole.CUSTOMER_USER) {
      if (!user.customerId) {
        throw new ForbiddenException('No customer assigned');
      }
      queryBuilder.andWhere('asset.customerId = :customerId', {
        customerId: user.customerId,
      });
    } else if (user.role === UserRole.TENANT_ADMIN) {
      queryBuilder.andWhere('asset.tenantId = :tenantId', {
        tenantId: user.tenantId,
      });
    }

    const asset = await queryBuilder.getOne();

    if (!asset) {
      throw new NotFoundException('Asset not found');
    }

    return asset;
  }

  /**
   * Update asset
   */
   async update(
    id: string,
    updateAssetDto: UpdateAssetDto,
    user: User,
  ): Promise<Asset> {
    const asset = await this.findOne(id, user);

    // Customer users cannot change customerId
    if (
      user.role === UserRole.CUSTOMER_USER &&
      updateAssetDto.customerId &&
      updateAssetDto.customerId !== asset.customerId
    ) {
      throw new ForbiddenException('Cannot change customer assignment');
    }

    // If parent is being changed, validate hierarchy
    if (
      updateAssetDto.parentAssetId &&
      updateAssetDto.parentAssetId !== asset.parentAssetId
    ) {
      const isCircular = await this.wouldCreateCircularReference(
        id,
        updateAssetDto.parentAssetId,
      );

      if (isCircular) {
        throw new BadRequestException('Cannot create circular asset hierarchy');
      }

      // Validate parent asset access for customer users
      if (user.role === UserRole.CUSTOMER_USER) {
        const parentAsset = await this.assetRepository.findOne({
          where: { id: updateAssetDto.parentAssetId },
        });

        if (parentAsset && parentAsset.customerId !== user.customerId) {
          throw new ForbiddenException(
            'Cannot move asset under another customer\'s asset',
          );
        }
      }
    }

    // Validate against whichever profile the asset will end up on, using the
    // configuration it will end up with — a partial PATCH of `configuration`
    // still has to satisfy the schema as a whole.
    if (
      updateAssetDto.assetProfileId !== undefined ||
      updateAssetDto.configuration !== undefined
    ) {
      await this.assertConfigurationValid(
        updateAssetDto.assetProfileId ?? asset.assetProfileId,
        updateAssetDto.configuration ?? asset.configuration,
        asset.tenantId,
      );
    }

    Object.assign(asset, updateAssetDto);
    const updatedAsset = await this.assetRepository.save(asset);

    // Emit event
    this.eventEmitter.emit('asset.updated', { asset: updatedAsset });

    return updatedAsset;
  }

  // ══════════════════════════════════════════════════════════════════════════
  // PROFILE SCHEMA VALIDATION
  // ══════════════════════════════════════════════════════════════════════════

  /**
   * Validate an asset's `configuration` against its AssetProfile `schema`.
   *
   * Only required fields are enforced; optional fields are range/option checked
   * when present. Returns the error list rather than throwing so it can also
   * back a dry-run endpoint.
   */
  async validateAssetConfiguration(
    profileId: string,
    configuration: Record<string, any> | undefined,
    tenantId: string | undefined,
  ): Promise<{ valid: boolean; errors: string[] }> {
    const profile = await this.assetProfileRepository.findOne({
      where: { id: profileId, tenantId },
    });

    // Unknown profile is a caller error, not a silent pass.
    if (!profile) {
      return {
        valid: false,
        errors: [`Asset profile ${profileId} not found for this tenant`],
      };
    }

    if (!profile.schema?.fields?.length) return { valid: true, errors: [] };

    const errors: string[] = [];

    for (const field of profile.schema.fields) {
      const value = configuration?.[field.key];
      const missing = value === undefined || value === null || value === '';

      if (field.required && missing) {
        errors.push(`Field "${field.label}" (${field.labelAr}) is required`);
        continue;
      }

      // Optional-and-absent needs no further checks.
      if (missing) continue;

      errors.push(...this.validateFieldValue(field, value));
    }

    return { valid: errors.length === 0, errors };
  }

  /** Type / range / option checks for a single supplied value. */
  private validateFieldValue(field: ProfileField, value: any): string[] {
    const errors: string[] = [];

    switch (field.type) {
      case 'number': {
        const num = Number(value);
        if (typeof value === 'boolean' || Number.isNaN(num)) {
          errors.push(`Field "${field.label}" must be a number`);
          break;
        }
        if (field.min !== undefined && num < field.min) {
          errors.push(`"${field.label}" must be at least ${field.min}`);
        }
        if (field.max !== undefined && num > field.max) {
          errors.push(`"${field.label}" must be at most ${field.max}`);
        }
        break;
      }

      case 'boolean':
        if (typeof value !== 'boolean') {
          errors.push(`Field "${field.label}" must be true or false`);
        }
        break;

      case 'select': {
        const allowed = (field.options ?? []).map((o) => o.value);
        if (allowed.length && !allowed.includes(String(value))) {
          errors.push(
            `"${field.label}" must be one of: ${allowed.join(', ')}`,
          );
        }
        break;
      }

      case 'multiselect': {
        if (!Array.isArray(value)) {
          errors.push(`Field "${field.label}" must be an array`);
          break;
        }
        const allowed = (field.options ?? []).map((o) => o.value);
        if (allowed.length) {
          const invalid = value
            .map(String)
            .filter((v) => !allowed.includes(v));
          if (invalid.length) {
            errors.push(
              `"${field.label}" contains invalid value(s): ${invalid.join(', ')}. ` +
                `Allowed: ${allowed.join(', ')}`,
            );
          }
        }
        break;
      }

      case 'date':
        if (Number.isNaN(Date.parse(String(value)))) {
          errors.push(`Field "${field.label}" must be a valid date`);
        }
        break;

      case 'floors_array':
      case 'devices_array':
        if (!Array.isArray(value)) {
          errors.push(`Field "${field.label}" must be an array`);
        }
        break;

      case 'text':
      default:
        break;
    }

    return errors;
  }

  /** Throws BadRequestException when the configuration fails validation. */
  private async assertConfigurationValid(
    profileId: string | undefined,
    configuration: Record<string, any> | undefined,
    tenantId: string | undefined,
  ): Promise<void> {
    if (!profileId) return;

    const validation = await this.validateAssetConfiguration(
      profileId,
      configuration,
      tenantId,
    );

    if (!validation.valid) {
      throw new BadRequestException(
        `Asset configuration invalid: ${validation.errors.join('; ')}`,
      );
    }
  }

  // ══════════════════════════════════════════════════════════════════════════
  // DEVICE LINKING RULES (AssetProfile.schema.deviceLinkingConfig)
  // ══════════════════════════════════════════════════════════════════════════

  /**
   * Enforce the profile's device-linking constraints before attaching devices.
   *
   * @param incoming devices about to be attached (already excluding ones
   *                 already on this asset)
   */
  private async assertDeviceLinkingAllowed(
    asset: Asset,
    incoming: Device[],
  ): Promise<void> {
    if (!asset.assetProfileId || incoming.length === 0) return;

    const profile = await this.assetProfileRepository.findOne({
      where: { id: asset.assetProfileId },
    });

    const cfg = profile?.schema?.deviceLinkingConfig;
    if (!cfg) return;

    const currentCount = await this.deviceRepository.count({
      where: { assetId: asset.id },
    });

    if (cfg.allowMultipleDevices === false && currentCount + incoming.length > 1) {
      throw new BadRequestException(
        'This asset type allows only one linked device',
      );
    }

    if (cfg.maxDevices !== undefined && currentCount + incoming.length > cfg.maxDevices) {
      throw new BadRequestException(
        `This asset type allows maximum ${cfg.maxDevices} devices ` +
          `(currently ${currentCount})`,
      );
    }

    if (cfg.deviceTypeFilter?.length) {
      const rejected = incoming.filter(
        (d) => !cfg.deviceTypeFilter!.includes(d.type),
      );
      if (rejected.length) {
        throw new BadRequestException(
          `This asset only allows device types: ${cfg.deviceTypeFilter.join(', ')}. ` +
            `Rejected: ${rejected.map((d) => `${d.name} (${d.type})`).join(', ')}`,
        );
      }
    }
  }

  /**
   * Delete asset
   */
  async remove(id: string, user: User): Promise<void> {
    const asset = await this.findOne(id, user);

    // Only admins can delete assets (or add owner check if needed)
    if (
      user.role !== UserRole.SUPER_ADMIN &&
      user.role !== UserRole.TENANT_ADMIN
    ) {
      throw new ForbiddenException('Only admins can delete assets');
    }

    // Check if asset has children
    const children = await this.assetRepository.count({
      where: { parentAssetId: id },
    });

    if (children > 0) {
      throw new BadRequestException(
        'Cannot delete asset with child assets. Delete children first.',
      );
    }

    // Check if asset has devices attached
    const devices = await this.deviceRepository.count({
      where: { assetId: id },
    });

    if (devices > 0) {
      throw new BadRequestException(
        'Cannot delete asset with attached devices. Detach devices first.',
      );
    }

    await this.assetRepository.softRemove(asset);

    try {
      await this.subscriptionsService.decrementTenantUsage(
        asset.tenantId,
        'assets',
        1,
      );
    } catch (err) {
      this.logger.error(
        `Failed to decrement assets usage for tenant ${asset.tenantId}`,
        err,
      );
    }

    // Emit event
    this.eventEmitter.emit('asset.deleted', { assetId: id });
  }

  /**
   * Get asset hierarchy (children)
   */
  async getHierarchy(
    id: string,
    user: User,
    maxDepth: number = 10,
    includeDevices: boolean = false,
  ): Promise<any> {
    const asset = await this.findOne(id, user); // This checks customer access

    const hierarchy = await this.buildHierarchy(
      asset,
      user,
      maxDepth,
      0,
      includeDevices,
    );

    return hierarchy;
  }

  /**
   * Get root assets (no parent)
   */
   async getRootAssets(user: User): Promise<Asset[]> {
    const queryBuilder = this.assetRepository
      .createQueryBuilder('asset')
      .where('asset.parentAssetId IS NULL');

    // Apply customer filtering
    if (user.role === UserRole.CUSTOMER_USER) {
      if (!user.customerId) {
        return [];
      }
      queryBuilder.andWhere('asset.customerId = :customerId', {
        customerId: user.customerId,
      });
    } else if (user.role === UserRole.TENANT_ADMIN) {
      queryBuilder.andWhere('asset.tenantId = :tenantId', {
        tenantId: user.tenantId,
      });
    }

    return await queryBuilder.orderBy('asset.name', 'ASC').getMany();
  }


  /**
   * Get the asset's floor list, merged with which floors already have a floor plan.
   *
   * This is the entry point the frontend uses to decide which floors still need a
   * DXF uploaded. Floors come from `asset.configuration.floorsData` when present;
   * otherwise they are synthesised as 1..configuration.totalFloors.
   *
   * Floor plans whose floorNumber is not in the configured list (or is null, on
   * rows created before floorNumber was required) are still returned, flagged
   * `inConfiguration: false`, so nothing is silently hidden.
   */
  async getFloors(id: string, user: User) {
    const asset = await this.findOne(id, user);

    const configuration = asset.configuration ?? {};
    const configuredFloors: FloorConfig[] = Array.isArray(
      configuration.floorsData,
    )
      ? configuration.floorsData
      : [];

    const floorPlans = await this.floorPlanRepository.find({
      where: { assetId: asset.id, tenantId: asset.tenantId },
      order: { floorNumber: 'ASC' },
    });

    // One grouped query for placement counts — not one per floor.
    const countRows: Array<{ floorPlanId: string; count: string }> =
      floorPlans.length > 0
        ? await this.floorPlanDeviceRepository
            .createQueryBuilder('placement')
            .select('placement.floorPlanId', 'floorPlanId')
            .addSelect('COUNT(*)', 'count')
            .where('placement.floorPlanId IN (:...ids)', {
              ids: floorPlans.map((fp) => fp.id),
            })
            .groupBy('placement.floorPlanId')
            .getRawMany()
        : [];

    const deviceCountByPlan = new Map(
      countRows.map((row) => [row.floorPlanId, parseInt(row.count, 10) || 0]),
    );

    const planByFloorNumber = new Map<number, FloorPlan>();
    for (const fp of floorPlans) {
      if (fp.floorNumber !== null && fp.floorNumber !== undefined) {
        // First plan wins; duplicates are impossible once the unique constraint
        // on (assetId, floorNumber) is in place, but stay defensive for legacy rows.
        if (!planByFloorNumber.has(fp.floorNumber)) {
          planByFloorNumber.set(fp.floorNumber, fp);
        }
      }
    }

    const totalFloors: number =
      typeof configuration.totalFloors === 'number'
        ? configuration.totalFloors
        : configuredFloors.length || planByFloorNumber.size;

    // Build the configured floor list.
    let baseFloors: FloorConfig[];
    if (configuredFloors.length > 0) {
      baseFloors = [...configuredFloors].sort(
        (a, b) => (a.floorNumber ?? 0) - (b.floorNumber ?? 0),
      );
    } else {
      baseFloors = Array.from({ length: Math.max(0, totalFloors) }, (_, i) => ({
        floorNumber: i + 1,
        name: i === 0 ? 'Ground Floor' : `Floor ${i + 1}`,
      }));
    }

    const describe = (
      floor: FloorConfig,
      plan: FloorPlan | undefined,
      inConfiguration: boolean,
    ) => ({
      floorNumber: floor.floorNumber ?? null,
      floorName:
        floor.name ??
        plan?.floorName ??
        plan?.floor ??
        (floor.floorNumber !== undefined && floor.floorNumber !== null
          ? `Floor ${floor.floorNumber}`
          : null),
      rooms: floor.rooms ?? null,
      area: floor.area ?? null,
      hasFloorPlan: !!plan,
      floorPlanId: plan?.id ?? null,
      floorPlanStatus: plan?.status ?? null,
      hasDxf: !!plan?.dwgFileUrl,
      deviceCount: plan ? (deviceCountByPlan.get(plan.id) ?? 0) : 0,
      inConfiguration,
    });

    const usedPlanIds = new Set<string>();
    const floors = baseFloors.map((floor) => {
      const plan =
        floor.floorNumber !== undefined && floor.floorNumber !== null
          ? planByFloorNumber.get(floor.floorNumber)
          : undefined;
      if (plan) usedPlanIds.add(plan.id);
      return describe(floor, plan, true);
    });

    // Floor plans that don't correspond to any configured floor.
    const orphans = floorPlans
      .filter((fp) => !usedPlanIds.has(fp.id))
      .map((fp) =>
        describe(
          {
            floorNumber: fp.floorNumber as number,
            name: fp.floorName ?? fp.floor,
          },
          fp,
          false,
        ),
      );

    return {
      assetId: asset.id,
      assetName: asset.name,
      assetProfileId: asset.assetProfileId ?? null,
      assetProfileType: (asset.assetProfile as any)?.type ?? null,
      totalFloors,
      floorsWithPlans: floorPlans.length,
      floors: [...floors, ...orphans],
    };
  }

  /**
   * Get asset path (from root to asset)
   */
  async getAssetPath(id: string, user: User): Promise<Asset[]> {
    const path: Asset[] = [];
    let currentAsset = await this.findOne(id, user);

    path.unshift(currentAsset);

    while (currentAsset.parentAssetId) {
      currentAsset = await this.findOne(currentAsset.parentAssetId, user);
      path.unshift(currentAsset);
    }

    return path;
  }

  /**
   * Get child assets, each carrying a live device count.
   *
   * `deviceCount` is computed here rather than read from the denormalised
   * Asset.deviceCount column — nothing in the codebase maintains that column,
   * so it is always 0 and would report every child as empty.
   */
  async getChildren(
    id: string,
    user: User,
  ): Promise<Array<Asset & { deviceCount: number }>> {
    await this.findOne(id, user); // Validate access to parent

    const queryBuilder = this.assetRepository
      .createQueryBuilder('asset')
      .where('asset.parentAssetId = :id', { id });

    // Apply customer filtering
    if (user.role === UserRole.CUSTOMER_USER) {
      queryBuilder.andWhere('asset.customerId = :customerId', {
        customerId: user.customerId,
      });
    } else if (user.role === UserRole.TENANT_ADMIN) {
      queryBuilder.andWhere('asset.tenantId = :tenantId', {
        tenantId: user.tenantId,
      });
    }

    const children = await queryBuilder.orderBy('asset.name', 'ASC').getMany();

    if (children.length === 0) return [];

    const counts = await this.countDevicesByAsset(children.map((c) => c.id));

    return children.map((child) =>
      Object.assign(child, { deviceCount: counts.get(child.id) ?? 0 }),
    );
  }

  /** One grouped query for device counts — not one per asset. */
  private async countDevicesByAsset(
    assetIds: string[],
  ): Promise<Map<string, number>> {
    if (assetIds.length === 0) return new Map();

    const rows: Array<{ assetId: string; count: string }> =
      await this.deviceRepository
        .createQueryBuilder('device')
        .select('device.assetId', 'assetId')
        .addSelect('COUNT(*)', 'count')
        .where('device.assetId IN (:...assetIds)', { assetIds })
        .groupBy('device.assetId')
        .getRawMany();

    return new Map(rows.map((r) => [r.assetId, parseInt(r.count, 10) || 0]));
  }

  // ══════════════════════════════════════════════════════════════════════════
  // ROLL-UPS ACROSS THE ASSET'S DEVICES
  // ══════════════════════════════════════════════════════════════════════════

  /**
   * Latest telemetry for every device linked to this asset.
   *
   * One DISTINCT ON query covers all devices rather than a per-device "latest"
   * lookup, so an asset with 200 sensors still costs two queries.
   *
   * Devices that have never reported are included with `telemetry: null` —
   * "installed but silent" is exactly what an operator needs to see here.
   */
  async getAssetTelemetry(assetId: string, user: User) {
    const asset = await this.findOne(assetId, user); // access check
    const devices = await this.getDevices(assetId, user);

    if (devices.length === 0) {
      return {
        assetId: asset.id,
        assetName: asset.name,
        deviceCount: 0,
        devices: [],
      };
    }

    const deviceIds = devices.map((d) => d.id);

    const latest = await this.telemetryRepository
      .createQueryBuilder('telemetry')
      .distinctOn(['telemetry.deviceId'])
      .where('telemetry.deviceId IN (:...deviceIds)', { deviceIds })
      .andWhere('telemetry.tenantId = :tenantId', { tenantId: asset.tenantId })
      .orderBy('telemetry.deviceId', 'ASC')
      .addOrderBy('telemetry.timestamp', 'DESC')
      .getMany();

    const latestByDevice = new Map(latest.map((t) => [t.deviceId, t]));

    return {
      assetId: asset.id,
      assetName: asset.name,
      deviceCount: devices.length,
      devices: devices.map((device) => {
        const telemetry = latestByDevice.get(device.id);

        return {
          deviceId: device.id,
          deviceKey: device.deviceKey,
          deviceName: device.name,
          deviceType: device.type,
          status: device.status,
          lastSeenAt: device.lastSeenAt ?? null,
          telemetry: telemetry
            ? {
                timestamp: telemetry.timestamp,
                data: telemetry.data,
                temperature: telemetry.temperature ?? null,
                humidity: telemetry.humidity ?? null,
                pressure: telemetry.pressure ?? null,
                batteryLevel: telemetry.batteryLevel ?? null,
                signalStrength: telemetry.signalStrength ?? null,
              }
            : null,
        };
      }),
    };
  }

  /**
   * Alarms raised by any device linked to this asset.
   *
   * Defaults to currently-raised alarms (ACTIVE + ACKNOWLEDGED) — the common
   * question is "what is wrong with this building right now". Pass ?status to
   * widen it to cleared/resolved history.
   */
  async getAssetAlarms(
    assetId: string,
    user: User,
    query: AssetAlarmsQueryDto,
  ): Promise<PaginatedResponseDto<any>> {
    const { page = 1, limit = 20, status, severity } = query;

    const asset = await this.findOne(assetId, user); // access check
    const devices = await this.getDevices(assetId, user);

    if (devices.length === 0) {
      return PaginatedResponseDto.create([], page, limit, 0);
    }

    const qb = this.alarmRepository
      .createQueryBuilder('alarm')
      .leftJoin('alarm.device', 'device')
      .addSelect(['device.id', 'device.name', 'device.deviceKey', 'device.type'])
      .where('alarm.deviceId IN (:...deviceIds)', {
        deviceIds: devices.map((d) => d.id),
      })
      .andWhere('alarm.tenantId = :tenantId', { tenantId: asset.tenantId });

    if (status) {
      qb.andWhere('alarm.status = :status', { status });
    } else {
      qb.andWhere('alarm.status IN (:...activeStatuses)', {
        activeStatuses: [AlarmStatus.ACTIVE, AlarmStatus.ACKNOWLEDGED],
      });
    }

    if (severity) {
      qb.andWhere('alarm.severity = :severity', { severity });
    }

    qb.orderBy('alarm.triggeredAt', 'DESC', 'NULLS LAST')
      .addOrderBy('alarm.createdAt', 'DESC')
      .skip((page - 1) * limit)
      .take(limit);

    const [alarms, total] = await qb.getManyAndCount();

    const data = alarms.map((alarm) => ({
      ...alarm,
      deviceName: alarm.device?.name ?? null,
      deviceKey: alarm.device?.deviceKey ?? null,
    }));

    return PaginatedResponseDto.create(data, page, limit, total);
  }

  /**
   * Assign device to asset
   */
  async assignDevice(
    assetId: string,
    deviceId: string,
    user: User,
  ): Promise<void> {
    const asset = await this.findOne(assetId, user);

    const device = await this.deviceRepository.findOne({
      where: { id: deviceId },
    });

    if (!device) {
      throw new NotFoundException('Device not found');
    }

    // Validate customer match
    if (user.role === UserRole.CUSTOMER_USER) {
      if (device.customerId !== user.customerId) {
        throw new ForbiddenException(
          'Cannot assign device from another customer',
        );
      }
    }

    // Enforce the asset profile's deviceLinkingConfig. Re-assigning a device
    // that is already on this asset is a no-op, so it is not counted.
    if (device.assetId !== assetId) {
      await this.assertDeviceLinkingAllowed(asset, [device]);
    }

    device.assetId = assetId;
    await this.deviceRepository.save(device);

    // Emit event
    this.eventEmitter.emit('asset.device.assigned', {
      assetId,
      deviceId,
    });
  }

  /**
   * Unassign device from asset
   */
  async unassignDevice(
    assetId: string,
    deviceId: string,
    user: User,
  ): Promise<void> {
    await this.findOne(assetId, user); // Validate access

    const device = await this.deviceRepository.findOne({
      where: { id: deviceId, assetId },
    });

    if (!device) {
      throw new NotFoundException(
        'Device not found or not assigned to this asset',
      );
    }

    // Must be null, not '' — assetId is a uuid FK and Postgres rejects an
    // empty string with "invalid input syntax for type uuid".
    device.assetId = null as unknown as undefined;
    await this.deviceRepository.save(device);

    // Emit event
    this.eventEmitter.emit('asset.device.unassigned', {
      assetId,
      deviceId,
    });
  }


  /**
   * Bulk assign devices to asset
   */
   async bulkAssignDevices(
    assetId: string,
    deviceIds: string[],
    user: User,
  ): Promise<void> {
    const asset = await this.findOne(assetId, user);

    const devices = await this.deviceRepository.find({
      where: { id: In(deviceIds) },
    });

    // Validate all devices belong to the same customer (for customer users)
    if (user.role === UserRole.CUSTOMER_USER) {
      const invalidDevices = devices.filter(
        (d) => d.customerId !== user.customerId,
      );

      if (invalidDevices.length > 0) {
        throw new ForbiddenException(
          'Cannot assign devices from another customer',
        );
      }
    }

    // Enforce the asset profile's deviceLinkingConfig against the devices that
    // are not already on this asset.
    await this.assertDeviceLinkingAllowed(
      asset,
      devices.filter((d) => d.assetId !== assetId),
    );

    await this.deviceRepository.update({ id: In(deviceIds) }, { assetId });

    // Emit event
    this.eventEmitter.emit('asset.devices.bulk.assigned', {
      assetId,
      deviceIds,
    });
  }

  /**
   * Get devices assigned to asset
   */
  async getDevices(assetId: string, user: User): Promise<Device[]> {
    await this.findOne(assetId, user); // Validate access

    const queryBuilder = this.deviceRepository
      .createQueryBuilder('device')
      .where('device.assetId = :assetId', { assetId });

    // Apply customer filtering for devices too
    if (user.role === UserRole.CUSTOMER_USER) {
      queryBuilder.andWhere('device.customerId = :customerId', {
        customerId: user.customerId,
      });
    }

    return await queryBuilder.orderBy('device.name', 'ASC').getMany();
  }

  /**
   * Update asset attributes
   */
  async updateAttributes(
    id: string,
    updateAttributesDto: UpdateAttributesDto,
    user: User,
  ): Promise<Asset> {
    const asset = await this.findOne(id, user);

    asset.attributes = {
      ...asset.attributes,
      ...updateAttributesDto.attributes,
    };

    return await this.assetRepository.save(asset);
  }

  /**
   * Search assets by location
   */
  async searchByLocation(
    latitude: number,
    longitude: number,
    radiusKm: number,
    user: User,
  ): Promise<Asset[]> {
    const queryBuilder = this.assetRepository
      .createQueryBuilder('asset')
      .where("asset.location->>'latitude' IS NOT NULL")
      .andWhere("asset.location->>'longitude' IS NOT NULL");

    // Apply customer filtering
    if (user.role === UserRole.CUSTOMER_USER) {
      if (!user.customerId) {
        return [];
      }
      queryBuilder.andWhere('asset.customerId = :customerId', {
        customerId: user.customerId,
      });
    } else if (user.role === UserRole.TENANT_ADMIN) {
      queryBuilder.andWhere('asset.tenantId = :tenantId', {
        tenantId: user.tenantId,
      });
    }

    const assets = await queryBuilder.getMany();

    // Filter by distance (Haversine formula)
    return assets.filter((asset) => {
      if (!asset.location?.latitude || !asset.location?.longitude) {
        return false;
      }

      const distance = this.calculateDistance(
        latitude,
        longitude,
        asset.location.latitude,
        asset.location.longitude,
      );

      return distance <= radiusKm;
    });
  }

  /**
   * Get asset statistics
   */
  async getStatistics(user: User): Promise<{
    total: number;
    active: number;
    inactive: number;
    byType: Record<AssetType, number>;
    withDevices: number;
    withoutDevices: number;
  }> {
    const queryBuilder = this.assetRepository.createQueryBuilder('asset');

    // Apply customer filtering
    if (user.role === UserRole.CUSTOMER_USER) {
      if (!user.customerId) {
        return this.getEmptyStatistics();
      }
      queryBuilder.where('asset.customerId = :customerId', {
        customerId: user.customerId,
      });
    } else if (user.role === UserRole.TENANT_ADMIN) {
      queryBuilder.where('asset.tenantId = :tenantId', {
        tenantId: user.tenantId,
      });
    }

    const [total, active, inactive] = await Promise.all([
      queryBuilder.getCount(),
      queryBuilder
        .clone()
        .andWhere('asset.active = :active', { active: true })
        .getCount(),
      queryBuilder
        .clone()
        .andWhere('asset.active = :active', { active: false })
        .getCount(),
    ]);

    // Count by type
    const types = await queryBuilder
      .clone()
      .select('asset.type', 'type')
      .addSelect('COUNT(*)', 'count')
      .groupBy('asset.type')
      .getRawMany();

    const byType: any = {};
    Object.values(AssetType).forEach((type) => {
      byType[type] = 0;
    });

    types.forEach((row) => {
      byType[row.type] = parseInt(row.count);
    });

    // Count assets with/without devices
    const assetsWithDevices = await queryBuilder
      .clone()
      .innerJoin('devices', 'device', 'device.assetId = asset.id')
      .select('COUNT(DISTINCT asset.id)', 'count')
      .getRawOne();

    const withDevices = parseInt(assetsWithDevices.count) || 0;
    const withoutDevices = total - withDevices;

    return {
      total,
      active,
      inactive,
      byType,
      withDevices,
      withoutDevices,
    };
  }

    /**
   * ============================================
   * CUSTOMER-SPECIFIC METHODS
   * ============================================
   */

  /**
   * Get assets by customer
   */
  async findByCustomer(customerId: string, user: User): Promise<Asset[]> {
    // Validate access
    if (user.role === UserRole.CUSTOMER_USER && user.customerId !== customerId) {
      throw new ForbiddenException('Access denied to this customer');
    }

    return await this.assetRepository.find({
      where: { customerId },
      relations: ['parentAsset'],
      order: { name: 'ASC' },
    });
  }

  /**
   * Assign asset to customer
   */
  async assignToCustomer(
    assetId: string,
    customerId: string,
    user: User,
  ): Promise<Asset> {
    // Only admins can assign
    if (
      user.role !== UserRole.SUPER_ADMIN &&
      user.role !== UserRole.TENANT_ADMIN
    ) {
      throw new ForbiddenException('Only admins can assign assets to customers');
    }

    const asset = await this.findOne(assetId, user);
    asset.customerId = customerId;
    return await this.assetRepository.save(asset);
  }

  /**
   * Unassign asset from customer
   */
  async unassignFromCustomer(assetId: string, user: User): Promise<Asset> {
    // Only admins can unassign
    if (
      user.role !== UserRole.SUPER_ADMIN &&
      user.role !== UserRole.TENANT_ADMIN
    ) {
      throw new ForbiddenException('Only admins can unassign assets');
    }

    const asset = await this.findOne(assetId, user);
    asset.customerId = undefined;
    return await this.assetRepository.save(asset);
  }

  /**
   * Private: Build asset hierarchy recursively
   */
  private async buildHierarchy(
    asset: Asset,
    user: User,
    maxDepth: number,
    currentDepth: number,
    includeDevices: boolean,
  ): Promise<any> {
    const result: any = {
      ...asset,
      children: [],
    };

    if (includeDevices) {
      result.devices = await this.getDevices(asset.id, user);
    }

    if (currentDepth < maxDepth) {
      const children = await this.getChildren(asset.id, user);

      for (const child of children) {
        const childHierarchy = await this.buildHierarchy(
          child,
          user,
          maxDepth,
          currentDepth + 1,
          includeDevices,
        );
        result.children.push(childHierarchy);
      }
    }

    return result;
  }

 /**
 * Private: Check if changing parent would create circular reference
 */
private async wouldCreateCircularReference(
  assetId: string | null,
  newParentId: string,
  tenantId?: string,  // ✅ Added tenant parameter
): Promise<boolean> {
  if (!assetId) return false;
  if (assetId === newParentId) return true;

  let currentParentId: string | null = newParentId;

  while (currentParentId) {
    if (currentParentId === assetId) {
      return true;
    }

    const whereClause: any = { id: currentParentId };
    if (tenantId) {
      whereClause.tenantId = tenantId;  // ✅ Add tenant scoping
    }

    const parent = await this.assetRepository.findOne({
      where: whereClause,
    });

    currentParentId = parent?.parentAssetId || null;
  }

  return false;
}

  /**
   * Private: Calculate distance between two coordinates (Haversine formula)
   */
  private calculateDistance(
    lat1: number,
    lon1: number,
    lat2: number,
    lon2: number,
  ): number {
    const R = 6371; // Earth's radius in km
    const dLat = this.deg2rad(lat2 - lat1);
    const dLon = this.deg2rad(lon2 - lon1);

    const a =
      Math.sin(dLat / 2) * Math.sin(dLat / 2) +
      Math.cos(this.deg2rad(lat1)) *
        Math.cos(this.deg2rad(lat2)) *
        Math.sin(dLon / 2) *
        Math.sin(dLon / 2);

    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
    return R * c;
  }

  private deg2rad(deg: number): number {
    return deg * (Math.PI / 180);
  }

  private getEmptyStatistics() {
    const byType: any = {};
    Object.values(AssetType).forEach((type) => {
      byType[type] = 0;
    });

    return {
      total: 0,
      active: 0,
      inactive: 0,
      byType,
      withDevices: 0,
      withoutDevices: 0,
    };
  }
}
