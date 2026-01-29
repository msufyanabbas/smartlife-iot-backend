import {
  Injectable,
  NotFoundException,
  ConflictException,
  BadRequestException,
  ForbiddenException,
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
import { User } from '../index.entities';
import { UserRole } from '@common/enums/index.enum';

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
  async create(createAssetDto: CreateAssetDto, user: User): Promise<Asset> {
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

      if (user.role === UserRole.CUSTOMER_USER) {
        if (parentAsset.customerId !== user.customerId) {
          throw new ForbiddenException(
            'Cannot create asset under another customer\'s asset',
          );
        }
      }
    }

    const asset = this.assetRepository.create(
      {
        ...createAssetDto,
        tenantId: user.tenantId,
        customerId: user.role === UserRole.CUSTOMER_USER ? user.customerId : createAssetDto.customerId
      }
    );
    const savedAsset = await this.assetRepository.save(asset);

    // Emit event
    this.eventEmitter.emit('asset.created', { asset: savedAsset });

    return savedAsset;
  }

  /**
   * Find all assets with filters and pagination
   */
  async findAll(queryDto: QueryAssetsDto, user: User): Promise<{
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

     // ========================================
    // CUSTOMER FILTERING LOGIC (if user provided)
    // ========================================
    if (user) {
      if (user.role === UserRole.CUSTOMER_USER) {
        // Customer users only see their customer's assets
        if (!user.customerId) {
          return {
            assets: [],
            total: 0,
            page,
            limit,
            totalPages: 0,
          };
        }
        queryBuilder.andWhere('asset.customerId = :customerId', {
          customerId: user.customerId,
        });
      } else if (user.role === UserRole.TENANT_ADMIN) {
        // Tenant admins see all assets in their tenant
        queryBuilder.andWhere('asset.tenantId = :tenantId', {
          tenantId: user.tenantId,
        });
      }
      // SUPER_ADMIN sees everything (no filter)
    }

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

      if (queryDto.tenantId && user.role === UserRole.SUPER_ADMIN) {
      queryBuilder.andWhere('asset.tenantId = :tenantId', {
        tenantId: queryDto.tenantId,
      });
    }

     if (queryDto.customerId) {
      // Validate access
      if (
        user.role === UserRole.CUSTOMER_USER &&
        user.customerId !== queryDto.customerId
      ) {
        throw new ForbiddenException('Access denied to this customer');
      }
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
   async findOne(id: string, user: User): Promise<Asset> {
    const queryBuilder = this.assetRepository
      .createQueryBuilder('asset')
      .leftJoinAndSelect('asset.parentAsset', 'parentAsset')
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

    Object.assign(asset, updateAssetDto);
    const updatedAsset = await this.assetRepository.save(asset);

    // Emit event
    this.eventEmitter.emit('asset.updated', { asset: updatedAsset });

    return updatedAsset;
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
   * Get child assets
   */
  async getChildren(id: string, user: User): Promise<Asset[]> {
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

    return await queryBuilder.orderBy('asset.name', 'ASC').getMany();
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
   async bulkAssignDevices(
    assetId: string,
    deviceIds: string[],
    user: User,
  ): Promise<void> {
    const asset = await this.findOne(assetId, user);

    // Validate all devices belong to the same customer (for customer users)
    if (user.role === UserRole.CUSTOMER_USER) {
      const devices = await this.deviceRepository.find({
        where: { id: In(deviceIds) },
      });

      const invalidDevices = devices.filter(
        (d) => d.customerId !== user.customerId,
      );

      if (invalidDevices.length > 0) {
        throw new ForbiddenException(
          'Cannot assign devices from another customer',
        );
      }
    }

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
