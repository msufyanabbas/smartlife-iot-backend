// src/modules/attributes/entities/attribute.entity.ts
import { Entity, Column, Index, ManyToOne, JoinColumn } from 'typeorm';
import { BaseEntity } from '@common/entities/base.entity';
import { Tenant, Customer, User } from '@modules/index.entities';
import { DataType, AttributeScope } from '@common/enums/index.enum';

@Entity('attributes')
@Index(['tenantId', 'entityType', 'entityId', 'scope'])
@Index(['tenantId', 'attributeKey'])
@Index(['tenantId', 'entityType', 'entityId', 'attributeKey'], { unique: true })  // ✅ Added tenantId to unique constraint
export class Attribute extends BaseEntity {
  // ══════════════════════════════════════════════════════════════════════════
  // TENANT SCOPING (REQUIRED)
  // ══════════════════════════════════════════════════════════════════════════

  @Column()
  @Index()
  tenantId: string;

  @ManyToOne(() => Tenant)
  @JoinColumn({ name: 'tenantId' })
  tenant: Tenant;

  // ══════════════════════════════════════════════════════════════════════════
  // CUSTOMER SCOPING (OPTIONAL - denormalized from entity)
  // ══════════════════════════════════════════════════════════════════════════

  @Column({ nullable: true })
  @Index()
  customerId?: string;  // Denormalized from the entity for fast filtering

  @ManyToOne(() => Customer, { nullable: true })
  @JoinColumn({ name: 'customerId' })
  customer?: Customer;

  // ══════════════════════════════════════════════════════════════════════════
  // ENTITY REFERENCE (What does this attribute belong to?)
  // ══════════════════════════════════════════════════════════════════════════
  
  @Column()
  @Index()
  entityType: string;  // 'device', 'asset', 'user', 'dashboard'

  @Column()
  @Index()
  entityId: string;  // UUID of the device/asset/user/dashboard

  // ══════════════════════════════════════════════════════════════════════════
  // ATTRIBUTE KEY & SCOPE
  // ══════════════════════════════════════════════════════════════════════════

  @Column()
  @Index()
  attributeKey: string;  // 'firmwareVersion', 'reportingInterval', 'rssi'

  @Column({ type: 'enum', enum: AttributeScope, default: AttributeScope.SERVER })
  @Index()
  scope: AttributeScope;
  // SERVER = Read-only from device, server sets (e.g., firmware URL)
  // SHARED = Both server and device can read/write (e.g., reporting interval)
  // CLIENT = Device sets, server reads (e.g., current signal strength)

  // ══════════════════════════════════════════════════════════════════════════
  // VALUE (Polymorphic - only ONE field is populated based on dataType)
  // ══════════════════════════════════════════════════════════════════════════

  @Column({ type: 'enum', enum: DataType })
  dataType: DataType;

  @Column({ type: 'text', nullable: true })  // ✅ Changed to text for longer strings
  stringValue?: string;

  @Column({ type: 'decimal', precision: 20, scale: 6, nullable: true })
  numberValue?: number;

  @Column({ nullable: true })
  booleanValue?: boolean;

  @Column({ type: 'jsonb', nullable: true })
  jsonValue?: any;  

  // ══════════════════════════════════════════════════════════════════════════
  // METADATA
  // ══════════════════════════════════════════════════════════════════════════

  @Column({ type: 'bigint' })
  @Index()  // ✅ Added index for time-based queries
  lastUpdateTs: number;  // Unix timestamp in milliseconds

  @Column()
  @Index()
  userId: string;  // Who last updated this attribute

  @ManyToOne(() => User)  // ✅ Added relation
  @JoinColumn({ name: 'userId' })
  user: User;

  // ══════════════════════════════════════════════════════════════════════════
  // ADDITIONAL METADATA
  // ══════════════════════════════════════════════════════════════════════════

  @Column({ type: 'jsonb', nullable: true })
  metadata?: {
    source?: string;        // 'device', 'user', 'automation', 'rule_chain'
    quality?: number;       // Data quality indicator (0-100)
    unit?: string;          // 'celsius', 'meters', 'percent'
    [key: string]: any;
  };

  // ══════════════════════════════════════════════════════════════════════════
  // HELPER METHODS
  // ══════════════════════════════════════════════════════════════════════════

  /**
   * Get the actual value regardless of data type
   */
  getValue(): any {
    switch (this.dataType) {
      case DataType.STRING: return this.stringValue;
      case DataType.NUMBER: return this.numberValue;
      case DataType.BOOLEAN: return this.booleanValue;
      case DataType.JSON: return this.jsonValue;
      default: return null;
    }
  }

  /**
   * Set value and automatically determine data type
   */
  setValue(value: any): void {
    // Reset all values
    this.stringValue = undefined;
    this.numberValue = undefined;
    this.booleanValue = undefined;
    this.jsonValue = null;

    if (typeof value === 'string') {
      this.dataType = DataType.STRING;
      this.stringValue = value;
    } else if (typeof value === 'number') {
      this.dataType = DataType.NUMBER;
      this.numberValue = value;
    } else if (typeof value === 'boolean') {
      this.dataType = DataType.BOOLEAN;
      this.booleanValue = value;
    } else {
      this.dataType = DataType.JSON;
      this.jsonValue = value;
    }

    this.lastUpdateTs = Date.now();
  }

  /**
   * Check if attribute was recently updated
   */
  isRecent(thresholdMs: number = 60000): boolean {
    return Date.now() - this.lastUpdateTs < thresholdMs;
  }

  /**
   * Check if attribute is server-side only
   */
  isServerScope(): boolean {
    return this.scope === AttributeScope.SERVER;
  }

  /**
   * Check if attribute is client-side only
   */
  isClientScope(): boolean {
    return this.scope === AttributeScope.CLIENT;
  }

  /**
   * Check if attribute is shared
   */
  isSharedScope(): boolean {
    return this.scope === AttributeScope.SHARED;
  }
}