import {
  Injectable,
  NotFoundException,
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Logger,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, IsNull, Not, Repository } from 'typeorm';
import type { File as MulterFile } from 'multer';
import { FloorPlan } from './entities/floor-plan.entity';
import { FloorPlanDevice } from './entities/floor-plan-device.entity';
import { Asset } from '../assets/entities/asset.entity';
import { Device } from '../devices/entities/device.entity';
import { Telemetry } from '../telemetry/entities/telemetry.entity';
import { Alarm } from '../alarms/entities/alarm.entity';
import { Subscription } from '../subscriptions/entities/subscription.entity';
import { SubscriptionsService } from '../subscriptions/subscriptions.service';
import {
  FloorPlanStatus,
  DeviceAnimationType,
  AlarmStatus,
  UserRole,
} from '@common/enums/index.enum';
import type { SubscriptionLimits } from '@common/interfaces/index.interface';
import { Device3DData } from '@common/interfaces/index.interface';
import {
  CreateFloorPlanDto,
  AddZoneDto,
  Building3DMetadataDto,
} from './dto/create-floor-plan.dto';
import { PlaceDeviceDto, UpdatePlacementDto } from './dto/place-device.dto';
import { UpdateFloorPlanDto } from './dto/update-floor-plan.dto';
import { UpdateFloorPlanSettingsDto } from './dto/floor-plan-settings.dto';
import {
  PaginationDto,
  PaginatedResponseDto,
} from '../../common/dto/pagination.dto';
import { DWGParserService } from './dwg-parser.service';
import { v4 as uuidv4 } from 'uuid';
import * as fs from 'fs/promises';
import * as path from 'path';

/** Caller identity, taken from the JWT — never from the request body. */
export interface Actor {
  userId: string;
  tenantId: string;
  /** Present so SUPER_ADMIN can bypass subscription quotas. */
  role?: UserRole;
}

/** Columns a client is allowed to sort by (prevents ORDER BY injection). */
const SORTABLE = new Set([
  'createdAt',
  'updatedAt',
  'name',
  'building',
  'floor',
  'floorNumber',
  'status',
]);

export const ALLOWED_MODEL_EXTENSIONS = ['obj', 'gltf', 'glb', 'fbx'] as const;

const MODEL_CONTENT_TYPES: Record<string, string> = {
  obj: 'model/obj',
  gltf: 'model/gltf+json',
  glb: 'model/gltf-binary',
  fbx: 'application/octet-stream',
};

@Injectable()
export class FloorPlansService {
  private readonly logger = new Logger(FloorPlansService.name);
  private readonly uploadDir =
    process.env.UPLOAD_PATH || './uploads/floor-plans';
  private readonly dwgDir = path.join(this.uploadDir, 'dwg');
  private readonly modelDir = path.join(this.uploadDir, 'models');

  constructor(
    @InjectRepository(FloorPlan)
    private readonly floorPlanRepository: Repository<FloorPlan>,
    @InjectRepository(FloorPlanDevice)
    private readonly placementRepository: Repository<FloorPlanDevice>,
    @InjectRepository(Asset)
    private readonly assetRepository: Repository<Asset>,
    @InjectRepository(Device)
    private readonly deviceRepository: Repository<Device>,
    @InjectRepository(Telemetry)
    private readonly telemetryRepository: Repository<Telemetry>,
    @InjectRepository(Alarm)
    private readonly alarmRepository: Repository<Alarm>,
    @InjectRepository(Subscription)
    private readonly subscriptionRepository: Repository<Subscription>,
    // The repository above answers "what is the maxFloorPlans ceiling"; the
    // service below maintains usage.floorPlans. Both are needed: the ceiling
    // check counts rows live, the counter feeds GET /tenants/:id/usage.
    private readonly subscriptionsService: SubscriptionsService,
    private readonly dwgParserService: DWGParserService,
  ) {
    this.ensureUploadDirectories();
  }

  private async ensureUploadDirectories(): Promise<void> {
    try {
      await fs.mkdir(this.uploadDir, { recursive: true });
      await fs.mkdir(this.dwgDir, { recursive: true });
      await fs.mkdir(this.modelDir, { recursive: true });
      this.logger.log('Upload directories initialized');
    } catch (error) {
      this.logger.error('Failed to create upload directories', error);
    }
  }

  // ══════════════════════════════════════════════════════════════════════════
  // VALIDATION HELPERS
  // ══════════════════════════════════════════════════════════════════════════

  /** FIX 1: the asset must exist AND belong to the caller's tenant. */
  private async assertAsset(assetId: string, tenantId: string): Promise<Asset> {
    const asset = await this.assetRepository.findOne({
      where: { id: assetId, tenantId },
    });
    if (!asset) {
      throw new NotFoundException('Asset not found');
    }
    return asset;
  }

  /** The device must exist AND belong to the caller's tenant. */
  private async assertDevice(
    deviceId: string,
    tenantId: string,
  ): Promise<Device> {
    const device = await this.deviceRepository.findOne({
      where: { id: deviceId, tenantId },
    });
    if (!device) {
      throw new NotFoundException('Device not found');
    }
    return device;
  }

  // ══════════════════════════════════════════════════════════════════════════
  // SUBSCRIPTION LIMITS
  // ══════════════════════════════════════════════════════════════════════════

  /**
   * Resolve a plan limit for the tenant.
   *
   * Returns null when the check should be skipped: SUPER_ADMIN callers, tenants
   * with no subscription row, and limits the plan does not define (so adding a
   * new limit key never retroactively locks out existing tenants). -1 means
   * unlimited and is also returned as null.
   */
  private async resolveLimit(
    actor: Actor,
    key: keyof SubscriptionLimits,
  ): Promise<number | null> {
    if (actor.role === UserRole.SUPER_ADMIN) return null;

    const subscription = await this.subscriptionRepository.findOne({
      where: { tenantId: actor.tenantId },
    });
    if (!subscription) return null;

    const value = subscription.limits?.[key];
    if (typeof value !== 'number' || value === -1) return null;

    return value;
  }

  /** Blocks creating another floor plan once the plan's maxFloorPlans is hit. */
  private async assertFloorPlanQuota(actor: Actor): Promise<void> {
    const limit = await this.resolveLimit(actor, 'maxFloorPlans');
    if (limit === null) return;

    const current = await this.floorPlanRepository.count({
      where: { tenantId: actor.tenantId },
    });

    if (current >= limit) {
      throw new ForbiddenException(
        `Your tenant has reached the Floor Plan limit for its subscription plan ` +
          `(${current}/${limit}). Please upgrade your subscription to add more floor plans.`,
      );
    }
  }

  /** Blocks placing another device once the plan's maxDevicesPerFloorPlan is hit. */
  private async assertDevicePlacementQuota(
    actor: Actor,
    floorPlanId: string,
  ): Promise<void> {
    const limit = await this.resolveLimit(actor, 'maxDevicesPerFloorPlan');
    if (limit === null) return;

    const current = await this.placementRepository.count({
      where: { floorPlanId, tenantId: actor.tenantId },
    });

    if (current >= limit) {
      throw new ForbiddenException(
        `This floor plan has reached the device limit for your subscription plan ` +
          `(${current}/${limit}). Please upgrade your subscription to place more devices.`,
      );
    }
  }

  // ══════════════════════════════════════════════════════════════════════════
  // FLOOR NUMBER RESOLUTION
  // ══════════════════════════════════════════════════════════════════════════

  /**
   * Work out which floor a new/updated plan belongs to.
   *
   * - Multi-floor asset (configuration.totalFloors > 1): floorNumber is required.
   * - Single-floor asset: defaults to 1.
   * - When the asset declares floorsData, the number must be one of those floors.
   */
  private resolveFloorNumber(
    asset: Asset,
    requested: number | undefined,
  ): number {
    const configuration = asset.configuration ?? {};
    const totalFloors =
      typeof configuration.totalFloors === 'number'
        ? configuration.totalFloors
        : undefined;
    const floorsData = Array.isArray(configuration.floorsData)
      ? configuration.floorsData
      : [];

    if (requested === undefined || requested === null) {
      if (totalFloors !== undefined && totalFloors > 1) {
        throw new BadRequestException(
          `Asset "${asset.name}" has ${totalFloors} floors — floorNumber is required. ` +
            `Call GET /assets/${asset.id}/floors to see which floors still need a plan.`,
        );
      }
      return 1;
    }

    if (floorsData.length > 0) {
      const known = floorsData.some((f) => f.floorNumber === requested);
      if (!known) {
        const available = floorsData
          .map((f) => f.floorNumber)
          .sort((a, b) => a - b)
          .join(', ');
        throw new BadRequestException(
          `Floor ${requested} is not part of asset "${asset.name}". ` +
            `Configured floors are: ${available}.`,
        );
      }
    } else if (totalFloors !== undefined && requested > totalFloors) {
      throw new BadRequestException(
        `Floor ${requested} exceeds the asset's totalFloors (${totalFloors}).`,
      );
    }

    return requested;
  }

  /** One plan per (asset, floor) — checked up front for a clean 409. */
  private async assertFloorIsFree(
    assetId: string,
    floorNumber: number,
    tenantId: string,
    excludeFloorPlanId?: string,
  ): Promise<void> {
    const existing = await this.floorPlanRepository.findOne({
      where: { assetId, floorNumber, tenantId },
    });

    if (existing && existing.id !== excludeFloorPlanId) {
      throw new ConflictException(
        `A floor plan already exists for floor ${floorNumber} of this asset ` +
          `(${existing.name}, id ${existing.id}). Update it instead of creating a second one.`,
      );
    }
  }

  // ══════════════════════════════════════════════════════════════════════════
  // CRUD
  // ══════════════════════════════════════════════════════════════════════════

  async create(
    actor: Actor,
    dto: CreateFloorPlanDto,
    file?: MulterFile,
  ): Promise<FloorPlan> {
    // Previously tenantId was never set, so every insert violated the NOT NULL
    // constraint on floor_plans.tenantId and POST /floor-plans always 500'd.
    const asset = await this.assertAsset(dto.assetId, actor.tenantId);

    // Validate the upload before the insert, otherwise a wrong extension leaves
    // an orphaned floor plan row behind.
    if (file) this.assertDwgExtension(file);

    // Subscription ceiling first — cheapest rejection, and it should fire before
    // any of the shape validation below.
    await this.assertFloorPlanQuota(actor);

    const floorNumber = this.resolveFloorNumber(asset, dto.floorNumber);
    await this.assertFloorIsFree(asset.id, floorNumber, actor.tenantId);

    // Only name + assetId are required on the wire. building/floor/dimensions are
    // NOT NULL on floor_plans, so anything the caller omits is derived here rather
    // than blowing up at insert time.
    const floorName = dto.floorName ?? dto.floor ?? `Floor ${floorNumber}`;

    const floorPlan = this.floorPlanRepository.create({
      ...dto,
      floorNumber,
      floorName,
      building: dto.building ?? asset.name,
      floor: dto.floor ?? floorName,
      dimensions: dto.dimensions ?? { width: 100, height: 100, unit: 'meters' },
      tenantId: actor.tenantId,
      userId: actor.userId,
      createdBy: actor.userId,
      devices: [],
      zones: [],
    });

    const saved = await this.floorPlanRepository.save(floorPlan);

    try {
      await this.subscriptionsService.incrementTenantUsage(
        actor.tenantId,
        'floorPlans',
      );
    } catch (e) {
      this.logger.warn(`Failed to update usage counter: ${(e as Error).message}`);
    }

    // One-shot create + upload: same effect as calling POST /floor-plans/:id/dwg-upload
    // straight after. Parsing still happens asynchronously.
    if (file) {
      return await this.uploadDWGFile(saved.id, actor, file);
    }

    return saved;
  }

  async findAll(
    tenantId: string,
    paginationDto: PaginationDto,
    assetId?: string,
  ): Promise<PaginatedResponseDto<FloorPlan>> {
    const {
      page = 1,
      limit = 10,
      search,
      sortBy = 'createdAt',
      sortOrder = 'DESC',
    } = paginationDto;
    const skip = (page - 1) * limit;

    const sortColumn = SORTABLE.has(sortBy) ? sortBy : 'createdAt';
    const direction =
      String(sortOrder).toUpperCase() === 'ASC' ? 'ASC' : 'DESC';

    const qb = this.floorPlanRepository
      .createQueryBuilder('floorPlan')
      .leftJoinAndSelect('floorPlan.asset', 'asset')
      .where('floorPlan.tenantId = :tenantId', { tenantId });

    if (assetId) {
      qb.andWhere('floorPlan.assetId = :assetId', { assetId });
    }

    if (search) {
      qb.andWhere(
        '(floorPlan.name ILIKE :search OR floorPlan.building ILIKE :search OR floorPlan.floor ILIKE :search OR floorPlan.floorName ILIKE :search)',
        { search: `%${search}%` },
      );
    }

    if (assetId) {
      // Browsing one building: floor order is the only order that makes sense.
      qb.orderBy('floorPlan.floorNumber', 'ASC');
    } else {
      qb.orderBy(`floorPlan.${sortColumn}`, direction);
    }

    qb.skip(skip).take(limit);

    const [data, total] = await qb.getManyAndCount();

    return PaginatedResponseDto.create(data, page, limit, total);
  }

  /** Raw entity fetch, tenant-scoped, with the asset joined. */
  async findOne(id: string, tenantId: string): Promise<FloorPlan> {
    const floorPlan = await this.floorPlanRepository.findOne({
      where: { id, tenantId },
      relations: ['asset'],
    });

    if (!floorPlan) {
      throw new NotFoundException('Floor plan not found');
    }

    return floorPlan;
  }

  /** FIX 3: enriched single floor plan (asset + placed devices + telemetry). */
  async findOneEnriched(id: string, tenantId: string) {
    const floorPlan = await this.findOne(id, tenantId);
    const placedDevices = await this.getPlacedDevices(id, tenantId);

    return {
      ...floorPlan,
      asset: floorPlan.asset
        ? {
            id: (floorPlan.asset as any).id,
            name: (floorPlan.asset as any).name,
            type: (floorPlan.asset as any).type,
            description: (floorPlan.asset as any).description,
          }
        : null,
      // Legacy shape, reconstructed from the relational placements so existing
      // 3D clients reading `devices[]` keep working.
      devices: placedDevices.map((p) => p.legacy),
      placedDevices: placedDevices.map(({ legacy, ...rest }) => rest),
      deviceCount: placedDevices.length,
      previewUrl: floorPlan.thumbnailUrl ?? null,
      modelUrl: floorPlan.modelFileUrl ?? null,
    };
  }

  async findByAsset(assetId: string, tenantId: string): Promise<FloorPlan[]> {
    return await this.floorPlanRepository.find({
      where: { assetId, tenantId },
      relations: ['asset'],
      order: { floorNumber: 'ASC' },
    });
  }

  async update(
    id: string,
    actor: Actor,
    dto: UpdateFloorPlanDto,
  ): Promise<FloorPlan> {
    const floorPlan = await this.findOne(id, actor.tenantId);

    // FIX 1: re-validate the asset when it is being reassigned.
    const targetAssetId = dto.assetId ?? floorPlan.assetId;
    let asset: Asset | undefined;
    if (dto.assetId && dto.assetId !== floorPlan.assetId) {
      asset = await this.assertAsset(dto.assetId, actor.tenantId);
    }

    // Re-check the floor slot whenever the asset or the floor number moves.
    if (
      (dto.floorNumber !== undefined && dto.floorNumber !== floorPlan.floorNumber) ||
      (dto.assetId && dto.assetId !== floorPlan.assetId)
    ) {
      asset ??= await this.assertAsset(targetAssetId, actor.tenantId);
      const floorNumber = this.resolveFloorNumber(
        asset,
        dto.floorNumber ?? floorPlan.floorNumber,
      );
      await this.assertFloorIsFree(
        targetAssetId,
        floorNumber,
        actor.tenantId,
        floorPlan.id,
      );
      dto = { ...dto, floorNumber };
    }

    Object.assign(floorPlan, dto);
    floorPlan.updatedBy = actor.userId;

    return await this.floorPlanRepository.save(floorPlan);
  }

  async remove(id: string, actor: Actor): Promise<void> {
    const floorPlan = await this.findOne(id, actor.tenantId);

    if (floorPlan.dwgFileUrl) await this.deleteFile(floorPlan.dwgFileUrl);
    if (floorPlan.thumbnailUrl) await this.deleteFile(floorPlan.thumbnailUrl);
    if (floorPlan.modelFileUrl) await this.deleteFile(floorPlan.modelFileUrl);

    await this.floorPlanRepository.softRemove(floorPlan);

    try {
      await this.subscriptionsService.decrementTenantUsage(
        actor.tenantId,
        'floorPlans',
      );
    } catch (e) {
      this.logger.warn(`Failed to update usage counter: ${(e as Error).message}`);
    }
  }

  // ══════════════════════════════════════════════════════════════════════════
  // DEVICE PLACEMENT (FIX 2)
  // ══════════════════════════════════════════════════════════════════════════

  private coords(dto: PlaceDeviceDto | UpdatePlacementDto) {
    // `position` (legacy) wins over flat x/y/z when both are supplied.
    return {
      x: dto.position?.x ?? dto.x,
      y: dto.position?.y ?? dto.y,
      z: dto.position?.z ?? dto.z,
    };
  }

  /** POST /floor-plans/:id/devices — place (or reposition) a device. */
  async placeDevice(floorPlanId: string, actor: Actor, dto: PlaceDeviceDto) {
    const floorPlan = await this.findOne(floorPlanId, actor.tenantId);
    const device = await this.assertDevice(dto.deviceId, actor.tenantId);

    // A device may only be placed on a floor plan of the asset it belongs to.
    // This used to be a soft warning; it is now a hard rejection, so a floor plan
    // can never show telemetry for equipment that isn't part of that building.
    if (!device.assetId || device.assetId !== floorPlan.assetId) {
      throw new BadRequestException(
        'This device is not linked to the asset associated with this floor plan. ' +
          'Please link the device to the asset first before placing it on the floor plan.',
      );
    }

    const { x, y, z } = this.coords(dto);

    let placement = await this.placementRepository.findOne({
      where: { floorPlanId, deviceId: dto.deviceId, tenantId: actor.tenantId },
    });

    // Quota applies to new placements only — repositioning an existing device
    // must keep working even for a tenant sitting exactly on its limit.
    if (!placement) {
      await this.assertDevicePlacementQuota(actor, floorPlanId);
    }

    if (placement) {
      // Already placed → reposition instead of creating a duplicate.
      placement.x = x ?? placement.x;
      placement.y = y ?? placement.y;
      placement.z = z ?? placement.z;
      if (dto.rotation) placement.rotation = dto.rotation;
      if (dto.scale) placement.scale = dto.scale;
      if (dto.metadata) placement.metadata = dto.metadata;
      if (dto.animationType) placement.animationType = dto.animationType;
      if (dto.animationConfig) placement.animationConfig = dto.animationConfig;
      if (dto.telemetryBindings)
        placement.telemetryBindings = dto.telemetryBindings;
      placement.updatedBy = actor.userId;
    } else {
      placement = this.placementRepository.create({
        tenantId: actor.tenantId,
        floorPlanId,
        deviceId: dto.deviceId,
        x: x ?? 0,
        y: y ?? 0,
        z: z ?? 0,
        rotation: dto.rotation ?? { x: 0, y: 0, z: 0 },
        scale: dto.scale ?? { x: 1, y: 1, z: 1 },
        metadata: dto.metadata,
        displayName: dto.name ?? device.name,
        deviceTypeLabel: dto.type ?? String(device.type),
        model3DUrl: dto.model3DUrl,
        animationType: dto.animationType ?? DeviceAnimationType.NONE,
        animationConfig:
          dto.animationConfig ??
          this.getDefaultAnimationConfig(
            dto.animationType ?? DeviceAnimationType.NONE,
          ),
        telemetryBindings: dto.telemetryBindings,
        createdBy: actor.userId,
      });
    }

    const saved = await this.placementRepository.save(placement);
    const [enriched] = await this.enrich([saved], actor.tenantId);

    const { legacy, ...placementView } = enriched;
    return { ...placementView, linkedToAsset: true };
  }

  /** PATCH /floor-plans/:id/devices/:deviceId — move / update a placement. */
  async updatePlacement(
    floorPlanId: string,
    deviceId: string,
    actor: Actor,
    dto: UpdatePlacementDto,
  ) {
    await this.findOne(floorPlanId, actor.tenantId);

    const placement = await this.placementRepository.findOne({
      where: { floorPlanId, deviceId, tenantId: actor.tenantId },
    });
    if (!placement) {
      throw new NotFoundException('Device is not placed on this floor plan');
    }

    const { x, y, z } = this.coords(dto);
    if (x !== undefined) placement.x = x;
    if (y !== undefined) placement.y = y;
    if (z !== undefined) placement.z = z;
    if (dto.rotation) placement.rotation = dto.rotation;
    if (dto.scale) placement.scale = dto.scale;
    if (dto.metadata) placement.metadata = dto.metadata;
    if (dto.animationType) placement.animationType = dto.animationType;
    if (dto.animationConfig) {
      placement.animationConfig = {
        ...placement.animationConfig,
        ...dto.animationConfig,
      };
    }
    if (dto.telemetryBindings)
      placement.telemetryBindings = dto.telemetryBindings;
    placement.updatedBy = actor.userId;

    const saved = await this.placementRepository.save(placement);
    const [enriched] = await this.enrich([saved], actor.tenantId);
    const { legacy, ...placementView } = enriched;
    return placementView;
  }

  /** DELETE /floor-plans/:id/devices/:deviceId */
  async removePlacement(
    floorPlanId: string,
    deviceId: string,
    actor: Actor,
  ): Promise<{ removed: true }> {
    await this.findOne(floorPlanId, actor.tenantId);

    const placement = await this.placementRepository.findOne({
      where: { floorPlanId, deviceId, tenantId: actor.tenantId },
    });
    if (!placement) {
      throw new NotFoundException('Device is not placed on this floor plan');
    }

    await this.placementRepository.remove(placement);
    return { removed: true };
  }

  /**
   * GET /floor-plans/:id/available-devices — the device picker list.
   *
   * Every device linked to this floor plan's asset, minus the ones already placed
   * on THIS plan. Devices already placed on another floor of the same asset are
   * still returned but marked `isAvailable: false` with the floor they sit on, so
   * the picker can grey them out rather than pretend they don't exist.
   */
  async getAvailableDevices(floorPlanId: string, tenantId: string) {
    const floorPlan = await this.findOne(floorPlanId, tenantId);

    const devices = await this.deviceRepository.find({
      where: { assetId: floorPlan.assetId, tenantId },
      order: { name: 'ASC' },
    });

    if (devices.length === 0) {
      return {
        floorPlanId,
        assetId: floorPlan.assetId,
        total: 0,
        availableCount: 0,
        devices: [],
      };
    }

    // Every floor plan of this asset — a device placed on floor 2 is not free
    // to be placed on floor 3.
    const siblingPlans = await this.floorPlanRepository.find({
      where: { assetId: floorPlan.assetId, tenantId },
      select: ['id', 'floorNumber', 'floorName', 'floor', 'name'] as any,
    });
    const planById = new Map(siblingPlans.map((p) => [p.id, p]));

    const placements = await this.placementRepository.find({
      where: {
        tenantId,
        floorPlanId: In(siblingPlans.map((p) => p.id)),
        deviceId: In(devices.map((d) => d.id)),
      },
    });
    const placementByDevice = new Map(
      placements.map((p) => [p.deviceId, p]),
    );

    const rows = devices
      .map((device) => {
        const placement = placementByDevice.get(device.id);
        const placedPlan = placement ? planById.get(placement.floorPlanId) : undefined;

        return {
          id: device.id,
          name: device.name,
          type: device.type,
          status: device.status,
          deviceKey: device.deviceKey,
          assetId: device.assetId,
          isAvailable: !placement,
          placedOnFloor: placedPlan?.floorNumber ?? null,
          placedOnFloorPlanId: placement?.floorPlanId ?? null,
          placedOnThisFloorPlan: placement?.floorPlanId === floorPlanId,
        };
      })
      // Already on this plan → not a picker candidate at all.
      .filter((row) => !row.placedOnThisFloorPlan)
      .map(({ placedOnThisFloorPlan, ...row }) => row);

    return {
      floorPlanId,
      assetId: floorPlan.assetId,
      total: rows.length,
      availableCount: rows.filter((r) => r.isAvailable).length,
      devices: rows,
    };
  }

  /**
   * GET /floor-plans/asset/:assetId — one row per floor plan of an asset, with the
   * bits a floor switcher needs: device count, whether a DXF was uploaded, and a
   * summary of the parsed geometry.
   */
  async getAssetFloorPlansOverview(assetId: string, tenantId: string) {
    await this.assertAsset(assetId, tenantId);

    const floorPlans = await this.floorPlanRepository.find({
      where: { assetId, tenantId },
      order: { floorNumber: 'ASC' },
    });

    if (floorPlans.length === 0) {
      return { assetId, total: 0, floorPlans: [] };
    }

    const countRows: Array<{ floorPlanId: string; count: string }> =
      await this.placementRepository
        .createQueryBuilder('placement')
        .select('placement.floorPlanId', 'floorPlanId')
        .addSelect('COUNT(*)', 'count')
        .where('placement.tenantId = :tenantId', { tenantId })
        .andWhere('placement.floorPlanId IN (:...ids)', {
          ids: floorPlans.map((fp) => fp.id),
        })
        .groupBy('placement.floorPlanId')
        .getRawMany();

    const deviceCountByPlan = new Map(
      countRows.map((r) => [r.floorPlanId, parseInt(r.count, 10) || 0]),
    );

    return {
      assetId,
      total: floorPlans.length,
      floorPlans: floorPlans.map((fp) => ({
        id: fp.id,
        name: fp.name,
        building: fp.building,
        floor: fp.floor,
        floorNumber: fp.floorNumber ?? null,
        floorName: fp.floorName ?? fp.floor ?? null,
        status: fp.status,
        dimensions: fp.dimensions,
        scale: fp.scale ?? null,
        deviceCount: deviceCountByPlan.get(fp.id) ?? 0,
        hasDxf: !!fp.dwgFileUrl,
        dwgUploadedAt: fp.dwgUploadedAt ?? null,
        parsingError: fp.parsingError ?? null,
        hasModel: !!fp.modelFileUrl,
        thumbnailUrl: fp.thumbnailUrl ?? null,
        geometrySummary: this.summariseGeometry(fp),
      })),
    };
  }

  /** Compact stats over parsedGeometry — null when the plan has not been parsed. */
  private summariseGeometry(floorPlan: FloorPlan) {
    const geometry = floorPlan.parsedGeometry;
    if (!geometry) return null;

    const rooms = geometry.rooms ?? [];

    return {
      roomCount: rooms.length,
      wallCount: geometry.walls?.length ?? 0,
      doorCount: geometry.doors?.length ?? 0,
      windowCount: geometry.windows?.length ?? 0,
      stairCount: geometry.stairs?.length ?? 0,
      // Sum of detected room areas (m²). Falls back to the declared plan
      // footprint when the drawing yielded no rooms.
      totalArea:
        rooms.length > 0
          ? Math.round(rooms.reduce((sum, r) => sum + (r.area ?? 0), 0) * 100) / 100
          : ((floorPlan.dimensions?.width ?? 0) *
              (floorPlan.dimensions?.height ?? 0)) || null,
      hasElevationData: geometry.building?.hasElevationData ?? false,
      floorHeight: geometry.building?.floorHeight ?? null,
    };
  }

  /** GET /floor-plans/:id/devices — placements + device info + telemetry + alarms. */
  async getPlacedDevices(floorPlanId: string, tenantId: string) {
    await this.findOne(floorPlanId, tenantId);

    const placements = await this.placementRepository.find({
      where: { floorPlanId, tenantId },
      order: { createdAt: 'ASC' },
    });

    return this.enrich(placements, tenantId);
  }

  /**
   * Batch-enrich placements with device info, latest telemetry and active alarm
   * counts. Deliberately 3 queries total regardless of placement count — the
   * naive per-device loop would be an N+1 on a floor plan with 200 sensors.
   */
  private async enrich(placements: FloorPlanDevice[], tenantId: string) {
    if (placements.length === 0) return [];

    const deviceIds = [...new Set(placements.map((p) => p.deviceId))];

    const devices = await this.deviceRepository.find({
      where: { id: In(deviceIds), tenantId },
    });
    const deviceById = new Map(devices.map((d) => [d.id, d]));

    // Latest telemetry row per device, in one round trip.
    const latestRows: Array<{ deviceId: string; data: any; timestamp: Date }> =
      await this.telemetryRepository
        .createQueryBuilder('t')
        .distinctOn(['t.deviceId'])
        .select([
          't.deviceId AS "deviceId"',
          't.data AS data',
          't.timestamp AS timestamp',
        ])
        .where('t.tenantId = :tenantId', { tenantId })
        .andWhere('t.deviceId IN (:...deviceIds)', { deviceIds })
        .orderBy('t.deviceId')
        .addOrderBy('t.timestamp', 'DESC')
        .getRawMany();
    const telemetryByDevice = new Map(latestRows.map((r) => [r.deviceId, r]));

    // Active (unacknowledged) alarm counts, in one round trip.
    const alarmRows: Array<{ deviceId: string; count: string }> =
      await this.alarmRepository
        .createQueryBuilder('a')
        .select('a.deviceId', 'deviceId')
        .addSelect('COUNT(*)', 'count')
        .where('a.tenantId = :tenantId', { tenantId })
        .andWhere('a.deviceId IN (:...deviceIds)', { deviceIds })
        .andWhere('a.status = :status', { status: AlarmStatus.ACTIVE })
        .groupBy('a.deviceId')
        .getRawMany();
    const alarmsByDevice = new Map(
      alarmRows.map((r) => [r.deviceId, parseInt(r.count, 10) || 0]),
    );

    return placements.map((p) => {
      const device = deviceById.get(p.deviceId);
      const tele = telemetryByDevice.get(p.deviceId);

      const legacy: Device3DData = {
        deviceId: p.deviceId,
        name: p.displayName ?? device?.name ?? '',
        type: p.deviceTypeLabel ?? String(device?.type ?? ''),
        position: { x: p.x, y: p.y, z: p.z },
        rotation: p.rotation ?? { x: 0, y: 0, z: 0 },
        scale: p.scale ?? { x: 1, y: 1, z: 1 },
        model3DUrl: p.model3DUrl,
        animationType: p.animationType ?? DeviceAnimationType.NONE,
        animationConfig: p.animationConfig,
        telemetryBindings: p.telemetryBindings,
        status: (device?.status as any) ?? 'offline',
      } as Device3DData;

      return {
        placementId: p.id,
        deviceId: p.deviceId,
        x: p.x,
        y: p.y,
        z: p.z,
        rotation: p.rotation ?? null,
        scale: p.scale ?? null,
        metadata: p.metadata ?? null,
        device: device
          ? {
              id: device.id,
              name: device.name,
              type: device.type,
              status: device.status,
              deviceKey: device.deviceKey,
            }
          : null,
        latestTelemetry: tele?.data ?? null,
        activeAlarms: alarmsByDevice.get(p.deviceId) ?? 0,
        lastSeen: device?.lastSeenAt ?? tele?.timestamp ?? null,
        // internal: used to rebuild the legacy `devices[]` array; stripped by callers
        legacy,
      };
    });
  }

  // ══════════════════════════════════════════════════════════════════════════
  // DWG UPLOAD / PARSING
  // ══════════════════════════════════════════════════════════════════════════

  /** Shared by POST /floor-plans (inline upload) and POST /floor-plans/:id/dwg-upload. */
  private assertDwgExtension(file: MulterFile): string {
    const ext = path.extname(file.originalname ?? '').toLowerCase();
    if (ext !== '.dwg' && ext !== '.dxf') {
      throw new BadRequestException('Only DWG and DXF files are supported');
    }
    return ext;
  }

  async uploadDWGFile(
    id: string,
    actor: Actor,
    file: MulterFile,
  ): Promise<FloorPlan> {
    const floorPlan = await this.findOne(id, actor.tenantId);

    const ext = this.assertDwgExtension(file);

    try {
      // Never interpolate the client-supplied filename into a shell command or a
      // path: the parser shells out to dwg2dxf. Use a UUID and keep the extension.
      const fileName = `${uuidv4()}${ext}`;
      const filePath = path.join(this.dwgDir, fileName);
      await fs.writeFile(filePath, file.buffer);

      floorPlan.dwgFileUrl = `/uploads/floor-plans/dwg/${fileName}`;
      floorPlan.dwgFileSizeBytes = file.size;
      floorPlan.dwgUploadedAt = new Date();
      floorPlan.status = FloorPlanStatus.PROCESSING;
      floorPlan.updatedBy = actor.userId;

      await this.floorPlanRepository.save(floorPlan);

      void this.parseDWGFileAsync(id, actor, filePath).catch((err) =>
        this.logger.error(
          `Unhandled DWG parse failure: ${err?.message}`,
          err?.stack,
        ),
      );

      return floorPlan;
    } catch (error) {
      this.logger.error(
        `Failed to upload DWG file: ${error.message}`,
        error.stack,
      );
      throw new BadRequestException('Failed to upload DWG file');
    }
  }

  private async parseDWGFileAsync(
    floorPlanId: string,
    actor: Actor,
    filePath: string,
  ): Promise<void> {
    try {
      this.logger.log(
        `Starting async DWG parsing for floor plan: ${floorPlanId}`,
      );

      const geometry = await this.dwgParserService.parseDWGFile(filePath);

      // A drawing fails only when it is unreadable. Missing walls or rooms are
      // warnings — the geometry that *was* found is saved either way.
      const validation = this.dwgParserService.validateGeometry(geometry);
      if (!validation.valid) {
        throw new Error(validation.errors.join(', '));
      }
      if (validation.warnings.length > 0) {
        this.logger.warn(
          `Floor plan ${floorPlanId} parsed with warnings: ${validation.warnings.join(', ')}`,
        );
      }

      // Thumbnail: previously generated but never persisted, leaving the PNG
      // orphaned on disk and thumbnailUrl null.
      const thumbName = `${path.parse(filePath).name}_thumb.png`;
      const thumbPath = path.join(this.dwgDir, thumbName);
      let thumbnailUrl: string | undefined;
      try {
        await this.dwgParserService.generateThumbnail(geometry, thumbPath);
        await fs.access(thumbPath);
        thumbnailUrl = `/uploads/floor-plans/dwg/${thumbName}`;
      } catch {
        this.logger.warn(`Thumbnail generation failed for ${floorPlanId}`);
      }

      const floorPlan = await this.findOne(floorPlanId, actor.tenantId);
      floorPlan.parsedGeometry = geometry;
      floorPlan.status = FloorPlanStatus.ACTIVE;
      floorPlan.parsingError = null as any;
      if (thumbnailUrl) floorPlan.thumbnailUrl = thumbnailUrl;

      // Extents come from the drawing's own bounding box (every entity type,
      // not just rooms), falling back to the wall/room point cloud.
      {
        const bounds =
          geometry.bounds && geometry.bounds.width > 0 && geometry.bounds.height > 0
            ? geometry.bounds
            : this.calculateBounds(geometry);
        if (
          Number.isFinite(bounds.width) &&
          Number.isFinite(bounds.height) &&
          bounds.width > 0 &&
          bounds.height > 0
        ) {
          floorPlan.dimensions = {
            width: bounds.width,
            height: bounds.height,
            unit: floorPlan.dimensions?.unit || 'meters',
          };
        }
      }

      await this.floorPlanRepository.save(floorPlan);
      this.logger.log(`DWG parsing completed for floor plan: ${floorPlanId}`);
    } catch (error) {
      this.logger.error(
        `DWG parsing failed for floor plan ${floorPlanId}: ${error.message}`,
        error.stack,
      );
      try {
        const floorPlan = await this.floorPlanRepository.findOne({
          where: { id: floorPlanId },
        });
        if (floorPlan) {
          floorPlan.status = FloorPlanStatus.FAILED;
          floorPlan.parsingError = error.message;
          await this.floorPlanRepository.save(floorPlan);
        }
      } catch (inner) {
        this.logger.error(`Failed to record parsing error: ${inner?.message}`);
      }
    }
  }

  async getParsedGeometry(id: string, tenantId: string) {
    const floorPlan = await this.findOne(id, tenantId);

    if (!floorPlan.parsedGeometry) {
      throw new NotFoundException('Floor plan has not been parsed yet');
    }

    return {
      floorPlanId: floorPlan.id,
      name: floorPlan.name,
      floor: floorPlan.floor,
      geometry: floorPlan.parsedGeometry,
      dimensions: floorPlan.dimensions,
      scale: floorPlan.scale,
    };
  }

  // ══════════════════════════════════════════════════════════════════════════
  // 3D MODEL FILE (FIX 5)
  // ══════════════════════════════════════════════════════════════════════════

  async uploadModel(
    id: string,
    actor: Actor,
    file: MulterFile,
  ): Promise<FloorPlan> {
    const floorPlan = await this.findOne(id, actor.tenantId);

    const ext = path.extname(file.originalname).toLowerCase().replace('.', '');
    if (!(ALLOWED_MODEL_EXTENSIONS as readonly string[]).includes(ext)) {
      throw new BadRequestException(
        `Unsupported model format '${ext}'. Allowed: ${ALLOWED_MODEL_EXTENSIONS.join(', ')}`,
      );
    }

    // Filename is derived from the floor plan id, never from client input.
    const fileName = `${floorPlan.id}.${ext}`;
    const filePath = path.join(this.modelDir, fileName);
    await fs.writeFile(filePath, file.buffer);

    // Remove a previously uploaded model with a different extension.
    if (floorPlan.modelFileUrl && floorPlan.modelFileType !== ext) {
      await this.deleteFile(floorPlan.modelFileUrl);
    }

    floorPlan.modelFileUrl = `/uploads/floor-plans/models/${fileName}`;
    floorPlan.modelFileType = ext;
    floorPlan.modelFileSize = file.size;
    floorPlan.updatedBy = actor.userId;

    return await this.floorPlanRepository.save(floorPlan);
  }

  /** Returns the absolute path + content type for streaming the model file. */
  async getModelFile(id: string, tenantId: string) {
    const floorPlan = await this.findOne(id, tenantId);

    if (!floorPlan.modelFileUrl || !floorPlan.modelFileType) {
      throw new NotFoundException('No 3D model uploaded for this floor plan');
    }

    const absolutePath = path.join(
      this.modelDir,
      `${floorPlan.id}.${floorPlan.modelFileType}`,
    );

    try {
      await fs.access(absolutePath);
    } catch {
      throw new NotFoundException('Model file is missing from storage');
    }

    return {
      path: absolutePath,
      contentType:
        MODEL_CONTENT_TYPES[floorPlan.modelFileType] ??
        'application/octet-stream',
      fileName: `${floorPlan.name}.${floorPlan.modelFileType}`,
    };
  }

  // ══════════════════════════════════════════════════════════════════════════
  // 3D SIMULATION
  // ══════════════════════════════════════════════════════════════════════════

  async get3DSimulationData(assetId: string, tenantId: string) {
    const floorPlans = await this.findByAsset(assetId, tenantId);

    if (floorPlans.length === 0) {
      throw new NotFoundException('No floor plans found for this asset');
    }

    const building3DMetadata = floorPlans[0].building3DMetadata || {
      buildingName: floorPlans[0].building,
      totalFloors: floorPlans.length,
      floorHeight: 3.5,
      buildingDimensions: {
        width: 50,
        length: 30,
        height: floorPlans.length * 3.5,
      },
      floorOrder: floorPlans.map((fp) => fp.floor),
    };

    const floors = await Promise.all(
      floorPlans.map(async (fp, index) => {
        const placed = await this.getPlacedDevices(fp.id, tenantId);
        return {
          floorId: fp.id,
          floorName: fp.floor,
          floorNumber: fp.floorNumber ?? index,
          geometry: fp.parsedGeometry,
          devices: placed.map((p) => p.legacy),
          placedDevices: placed.map(({ legacy, ...rest }) => rest),
          zones: fp.zones,
          dimensions: fp.dimensions,
          modelUrl: fp.modelFileUrl ?? null,
        };
      }),
    );

    return {
      assetId,
      building: building3DMetadata,
      floors,
      totalDevices: floors.reduce((sum, f) => sum + f.devices.length, 0),
      totalZones: floorPlans.reduce(
        (sum, fp) => sum + (fp.zones?.length ?? 0),
        0,
      ),
    };
  }

  // ══════════════════════════════════════════════════════════════════════════
  // ZONES
  // ══════════════════════════════════════════════════════════════════════════

  async addZone(
    id: string,
    actor: Actor,
    zoneDto: AddZoneDto,
  ): Promise<FloorPlan> {
    const floorPlan = await this.findOne(id, actor.tenantId);
    if (!floorPlan.zones) floorPlan.zones = [];

    floorPlan.zones.push({ id: uuidv4(), ...zoneDto } as any);
    floorPlan.updatedBy = actor.userId;

    return await this.floorPlanRepository.save(floorPlan);
  }

  async updateZone(
    id: string,
    zoneId: string,
    actor: Actor,
    zoneDto: Partial<AddZoneDto>,
  ): Promise<FloorPlan> {
    const floorPlan = await this.findOne(id, actor.tenantId);

    const zone = floorPlan.zones?.find((z) => z.id === zoneId);
    if (!zone) {
      throw new NotFoundException('Zone not found on floor plan');
    }

    Object.assign(zone, zoneDto);
    floorPlan.updatedBy = actor.userId;

    return await this.floorPlanRepository.save(floorPlan);
  }

  async removeZone(
    id: string,
    zoneId: string,
    actor: Actor,
  ): Promise<FloorPlan> {
    const floorPlan = await this.findOne(id, actor.tenantId);

    floorPlan.zones = (floorPlan.zones ?? []).filter((z) => z.id !== zoneId);
    floorPlan.updatedBy = actor.userId;

    return await this.floorPlanRepository.save(floorPlan);
  }

  // ══════════════════════════════════════════════════════════════════════════
  // BUILDING 3D METADATA / SETTINGS / STATS
  // ══════════════════════════════════════════════════════════════════════════

  async updateBuilding3DMetadata(
    id: string,
    actor: Actor,
    metadata: Building3DMetadataDto,
  ): Promise<FloorPlan> {
    const floorPlan = await this.findOne(id, actor.tenantId);
    floorPlan.building3DMetadata = metadata;
    floorPlan.updatedBy = actor.userId;
    return await this.floorPlanRepository.save(floorPlan);
  }

  async getSettings(id: string, tenantId: string) {
    const floorPlan = await this.findOne(id, tenantId);
    return floorPlan.settings ?? this.getDefaultSettings();
  }

  async updateSettings(
    id: string,
    actor: Actor,
    settingsDto: UpdateFloorPlanSettingsDto,
  ): Promise<FloorPlan> {
    const floorPlan = await this.findOne(id, actor.tenantId);

    floorPlan.settings = {
      ...floorPlan.settings,
      ...settingsDto,
      gridSettings: {
        ...floorPlan.settings?.gridSettings,
        ...settingsDto.gridSettings,
      },
      defaultColors: {
        ...floorPlan.settings?.defaultColors,
        ...settingsDto.defaultColors,
      },
    } as any;

    floorPlan.updatedBy = actor.userId;
    return await this.floorPlanRepository.save(floorPlan);
  }

  async resetSettings(id: string, actor: Actor): Promise<FloorPlan> {
    const floorPlan = await this.findOne(id, actor.tenantId);
    floorPlan.settings = this.getDefaultSettings() as any;
    floorPlan.updatedBy = actor.userId;
    return await this.floorPlanRepository.save(floorPlan);
  }

  async getStatistics(tenantId: string) {
    const [total, active, draft, processing, failed] = await Promise.all([
      this.floorPlanRepository.count({ where: { tenantId } }),
      this.floorPlanRepository.count({
        where: { tenantId, status: FloorPlanStatus.ACTIVE },
      }),
      this.floorPlanRepository.count({
        where: { tenantId, status: FloorPlanStatus.DRAFT },
      }),
      this.floorPlanRepository.count({
        where: { tenantId, status: FloorPlanStatus.PROCESSING },
      }),
      this.floorPlanRepository.count({
        where: { tenantId, status: FloorPlanStatus.FAILED },
      }),
    ]);

    const totalDevices = await this.placementRepository.count({
      where: { tenantId },
    });

    const plans = await this.floorPlanRepository.find({
      where: { tenantId },
      select: ['id', 'assetId', 'zones'] as any,
    });
    const totalZones = plans.reduce(
      (sum, p) => sum + (p.zones?.length ?? 0),
      0,
    );
    const uniqueAssets = new Set(plans.map((p) => p.assetId)).size;

    return {
      total,
      active,
      draft,
      processing,
      failed,
      archived: Math.max(0, total - active - draft - processing - failed),
      totalDevices,
      totalZones,
      uniqueAssets,
    };
  }

  // ══════════════════════════════════════════════════════════════════════════
  // HELPERS
  // ══════════════════════════════════════════════════════════════════════════

  private getDefaultSettings() {
    return {
      measurementUnit: 'metric' as const,
      autoSave: true,
      gridSettings: { showGrid: true, snapToGrid: true, gridSize: 1 },
      defaultColors: {
        gateways: '#22c55e',
        sensorsToGateway: '#f59e0b',
        zones: '#3b82f6',
        sensorsToGrid: '#a855f7',
      },
    };
  }

  private getDefaultAnimationConfig(animationType: DeviceAnimationType) {
    const configs: Record<string, Record<string, any>> = {
      [DeviceAnimationType.SMOKE]: {
        intensity: 0.7,
        speed: 1.0,
        color: '#808080',
        particleCount: 100,
        radius: 2.0,
      },
      [DeviceAnimationType.DOOR_OPEN_CLOSE]: { speed: 1.0 },
      [DeviceAnimationType.LIGHT_PULSE]: {
        intensity: 0.8,
        speed: 1.5,
        color: '#FFFFFF',
      },
      [DeviceAnimationType.WATER_LEAK]: {
        intensity: 0.6,
        speed: 1.2,
        color: '#0077BE',
        particleCount: 50,
      },
      [DeviceAnimationType.ALARM_FLASH]: {
        intensity: 1.0,
        speed: 2.0,
        color: '#FF0000',
      },
      [DeviceAnimationType.NONE]: {},
    };

    return configs[animationType] ?? {};
  }

  private calculateBounds(geometry: any): { width: number; height: number } {
    let minX = Infinity,
      maxX = -Infinity;
    let minY = Infinity,
      maxY = -Infinity;

    [...(geometry.walls || []), ...(geometry.rooms || [])].forEach(
      (item: any) => {
        const points = item.points || item.boundaries || [];
        points.forEach((point: any) => {
          minX = Math.min(minX, point.x);
          maxX = Math.max(maxX, point.x);
          minY = Math.min(minY, point.y);
          maxY = Math.max(maxY, point.y);
        });
      },
    );

    return { width: maxX - minX, height: maxY - minY };
  }

  private async deleteFile(fileUrl: string): Promise<void> {
    try {
      const filePath = path.join(process.cwd(), fileUrl);
      await fs.unlink(filePath);
    } catch (error) {
      this.logger.warn(`Failed to delete file ${fileUrl}: ${error.message}`);
    }
  }
}
