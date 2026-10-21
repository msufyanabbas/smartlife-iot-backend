import { Entity, Column, Index, ManyToOne, OneToMany, JoinColumn } from 'typeorm';
import { BaseEntity } from '@common/entities/base.entity';
import type { Relation } from 'typeorm';
import type { Tenant } from '../../tenants/entities/tenant.entity';
import type { Customer } from '../../customers/entities/customers.entity';
import type { AssetProfile } from '../../profiles/entities/asset-profile.entity';
import type { Device } from '../../devices/entities/device.entity';
import { AssetType } from '@common/enums/asset.enum';
import type { AssetProfileType } from '@common/enums/index.enum';
import type { AssetConfiguration } from '@common/interfaces/index.interface';

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

  @ManyToOne('Tenant')
  @JoinColumn({ name: 'tenantId' })
  tenant: Relation<Tenant>;

  // ══════════════════════════════════════════════════════════════════════════
  // CUSTOMER SCOPING (OPTIONAL)
  // ══════════════════════════════════════════════════════════════════════════

  @Column({ nullable: true })

  customerId?: string;

  @ManyToOne('Customer', { nullable: true })
  @JoinColumn({ name: 'customerId' })
  customer?: Relation<Customer>;

  // ══════════════════════════════════════════════════════════════════════════
  // BASIC INFO
  // ══════════════════════════════════════════════════════════════════════════

  @Column()
  name: string;

  @Column({ nullable: true })
  label?: string;

  /**
   * @deprecated **Not the asset's type.** `AssetProfile.type` is.
   *
   * This column predates asset profiles and was the second, conflicting
   * answer to "what kind of thing is this?": a PG enum
   * (`building | floor | room | office | vehicle | equipment |
   * infrastructure | zone | other`) that does not even share a vocabulary
   * with `AssetProfileType` (`building | vehicle | shop | farm | warehouse |
   * hospital | hotel | factory | custom`). Two columns, two closed lists, no
   * rule for which won — so the 3D viewer picked its context scene from the
   * profile when there was one and keyword-matched this when there wasn't,
   * and the same asset could render as a building on one screen and a bare
   * ground plate on another.
   *
   * It survives rather than being dropped for three reasons, all of them
   * about rows and callers that already exist:
   *
   *   1. Live rows carry values here that are the ONLY record of an operator's
   *      original classification. `AssetTypeFromProfile1788700000000` reads
   *      them to decide which profile an unprofiled asset should get; deleting
   *      the column would delete the evidence the backfill (and any later
   *      correction of it) depends on.
   *   2. `AnalyticsService.getAssetPerformance()` still groups by it, and that
   *      module is not this change's to edit.
   *   3. The vocabularies do not map — `shop`, `farm`, `warehouse`, `hospital`,
   *      `hotel`, `factory` and `custom` are not members of `assets_type_enum`
   *      — so the column CANNOT be kept in sync with the profile without an
   *      enum migration. Frozen legacy data is honest; a half-mirrored column
   *      would be a third source of truth.
   *
   * Nothing should read it. Reads go through {@link resolveAssetType} or the
   * derived `assetType` the services attach to responses. Writes are ignored
   * with a deprecation warning (`AssetsService.stripDeprecatedType`), so the
   * value on an existing row never changes and the column holds exactly the
   * history it held before this change.
   */
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

  @ManyToOne('AssetProfile', { nullable: true })
  @JoinColumn({ name: 'assetProfileId' })
  assetProfile?: Relation<AssetProfile>;

  /**
   * The inherited type, materialised onto the response.
   *
   * **Not a column** — no `@Column`, so TypeORM neither selects nor persists
   * it. It exists so that consumers have one obvious field to read instead of
   * reaching through `assetProfile?.type`, which is only present when the
   * relation happens to have been joined. The read paths set it from
   * {@link resolveAssetType}; see `AssetsService.withAssetType`.
   */
  assetType?: AssetProfileType | null;

  // ══════════════════════════════════════════════════════════════════════════
  // PROFILE-SPECIFIC CONFIGURATION (values for AssetProfile.schema.fields)
  // ══════════════════════════════════════════════════════════════════════════

  /**
   * Values for the fields declared by this asset's AssetProfile.schema.
   * Keyed by ProfileField.key.
   *
   * Example (a "Building" profile asset):
   *   configuration: {
   *     totalFloors: 5,
   *     totalArea: 2000,
   *     yearBuilt: 2020,
   *     buildingType: 'Commercial',
   *     floorsData: [
   *       { floorNumber: 0, name: 'Basement',     rooms: 5,  area: 300 },
   *       { floorNumber: 1, name: 'Ground Floor', rooms: 12, area: 450 },
   *       { floorNumber: 2, name: 'First Floor',  rooms: 10, area: 450 },
   *     ]
   *   }
   *
   * `floorsData` is the source of truth for GET /assets/:id/floors and for
   * which floor numbers may have a FloorPlan.
   *
   * Distinct from `attributes` (free-form/legacy) and `additionalInfo`
   * (anything outside the schema).
   */
  @Column({ type: 'jsonb', nullable: true, default: {} })
  configuration?: AssetConfiguration;

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

  @OneToMany('Device', 'asset')
  devices: Relation<Device>[];

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

  /**
   * The asset's type — the one answer, inherited from its profile.
   *
   * `null` when the asset has no profile, or has one whose `type` was never
   * set. Null is a real state and is deliberately not papered over with a
   * default: "unclassified" is the truth, and a guessed `custom` would be
   * indistinguishable from a profile that really is custom.
   *
   * Requires `assetProfile` to be loaded. Every read path that exposes a type
   * joins it (`AssetsService.findOne/findAll/getChildren`,
   * `FloorPlansService.findOne/findByAsset/assertAsset`); an unloaded relation
   * yields `null` rather than throwing, which is the same answer an asset
   * without a profile gives and so cannot be mistaken for a different kind of
   * failure.
   */
  resolveAssetType(): AssetProfileType | null {
    return this.assetProfile?.type ?? null;
  }

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