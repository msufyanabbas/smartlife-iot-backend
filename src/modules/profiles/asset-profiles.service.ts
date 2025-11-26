import {
  Injectable,
  NotFoundException,
  ConflictException,
  BadRequestException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { AssetProfile } from './entities/asset-profile.entity';
import { Asset } from '../assets/entities/asset.entity';
import {
  CreateAssetProfileDto,
  UpdateAssetProfileDto,
  QueryProfilesDto,
} from './dto/profiles.dto';

@Injectable()
export class AssetProfilesService {
  constructor(
    @InjectRepository(AssetProfile)
    private assetProfileRepository: Repository<AssetProfile>,
    @InjectRepository(Asset)
    private assetRepository: Repository<Asset>,
    private eventEmitter: EventEmitter2,
  ) {}

  /**
   * Create a new asset profile
   */
  async create(createDto: CreateAssetProfileDto): Promise<AssetProfile> {
    // Check if name already exists
    const existing = await this.assetProfileRepository.findOne({
      where: { name: createDto.name },
    });

    if (existing) {
      throw new ConflictException(
        'Asset profile with this name already exists',
      );
    }

    // If this is set as default, unset other defaults
    if (createDto.default) {
      await this.unsetAllDefaults(createDto.tenantId);
    }

    const profile = this.assetProfileRepository.create(createDto);
    const savedProfile = await this.assetProfileRepository.save(profile);

    // Emit event
    this.eventEmitter.emit('asset.profile.created', { profile: savedProfile });

    return savedProfile;
  }

  /**
   * Find all asset profiles with filters
   */
  async findAll(queryDto: QueryProfilesDto): Promise<{
    profiles: AssetProfile[];
    total: number;
    page: number;
    limit: number;
    totalPages: number;
  }> {
    const page = queryDto.page || 1;
    const limit = queryDto.limit || 10;
    const skip = (page - 1) * limit;

    const queryBuilder =
      this.assetProfileRepository.createQueryBuilder('profile');

    // Apply filters
    if (queryDto.search) {
      queryBuilder.andWhere(
        '(profile.name ILIKE :search OR profile.description ILIKE :search)',
        { search: `%${queryDto.search}%` },
      );
    }

    if (queryDto.tenantId) {
      queryBuilder.andWhere('profile.tenantId = :tenantId', {
        tenantId: queryDto.tenantId,
      });
    }

    if (queryDto.default !== undefined) {
      queryBuilder.andWhere('profile.default = :default', {
        default: queryDto.default,
      });
    }

    // Get total count
    const total = await queryBuilder.getCount();

    // Apply pagination
    const profiles = await queryBuilder
      .skip(skip)
      .take(limit)
      .orderBy('profile.createdAt', 'DESC')
      .getMany();

    return {
      profiles,
      total,
      page,
      limit,
      totalPages: Math.ceil(total / limit),
    };
  }

  /**
   * Find one asset profile by ID
   */
  async findOne(id: string): Promise<AssetProfile> {
    const profile = await this.assetProfileRepository.findOne({
      where: { id },
    });

    if (!profile) {
      throw new NotFoundException('Asset profile not found');
    }

    return profile;
  }

  /**
   * Get default asset profile
   */
  async getDefault(tenantId?: string): Promise<AssetProfile> {
    const query: any = { default: true };
    if (tenantId) {
      query.tenantId = tenantId;
    }

    const profile = await this.assetProfileRepository.findOne({
      where: query,
    });

    if (!profile) {
      throw new NotFoundException('No default asset profile found');
    }

    return profile;
  }

  /**
   * Update asset profile
   */
  async update(
    id: string,
    updateDto: UpdateAssetProfileDto,
  ): Promise<AssetProfile> {
    const profile = await this.findOne(id);

    // Check if name is being changed and if it already exists
    if (updateDto.name && updateDto.name !== profile.name) {
      const existing = await this.assetProfileRepository.findOne({
        where: { name: updateDto.name },
      });

      if (existing) {
        throw new ConflictException(
          'Asset profile with this name already exists',
        );
      }
    }

    // If setting as default, unset others
    if (updateDto.default && !profile.default) {
      await this.unsetAllDefaults(profile.tenantId);
    }

    Object.assign(profile, updateDto);
    const updatedProfile = await this.assetProfileRepository.save(profile);

    // Emit event
    this.eventEmitter.emit('asset.profile.updated', {
      profile: updatedProfile,
    });

    return updatedProfile;
  }

  /**
   * Set as default profile
   */
  async setDefault(id: string): Promise<AssetProfile> {
    const profile = await this.findOne(id);

    // Unset all other defaults for this tenant
    await this.unsetAllDefaults(profile.tenantId);

    profile.default = true;
    return await this.assetProfileRepository.save(profile);
  }

  /**
   * Delete asset profile
   */
  async remove(id: string): Promise<void> {
    const profile = await this.findOne(id);

    // Check if profile is in use
    const assetsUsingProfile = await this.assetRepository.count({
      where: { assetProfileId: id },
    });

    if (assetsUsingProfile > 0) {
      throw new BadRequestException(
        `Cannot delete profile. ${assetsUsingProfile} asset(s) are using this profile.`,
      );
    }

    // Can't delete default profile
    if (profile.default) {
      throw new BadRequestException('Cannot delete the default asset profile');
    }

    await this.assetProfileRepository.softRemove(profile);

    // Emit event
    this.eventEmitter.emit('asset.profile.deleted', { profileId: id });
  }

  /**
   * Clone asset profile
   */
  async clone(id: string, newName: string): Promise<AssetProfile> {
    const original = await this.findOne(id);

    // Check if new name already exists
    const existing = await this.assetProfileRepository.findOne({
      where: { name: newName },
    });

    if (existing) {
      throw new ConflictException(
        'Asset profile with this name already exists',
      );
    }

    // Create new profile based on original
    const cloned = this.assetProfileRepository.create({
      ...original,
      id: undefined, // Remove ID
      name: newName,
      default: false, // Clone is not default
      createdAt: undefined,
      updatedAt: undefined,
    });

    return await this.assetProfileRepository.save(cloned);
  }

  /**
   * Validate asset data against profile schema
   */
  async validateAssetData(
    id: string,
    assetData: Record<string, any>,
  ): Promise<{
    valid: boolean;
    errors: string[];
    warnings: string[];
  }> {
    const profile = await this.findOne(id);
    const errors: string[] = [];
    const warnings: string[] = [];

    // Validate custom fields
    if (profile.customFields && profile.customFields.length > 0) {
      for (const field of profile.customFields) {
        const value = assetData[field.key];

        // Check required fields
        if (field.required && (value === undefined || value === null)) {
          errors.push(`Required field missing: ${field.key}`);
          continue;
        }

        // Validate type if value present
        if (value !== undefined && value !== null) {
          const typeValid = this.validateFieldType(value, field.type);
          if (!typeValid) {
            errors.push(
              `Invalid type for ${field.key}. Expected ${field.type}`,
            );
          }
        }
      }
    }

    // Validate against metadata schema if present
    if (profile.metadataSchema?.properties) {
      for (const [key, schema] of Object.entries(
        profile.metadataSchema.properties,
      )) {
        const value = assetData[key];
        const propSchema = schema as any;

        if (propSchema.required && (value === undefined || value === null)) {
          errors.push(`Required property missing: ${key}`);
        }
      }
    }

    return {
      valid: errors.length === 0,
      errors,
      warnings,
    };
  }

  /**
   * Get assets using this profile
   */
  async getAssetsUsingProfile(id: string): Promise<Asset[]> {
    await this.findOne(id); // Ensure profile exists

    return await this.assetRepository.find({
      where: { assetProfileId: id },
      order: { name: 'ASC' },
    });
  }

  /**
   * Get profile statistics
   */
  async getStatistics(): Promise<{
    total: number;
    withCustomFields: number;
    withAlarmRules: number;
    withMetadataSchema: number;
  }> {
    const total = await this.assetProfileRepository.count();

    const withCustomFields = await this.assetProfileRepository
      .createQueryBuilder('profile')
      .where('profile.customFields IS NOT NULL')
      .andWhere('jsonb_array_length(profile.customFields) > 0')
      .getCount();

    const withAlarmRules = await this.assetProfileRepository
      .createQueryBuilder('profile')
      .where('profile.alarmRules IS NOT NULL')
      .andWhere('jsonb_array_length(profile.alarmRules) > 0')
      .getCount();

    const withMetadataSchema = await this.assetProfileRepository
      .createQueryBuilder('profile')
      .where('profile.metadataSchema IS NOT NULL')
      .getCount();

    return {
      total,
      withCustomFields,
      withAlarmRules,
      withMetadataSchema,
    };
  }

  /**
   * Private: Unset all default profiles for a tenant
   */
  private async unsetAllDefaults(tenantId?: string): Promise<void> {
    const query: any = { default: true };
    if (tenantId) {
      query.tenantId = tenantId;
    }

    const defaults = await this.assetProfileRepository.find({ where: query });

    for (const profile of defaults) {
      profile.default = false;
      await this.assetProfileRepository.save(profile);
    }
  }

  /**
   * Private: Validate field type
   */
  private validateFieldType(value: any, expectedType: string): boolean {
    switch (expectedType) {
      case 'string':
        return typeof value === 'string';
      case 'number':
        return typeof value === 'number';
      case 'boolean':
        return typeof value === 'boolean';
      case 'date':
        return value instanceof Date || !isNaN(Date.parse(value));
      case 'json':
        return typeof value === 'object';
      default:
        return true;
    }
  }
}
