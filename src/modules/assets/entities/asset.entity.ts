import { Entity, Column, Index, ManyToOne, JoinColumn } from 'typeorm';
import { BaseEntity } from '../../../common/entities/base.entity';

export enum AssetType {
  BUILDING = 'building',
  FLOOR = 'floor',
  ROOM = 'room',
  OFFICE = 'office', // Added
  VEHICLE = 'vehicle',
  EQUIPMENT = 'equipment',
  INFRASTRUCTURE = 'infrastructure',
  ZONE = 'zone', // Added
  OTHER = 'other',
}

@Entity('assets')
export class Asset extends BaseEntity {
  @Column()
  name: string;

  @Column({ nullable: true })
  label?: string;

  @Column({
    type: 'enum',
    enum: AssetType,
    default: AssetType.OTHER,
  })
  type: AssetType;

  @Column({ nullable: true })
  @Index()
  tenantId?: string;

  @Column({ nullable: true })
  @Index()
  customerId?: string;

  @Column({ nullable: true })
  @Index()
  assetProfileId?: string;

  // Hierarchical structure (like ThingsBoard)
  @Column({ nullable: true })
  @Index()
  parentAssetId?: string;

  @ManyToOne(() => Asset, { nullable: true })
  @JoinColumn({ name: 'parentAssetId' })
  parentAsset?: Asset;

  // Additional info
  @Column({ type: 'jsonb', nullable: true })
  additionalInfo?: Record<string, any>;

  // Location
  @Column({ type: 'jsonb', nullable: true })
  location?: {
    address?: string;
    city?: string;
    state?: string;
    country?: string;
    zip?: string;
    latitude?: number;
    longitude?: number;
  };

  // Attributes (key-value pairs like ThingsBoard)
  @Column({ type: 'jsonb', nullable: true })
  attributes?: Record<string, any>;

  // Tags for grouping and filtering
  @Column({ type: 'simple-array', nullable: true })
  tags?: string[];

  @Column({ nullable: true })
  description?: string;

  @Column({ nullable: true })
  imageUrl?: string;

  // Status
  @Column({ default: true })
  active: boolean;

  // Owner information
  @Column({ nullable: true })
  ownerId?: string;

  @Column({ nullable: true })
  ownerName?: string;

  // Maintenance info
  @Column({ type: 'jsonb', nullable: true })
  maintenance?: {
    lastServiceDate?: Date;
    nextServiceDate?: Date;
    warrantyExpiry?: Date;
    serviceInterval?: number; // in days
  };

  // ADD THESE TWO PROPERTIES
  @Column({ default: 0 })
  deviceCount: number;

  @Column({ default: 0 })
  childrenCount: number;
}