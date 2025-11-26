import {
  Injectable,
  NotFoundException,
  ConflictException,
  BadRequestException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { DeviceProfile } from './entities/device-profile.entity';
import { Device } from '../devices/entities/device.entity';
import {
  CreateDeviceProfileDto,
  UpdateDeviceProfileDto,
  QueryProfilesDto,
} from './dto/profiles.dto';

@Injectable()
export class DeviceProfilesService {
  constructor(
    @InjectRepository(DeviceProfile)
    private deviceProfileRepository: Repository<DeviceProfile>,
    @InjectRepository(Device)
    private deviceRepository: Repository<Device>,
    private eventEmitter: EventEmitter2,
  ) {}

  /**
   * Create a new device profile
   */
  async create(createDto: CreateDeviceProfileDto): Promise<DeviceProfile> {
    // Check if name already exists
    const existing = await this.deviceProfileRepository.findOne({
      where: { name: createDto.name },
    });

    if (existing) {
      throw new ConflictException(
        'Device profile with this name already exists',
      );
    }

    // If this is set as default, unset other defaults
    if (createDto.default) {
      await this.unsetAllDefaults(createDto.tenantId);
    }

    const profile = this.deviceProfileRepository.create(createDto);
    const savedProfile = await this.deviceProfileRepository.save(profile);

    // Emit event
    this.eventEmitter.emit('device.profile.created', { profile: savedProfile });

    return savedProfile;
  }

  /**
   * Find all device profiles with filters
   */
  async findAll(queryDto: QueryProfilesDto): Promise<{
    profiles: DeviceProfile[];
    total: number;
    page: number;
    limit: number;
    totalPages: number;
  }> {
    const page = queryDto.page || 1;
    const limit = queryDto.limit || 10;
    const skip = (page - 1) * limit;

    const queryBuilder =
      this.deviceProfileRepository.createQueryBuilder('profile');

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
   * Find one device profile by ID
   */
  async findOne(id: string): Promise<DeviceProfile> {
    const profile = await this.deviceProfileRepository.findOne({
      where: { id },
    });

    if (!profile) {
      throw new NotFoundException('Device profile not found');
    }

    return profile;
  }

  /**
   * Get default device profile
   */
  async getDefault(tenantId?: string): Promise<DeviceProfile> {
    const query: any = { default: true };
    if (tenantId) {
      query.tenantId = tenantId;
    }

    const profile = await this.deviceProfileRepository.findOne({
      where: query,
    });

    if (!profile) {
      throw new NotFoundException('No default device profile found');
    }

    return profile;
  }

  /**
   * Update device profile
   */
  async update(
    id: string,
    updateDto: UpdateDeviceProfileDto,
  ): Promise<DeviceProfile> {
    const profile = await this.findOne(id);

    // Check if name is being changed and if it already exists
    if (updateDto.name && updateDto.name !== profile.name) {
      const existing = await this.deviceProfileRepository.findOne({
        where: { name: updateDto.name },
      });

      if (existing) {
        throw new ConflictException(
          'Device profile with this name already exists',
        );
      }
    }

    // If setting as default, unset others
    if (updateDto.default && !profile.default) {
      await this.unsetAllDefaults(profile.tenantId);
    }

    Object.assign(profile, updateDto);
    const updatedProfile = await this.deviceProfileRepository.save(profile);

    // Emit event
    this.eventEmitter.emit('device.profile.updated', {
      profile: updatedProfile,
    });

    return updatedProfile;
  }

  /**
   * Set as default profile
   */
  async setDefault(id: string): Promise<DeviceProfile> {
    const profile = await this.findOne(id);

    // Unset all other defaults for this tenant
    await this.unsetAllDefaults(profile.tenantId);

    profile.default = true;
    return await this.deviceProfileRepository.save(profile);
  }

  /**
   * Delete device profile
   */
  async remove(id: string): Promise<void> {
    const profile = await this.findOne(id);

    // Check if profile is in use
    const devicesUsingProfile = await this.deviceRepository.count({
      where: { deviceProfileId: id },
    });

    if (devicesUsingProfile > 0) {
      throw new BadRequestException(
        `Cannot delete profile. ${devicesUsingProfile} device(s) are using this profile.`,
      );
    }

    // Can't delete default profile
    if (profile.default) {
      throw new BadRequestException('Cannot delete the default device profile');
    }

    await this.deviceProfileRepository.softRemove(profile);

    // Emit event
    this.eventEmitter.emit('device.profile.deleted', { profileId: id });
  }

  /**
   * Clone device profile
   */
  async clone(id: string, newName: string): Promise<DeviceProfile> {
    const original = await this.findOne(id);

    // Check if new name already exists
    const existing = await this.deviceProfileRepository.findOne({
      where: { name: newName },
    });

    if (existing) {
      throw new ConflictException(
        'Device profile with this name already exists',
      );
    }

    // Create new profile based on original
    const cloned = this.deviceProfileRepository.create({
      ...original,
      id: undefined, // Remove ID
      name: newName,
      default: false, // Clone is not default
      createdAt: undefined,
      updatedAt: undefined,
    });

    return await this.deviceProfileRepository.save(cloned);
  }

  /**
   * Validate telemetry data against profile
   */
  async validateTelemetry(
    id: string,
    telemetryData: Record<string, any>,
  ): Promise<{
    valid: boolean;
    errors: string[];
    warnings: string[];
  }> {
    const profile = await this.findOne(id);
    const errors: string[] = [];
    const warnings: string[] = [];

    if (!profile.telemetryConfig || !profile.telemetryConfig.keys) {
      return { valid: true, errors, warnings };
    }

    const expectedKeys = profile.telemetryConfig.keys.map((k: any) => k.key);
    const receivedKeys = Object.keys(telemetryData);

    // Check for missing expected keys
    for (const expectedKey of expectedKeys) {
      if (!receivedKeys.includes(expectedKey)) {
        warnings.push(`Missing expected key: ${expectedKey}`);
      }
    }

    // Check for unexpected keys
    for (const receivedKey of receivedKeys) {
      if (!expectedKeys.includes(receivedKey)) {
        warnings.push(`Unexpected key: ${receivedKey}`);
      }
    }

    // Validate data types
    for (const keyConfig of profile.telemetryConfig.keys) {
      const value = telemetryData[keyConfig.key];
      if (value !== undefined) {
        const typeValid = this.validateDataType(value, keyConfig.type);
        if (!typeValid) {
          errors.push(
            `Invalid type for ${keyConfig.key}. Expected ${keyConfig.type}`,
          );
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
   * Get devices using this profile
   */
  async getDevicesUsingProfile(id: string): Promise<Device[]> {
    await this.findOne(id); // Ensure profile exists

    return await this.deviceRepository.find({
      where: { deviceProfileId: id },
      order: { name: 'ASC' },
    });
  }

  /**
   * Get profile statistics
   */
  async getStatistics(): Promise<{
    total: number;
    byTransportType: Record<string, number>;
    byProvisionType: Record<string, number>;
    withAlarmRules: number;
  }> {
    const total = await this.deviceProfileRepository.count();

    // Count by transport type
    const transportTypes = await this.deviceProfileRepository
      .createQueryBuilder('profile')
      .select('profile.transportType', 'transportType')
      .addSelect('COUNT(*)', 'count')
      .groupBy('profile.transportType')
      .getRawMany();

    const byTransportType: Record<string, number> = {};
    transportTypes.forEach((row) => {
      byTransportType[row.transportType] = parseInt(row.count);
    });

    // Count by provision type
    const provisionTypes = await this.deviceProfileRepository
      .createQueryBuilder('profile')
      .select('profile.provisionType', 'provisionType')
      .addSelect('COUNT(*)', 'count')
      .groupBy('profile.provisionType')
      .getRawMany();

    const byProvisionType: Record<string, number> = {};
    provisionTypes.forEach((row) => {
      byProvisionType[row.provisionType] = parseInt(row.count);
    });

    // Count profiles with alarm rules
    const withAlarmRules = await this.deviceProfileRepository
      .createQueryBuilder('profile')
      .where('profile.alarmRules IS NOT NULL')
      .andWhere('jsonb_array_length(profile.alarmRules) > 0')
      .getCount();

    return {
      total,
      byTransportType,
      byProvisionType,
      withAlarmRules,
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

    const defaults = await this.deviceProfileRepository.find({ where: query });

    for (const profile of defaults) {
      profile.default = false;
      await this.deviceProfileRepository.save(profile);
    }
  }

  /**
   * Private: Validate data type
   */
  private validateDataType(value: any, expectedType: string): boolean {
    switch (expectedType) {
      case 'string':
        return typeof value === 'string';
      case 'long':
      case 'double':
        return typeof value === 'number';
      case 'boolean':
        return typeof value === 'boolean';
      case 'json':
        return typeof value === 'object';
      default:
        return true;
    }
  }
}
