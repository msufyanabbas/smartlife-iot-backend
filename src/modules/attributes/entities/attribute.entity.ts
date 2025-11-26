import { Entity, Column, Index } from 'typeorm';
import { BaseEntity } from '../../../common/entities/base.entity';

export enum AttributeScope {
  SERVER = 'server',
  SHARED = 'shared',
  CLIENT = 'client',
}

export enum DataType {
  STRING = 'string',
  NUMBER = 'number',
  BOOLEAN = 'boolean',
  JSON = 'json',
}

@Entity('attributes')
@Index(['entityType', 'entityId'])
@Index(['entityType', 'entityId', 'scope'])
@Index(['attributeKey'])
export class Attribute extends BaseEntity {
  @Column({ name: 'entity_type' })
  entityType: string;

  @Column({ name: 'entity_id' })
  @Index()
  entityId: string;

  @Column({ name: 'attribute_key' })
  attributeKey: string;

  @Column({
    type: 'enum',
    enum: AttributeScope,
    default: AttributeScope.SERVER,
  })
  scope: AttributeScope;

  @Column({
    type: 'enum',
    enum: DataType,
  })
  dataType: DataType;

  @Column({ name: 'string_value', nullable: true })
  stringValue?: string;

  @Column({
    name: 'number_value',
    type: 'decimal',
    precision: 20,
    scale: 6,
    nullable: true,
  })
  numberValue?: number;

  @Column({ name: 'boolean_value', nullable: true })
  booleanValue?: boolean;

  @Column({ name: 'json_value', type: 'jsonb', nullable: true })
  jsonValue?: any;

  @Column({ name: 'last_update_ts', type: 'bigint' })
  lastUpdateTs: number;

  @Column({ name: 'user_id' })
  @Index()
  userId: string;

  @Column({ name: 'tenant_id', nullable: true })
  @Index()
  tenantId?: string;
}
