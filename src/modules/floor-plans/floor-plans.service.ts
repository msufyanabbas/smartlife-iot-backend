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
import {
  GenerateModelDto,
  ModelFormat,
  ModelUpAxis,
} from './dto/generate-model.dto';
import { FloorPlanMeshFactory } from './mesh/floor-plan-mesh.factory';
import { GltfExporter } from './mesh/gltf.exporter';
import {
  buildDisplayGeometry,
  type DisplayGeometryOptions,
} from './display/display-geometry';
import { ObjExporter } from './mesh/obj.exporter';
import { UpdateFloorPlanDto } from './dto/update-floor-plan.dto';
import { UpdateFloorPlanSettingsDto } from './dto/floor-plan-settings.dto';
import {
  PaginationDto,
  PaginatedResponseDto,
} from '../../common/dto/pagination.dto';
import { DWGParserService } from './dwg-parser.service';
import { StorageService } from '@/lib/storage/storage.service';
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

/**
 * `StorageService` key prefixes for the three artefacts a floor plan owns.
 *
 * These are the first segment pair of every key this service writes, and they
 * deliberately match the directory layout the local driver used to produce —
 * `<UPLOAD_PATH>/floor-plans/dwg/…` — so switching to the seam is a no-op on a
 * single instance and existing bytes stay reachable under their derived key.
 */
const DWG_KEY_PREFIX = 'floor-plans/dwg';
const MODEL_KEY_PREFIX = 'floor-plans/models';
const PREVIEW_KEY_PREFIX = 'floor-plans/previews';

/**
 * What a stored reference on a floor-plan row turns out to be.
 *
 * Rows predate the storage seam, so one column can hold three different kinds
 * of value. `FloorPlansService.resolveRef()` classifies them; everything that
 * reads or deletes a floor-plan file goes through it.
 */
interface StoredRef {
  /** The driver-independent key, when the value is or implies one. */
  key: string | null;
  /**
   * The absolute local path the value used to mean, for rows written before
   * the seam. Tried only after the key misses.
   */
  legacyPath: string | null;
  /** An absolute http(s) URL — someone else's file. Nothing to read or delete. */
  external: boolean;
}

@Injectable()
export class FloorPlansService {
  private readonly logger = new Logger(FloorPlansService.name);
  // `uploadDir` / `dwgDir` / `modelDir` are gone. They existed to build the
  // absolute path of every write and read, which is precisely the coupling the
  // storage seam removes — a key (`floor-plans/dwg/<uuid>.dwg`) now names the
  // artefact and the driver decides where it lives. Keeping dead directory
  // fields would have implied the bytes still land there.
  //
  // The bug they used to carry is worth remembering, because the key prefixes
  // preserve the layout it produced: `uploadDir` was once
  // `process.env.UPLOAD_PATH || './uploads/floor-plans'`, so the fallback
  // included the /floor-plans segment and the configured value did not. With
  // UPLOAD_PATH=./uploads, floor plans were written straight into ./uploads
  // and their dwg/ and models/ subdirectories landed next to every other
  // module's uploads — which is what the stray uploads/dwg and uploads/models
  // directories in this repository are. `DWG_KEY_PREFIX` and friends always
  // include the segment.

  /**
   * The absolute root the local driver writes under, and therefore the root a
   * legacy absolute path has to sit inside to be expressible as a key.
   */
  private readonly storageRoot = path.resolve(
    process.cwd(),
    process.env.UPLOAD_PATH || './uploads',
  );

  /** The public prefix `main.ts` serves the upload directory at. */
  private readonly urlPrefix = (
    process.env.UPLOAD_URL_PREFIX || '/uploads'
  ).replace(/\/+$/, '');

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
    // StorageModule is @Global, so FloorPlansModule needs no new import.
    private readonly storage: StorageService,
  ) {}

  // The constructor used to mkdir uploadDir/dwgDir/modelDir eagerly. That is
  // gone with the writes: `StorageService.put()` creates whatever the key
  // needs, and on a remote driver there is no directory to create. Creating
  // them here would also have been a lie about where the bytes now go.

  // ══════════════════════════════════════════════════════════════════════════
  // VALIDATION HELPERS
  // ══════════════════════════════════════════════════════════════════════════

  /** FIX 1: the asset must exist AND belong to the caller's tenant. */
  private async assertAsset(assetId: string, tenantId: string): Promise<Asset> {
    const asset = await this.assetRepository.findOne({
      where: { id: assetId, tenantId },
      // The profile travels with the asset because the asset's TYPE lives on
      // it, and a floor plan has no type of its own — it inherits the one its
      // asset inherits. Without this relation `resolveAssetType()` would
      // answer null for every plan whose asset does have a profile.
      relations: ['assetProfile'],
    });
    if (!asset) {
      throw new NotFoundException('Asset not found');
    }
    return asset;
  }

  /**
   * The asset a floor plan hangs off, as every floor-plan read projects it.
   *
   * One helper so the four read paths cannot drift: `type` used to be
   * `Asset.type`, free text that the 3D viewer keyword-matched when the
   * profile was missing. There is now exactly one answer and it comes from
   * the profile.
   *
   * A plan whose asset has **no profile** (or a profile with no `type`) gets
   * `assetType: null`. That is not an error and nothing is withheld: the plan
   * lists, parses, exports and renders exactly as before — the 3D viewer's
   * `resolveAssetSceneFamily()` resolves `null` to its `ground` family, the
   * neutral ground plate that was the viewer's behaviour before asset context
   * scenes existed. `assetProfileId: null` is in the payload so a UI can say
   * "attach a profile to get a building" rather than silently showing a slab.
   */
  private projectAsset(asset: Asset | undefined | null) {
    if (!asset) return null;
    const assetType = asset.resolveAssetType();
    return {
      id: asset.id,
      name: asset.name,
      description: asset.description ?? null,
      assetProfileId: asset.assetProfileId ?? null,
      /** The inherited type — `AssetProfile.type`, the only source. */
      assetType,
      /** The same value under the name the 3D payloads already used. */
      assetProfileType: assetType,
    };
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
      // The asset's profile carries the type each listed plan inherits.
      // Projected to three columns rather than `leftJoinAndSelect`: the
      // profile's `schema` and `alarmRules` jsonb would otherwise be repeated
      // on every row of every page.
      .leftJoin('asset.assetProfile', 'assetProfile')
      .addSelect(['assetProfile.id', 'assetProfile.name', 'assetProfile.type'])
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

  /**
   * Raw entity fetch, tenant-scoped, with the asset — and the asset's profile
   * — joined. The profile is what carries the type the plan inherits.
   */
  async findOne(id: string, tenantId: string): Promise<FloorPlan> {
    const floorPlan = await this.floorPlanRepository.findOne({
      where: { id, tenantId },
      relations: ['asset', 'asset.assetProfile'],
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
      // `type` is gone from this projection on purpose. It was `Asset.type`,
      // and a consumer reading it was reading the duplicate: the same screen
      // could get `building` here and `warehouse` from the asset's profile.
      asset: this.projectAsset(floorPlan.asset as Asset | undefined),
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
      // `asset.assetProfile` for the same reason as `findOne`: the plans of an
      // asset inherit its type, and `get3DSimulationData` reads it off these
      // rows.
      relations: ['asset', 'asset.assetProfile'],
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

    // The key is preferred and the URL is the fallback, so a row written before
    // the storage seam still has its bytes removed.
    await this.deleteRef(floorPlan.dwgStorageKey ?? floorPlan.dwgFileUrl);
    await this.deleteRef(
      floorPlan.thumbnailStorageKey ?? floorPlan.thumbnailUrl,
    );
    await this.deleteRef(floorPlan.modelStorageKey ?? floorPlan.modelFileUrl);

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
    const asset = await this.assertAsset(assetId, tenantId);
    const assetContext = this.projectAsset(asset);

    const floorPlans = await this.floorPlanRepository.find({
      where: { assetId, tenantId },
      order: { floorNumber: 'ASC' },
    });

    if (floorPlans.length === 0) {
      // The type is reported even with no plans: this is the screen that
      // decides what to offer, and "a warehouse with no floor plan yet" is a
      // different thing to offer than "a building with no floor plan yet".
      return { assetId, asset: assetContext, total: 0, floorPlans: [] };
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
      asset: assetContext,
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

    if (!file.buffer?.length) {
      throw new BadRequestException('Uploaded file is empty');
    }

    try {
      // Never interpolate the client-supplied filename into a shell command or a
      // path: the parser shells out to dwg2dxf. Use a UUID and keep the extension.
      const fileName = `${uuidv4()}${ext}`;
      const stored = await this.storage.put(
        `${DWG_KEY_PREFIX}/${fileName}`,
        file.buffer,
        { contentType: 'application/octet-stream' },
      );

      // The KEY is what every later read uses; the URL is what a browser gets.
      // Previously only the URL was stored and the read paths rebuilt an
      // absolute local path from it — correct on one container and a 404 on
      // every other replica.
      floorPlan.dwgStorageKey = stored.key;
      floorPlan.dwgFileUrl = stored.url;
      floorPlan.storageProvider = this.storage.name;
      floorPlan.dwgFileSizeBytes = file.size;
      floorPlan.dwgUploadedAt = new Date();
      floorPlan.status = FloorPlanStatus.PROCESSING;
      floorPlan.updatedBy = actor.userId;

      await this.floorPlanRepository.save(floorPlan);

      // The parse is handed the key and the extension, not a path: it reads the
      // bytes back out of storage and stages its own scratch copy for the
      // external converter.
      void this.parseDWGFileAsync(id, actor, stored.key, ext).catch((err) =>
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
    storageKey: string,
    extension: string,
  ): Promise<void> {
    try {
      this.logger.log(
        `Starting async DWG parsing for floor plan: ${floorPlanId}`,
      );

      // Read the bytes back through the seam rather than from the path the
      // upload happened to write. On a shared or remote driver this is the only
      // way the parse can run on a replica that did not handle the POST — and
      // with the local driver it is the same bytes it just wrote.
      const source = await this.readRef(storageKey);
      if (!source) {
        throw new Error(
          `The uploaded drawing could not be read back from storage (key ${storageKey})`,
        );
      }

      const geometry = await this.dwgParserService.parseDWGBuffer(
        source,
        extension,
      );

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

      // Thumbnail: the renderer returns PNG bytes and this stores them, so the
      // preview is reachable from every replica. It used to be written to the
      // dwg/ directory beside the source and keyed off the source filename;
      // the key is now derived from the floor plan id, which also means a
      // re-upload replaces the preview instead of orphaning the old one.
      let preview: { key: string; url: string } | null = null;
      try {
        const png = await this.dwgParserService.renderThumbnail(geometry);
        if (png?.length) {
          const stored = await this.storage.put(
            `${PREVIEW_KEY_PREFIX}/${floorPlanId}.png`,
            png,
            { contentType: 'image/png' },
          );
          preview = { key: stored.key, url: stored.url };
        } else {
          this.logger.warn(`Thumbnail generation failed for ${floorPlanId}`);
        }
      } catch (error) {
        this.logger.warn(
          `Thumbnail storage failed for ${floorPlanId}: ${(error as Error).message}`,
        );
      }

      const floorPlan = await this.findOne(floorPlanId, actor.tenantId);
      floorPlan.parsedGeometry = geometry;
      floorPlan.status = FloorPlanStatus.ACTIVE;
      floorPlan.parsingError = null as any;
      if (preview) {
        floorPlan.thumbnailStorageKey = preview.key;
        floorPlan.thumbnailUrl = preview.url;
        floorPlan.storageProvider = this.storage.name;
      }

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

  /**
   * Geometry ready to DRAW: the drawing standard applied, wall faces paired
   * into real walls, openings cut, X-marked spaces reported.
   *
   * Distinct from `getParsedGeometry` above, which returns the parser's raw
   * output. That output is deliberately permissive — it hands over every line
   * in the drawing as a wall CANDIDATE and lets the consumer decide — and the
   * 3D viewer was consuming it directly. On the client's own drawing library
   * that is 1211 "walls" of which 790 are the sheet title block, the wall
   * hatching, the section views, the dimension strings, the grid lines and the
   * letter outlines of the general notes. All of them were being extruded.
   *
   * `getParsedGeometry` is kept unchanged because the import wizard reads it
   * to show what was found in the file, including the things that are not
   * built — that screen's whole job is to report the drawing as it is.
   *
   * See `display/display-geometry.ts` for the four transformations and why
   * each one is there.
   */
  async getDisplayGeometry(
    id: string,
    tenantId: string,
    options: Partial<DisplayGeometryOptions> = {},
  ) {
    const floorPlan = await this.findOne(id, tenantId);

    if (!floorPlan.parsedGeometry) {
      throw new NotFoundException('Floor plan has not been parsed yet');
    }

    const display = buildDisplayGeometry(
      floorPlan.parsedGeometry as Record<string, any>,
      options,
    );

    return {
      floorPlanId: floorPlan.id,
      name: floorPlan.name,
      floor: floorPlan.floor,
      floorNumber: floorPlan.floorNumber,
      assetId: floorPlan.assetId,
      display,
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

    if (!file.buffer?.length) {
      throw new BadRequestException('Uploaded file is empty');
    }

    // Remove a previously stored model with a different extension BEFORE the
    // new one lands: the key is derived from the floor plan id, so a same-
    // extension re-upload overwrites in place and only a format change leaves
    // an orphan. Doing it after the put would be a no-op risk if the delete
    // resolved to the key just written.
    if (floorPlan.modelFileType && floorPlan.modelFileType !== ext) {
      await this.deleteRef(floorPlan.modelStorageKey ?? floorPlan.modelFileUrl);
    }

    // Filename is derived from the floor plan id, never from client input.
    const fileName = `${floorPlan.id}.${ext}`;
    const stored = await this.storage.put(
      `${MODEL_KEY_PREFIX}/${fileName}`,
      file.buffer,
      { contentType: MODEL_CONTENT_TYPES[ext] ?? 'application/octet-stream' },
    );

    floorPlan.modelStorageKey = stored.key;
    floorPlan.modelFileUrl = stored.url;
    floorPlan.storageProvider = this.storage.name;
    floorPlan.modelFileType = ext;
    floorPlan.modelFileSize = file.size;
    floorPlan.updatedBy = actor.userId;

    return await this.floorPlanRepository.save(floorPlan);
  }

  // ══════════════════════════════════════════════════════════════════════════
  // 3D MODEL GENERATION
  // ══════════════════════════════════════════════════════════════════════════

  /**
   * Builds a 3D model from the floor plan's parsed geometry and stores it.
   *
   * The counterpart to uploadModel(): rather than accepting a model made
   * elsewhere, this extrudes the DWG/DXF geometry already parsed. Walls become
   * solids with door and window openings cut out, rooms become floor slabs,
   * columns and stairs become massing.
   *
   * Runs synchronously: a floor plan's mesh is thousands of triangles, not
   * millions, and building it takes single-digit milliseconds. A queue would add
   * latency and failure modes for no benefit.
   */
  async generateModel(id: string, actor: Actor, dto: GenerateModelDto = {}) {
    const floorPlan = await this.findOne(id, actor.tenantId);

    if (!floorPlan.parsedGeometry) {
      throw new BadRequestException(
        'This floor plan has no parsed geometry. Upload a DWG or DXF file first ' +
          '(POST /floor-plans/:id/dwg-upload) and wait for its status to become ACTIVE.',
      );
    }

    const format = dto.format ?? ModelFormat.GLB;
    const upAxis = dto.upAxis === ModelUpAxis.Z_UP ? 'z-up' : 'y-up';

    const built = FloorPlanMeshFactory.build(floorPlan.parsedGeometry as any, {
      wallHeight: dto.wallHeight ?? 3,
      defaultWallThickness: dto.defaultWallThickness ?? 0.2,
      slabThickness: dto.slabThickness ?? 0.15,
      windowSillHeight: dto.windowSillHeight ?? 0.9,
      windowHeadHeight: dto.windowHeadHeight ?? 2.2,
      doorHeight: dto.doorHeight ?? 2.1,
      includeWalls: dto.includeWalls ?? true,
      includeFloors: dto.includeFloors ?? true,
      includeColumns: dto.includeColumns ?? true,
      includeDoors: dto.includeDoors ?? true,
      includeWindows: dto.includeWindows ?? true,
      includeStairs: dto.includeStairs ?? true,
      includeFurniture: dto.includeFurniture ?? false,
      includeDevices: dto.includeDevices ?? true,
      includeRoutes: dto.includeRoutes ?? true,
      includeBeams: dto.includeBeams ?? true,
      includeCeilings: dto.includeCeilings ?? false,
      cutOpenings: dto.cutOpenings ?? true,
      centerOnOrigin: dto.centerOnOrigin ?? true,
    });

    const groups = built.builder.getGroups();

    if (built.builder.isEmpty()) {
      // A valid-but-empty model would be worse than refusing: it looks like
      // success, and the user only finds out when the viewer shows nothing.
      throw new BadRequestException(
        'The parsed geometry produced no 3D solids. ' +
          built.warnings.join(' ') +
          ' Check that the drawing has walls or rooms on recognisable layers.',
      );
    }

    const companionFiles: string[] = [];
    let payload: Buffer;

    switch (format) {
      case ModelFormat.GLTF:
        payload = GltfExporter.toGLTF(groups, { upAxis, sceneName: floorPlan.name });
        break;

      case ModelFormat.OBJ: {
        const { obj, mtl } = ObjExporter.toOBJ(groups, {
          upAxis,
          baseName: floorPlan.id,
        });
        // The OBJ references the MTL by name, so both must be stored or the
        // model loads untextured. Through the seam for the same reason as the
        // OBJ itself: a companion file on one replica's disk is a 404 for the
        // viewer that fetched the OBJ from another.
        const mtlName = `${floorPlan.id}.mtl`;
        const storedMtl = await this.storage.put(
          `${MODEL_KEY_PREFIX}/${mtlName}`,
          mtl,
          { contentType: 'model/mtl' },
        );
        companionFiles.push(storedMtl.url);
        payload = obj;
        break;
      }

      case ModelFormat.STL:
        payload = ObjExporter.toSTL(groups);
        break;

      case ModelFormat.GLB:
      default:
        payload = GltfExporter.toGLB(groups, { upAxis, sceneName: floorPlan.name });
        break;
    }

    // Remove the previous model when the extension changes, or it lingers as an
    // orphan getModelFile can no longer reach.
    if (floorPlan.modelFileType && floorPlan.modelFileType !== format) {
      await this.deleteRef(floorPlan.modelStorageKey ?? floorPlan.modelFileUrl);
    }

    const fileName = `${floorPlan.id}.${format}`;
    const stored = await this.storage.put(
      `${MODEL_KEY_PREFIX}/${fileName}`,
      payload,
      {
        contentType:
          MODEL_CONTENT_TYPES[format] ?? 'application/octet-stream',
      },
    );

    floorPlan.modelStorageKey = stored.key;
    floorPlan.modelFileUrl = stored.url;
    floorPlan.storageProvider = this.storage.name;
    floorPlan.modelFileType = format;
    floorPlan.modelFileSize = payload.length;
    floorPlan.updatedBy = actor.userId;

    await this.floorPlanRepository.save(floorPlan);

    this.logger.log(
      `Generated ${format.toUpperCase()} model for floor plan ${id}: ` +
        `${built.stats.triangles} triangles, ${payload.length} bytes`,
    );

    return {
      format,
      fileName,
      url: floorPlan.modelFileUrl,
      sizeBytes: payload.length,
      stats: built.stats,
      warnings: built.warnings,
      boundingBox: built.boundingBox,
      companionFiles,
    };
  }

  /**
   * Reports what a generated model WOULD contain, without writing anything.
   *
   * Surfaces unmatched openings and untriangulatable rooms so the drawing can be
   * fixed first, rather than discovering the problem in a viewer.
   */
  async previewModel(id: string, tenantId: string, dto: GenerateModelDto = {}) {
    const floorPlan = await this.findOne(id, tenantId);

    if (!floorPlan.parsedGeometry) {
      throw new BadRequestException(
        'This floor plan has no parsed geometry. Upload a DWG or DXF file first.',
      );
    }

    const built = FloorPlanMeshFactory.build(floorPlan.parsedGeometry as any, {
      wallHeight: dto.wallHeight ?? 3,
      defaultWallThickness: dto.defaultWallThickness ?? 0.2,
      slabThickness: dto.slabThickness ?? 0.15,
      windowSillHeight: dto.windowSillHeight ?? 0.9,
      windowHeadHeight: dto.windowHeadHeight ?? 2.2,
      doorHeight: dto.doorHeight ?? 2.1,
      includeWalls: dto.includeWalls ?? true,
      includeFloors: dto.includeFloors ?? true,
      includeColumns: dto.includeColumns ?? true,
      includeDoors: dto.includeDoors ?? true,
      includeWindows: dto.includeWindows ?? true,
      includeStairs: dto.includeStairs ?? true,
      includeFurniture: dto.includeFurniture ?? false,
      includeDevices: dto.includeDevices ?? true,
      includeRoutes: dto.includeRoutes ?? true,
      includeBeams: dto.includeBeams ?? true,
      includeCeilings: dto.includeCeilings ?? false,
      cutOpenings: dto.cutOpenings ?? true,
      centerOnOrigin: dto.centerOnOrigin ?? true,
    });

    return {
      floorPlanId: floorPlan.id,
      name: floorPlan.name,
      wouldProduceGeometry: !built.builder.isEmpty(),
      stats: built.stats,
      warnings: built.warnings,
      boundingBox: built.boundingBox,
      // `key` and `layer` are included alongside the material name because
      // services are split one group per layer: seven separate camera,
      // access-control and Wi-Fi groups all carry the material name
      // "Telecoms equipment", so the name alone cannot drive a legend or a
      // per-service visibility toggle.
      materials: built.builder.getGroups().map((group) => {
        const colon = group.key.indexOf(':');
        return {
          key: group.key,
          name: group.material.name,
          kind: colon === -1 ? group.key : group.key.slice(0, colon),
          layer: colon === -1 ? null : group.key.slice(colon + 1),
          triangles: group.indices.length / 3,
        };
      }),
      availableFormats: ['glb', 'gltf', 'obj', 'stl'],
    };
  }

  // ══════════════════════════════════════════════════════════════════════════
  // READ PATHS — every byte served back comes through StorageService
  // ══════════════════════════════════════════════════════════════════════════
  //
  // These three return BYTES, not a path. A converted write with an
  // unconverted read is worse than not converting at all: it looks finished
  // and 404s (N-1)/N of the time behind a balancer, because the GET lands on a
  // replica where the path does not exist. `getModelFile()` was the clearest
  // case — it ignored `modelFileUrl` entirely and rebuilt
  // `<modelDir>/<id>.<type>`, which only the uploading replica has.
  //
  // The static `/uploads/**` mount in main.ts is still there and is still how
  // a browser loads `thumbnailUrl` on the local driver. These routes are the
  // driver-independent way to the same bytes, and the only way that keeps
  // working when the driver is not local.

  /** The uploaded DWG/DXF source, for download. */
  async getDwgFile(
    id: string,
    tenantId: string,
  ): Promise<{ buffer: Buffer; contentType: string; fileName: string }> {
    const floorPlan = await this.findOne(id, tenantId);

    const ref = floorPlan.dwgStorageKey ?? floorPlan.dwgFileUrl;
    if (!ref) {
      throw new NotFoundException(
        'No DWG or DXF file has been uploaded for this floor plan',
      );
    }

    const buffer = await this.readRef(ref);
    if (!buffer) {
      throw new NotFoundException('The source drawing is missing from storage');
    }

    // The stored key keeps the validated extension, so the download name is
    // honest about the format without trusting anything the client sent.
    const extension = path.extname(ref).toLowerCase() || '.dxf';

    return {
      buffer,
      contentType: 'application/octet-stream',
      fileName: this.downloadName(floorPlan.name, extension),
    };
  }

  /** The generated PNG preview. */
  async getPreviewFile(
    id: string,
    tenantId: string,
  ): Promise<{ buffer: Buffer; contentType: string; fileName: string }> {
    const floorPlan = await this.findOne(id, tenantId);

    const ref = floorPlan.thumbnailStorageKey ?? floorPlan.thumbnailUrl;
    if (!ref) {
      throw new NotFoundException(
        'This floor plan has no preview image. Upload a DWG or DXF file and ' +
          'wait for its status to become ACTIVE.',
      );
    }

    const buffer = await this.readRef(ref);
    if (!buffer) {
      // An external `https://…` thumbnailUrl (the seeder writes those) lands
      // here: it is a real URL the client should fetch itself, not bytes this
      // platform holds.
      throw new NotFoundException('The preview image is missing from storage');
    }

    return {
      buffer,
      contentType: 'image/png',
      fileName: this.downloadName(floorPlan.name, '.png'),
    };
  }

  /** The 3D model, uploaded or generated. */
  async getModelFile(
    id: string,
    tenantId: string,
  ): Promise<{ buffer: Buffer; contentType: string; fileName: string }> {
    const floorPlan = await this.findOne(id, tenantId);

    if (!floorPlan.modelFileType) {
      throw new NotFoundException('No 3D model uploaded for this floor plan');
    }

    // The key first, then the URL, and only then the path this used to build.
    // `generateModel` writes `<id>.<format>` under the models prefix, so the
    // derived fallback still finds a model stored before the key column
    // existed even if the row's URL was never set.
    const ref =
      floorPlan.modelStorageKey ??
      floorPlan.modelFileUrl ??
      `${MODEL_KEY_PREFIX}/${floorPlan.id}.${floorPlan.modelFileType}`;

    const buffer = await this.readRef(ref);
    if (!buffer) {
      throw new NotFoundException('Model file is missing from storage');
    }

    return {
      buffer,
      contentType:
        MODEL_CONTENT_TYPES[floorPlan.modelFileType] ??
        'application/octet-stream',
      fileName: this.downloadName(
        floorPlan.name,
        `.${floorPlan.modelFileType}`,
      ),
    };
  }

  /**
   * A Content-Disposition filename that cannot inject a header.
   *
   * `floorPlan.name` is free text a user typed, and it was previously
   * interpolated straight into the header.
   */
  private downloadName(name: string, extension: string): string {
    const base =
      path.basename(name || '').replace(/["\r\n\\]/g, '').trim() ||
      'floor-plan';
    return `${base}${extension}`;
  }

  // ══════════════════════════════════════════════════════════════════════════
  // 3D SIMULATION
  // ══════════════════════════════════════════════════════════════════════════

  async get3DSimulationData(assetId: string, tenantId: string) {
    const floorPlans = await this.findByAsset(assetId, tenantId);

    if (floorPlans.length === 0) {
      throw new NotFoundException('No floor plans found for this asset');
    }

    // Every plan of an asset shares that asset, so the first one's relation is
    // the asset — no second query. The 3D route is the main consumer of the
    // type (it picks the context scene from it), which is why it was the route
    // where the old free-text fallback was most visible.
    const assetContext = this.projectAsset(
      floorPlans[0].asset as Asset | undefined,
    );

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
      asset: assetContext,
      /** Inherited from the asset's profile; `null` → the `ground` scene. */
      assetType: assetContext?.assetType ?? null,
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

  /**
   * Lists the zones of a floor plan.
   *
   * Zones are stored on the floor plan row rather than in their own table, so
   * this is a projection rather than a query. It exists because the frontend was
   * calling GET /:id/zones and getting a 404 — it had no way to read zones back
   * without fetching the whole floor plan, including its parsed geometry, which
   * can be megabytes.
   */
  async getZones(id: string, tenantId: string) {
    const floorPlan = await this.findOne(id, tenantId);
    return Array.isArray(floorPlan.zones) ? floorPlan.zones : [];
  }

  /**
   * Duplicates a floor plan under a new name.
   *
   * Everything describing the layout is copied — geometry, zones, settings,
   * 3D metadata. Device placements are deliberately NOT copied: a device exists
   * in one physical place, and duplicating its placement would claim the same
   * hardware is on two floors at once. The copy starts empty and the user places
   * devices on it.
   *
   * The source file on disk is shared rather than duplicated. Both rows point at
   * the same uploaded DWG, which is correct for a copy made moments after the
   * original, and avoids doubling storage for every clone.
   */
  async clone(
    id: string,
    actor: Actor,
    newName: string,
  ): Promise<FloorPlan> {
    const { tenantId, userId } = actor;
    const source = await this.findOne(id, tenantId);

    const name = (newName || '').trim() || `${source.name} (copy)`;

    // A floor plan occupies a floor of an asset exclusively, so the copy cannot
    // sit on the same floor as its source.
    const existing = await this.floorPlanRepository.findOne({
      where: { tenantId, assetId: source.assetId, floor: source.floor },
    });

    await this.assertFloorPlanQuota(actor);

    const copy = this.floorPlanRepository.create({
      ...source,
      id: undefined,
      name,
      // Floor is cleared when it would collide; the user assigns one. Silently
      // reusing it would violate the one-plan-per-floor rule the rest of the
      // service enforces.
      floor: existing ? null : source.floor,
      devicePlacements: [],
      createdAt: undefined,
      updatedAt: undefined,
      createdBy: userId,
      updatedBy: userId,
    } as unknown as Partial<FloorPlan>);

    return this.floorPlanRepository.save(copy);
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

  // ══════════════════════════════════════════════════════════════════════════
  // STORED REFERENCES — the legacy-path resolver
  // ══════════════════════════════════════════════════════════════════════════
  //
  // Rows that already exist hold one of four things in `dwgFileUrl`,
  // `thumbnailUrl` and `modelFileUrl`, and nothing in the schema distinguishes
  // them:
  //
  //   1. `floor-plans/dwg/<uuid>.dwg`    — a storage key (written from now on)
  //   2. `/uploads/floor-plans/dwg/…`    — a public URL (every pre-seam upload)
  //   3. `/abs/path/uploads/floor-plans/…` — an absolute local path
  //   4. `https://example.com/…`         — someone else's URL (the seeder)
  //
  // Deciding by shape rather than by a flag column is deliberate: a flag would
  // have to be backfilled correctly for every row before any read worked,
  // whereas the shapes are unambiguous and a row needs no migration to be
  // readable. The `*StorageKey` columns the migration adds are the fast path,
  // not a prerequisite.

  /**
   * Classify a stored reference. Never throws and never touches the
   * filesystem — it is pure string work, so it is safe on a hot read path.
   */
  private resolveRef(value?: string | null): StoredRef {
    const empty: StoredRef = { key: null, legacyPath: null, external: false };
    if (!value) return empty;

    const raw = String(value).trim();
    if (!raw) return empty;

    // (4) Not ours. Returning a key here would make `delete()` try to remove a
    // path derived from someone else's hostname.
    if (/^[a-z][a-z0-9+.-]*:\/\//i.test(raw)) {
      return { key: null, legacyPath: null, external: true };
    }

    const posix = raw.replace(/\\/g, '/');

    // (2) A public URL. The segment after the prefix is exactly the key the
    // local driver would have produced for those bytes — `/uploads/x/y` → `x/y`
    // — so one value answers both questions, and that is what makes pre-seam
    // rows readable through the seam with no migration at all.
    if (posix === this.urlPrefix || posix.startsWith(`${this.urlPrefix}/`)) {
      const key = posix.slice(this.urlPrefix.length).replace(/^\/+/, '');
      return {
        key: this.safeKey(key),
        // What the old deleteFile() computed, kept as the fallback for a
        // deployment whose UPLOAD_PATH no longer matches UPLOAD_URL_PREFIX.
        legacyPath: path.join(process.cwd(), posix),
        external: false,
      };
    }

    // (3) An absolute path, including a Windows drive letter. Expressible as a
    // key when it sits under the storage root; outside it, only the path.
    if (path.isAbsolute(raw) || /^[A-Za-z]:[\\/]/.test(raw)) {
      const absolute = path.resolve(raw);
      const relative = path.relative(this.storageRoot, absolute);
      const inRoot =
        !!relative && !relative.startsWith('..') && !path.isAbsolute(relative);
      return {
        key: inRoot ? this.safeKey(relative.split(path.sep).join('/')) : null,
        legacyPath: absolute,
        external: false,
      };
    }

    // (1) Already a key.
    return { key: this.safeKey(posix), legacyPath: null, external: false };
  }

  /**
   * Refuse a key that walks out of its root.
   *
   * The local driver refuses one too — by throwing. These values come from the
   * database rather than from a request, so a bad row should degrade to a 404
   * on that one floor plan, not a 500 that takes out a list endpoint.
   */
  private safeKey(key: string): string | null {
    const normalised = key.replace(/^\/+/, '');
    if (!normalised) return null;
    if (normalised.split('/').includes('..')) return null;
    return normalised;
  }

  /**
   * Read a stored reference, whatever shape it is in.
   *
   * The key is tried first and the legacy absolute path second. With the local
   * driver both resolve to the same file, so the fallback costs nothing; with a
   * remote driver the fallback is what still serves a file uploaded before the
   * bytes were migrated into the bucket.
   *
   * Returns null rather than throwing: every caller turns a missing file into a
   * 404, and an unreadable artefact must not fail the whole floor plan.
   */
  private async readRef(value?: string | null): Promise<Buffer | null> {
    const ref = this.resolveRef(value);
    if (ref.external) return null;

    if (ref.key) {
      try {
        if (await this.storage.exists(ref.key)) {
          return await this.storage.get(ref.key);
        }
      } catch (error) {
        this.logger.warn(
          `Storage read failed for key ${ref.key}: ${(error as Error).message}`,
        );
      }
    }

    if (ref.legacyPath) {
      try {
        return await fs.readFile(ref.legacyPath);
      } catch {
        // Expected whenever the key above already answered, or the row is
        // stale. Not worth a log line per read.
      }
    }

    return null;
  }

  /**
   * Delete a stored reference. Replaces `deleteFile()`, which only ever knew
   * how to `path.join(process.cwd(), fileUrl)`.
   *
   * Both the key and the legacy path are attempted, because a file uploaded
   * before the seam may exist under only one of them. An already-absent file is
   * a success — these run on cleanup paths where throwing would mask the
   * original failure.
   */
  private async deleteRef(value?: string | null): Promise<void> {
    const ref = this.resolveRef(value);
    if (ref.external) return;

    if (ref.key) {
      await this.storage.delete(ref.key).catch((error) => {
        this.logger.warn(
          `Failed to delete storage key ${ref.key}: ${(error as Error).message}`,
        );
        return false;
      });
    }

    if (ref.legacyPath) {
      await fs.unlink(ref.legacyPath).catch(() => undefined);
    }
  }
}
