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

    // Validate hierarchy configuration
    if (createDto.hierarchyConfig) {
      this.validateHierarchyConfig(createDto.hierarchyConfig);
    }

    // Validate attributes schema
    if (createDto.attributesSchema) {
      this.validateAttributesSchema(createDto.attributesSchema);
    }

    // Validate calculated fields
    if (createDto.calculatedFields) {
      this.validateCalculatedFields(createDto.calculatedFields);
    }

    // Validate alarm rules
    if (createDto.alarmRules) {
      this.validateAlarmRules(createDto.alarmRules);
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

    // Validate updates
    if (updateDto.hierarchyConfig) {
      this.validateHierarchyConfig(updateDto.hierarchyConfig);
    }

    if (updateDto.attributesSchema) {
      this.validateAttributesSchema(updateDto.attributesSchema);
    }

    if (updateDto.calculatedFields) {
      this.validateCalculatedFields(updateDto.calculatedFields);
    }

    if (updateDto.alarmRules) {
      this.validateAlarmRules(updateDto.alarmRules);
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
    const updated = await this.assetProfileRepository.save(profile);

    // Emit event
    this.eventEmitter.emit('asset.profile.set.default', { profile: updated });

    return updated;
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
      deletedAt: undefined,
    });

    const savedClone = await this.assetProfileRepository.save(cloned);

    // Emit event
    this.eventEmitter.emit('asset.profile.cloned', {
      original: original,
      cloned: savedClone,
    });

    return savedClone;
  }

  /**
   * Export asset profile (for backup/version control)
   */
  async exportProfile(id: string): Promise<any> {
    const profile = await this.findOne(id);

    // Remove system fields
    const exported = {
      ...profile,
      id: undefined,
      createdAt: undefined,
      updatedAt: undefined,
      deletedAt: undefined,
      tenantId: undefined, // Will be set on import
    };

    return exported;
  }

  /**
   * Import asset profile (from backup/version control)
   */
  async importProfile(
    profileData: any,
    tenantId?: string,
  ): Promise<AssetProfile> {
    // Check if name already exists
    const existing = await this.assetProfileRepository.findOne({
      where: { name: profileData.name },
    });

    if (existing) {
      throw new ConflictException(
        `Asset profile with name "${profileData.name}" already exists`,
      );
    }

    // Create new profile
    const profile: any = this.assetProfileRepository.create({
      ...profileData,
      tenantId,
      default: false, // Imported profiles are not default
    });

    return await this.assetProfileRepository.save(profile);
  }

  /**
   * Validate asset data against profile schema
   */
  async validateAssetData(
    profileId: string,
    assetData: {
      type?: string;
      parentAssetId?: string;
      location?: any;
      attributes?: Record<string, any>;
      deviceIds?: string[];
    },
  ): Promise<{
    valid: boolean;
    errors: string[];
    warnings: string[];
  }> {
    const profile = await this.findOne(profileId);
    const errors: string[] = [];
    const warnings: string[] = [];

    // Validate hierarchy rules
    if (profile.hierarchyConfig) {
      const hierarchyErrors = this.validateHierarchyRules(
        profile.hierarchyConfig,
        assetData,
      );
      errors.push(...hierarchyErrors);
    }

    // Validate location requirements
    if (profile.locationConfig) {
      const locationErrors = this.validateLocationRequirements(
        profile.locationConfig,
        assetData.location,
      );
      errors.push(...locationErrors);
    }

    // Validate device requirements
    if (profile.deviceConfig) {
      const deviceErrors = this.validateDeviceRequirements(
        profile.deviceConfig,
        assetData.deviceIds || [],
      );
      errors.push(...deviceErrors);
    }

    // Validate required attributes
    if (profile.attributesSchema?.required) {
      for (const field of profile.attributesSchema.required) {
        const value = assetData.attributes?.[field.key];

        if (value === undefined || value === null) {
          errors.push(`Required attribute missing: ${field.label}`);
          continue;
        }

        // Validate type
        const typeValid = this.validateFieldType(value, field.type);
        if (!typeValid) {
          errors.push(
            `Invalid type for ${field.label}. Expected ${field.type}`,
          );
        }

        // Validate against validation rules
        if (field.validation) {
          const validationErrors = this.validateFieldValue(
            value,
            field.validation,
            field.label,
          );
          errors.push(...validationErrors);
        }
      }
    }

    // Validate optional attributes with validation rules
    if (profile.attributesSchema?.optional) {
      for (const field of profile.attributesSchema.optional) {
        const value = assetData.attributes?.[field.key];

        if (value !== undefined && value !== null) {
          const typeValid = this.validateFieldType(value, field.type);
          if (!typeValid) {
            errors.push(
              `Invalid type for ${field.label}. Expected ${field.type}`,
            );
          }

          if (field.validation) {
            const validationErrors = this.validateFieldValue(
              value,
              field.validation,
              field.label,
            );
            errors.push(...validationErrors);
          }
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
   * Calculate field values based on expressions
   */
  async calculateFields(
    profileId: string,
    assetAttributes: Record<string, any>,
  ): Promise<Record<string, any>> {
    const profile = await this.findOne(profileId);

    if (!profile.calculatedFields || profile.calculatedFields.length === 0) {
      return {};
    }

    const calculatedValues: Record<string, any> = {};

    for (const field of profile.calculatedFields) {
      try {
        // Create a safe evaluation context
        const context = { ...assetAttributes };

        // Evaluate expression
        // Note: In production, use a safe expression evaluator like mathjs or vm2
        const value = this.evaluateExpression(field.expression, context);

        // Format based on type
        let formattedValue = value;
        if (field.type === 'number' && field.decimalPlaces !== undefined) {
          formattedValue = Number(value).toFixed(field.decimalPlaces);
        }

        calculatedValues[field.name] = formattedValue;
      } catch (error) {
        console.error(
          `Error calculating field ${field.name}:`,
          error.message,
        );
        calculatedValues[field.name] = null;
      }
    }

    return calculatedValues;
  }

  /**
   * Get assets using this profile
   */
  async getAssetsUsingProfile(id: string): Promise<Asset[]> {
    await this.findOne(id); // Ensure profile exists

    return await this.assetRepository.find({
      where: { assetProfileId: id },
      relations: ['parentAsset'],
      order: { name: 'ASC' },
    });
  }

  /**
   * Get profile statistics
   */
  async getStatistics(): Promise<{
    total: number;
    withHierarchyConfig: number;
    withLocationRequired: number;
    withDevicesAllowed: number;
    withCalculatedFields: number;
    withAlarmRules: number;
    withCustomAttributes: number;
    byQueue: Record<string, number>;
  }> {
    const total = await this.assetProfileRepository.count();

    const withHierarchyConfig = await this.assetProfileRepository
      .createQueryBuilder('profile')
      .where('profile.hierarchyConfig IS NOT NULL')
      .getCount();

    const withLocationRequired = await this.assetProfileRepository
      .createQueryBuilder('profile')
      .where("profile.locationConfig->>'required' = 'true'")
      .getCount();

    const withDevicesAllowed = await this.assetProfileRepository
      .createQueryBuilder('profile')
      .where("profile.deviceConfig->>'allowDevices' = 'true'")
      .getCount();

    const withCalculatedFields = await this.assetProfileRepository
      .createQueryBuilder('profile')
      .where('profile.calculatedFields IS NOT NULL')
      .andWhere('jsonb_array_length(profile.calculatedFields) > 0')
      .getCount();

    const withAlarmRules = await this.assetProfileRepository
      .createQueryBuilder('profile')
      .where('profile.alarmRules IS NOT NULL')
      .andWhere('jsonb_array_length(profile.alarmRules) > 0')
      .getCount();

    const withCustomAttributes = await this.assetProfileRepository
      .createQueryBuilder('profile')
      .where('profile.attributesSchema IS NOT NULL')
      .getCount();

    // Count by queue
    const queueStats = await this.assetProfileRepository
      .createQueryBuilder('profile')
      .select('profile.defaultQueueName', 'queue')
      .addSelect('COUNT(*)', 'count')
      .groupBy('profile.defaultQueueName')
      .getRawMany();

    const byQueue: Record<string, number> = {};
    queueStats.forEach((row) => {
      byQueue[row.queue] = parseInt(row.count);
    });

    return {
      total,
      withHierarchyConfig,
      withLocationRequired,
      withDevicesAllowed,
      withCalculatedFields,
      withAlarmRules,
      withCustomAttributes,
      byQueue,
    };
  }

  /**
   * Get profile usage details
   */
  async getProfileUsage(id: string): Promise<{
    profile: AssetProfile;
    assetsCount: number;
    assets: Array<{
      id: string;
      name: string;
      type: string;
      active: boolean;
      deviceCount: number;
      childrenCount: number;
    }>;
  }> {
    const profile = await this.findOne(id);
    const assets = await this.getAssetsUsingProfile(id);

    return {
      profile,
      assetsCount: assets.length,
      assets: assets.map((asset) => ({
        id: asset.id,
        name: asset.name,
        type: asset.type,
        active: asset.active,
        deviceCount: asset.deviceCount || 0,
        childrenCount: asset.childrenCount || 0,
      })),
    };
  }

  // ==================== PRIVATE VALIDATION METHODS ====================

  /**
   * Validate hierarchy configuration
   */
  private validateHierarchyConfig(config: any): void {
    if (config.maxDepth && config.maxDepth < 1) {
      throw new BadRequestException('maxDepth must be at least 1');
    }

    if (config.allowedChildTypes && !Array.isArray(config.allowedChildTypes)) {
      throw new BadRequestException('allowedChildTypes must be an array');
    }

    if (
      config.allowedParentTypes &&
      !Array.isArray(config.allowedParentTypes)
    ) {
      throw new BadRequestException('allowedParentTypes must be an array');
    }

    if (config.requireParent && config.allowChildren === false) {
      throw new BadRequestException(
        'Cannot require parent if children are not allowed',
      );
    }
  }

  /**
   * Validate attributes schema
   */
  private validateAttributesSchema(schema: any): void {
    if (!schema.required || !Array.isArray(schema.required)) {
      throw new BadRequestException(
        'attributesSchema.required must be an array',
      );
    }

    if (!schema.optional || !Array.isArray(schema.optional)) {
      throw new BadRequestException(
        'attributesSchema.optional must be an array',
      );
    }

    // Check for duplicate keys
    const allKeys = [
      ...schema.required.map((f: any) => f.key),
      ...schema.optional.map((f: any) => f.key),
    ];

    const duplicates = allKeys.filter(
      (key, index) => allKeys.indexOf(key) !== index,
    );

    if (duplicates.length > 0) {
      throw new BadRequestException(
        `Duplicate attribute keys found: ${duplicates.join(', ')}`,
      );
    }

    // Validate each field
    [...schema.required, ...schema.optional].forEach((field: any) => {
      if (!field.key || !field.label || !field.type) {
        throw new BadRequestException(
          'Each attribute must have key, label, and type',
        );
      }

      const validTypes = ['string', 'number', 'boolean', 'date', 'json', 'select'];
      if (!validTypes.includes(field.type)) {
        throw new BadRequestException(
          `Invalid attribute type: ${field.type}. Must be one of: ${validTypes.join(', ')}`,
        );
      }

      if (field.type === 'select' && !field.options) {
        throw new BadRequestException(
          `Attribute ${field.key} of type 'select' must have options`,
        );
      }
    });
  }

  /**
   * Validate calculated fields
   */
  private validateCalculatedFields(fields: any[]): void {
    if (!Array.isArray(fields)) {
      throw new BadRequestException('calculatedFields must be an array');
    }

    // Check for duplicate IDs
    const ids = fields.map((f) => f.id);
    const duplicates = ids.filter((id, index) => ids.indexOf(id) !== index);

    if (duplicates.length > 0) {
      throw new BadRequestException(
        `Duplicate calculated field IDs: ${duplicates.join(', ')}`,
      );
    }

    fields.forEach((field) => {
      if (!field.id || !field.name || !field.type || !field.expression) {
        throw new BadRequestException(
          'Each calculated field must have id, name, type, and expression',
        );
      }

      const validTypes = ['number', 'string', 'boolean'];
      if (!validTypes.includes(field.type)) {
        throw new BadRequestException(
          `Invalid calculated field type: ${field.type}`,
        );
      }

      // Basic expression validation
      if (typeof field.expression !== 'string') {
        throw new BadRequestException(
          `Expression for field ${field.name} must be a string`,
        );
      }
    });
  }

  /**
   * Validate alarm rules
   */
  private validateAlarmRules(rules: any[]): void {
    if (!Array.isArray(rules)) {
      throw new BadRequestException('alarmRules must be an array');
    }

    const validSeverities = [
      'CRITICAL',
      'MAJOR',
      'MINOR',
      'WARNING',
      'INDETERMINATE',
    ];

    rules.forEach((rule) => {
      if (!rule.id || !rule.alarmType || !rule.severity) {
        throw new BadRequestException(
          'Each alarm rule must have id, alarmType, and severity',
        );
      }

      if (!validSeverities.includes(rule.severity)) {
        throw new BadRequestException(
          `Invalid alarm severity: ${rule.severity}`,
        );
      }

      if (!rule.createCondition) {
        throw new BadRequestException(
          `Alarm rule ${rule.id} must have createCondition`,
        );
      }
    });
  }

  /**
   * Validate hierarchy rules against asset data
   */
  private validateHierarchyRules(config: any, assetData: any): string[] {
    const errors: string[] = [];

    if (config.requireParent && !assetData.parentAssetId) {
      errors.push('This asset type requires a parent asset');
    }

    if (!config.allowChildren && assetData.parentAssetId) {
      // This would be validated when creating children, not parent
    }

    if (
      config.allowedParentTypes &&
      assetData.parentAssetId &&
      assetData.parentType
    ) {
      if (!config.allowedParentTypes.includes(assetData.parentType)) {
        errors.push(
          `Parent asset type must be one of: ${config.allowedParentTypes.join(', ')}`,
        );
      }
    }

    return errors;
  }

  /**
   * Validate location requirements
   */
  private validateLocationRequirements(
    config: any,
    location: any,
  ): string[] {
    const errors: string[] = [];

    if (config.required && !location) {
      errors.push('Location is required for this asset type');
      return errors;
    }

    if (location) {
      if (
        config.requireCoordinates &&
        (location.latitude === undefined || location.longitude === undefined)
      ) {
        errors.push('Latitude and longitude are required');
      }

      if (config.requireAddress && !location.address) {
        errors.push('Address is required');
      }

      // Validate coordinate values
      if (location.latitude !== undefined) {
        if (location.latitude < -90 || location.latitude > 90) {
          errors.push('Latitude must be between -90 and 90');
        }
      }

      if (location.longitude !== undefined) {
        if (location.longitude < -180 || location.longitude > 180) {
          errors.push('Longitude must be between -180 and 180');
        }
      }

      // Validate region restrictions if configured
      if (config.restrictToRegion && location.latitude && location.longitude) {
        const { northEast, southWest } = config.restrictToRegion;
        if (northEast && southWest) {
          if (
            location.latitude > northEast.lat ||
            location.latitude < southWest.lat ||
            location.longitude > northEast.lng ||
            location.longitude < southWest.lng
          ) {
            errors.push('Asset location is outside the allowed region');
          }
        }
      }
    }

    return errors;
  }

  /**
   * Validate device requirements
   */
  private validateDeviceRequirements(
    config: any,
    deviceIds: string[],
  ): string[] {
    const errors: string[] = [];

    if (!config.allowDevices && deviceIds.length > 0) {
      errors.push('This asset type does not allow devices');
      return errors;
    }

    if (config.requireDevices && deviceIds.length === 0) {
      errors.push('At least one device is required for this asset type');
    }

    if (config.minDevices && deviceIds.length < config.minDevices) {
      errors.push(`Minimum ${config.minDevices} device(s) required`);
    }

    if (config.maxDevices && deviceIds.length > config.maxDevices) {
      errors.push(`Maximum ${config.maxDevices} device(s) allowed`);
    }

    return errors;
  }

  /**
   * Validate field type
   */
  private validateFieldType(value: any, expectedType: string): boolean {
    switch (expectedType) {
      case 'string':
        return typeof value === 'string';
      case 'number':
        return typeof value === 'number' && !isNaN(value);
      case 'boolean':
        return typeof value === 'boolean';
      case 'date':
        return value instanceof Date || !isNaN(Date.parse(value));
      case 'json':
        return typeof value === 'object';
      case 'select':
        return true; // Type depends on options
      default:
        return true;
    }
  }

  /**
   * Validate field value against validation rules
   */
  private validateFieldValue(
    value: any,
    validation: any,
    fieldLabel: string,
  ): string[] {
    const errors: string[] = [];

    if (validation.min !== undefined && value < validation.min) {
      errors.push(`${fieldLabel} must be at least ${validation.min}`);
    }

    if (validation.max !== undefined && value > validation.max) {
      errors.push(`${fieldLabel} must be at most ${validation.max}`);
    }

    if (
      validation.minLength !== undefined &&
      typeof value === 'string' &&
      value.length < validation.minLength
    ) {
      errors.push(
        `${fieldLabel} must be at least ${validation.minLength} characters`,
      );
    }

    if (
      validation.maxLength !== undefined &&
      typeof value === 'string' &&
      value.length > validation.maxLength
    ) {
      errors.push(
        `${fieldLabel} must be at most ${validation.maxLength} characters`,
      );
    }

    if (
      validation.pattern &&
      typeof value === 'string' &&
      !new RegExp(validation.pattern).test(value)
    ) {
      errors.push(`${fieldLabel} format is invalid`);
    }

    if (
      validation.enum &&
      Array.isArray(validation.enum) &&
      !validation.enum.includes(value)
    ) {
      errors.push(
        `${fieldLabel} must be one of: ${validation.enum.join(', ')}`,
      );
    }

    return errors;
  }

  /**
   * Evaluate calculated field expression
   * Note: This is a simplified implementation. In production, use a safe evaluator
   */
  private evaluateExpression(
    expression: string,
    context: Record<string, any>,
  ): any {
    try {
      // Create a function from the expression
      // WARNING: This uses eval which is dangerous in production
      // Use a library like mathjs, expr-eval, or vm2 in production
      const func = new Function(
        ...Object.keys(context),
        `return ${expression}`,
      );
      return func(...Object.values(context));
    } catch (error) {
      throw new Error(`Invalid expression: ${error.message}`);
    }
  }

  /**
   * Unset all default profiles for a tenant
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
}