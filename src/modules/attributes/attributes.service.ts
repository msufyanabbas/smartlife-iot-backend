import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import {
  Attribute,
  AttributeScope,
  DataType,
} from './entities/attribute.entity';
import {
  CreateAttributeDto,
  SaveAttributesDto,
} from './dto/create-attribute.dto';
import { UpdateAttributeDto } from './dto/update-attribute.dto';

@Injectable()
export class AttributesService {
  constructor(
    @InjectRepository(Attribute)
    private readonly attributeRepository: Repository<Attribute>,
  ) {}

  async create(
    userId: string,
    createDto: CreateAttributeDto,
  ): Promise<Attribute> {
    const attribute = this.attributeRepository.create({
      ...createDto,
      userId,
      createdBy: userId,
      lastUpdateTs: Date.now(),
    });

    return await this.attributeRepository.save(attribute);
  }

  async saveAttributes(
    userId: string,
    entityType: string,
    entityId: string,
    scope: AttributeScope,
    attributes: Record<string, any>,
  ): Promise<Attribute[]> {
    const savedAttributes: Attribute[] = [];

    for (const [key, value] of Object.entries(attributes)) {
      // Determine data type
      const dataType = this.determineDataType(value);

      // Check if attribute exists
      let attribute = await this.attributeRepository.findOne({
        where: {
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
        attribute.updatedBy = userId;
      } else {
        // Create new attribute
        attribute = this.attributeRepository.create({
          entityType,
          entityId,
          attributeKey: key,
          scope,
          dataType,
          userId,
          createdBy: userId,
          lastUpdateTs: Date.now(),
        });
        this.setAttributeValue(attribute, dataType, value);
      }

      const saved = await this.attributeRepository.save(attribute);
      savedAttributes.push(saved);
    }

    return savedAttributes;
  }

  async findByEntity(
    entityType: string,
    entityId: string,
    scope?: AttributeScope,
  ): Promise<Record<string, any>> {
    const queryBuilder = this.attributeRepository
      .createQueryBuilder('attribute')
      .where('attribute.entityType = :entityType', { entityType })
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

  async findByKeys(
    entityType: string,
    entityId: string,
    keys: string[],
    scope?: AttributeScope,
  ): Promise<Record<string, any>> {
    const queryBuilder = this.attributeRepository
      .createQueryBuilder('attribute')
      .where('attribute.entityType = :entityType', { entityType })
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

  async deleteAttribute(
    entityType: string,
    entityId: string,
    attributeKey: string,
    scope?: AttributeScope,
  ): Promise<void> {
    const whereCondition: any = {
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

  async deleteAttributes(
    entityType: string,
    entityId: string,
    keys: string[],
    scope?: AttributeScope,
  ): Promise<number> {
    const queryBuilder = this.attributeRepository
      .createQueryBuilder()
      .softDelete()
      .where('entityType = :entityType', { entityType })
      .andWhere('entityId = :entityId', { entityId })
      .andWhere('attributeKey IN (:...keys)', { keys });

    if (scope) {
      queryBuilder.andWhere('scope = :scope', { scope });
    }

    const result = await queryBuilder.execute();
    return result.affected || 0;
  }

  async getTimeseries(
    entityType: string,
    entityId: string,
    keys: string[],
    startTs?: number,
    endTs?: number,
    limit: number = 100,
  ): Promise<Record<string, any[]>> {
    // TODO: Implement actual timeseries data retrieval from a timeseries table
    // For now, return latest attributes
    const attributes = await this.findByKeys(entityType, entityId, keys);

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

  private determineDataType(value: any): DataType {
    if (typeof value === 'string') return DataType.STRING;
    if (typeof value === 'number') return DataType.NUMBER;
    if (typeof value === 'boolean') return DataType.BOOLEAN;
    return DataType.JSON;
  }

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

    // Set the appropriate value based on data type
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
