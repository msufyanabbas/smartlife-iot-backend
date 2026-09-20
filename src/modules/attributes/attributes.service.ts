// src/modules/attributes/services/attributes.service.ts
import { Injectable, Logger, NotFoundException, ForbiddenException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, In } from 'typeorm';
import { Attribute, Device, Asset, Telemetry, User as UserEntity } from '@modules/index.entities';
import { DataType, AttributeScope } from '@common/enums/index.enum';
import { DeviceProtocol } from '@modules/devices/entities/device.entity';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { MQTTService } from '@/lib/mqtt/mqtt.service';
import { CreateAttributeDto } from './dto/create-attribute.dto';
import {
  AttributeTimeseriesQueryDto,
  TimeseriesAggregation,
} from './dto/attribute-timeseries.dto';
import { User } from '@modules/users/entities/user.entity';

@Injectable()
export class AttributesService {
  private readonly logger = new Logger(AttributesService.name);

  constructor(
    @InjectRepository(Attribute)
    private readonly attributeRepository: Repository<Attribute>,
    @InjectRepository(Device)
    private readonly deviceRepository: Repository<Device>,
    @InjectRepository(Asset)
    private readonly assetRepository: Repository<Asset>,
    // Registered as a repository rather than by importing TelemetryModule:
    // TelemetryModule → ProfilesModule → Asset repo, and ProtocolsModule
    // imports AttributesModule, so importing TelemetryModule here would close
    // a module cycle. Same idiom as AssetsModule's roll-up repositories.
    @InjectRepository(Telemetry)
    private readonly telemetryRepository: Repository<Telemetry>,
    // MQTTModule is @Global, so MQTTService needs no module import.
    private readonly mqttService: MQTTService,
    // EventEmitterModule is registered globally in AppModule.
    private readonly eventEmitter: EventEmitter2,
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

    // SHARED scope is the only one the device is allowed to read back, so it
    // is the only one worth pushing. Fire-and-forget: the attributes are
    // already committed and an unreachable broker must not fail the request.
    if (scope === AttributeScope.SHARED && entityType.toLowerCase() === 'device') {
      void this.pushSharedAttributesToDevice(entityId, savedAttributes);
    }

    // Consumed by AutomationListener to drive ATTRIBUTE-trigger automations.
    // An event rather than a direct AutomationService call: AutomationModule
    // already imports AttributesModule for the UPDATE_ATTRIBUTE action, and a
    // direct call back would close that cycle.
    this.eventEmitter.emit('attributes.updated', {
      tenantId: user.tenantId,
      entityType: entityType.toUpperCase(),
      entityId,
      scope,
      attributes,
    });

    return savedAttributes;
  }

  /**
   * Publish shared attributes down to the device over MQTT.
   *
   * Topic is `devices/{deviceKey}/attributes/shared`, NOT
   * `devices/{deviceKey}/attributes`. The platform's own MQTT client
   * subscribes to `devices/+/attributes` (UPLINK_TOPICS in mqtt.service.ts)
   * and routes everything it receives there into DeviceListenerService as
   * telemetry. Publishing a downlink to that topic therefore feeds straight
   * back into our own ingestion: the attribute values get stored as fake
   * sensor readings, the alarm engine evaluates them, and the device's
   * lastSeenAt/messageCount move as though it had reported. Measured during
   * testing — 5 spurious telemetry rows and 5 spurious "High Temperature"
   * alarms before the topic was changed.
   *
   * `+` matches exactly one level, so the four-level downlink topic is not
   * matched by the three-level uplink subscription and cannot loop.
   *
   * Only GENERIC_MQTT devices get a push: LoRaWAN downlinks are codec-encoded
   * onto the commands topic and a raw JSON payload there would reach the
   * device as an unparseable frame.
   */
  private async pushSharedAttributesToDevice(
    deviceId: string,
    attributes: Attribute[],
  ): Promise<void> {
    try {
      const device = await this.deviceRepository.findOne({
        where: { id: deviceId },
      });

      if (!device?.deviceKey) return;

      if (device.protocol !== DeviceProtocol.GENERIC_MQTT) {
        this.logger.debug(
          `Skipping shared-attribute push for ${device.deviceKey}: ` +
            `protocol ${device.protocol} has no attributes topic`,
        );
        return;
      }

      const payload: Record<string, any> = {};
      for (const attr of attributes) {
        payload[attr.attributeKey] = this.getAttributeValue(attr);
      }

      // publish() stringifies internally — pass the object, not a JSON string,
      // or the device receives a double-encoded payload.
      await this.mqttService.publish(
        `devices/${device.deviceKey}/attributes/shared`,
        payload,
      );

      this.logger.log(
        `Pushed ${Object.keys(payload).length} shared attribute(s) to ` +
          `${device.deviceKey}: [${Object.keys(payload).join(', ')}]`,
      );
    } catch (err) {
      this.logger.warn(
        `Failed to push shared attributes to device ${deviceId}: ${
          (err as Error).message
        }`,
      );
    }
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
   * Historical time-series for an entity, read from the telemetry table.
   *
   * Telemetry here is one row per message with a `data` jsonb blob — there is
   * no key/value row model — so a key's series is extracted with `data->>key`
   * and rows lacking the key are filtered out with the `?` containment
   * operator. One query per key keeps `limit` meaning "points per key" rather
   * than "rows in total", and each query rides the
   * (tenantId, deviceId, timestamp) index.
   *
   * Only `device` entities have telemetry; anything else returns {} rather
   * than silently reporting another entity's data.
   */
  async getTimeseries(
    tenantId: string | undefined,
    entityType: string,
    entityId: string,
    query: AttributeTimeseriesQueryDto,
  ): Promise<Record<string, Array<{ ts: number; value: any }>>> {
    const keys = query.keyList;
    const result: Record<string, Array<{ ts: number; value: any }>> = {};

    if (keys.length === 0) return result;

    if (entityType.toLowerCase() !== 'device') {
      this.logger.debug(
        `Timeseries requested for entityType '${entityType}' — only 'device' ` +
          `has telemetry; returning empty series`,
      );
      return result;
    }

    const limit = query.limit ?? 100;
    const agg = query.agg ?? TimeseriesAggregation.NONE;

    for (const key of keys) {
      result[key] =
        agg === TimeseriesAggregation.NONE
          ? await this.readRawSeries(tenantId, entityId, key, query, limit)
          : await this.readAggregatedSeries(tenantId, entityId, key, query, limit, agg);
    }

    return result;
  }

  /** Raw stored points, newest first. */
  private async readRawSeries(
    tenantId: string | undefined,
    deviceId: string,
    key: string,
    query: AttributeTimeseriesQueryDto,
    limit: number,
  ): Promise<Array<{ ts: number; value: any }>> {
    const qb = this.telemetryRepository
      .createQueryBuilder('t')
      .select(['t.timestamp AS "timestamp"'])
      .addSelect('t.data -> :key', 'value')
      .where('t.deviceId = :deviceId', { deviceId })
      // `data ? :key` — jsonb key-existence, so a row that never carried this
      // key is skipped instead of yielding a null point.
      .andWhere('t.data ? :key')
      .setParameter('key', key)
      .orderBy('t.timestamp', 'DESC')
      .limit(limit);

    if (tenantId) qb.andWhere('t.tenantId = :tenantId', { tenantId });
    this.applyWindow(qb, query);

    const rows: Array<{ timestamp: Date; value: any }> = await qb.getRawMany();

    return rows.map((row) => ({
      ts: new Date(row.timestamp).getTime(),
      value: row.value,
    }));
  }

  /** Interval-bucketed aggregate, newest bucket first. */
  private async readAggregatedSeries(
    tenantId: string | undefined,
    deviceId: string,
    key: string,
    query: AttributeTimeseriesQueryDto,
    limit: number,
    agg: TimeseriesAggregation,
  ): Promise<Array<{ ts: number; value: any }>> {
    // Default bucket: one hour. Validated as an integer >= 1000 by the DTO, so
    // it is safe to inline — it cannot be bound as a parameter inside a
    // GROUP BY expression that must match the SELECT expression exactly.
    const interval = Math.floor(query.interval ?? 3_600_000);

    const bucket = `floor(extract(epoch from t.timestamp) * 1000 / ${interval}) * ${interval}`;

    const valueExpr =
      agg === TimeseriesAggregation.COUNT
        ? 'COUNT(*)'
        : `${agg}((t.data ->> :key)::numeric)`;

    const qb = this.telemetryRepository
      .createQueryBuilder('t')
      .select(bucket, 'bucket')
      .addSelect(valueExpr, 'value')
      .where('t.deviceId = :deviceId', { deviceId })
      .andWhere('t.data ? :key')
      .setParameter('key', key);

    if (agg !== TimeseriesAggregation.COUNT) {
      // Guard the ::numeric cast — a single non-numeric reading for this key
      // would otherwise abort the whole query with a 22P02.
      qb.andWhere(`(t.data ->> :key) ~ '^-?[0-9]+(\\.[0-9]+)?$'`);
    }

    if (tenantId) qb.andWhere('t.tenantId = :tenantId', { tenantId });
    this.applyWindow(qb, query);

    const rows: Array<{ bucket: string; value: string }> = await qb
      .groupBy(bucket)
      .orderBy('bucket', 'DESC')
      .limit(limit)
      .getRawMany();

    return rows.map((row) => ({
      ts: Number(row.bucket),
      value: row.value === null ? null : Number(row.value),
    }));
  }

  /** Shared startTs/endTs window, applied identically to both read paths. */
  private applyWindow(qb: any, query: AttributeTimeseriesQueryDto): void {
    if (query.startTs !== undefined) {
      qb.andWhere('t.timestamp >= :startTs', { startTs: new Date(query.startTs) });
    }
    if (query.endTs !== undefined) {
      qb.andWhere('t.timestamp <= :endTs', { endTs: new Date(query.endTs) });
    }
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