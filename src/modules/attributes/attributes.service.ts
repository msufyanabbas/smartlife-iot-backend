// src/modules/attributes/services/attributes.service.ts
import { Injectable, NotFoundException, ForbiddenException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, In } from 'typeorm';
import { Attribute, Device, Asset, User as UserEntity } from '@modules/index.entities';
import { DataType, AttributeScope } from '@common/enums/index.enum';
import { CreateAttributeDto } from './dto/create-attribute.dto';
import { User } from '@modules/users/entities/user.entity';

@Injectable()
export class AttributesService {
  constructor(
    @InjectRepository(Attribute)
    private readonly attributeRepository: Repository<Attribute>,
    @InjectRepository(Device)
    private readonly deviceRepository: Repository<Device>,
    @InjectRepository(Asset)
    private readonly assetRepository: Repository<Asset>,
  ) {}

  /**
   * Create a single attribute
   */
  async create(user: User, createDto: CreateAttributeDto): Promise<Attribute> {
    // Get customerId from the entity
    const customerId = await this.getEntityCustomerId(
      user.tenantId,
      createDto.entityType,
      createDto.entityId,
    );

    const attribute = this.attributeRepository.create({
      ...createDto,
      tenantId: user.tenantId,
      customerId,
      userId: user.id,
      lastUpdateTs: Date.now(),
    });

    return await this.attributeRepository.save(attribute);
  }

  /**
   * Save multiple attributes for an entity
   */
  async saveAttributes(
    user: User,
    entityType: string,
    entityId: string,
    scope: AttributeScope,
    attributes: Record<string, any>,
  ): Promise<Attribute[]> {
    // Verify entity exists and belongs to tenant
    await this.verifyEntityAccess(user.tenantId, entityType, entityId);

    // Get customerId from the entity
    const customerId = await this.getEntityCustomerId(
      user.tenantId,
      entityType,
      entityId,
    );

    const savedAttributes: Attribute[] = [];

    for (const [key, value] of Object.entries(attributes)) {
      // Determine data type
      const dataType = this.determineDataType(value);

      // Check if attribute exists
      let attribute = await this.attributeRepository.findOne({
        where: {
          tenantId: user.tenantId,
          entityType,
          entityId,
          attributeKey: key,
          scope,
        },
      });

      if (attribute) {
        // Update existing attribute
        this.setAttributeValue(attribute, dataType, value);
        attribute.lastUpdateTs = Date.now();
        attribute.userId = user.id;
      } else {
        // Create new attribute
        attribute = this.attributeRepository.create({
          tenantId: user.tenantId,
          customerId,
          entityType,
          entityId,
          attributeKey: key,
          scope,
          dataType,
          userId: user.id,
          lastUpdateTs: Date.now(),
        });
        this.setAttributeValue(attribute, dataType, value);
      }

      const saved = await this.attributeRepository.save(attribute);
      savedAttributes.push(saved);
    }

    return savedAttributes;
  }

  /**
   * Find all attributes for an entity
   */
  async findByEntity(
    tenantId: string | undefined,
    entityType: string,
    entityId: string,
    scope?: AttributeScope,
  ): Promise<Record<string, any>> {
    const queryBuilder = this.attributeRepository
      .createQueryBuilder('attribute')
      .where('attribute.tenantId = :tenantId', { tenantId })
      .andWhere('attribute.entityType = :entityType', { entityType })
      .andWhere('attribute.entityId = :entityId', { entityId });

    if (scope) {
      queryBuilder.andWhere('attribute.scope = :scope', { scope });
    }

    const attributes = await queryBuilder.getMany();

    // Convert to key-value pairs
    const result: Record<string, any> = {};
    for (const attr of attributes) {
      result[attr.attributeKey] = this.getAttributeValue(attr);
    }

    return result;
  }

  /**
   * Find specific attribute keys for an entity
   */
  async findByKeys(
    tenantId: string | undefined,
    entityType: string,
    entityId: string,
    keys: string[],
    scope?: AttributeScope,
  ): Promise<Record<string, any>> {
    const queryBuilder = this.attributeRepository
      .createQueryBuilder('attribute')
      .where('attribute.tenantId = :tenantId', { tenantId })
      .andWhere('attribute.entityType = :entityType', { entityType })
      .andWhere('attribute.entityId = :entityId', { entityId })
      .andWhere('attribute.attributeKey IN (:...keys)', { keys });

    if (scope) {
      queryBuilder.andWhere('attribute.scope = :scope', { scope });
    }

    const attributes = await queryBuilder.getMany();

    const result: Record<string, any> = {};
    for (const attr of attributes) {
      result[attr.attributeKey] = this.getAttributeValue(attr);
    }

    return result;
  }

  /**
   * Get latest values with timestamps
   */
  async getLatestValues(
    tenantId: string | undefined,
    entityType: string,
    entityId: string,
    keys: string[],
  ): Promise<Record<string, { value: any; ts: number }>> {
    const queryBuilder = this.attributeRepository
      .createQueryBuilder('attribute')
      .where('attribute.tenantId = :tenantId', { tenantId })
      .andWhere('attribute.entityType = :entityType', { entityType })
      .andWhere('attribute.entityId = :entityId', { entityId })
      .andWhere('attribute.attributeKey IN (:...keys)', { keys });

    const attributes = await queryBuilder.getMany();

    const result: Record<string, { value: any; ts: number }> = {};
    for (const attr of attributes) {
      result[attr.attributeKey] = {
        value: this.getAttributeValue(attr),
        ts: attr.lastUpdateTs,
      };
    }

    return result;
  }

  /**
   * Delete an attribute
   */
  async deleteAttribute(
    tenantId: string | undefined,
    entityType: string,
    entityId: string,
    attributeKey: string,
    scope?: AttributeScope,
  ): Promise<void> {
    const whereCondition: any = {
      tenantId,
      entityType,
      entityId,
      attributeKey,
    };

    if (scope) {
      whereCondition.scope = scope;
    }

    const result = await this.attributeRepository.softDelete(whereCondition);

    if (result.affected === 0) {
      throw new NotFoundException('Attribute not found');
    }
  }

  /**
   * Delete multiple attributes
   */
  async deleteAttributes(
    tenantId: string | undefined,
    entityType: string,
    entityId: string,
    keys: string[],
    scope?: AttributeScope,
  ): Promise<number> {
    const queryBuilder = this.attributeRepository
      .createQueryBuilder()
      .softDelete()
      .where('tenantId = :tenantId', { tenantId })
      .andWhere('entityType = :entityType', { entityType })
      .andWhere('entityId = :entityId', { entityId })
      .andWhere('attributeKey IN (:...keys)', { keys });

    if (scope) {
      queryBuilder.andWhere('scope = :scope', { scope });
    }

    const result = await queryBuilder.execute();
    return result.affected || 0;
  }

  /**
   * Get timeseries data (stub - implement with actual timeseries table)
   */
  async getTimeseries(
    tenantId: string | undefined,
    entityType: string,
    entityId: string,
    keys: string[],
    startTs?: number,
    endTs?: number,
    limit: number = 100,
  ): Promise<Record<string, any[]>> {
    // TODO: Implement actual timeseries data retrieval from telemetry table
    // For now, return latest attributes as single data points
    const attributes = await this.findByKeys(tenantId, entityType, entityId, keys);

    const result: Record<string, any[]> = {};
    for (const key of keys) {
      if (attributes[key] !== undefined) {
        result[key] = [
          {
            ts: Date.now(),
            value: attributes[key],
          },
        ];
      }
    }

    return result;
  }

  /**
   * Get attributes by customer
   */
  async findByCustomer(
    tenantId: string,
    customerId: string,
    entityType?: string,
  ): Promise<Attribute[]> {
    const queryBuilder = this.attributeRepository
      .createQueryBuilder('attribute')
      .where('attribute.tenantId = :tenantId', { tenantId })
      .andWhere('attribute.customerId = :customerId', { customerId });

    if (entityType) {
      queryBuilder.andWhere('attribute.entityType = :entityType', { entityType });
    }

    return await queryBuilder
      .orderBy('attribute.lastUpdateTs', 'DESC')
      .getMany();
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // PRIVATE HELPER METHODS
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Verify entity exists and user has access
   */
  private async verifyEntityAccess(
    tenantId: string | undefined,
    entityType: string,
    entityId: string,
  ): Promise<void> {
    let exists = false;

    switch (entityType.toLowerCase()) {
      case 'device':
        exists = await this.deviceRepository.exist({
          where: { id: entityId, tenantId },
        });
        break;
      case 'asset':
        exists = await this.assetRepository.exist({
          where: { id: entityId, tenantId },
        });
        break;
      // Add more entity types as needed
      default:
        // For other entity types, skip validation
        return;
    }

    if (!exists) {
      throw new NotFoundException(`${entityType} not found`);
    }
  }

  /**
   * Get customerId from entity (denormalized for fast filtering)
   */
  private async getEntityCustomerId(
    tenantId: string | undefined,
    entityType: string,
    entityId: string,
  ): Promise<string | undefined> {
    switch (entityType.toLowerCase()) {
      case 'device': {
        const device = await this.deviceRepository.findOne({
          where: { id: entityId, tenantId },
          select: ['customerId'],
        });
        return device?.customerId;
      }
      case 'asset': {
        const asset = await this.assetRepository.findOne({
          where: { id: entityId, tenantId },
          select: ['customerId'],
        });
        return asset?.customerId;
      }
      default:
        return undefined;
    }
  }

  /**
   * Determine data type from value
   */
  private determineDataType(value: any): DataType {
    if (typeof value === 'string') return DataType.STRING;
    if (typeof value === 'number') return DataType.NUMBER;
    if (typeof value === 'boolean') return DataType.BOOLEAN;
    return DataType.JSON;
  }

  /**
   * Set attribute value based on data type
   */
  private setAttributeValue(
    attribute: Attribute,
    dataType: DataType,
    value: any,
  ): void {
    // Reset all values
    attribute.stringValue = undefined;
    attribute.numberValue = undefined;
    attribute.booleanValue = undefined;
    attribute.jsonValue = null;
    attribute.dataType = dataType;

    // Set the appropriate value
    switch (dataType) {
      case DataType.STRING:
        attribute.stringValue = String(value);
        break;
      case DataType.NUMBER:
        attribute.numberValue = Number(value);
        break;
      case DataType.BOOLEAN:
        attribute.booleanValue = Boolean(value);
        break;
      case DataType.JSON:
        attribute.jsonValue = value;
        break;
    }
  }

  /**
   * Get attribute value based on data type
   */
  private getAttributeValue(attribute: Attribute): any {
    switch (attribute.dataType) {
      case DataType.STRING:
        return attribute.stringValue;
      case DataType.NUMBER:
        return attribute.numberValue;
      case DataType.BOOLEAN:
        return attribute.booleanValue;
      case DataType.JSON:
        return attribute.jsonValue;
      default:
        return null;
    }
  }
}