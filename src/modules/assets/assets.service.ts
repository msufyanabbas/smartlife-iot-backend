import {
  Injectable,
  NotFoundException,
  ConflictException,
  BadRequestException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, Like, In, IsNull } from 'typeorm';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { Asset, AssetType } from './entities/asset.entity';
import { Device } from '../devices/entities/device.entity';
import {
  CreateAssetDto,
  UpdateAssetDto,
  QueryAssetsDto,
  UpdateAttributesDto,
} from './dto/assets.dto';

@Injectable()
export class AssetsService {
  constructor(
    @InjectRepository(Asset)
    private assetRepository: Repository<Asset>,
    @InjectRepository(Device)
    private deviceRepository: Repository<Device>,
    private eventEmitter: EventEmitter2,
  ) {}

  /**
   * Create a new asset
   */
  async create(createAssetDto: CreateAssetDto): Promise<Asset> {
    // Check if parent asset exists
    if (createAssetDto.parentAssetId) {
      const parentAsset = await this.assetRepository.findOne({
        where: { id: createAssetDto.parentAssetId },
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
    }

    const asset = this.assetRepository.create(createAssetDto);
    const savedAsset = await this.assetRepository.save(asset);

    // Emit event
    this.eventEmitter.emit('asset.created', { asset: savedAsset });

    return savedAsset;
  }

  /**
   * Find all assets with filters and pagination
   */
  async findAll(queryDto: QueryAssetsDto): Promise<{
    assets: Asset[];
    total: number;
    page: number;
    limit: number;
    totalPages: number;
  }> {
    const page = queryDto.page || 1;
    const limit = queryDto.limit || 10;
    const skip = (page - 1) * limit;

    const queryBuilder = this.assetRepository.createQueryBuilder('asset');

    // Apply filters
    if (queryDto.search) {
      queryBuilder.andWhere(
        '(asset.name ILIKE :search OR asset.label ILIKE :search OR asset.description ILIKE :search)',
        { search: `%${queryDto.search}%` },
      );
    }

    if (queryDto.type) {
      queryBuilder.andWhere('asset.type = :type', { type: queryDto.type });
    }

    if (queryDto.tenantId) {
      queryBuilder.andWhere('asset.tenantId = :tenantId', {
        tenantId: queryDto.tenantId,
      });
    }

    if (queryDto.customerId) {
      queryBuilder.andWhere('asset.customerId = :customerId', {
        customerId: queryDto.customerId,
      });
    }

    if (queryDto.assetProfileId) {
      queryBuilder.andWhere('asset.assetProfileId = :assetProfileId', {
        assetProfileId: queryDto.assetProfileId,
      });
    }

    if (queryDto.parentAssetId) {
      queryBuilder.andWhere('asset.parentAssetId = :parentAssetId', {
        parentAssetId: queryDto.parentAssetId,
      });
    }

    if (queryDto.active !== undefined) {
      queryBuilder.andWhere('asset.active = :active', {
        active: queryDto.active,
      });
    }

    if (queryDto.tags && queryDto.tags.length > 0) {
      queryBuilder.andWhere('asset.tags && :tags', { tags: queryDto.tags });
    }

    // Get total count
    const total = await queryBuilder.getCount();

    // Apply pagination
    const assets = await queryBuilder
      .leftJoinAndSelect('asset.parentAsset', 'parentAsset')
      .skip(skip)
      .take(limit)
      .orderBy('asset.createdAt', 'DESC')
      .getMany();

    return {
      assets,
      total,
      page,
      limit,
      totalPages: Math.ceil(total / limit),
    };
  }

  /**
   * Find one asset by ID
   */
  async findOne(id: string): Promise<Asset> {
    const asset = await this.assetRepository.findOne({
      where: { id },
      relations: ['parentAsset'],
    });

    if (!asset) {
      throw new NotFoundException('Asset not found');
    }

    return asset;
  }

  /**
   * Update asset
   */
  async update(id: string, updateAssetDto: UpdateAssetDto): Promise<Asset> {
    const asset = await this.findOne(id);

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
    }

    Object.assign(asset, updateAssetDto);
    const updatedAsset = await this.assetRepository.save(asset);

    // Emit event
    this.eventEmitter.emit('asset.updated', { asset: updatedAsset });

    return updatedAsset;
  }

  /**
   * Delete asset
   */
  async remove(id: string): Promise<void> {
    const asset = await this.findOne(id);

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

    // Emit event
    this.eventEmitter.emit('asset.deleted', { assetId: id });
  }

  /**
   * Get asset hierarchy (children)
   */
  async getHierarchy(
    id: string,
    maxDepth: number = 10,
    includeDevices: boolean = false,
  ): Promise<any> {
    const asset = await this.findOne(id);

    const hierarchy = await this.buildHierarchy(
      asset,
      maxDepth,
      0,
      includeDevices,
    );

    return hierarchy;
  }

  /**
   * Get root assets (no parent)
   */
  async getRootAssets(): Promise<Asset[]> {
    return await this.assetRepository.find({
      where: { parentAssetId: IsNull() },
      order: { name: 'ASC' },
    });
  }

  /**
   * Get asset path (from root to asset)
   */
  async getAssetPath(id: string): Promise<Asset[]> {
    const path: Asset[] = [];
    let currentAsset = await this.findOne(id);

    path.unshift(currentAsset);

    while (currentAsset.parentAssetId) {
      currentAsset = await this.findOne(currentAsset.parentAssetId);
      path.unshift(currentAsset);
    }

    return path;
  }

  /**
   * Get child assets
   */
  async getChildren(id: string): Promise<Asset[]> {
    return await this.assetRepository.find({
      where: { parentAssetId: id },
      order: { name: 'ASC' },
    });
  }

  /**
   * Assign device to asset
   */
  async assignDevice(assetId: string, deviceId: string): Promise<void> {
    const asset = await this.findOne(assetId);

    const device = await this.deviceRepository.findOne({
      where: { id: deviceId },
    });

    if (!device) {
      throw new NotFoundException('Device not found');
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
  async unassignDevice(assetId: string, deviceId: string): Promise<void> {
    const device = await this.deviceRepository.findOne({
      where: { id: deviceId, assetId },
    });

    if (!device) {
      throw new NotFoundException(
        'Device not found or not assigned to this asset',
      );
    }

    device.assetId = '';
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
  async bulkAssignDevices(assetId: string, deviceIds: string[]): Promise<void> {
    const asset = await this.findOne(assetId);

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
  async getDevices(assetId: string): Promise<Device[]> {
    return await this.deviceRepository.find({
      where: { assetId },
      order: { name: 'ASC' },
    });
  }

  /**
   * Update asset attributes
   */
  async updateAttributes(
    id: string,
    updateAttributesDto: UpdateAttributesDto,
  ): Promise<Asset> {
    const asset = await this.findOne(id);

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
  ): Promise<Asset[]> {
    // Simplified location search
    // In production, use PostGIS for accurate geospatial queries
    const assets = await this.assetRepository
      .createQueryBuilder('asset')
      .where("asset.location->>'latitude' IS NOT NULL")
      .andWhere("asset.location->>'longitude' IS NOT NULL")
      .getMany();

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
  async getStatistics(): Promise<{
    total: number;
    active: number;
    inactive: number;
    byType: Record<AssetType, number>;
    withDevices: number;
    withoutDevices: number;
  }> {
    const [total, active, inactive] = await Promise.all([
      this.assetRepository.count(),
      this.assetRepository.count({ where: { active: true } }),
      this.assetRepository.count({ where: { active: false } }),
    ]);

    // Count by type
    const types = await this.assetRepository
      .createQueryBuilder('asset')
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
    const assetsWithDevices = await this.assetRepository
      .createQueryBuilder('asset')
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
   * Private: Build asset hierarchy recursively
   */
  private async buildHierarchy(
    asset: Asset,
    maxDepth: number,
    currentDepth: number,
    includeDevices: boolean,
  ): Promise<any> {
    const result: any = {
      ...asset,
      children: [],
    };

    if (includeDevices) {
      result.devices = await this.getDevices(asset.id);
    }

    if (currentDepth < maxDepth) {
      const children = await this.getChildren(asset.id);

      for (const child of children) {
        const childHierarchy = await this.buildHierarchy(
          child,
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
  ): Promise<boolean> {
    if (!assetId) return false;
    if (assetId === newParentId) return true;

    let currentParentId: string | null = newParentId;

    while (currentParentId) {
      if (currentParentId === assetId) {
        return true;
      }

      const parent = await this.assetRepository.findOne({
        where: { id: currentParentId },
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
}
