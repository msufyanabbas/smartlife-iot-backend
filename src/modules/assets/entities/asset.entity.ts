import { Entity, Column, Index, ManyToOne, OneToMany, JoinColumn } from 'typeorm';
import { BaseEntity } from '@common/entities/base.entity';
import { Tenant, Customer, AssetProfile, Device } from '@modules/index.entities';
import { AssetType } from '@common/enums/asset.enum';

@Entity('assets')
@Index(['tenantId', 'type'])
@Index(['tenantId', 'customerId'])
@Index(['tenantId', 'parentAssetId'])
@Index(['tenantId', 'assetProfileId'])
@Index(['tenantId', 'active'])
export class Asset extends BaseEntity {
  // ══════════════════════════════════════════════════════════════════════════
  // TENANT SCOPING (REQUIRED)
  // ══════════════════════════════════════════════════════════════════════════

  @Column()

  tenantId: string;

  @ManyToOne(() => Tenant)
  @JoinColumn({ name: 'tenantId' })
  tenant: Tenant;

  // ══════════════════════════════════════════════════════════════════════════
  // CUSTOMER SCOPING (OPTIONAL)
  // ══════════════════════════════════════════════════════════════════════════

  @Column({ nullable: true })

  customerId?: string;

  @ManyToOne(() => Customer, { nullable: true })
  @JoinColumn({ name: 'customerId' })
  customer?: Customer;

  // ══════════════════════════════════════════════════════════════════════════
  // BASIC INFO
  // ══════════════════════════════════════════════════════════════════════════

  @Column()
  name: string;

  @Column({ nullable: true })
  label?: string;

  @Column({ type: 'enum', enum: AssetType, default: AssetType.OTHER })

  type: AssetType;

  @Column({ type: 'text', nullable: true })
  description?: string;

  @Column({ nullable: true })
  imageUrl?: string;

  @Column({ default: true })

  active: boolean;

  // ══════════════════════════════════════════════════════════════════════════
  // ASSET PROFILE (Template/Configuration)
  // ══════════════════════════════════════════════════════════════════════════

  @Column({ nullable: true })

  assetProfileId?: string;

  @ManyToOne(() => AssetProfile, { nullable: true })
  @JoinColumn({ name: 'assetProfileId' })
  assetProfile?: AssetProfile;

  // ══════════════════════════════════════════════════════════════════════════
  // HIERARCHICAL STRUCTURE (Building → Floor → Room)
  // ══════════════════════════════════════════════════════════════════════════

  @Column({ nullable: true })

  parentAssetId?: string;

  @ManyToOne(() => Asset, asset => asset.children, { nullable: true })
  @JoinColumn({ name: 'parentAssetId' })
  parentAsset?: Asset;

  @OneToMany(() => Asset, asset => asset.parentAsset)
  children: Asset[];

  @Column({ type: 'int', default: 0 })
  childrenCount: number;

  // ══════════════════════════════════════════════════════════════════════════
  // DEVICE ASSOCIATIONS (1 Asset → Many Devices)
  // ══════════════════════════════════════════════════════════════════════════

  @OneToMany(() => Device, device => device.asset)
  devices: Device[];

  @Column({ type: 'int', default: 0 })
  deviceCount: number;

  // ══════════════════════════════════════════════════════════════════════════
  // LOCATION
  // ══════════════════════════════════════════════════════════════════════════

  @Column({ type: 'jsonb', nullable: true })
  location?: {
    address?: string;      // "123 King Fahd Road"
    city?: string;         // "Riyadh"
    state?: string;        // "Riyadh Region"
    country?: string;      // "Saudi Arabia"
    zip?: string;          // "11564"
    latitude?: number;     // 24.7136
    longitude?: number;    // 46.6753
  };
  // Example:
  // location: {
  //   address: "123 King Fahd Road",
  //   city: "Riyadh",
  //   state: "Riyadh Region",
  //   country: "Saudi Arabia",
  //   zip: "11564",
  //   latitude: 24.7136,
  //   longitude: 46.6753
  // }

  // ══════════════════════════════════════════════════════════════════════════
  // ATTRIBUTES (Static Metadata - Defined by AssetProfile)
  // ══════════════════════════════════════════════════════════════════════════

  @Column({ type: 'jsonb', nullable: true })
  attributes?: Record<string, any>;
  // Example for a Floor asset:
  // attributes: {
  //   floorNumber: 3,
  //   area: 500,              // square meters
  //   capacity: 50,           // max people
  //   buildingCode: "B-301",
  //   hasFireExit: true,
  //   hvacZone: "Zone-A"
  // }
  //
  // Example for a Room asset:
  // attributes: {
  //   roomNumber: "301",
  //   area: 25,
  //   capacity: 10,
  //   roomType: "conference",
  //   hasProjector: true,
  //   hasWhiteboard: true
  // }
  //
  // Example for a Vehicle asset:
  // attributes: {
  //   plateNumber: "ABC-1234",
  //   vin: "1HGBH41JXMN109186",
  //   manufacturer: "Toyota",
  //   model: "Camry",
  //   year: 2023,
  //   color: "White"
  // }

  // ══════════════════════════════════════════════════════════════════════════
  // METADATA (Flexible - Anything Not in Schema)
  // ══════════════════════════════════════════════════════════════════════════

  @Column({ type: 'simple-array', nullable: true })
  tags?: string[];
  // Example: ['critical', 'hvac', 'monitored', 'public-access']

  @Column({ type: 'jsonb', nullable: true })
  additionalInfo?: Record<string, any>;
  // Example:
  // additionalInfo: {
  //   purchaseDate: "2023-01-15",
  //   purchasePrice: 50000,
  //   vendor: "ABC Equipment Co.",
  //   warrantyYears: 3,
  //   maintenanceContract: "MC-2023-001",
  //   notes: "Requires monthly inspection",
  //   customField1: "value1"
  // }

  // ══════════════════════════════════════════════════════════════════════════
  // HELPER METHODS
  // ══════════════════════════════════════════════════════════════════════════

  isRoot(): boolean {
    return !this.parentAssetId;
  }

  hasChildren(): boolean {
    return this.childrenCount > 0;
  }

  hasDevices(): boolean {
    return this.deviceCount > 0;
  }
}