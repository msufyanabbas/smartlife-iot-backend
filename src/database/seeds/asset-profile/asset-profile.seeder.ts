// src/database/seeds/asset-profile/asset-profile.seeder.ts
import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Tenant, AssetProfile } from '@modules/index.entities';
import { AssetProfileType, ProfileFieldType } from '@common/enums/index.enum';
import type { ProfileSchema } from '@common/interfaces/index.interface';
import { ISeeder } from '../seeder.interface';

/**
 * Seeds the 8 stock asset profiles (building, shop, farm, warehouse, hospital,
 * hotel, factory, custom) for EVERY tenant.
 *
 * Each profile declares a `schema.fields[]`, which is what the frontend renders
 * as a dynamic form and what `Asset.configuration` is keyed by. Profiles whose
 * schema contains a `floors_array` field (building / hospital / hotel) are the
 * multi-floor ones — their assets drive GET /assets/:id/floors and per-floor
 * floor plans.
 *
 * Replaces the older 5-profile seeder in ../asset-profiles/ (which is no longer
 * registered in index.seeder.ts).
 *
 * Re-runnable: profiles are matched on (tenantId, name); existing rows are
 * updated in place so `type` / `schema` get backfilled on databases seeded
 * before those columns existed.
 */

interface ProfileDefinition {
  name: string;
  description: string;
  type: AssetProfileType;
  schema: ProfileSchema;
  default?: boolean;
  hierarchyConfig?: AssetProfile['hierarchyConfig'];
  mapConfig?: AssetProfile['mapConfig'];
  additionalInfo?: Record<string, any>;
}

const PROFILE_DEFINITIONS: ProfileDefinition[] = [
  // ── 1. Building ───────────────────────────────────────────────────────────
  {
    name: 'Building',
    description:
      'Multi-floor commercial or residential building. Supports per-floor floor plans.',
    type: AssetProfileType.BUILDING,
    schema: {
      fields: [
        {
          key: 'totalFloors',
          label: 'Total Floors',
          type: ProfileFieldType.NUMBER,
          required: true,
          min: 1,
          max: 200,
        },
        {
          key: 'totalArea',
          label: 'Total Area (m²)',
          type: ProfileFieldType.NUMBER,
          required: false,
        },
        {
          key: 'yearBuilt',
          label: 'Year Built',
          type: ProfileFieldType.NUMBER,
          required: false,
        },
        {
          key: 'buildingType',
          label: 'Building Type',
          type: ProfileFieldType.SELECT,
          required: false,
          options: [
            'Commercial',
            'Residential',
            'Industrial',
            'Mixed Use',
            'Government',
          ],
        },
        {
          key: 'floorsData',
          label: 'Floors Configuration',
          type: ProfileFieldType.FLOORS_ARRAY,
          required: false,
        },
      ],
    },
    hierarchyConfig: {
      allowChildren: true,
      allowedChildTypes: ['floor', 'zone', 'room'],
      requireParent: false,
      maxDepth: 3,
    },
    mapConfig: {
      icon: 'business',
      iconColor: '#2196F3',
      markerType: 'pin',
      showLabel: true,
    },
    additionalInfo: { category: 'building', icon: 'business', color: '#2196F3' },
  },

  // ── 2. Shop / Retail ──────────────────────────────────────────────────────
  {
    name: 'Shop/Retail',
    description: 'Retail store or shop floor with departments and checkouts.',
    type: AssetProfileType.SHOP,
    schema: {
      fields: [
        {
          key: 'totalArea',
          label: 'Total Area (m²)',
          type: ProfileFieldType.NUMBER,
          required: true,
        },
        {
          key: 'departments',
          label: 'Number of Departments',
          type: ProfileFieldType.NUMBER,
          required: false,
        },
        {
          key: 'checkoutCounters',
          label: 'Checkout Counters',
          type: ProfileFieldType.NUMBER,
          required: false,
        },
        {
          key: 'storageArea',
          label: 'Storage Area (m²)',
          type: ProfileFieldType.NUMBER,
          required: false,
        },
      ],
    },
    hierarchyConfig: {
      allowChildren: true,
      allowedChildTypes: ['zone', 'room'],
      requireParent: false,
      maxDepth: 2,
    },
    mapConfig: {
      icon: 'storefront',
      iconColor: '#FF9800',
      markerType: 'pin',
      showLabel: true,
    },
    additionalInfo: { category: 'retail', icon: 'storefront', color: '#FF9800' },
  },

  // ── 3. Farm ───────────────────────────────────────────────────────────────
  {
    name: 'Farm',
    description: 'Agricultural site divided into irrigation / crop zones.',
    type: AssetProfileType.FARM,
    schema: {
      fields: [
        {
          key: 'totalArea',
          label: 'Total Area (hectares)',
          type: ProfileFieldType.NUMBER,
          required: true,
        },
        {
          key: 'zones',
          label: 'Number of Zones',
          type: ProfileFieldType.NUMBER,
          required: false,
        },
        {
          key: 'cropTypes',
          label: 'Crop Types',
          type: ProfileFieldType.TEXT,
          required: false,
        },
        {
          key: 'irrigationSystem',
          label: 'Irrigation System',
          type: ProfileFieldType.SELECT,
          required: false,
          options: ['Drip', 'Sprinkler', 'Flood', 'None'],
        },
      ],
    },
    hierarchyConfig: {
      allowChildren: true,
      allowedChildTypes: ['zone'],
      requireParent: false,
      maxDepth: 2,
    },
    mapConfig: {
      icon: 'agriculture',
      iconColor: '#4CAF50',
      markerType: 'pin',
      showLabel: true,
    },
    additionalInfo: {
      category: 'agriculture',
      icon: 'agriculture',
      color: '#4CAF50',
    },
  },

  // ── 4. Warehouse ──────────────────────────────────────────────────────────
  {
    name: 'Warehouse',
    description: 'Storage facility with racking, docking bays and capacity.',
    type: AssetProfileType.WAREHOUSE,
    schema: {
      fields: [
        {
          key: 'totalArea',
          label: 'Total Area (m²)',
          type: ProfileFieldType.NUMBER,
          required: true,
        },
        {
          key: 'storageCapacity',
          label: 'Storage Capacity (tons)',
          type: ProfileFieldType.NUMBER,
          required: false,
        },
        {
          key: 'dockingBays',
          label: 'Docking Bays',
          type: ProfileFieldType.NUMBER,
          required: false,
        },
        {
          key: 'rackingLevels',
          label: 'Racking Levels',
          type: ProfileFieldType.NUMBER,
          required: false,
        },
      ],
    },
    hierarchyConfig: {
      allowChildren: true,
      allowedChildTypes: ['zone', 'room'],
      requireParent: false,
      maxDepth: 2,
    },
    mapConfig: {
      icon: 'warehouse',
      iconColor: '#795548',
      markerType: 'pin',
      showLabel: true,
    },
    additionalInfo: { category: 'logistics', icon: 'warehouse', color: '#795548' },
  },

  // ── 5. Hospital ───────────────────────────────────────────────────────────
  {
    name: 'Hospital',
    description:
      'Healthcare facility with wards and departments. Supports per-floor floor plans.',
    type: AssetProfileType.HOSPITAL,
    schema: {
      fields: [
        {
          key: 'totalFloors',
          label: 'Total Floors',
          type: ProfileFieldType.NUMBER,
          required: true,
          min: 1,
        },
        {
          key: 'totalBeds',
          label: 'Total Beds',
          type: ProfileFieldType.NUMBER,
          required: false,
        },
        {
          key: 'departments',
          label: 'Number of Departments',
          type: ProfileFieldType.NUMBER,
          required: false,
        },
        {
          key: 'icuBeds',
          label: 'ICU Beds',
          type: ProfileFieldType.NUMBER,
          required: false,
        },
        {
          key: 'floorsData',
          label: 'Floors Configuration',
          type: ProfileFieldType.FLOORS_ARRAY,
          required: false,
        },
      ],
    },
    hierarchyConfig: {
      allowChildren: true,
      allowedChildTypes: ['floor', 'zone', 'room'],
      requireParent: false,
      maxDepth: 3,
    },
    mapConfig: {
      icon: 'local_hospital',
      iconColor: '#E91E63',
      markerType: 'pin',
      showLabel: true,
    },
    additionalInfo: {
      category: 'healthcare',
      icon: 'local_hospital',
      color: '#E91E63',
    },
  },

  // ── 6. Hotel ──────────────────────────────────────────────────────────────
  {
    name: 'Hotel',
    description:
      'Hospitality property with guest rooms. Supports per-floor floor plans.',
    type: AssetProfileType.HOTEL,
    schema: {
      fields: [
        {
          key: 'totalFloors',
          label: 'Total Floors',
          type: ProfileFieldType.NUMBER,
          required: true,
          min: 1,
        },
        {
          key: 'totalRooms',
          label: 'Total Rooms',
          type: ProfileFieldType.NUMBER,
          required: false,
        },
        {
          key: 'starRating',
          label: 'Star Rating',
          type: ProfileFieldType.SELECT,
          required: false,
          options: ['1', '2', '3', '4', '5'],
        },
        {
          key: 'floorsData',
          label: 'Floors Configuration',
          type: ProfileFieldType.FLOORS_ARRAY,
          required: false,
        },
      ],
    },
    hierarchyConfig: {
      allowChildren: true,
      allowedChildTypes: ['floor', 'zone', 'room'],
      requireParent: false,
      maxDepth: 3,
    },
    mapConfig: {
      icon: 'hotel',
      iconColor: '#9C27B0',
      markerType: 'pin',
      showLabel: true,
    },
    additionalInfo: { category: 'hospitality', icon: 'hotel', color: '#9C27B0' },
  },

  // ── 7. Factory ────────────────────────────────────────────────────────────
  {
    name: 'Factory',
    description: 'Manufacturing plant with production lines and shifts.',
    type: AssetProfileType.FACTORY,
    schema: {
      fields: [
        {
          key: 'totalArea',
          label: 'Total Area (m²)',
          type: ProfileFieldType.NUMBER,
          required: true,
        },
        {
          key: 'productionLines',
          label: 'Production Lines',
          type: ProfileFieldType.NUMBER,
          required: false,
        },
        {
          key: 'shifts',
          label: 'Number of Shifts',
          type: ProfileFieldType.NUMBER,
          required: false,
        },
        {
          key: 'industryType',
          label: 'Industry Type',
          type: ProfileFieldType.SELECT,
          required: false,
          options: [
            'Food & Beverage',
            'Automotive',
            'Electronics',
            'Pharmaceutical',
            'Textile',
            'Chemical',
            'Other',
          ],
        },
      ],
    },
    hierarchyConfig: {
      allowChildren: true,
      allowedChildTypes: ['zone', 'room'],
      requireParent: false,
      maxDepth: 2,
    },
    mapConfig: {
      icon: 'precision_manufacturing',
      iconColor: '#FF6F00',
      markerType: 'pin',
      showLabel: true,
    },
    additionalInfo: {
      category: 'industrial',
      icon: 'precision_manufacturing',
      color: '#FF6F00',
    },
  },

  // ── 8. Custom ─────────────────────────────────────────────────────────────
  {
    name: 'Custom',
    description:
      'Blank profile — define your own fields. Used as the tenant default.',
    type: AssetProfileType.CUSTOM,
    schema: { fields: [] },
    default: true,
    hierarchyConfig: {
      allowChildren: true,
      requireParent: false,
    },
    mapConfig: {
      icon: 'category',
      iconColor: '#607D8B',
      markerType: 'pin',
      showLabel: true,
    },
    additionalInfo: { category: 'custom', icon: 'category', color: '#607D8B' },
  },
];

@Injectable()
export class AssetProfileSeeder implements ISeeder {
  private readonly logger = new Logger(AssetProfileSeeder.name);

  constructor(
    @InjectRepository(AssetProfile)
    private readonly assetProfileRepository: Repository<AssetProfile>,
    @InjectRepository(Tenant)
    private readonly tenantRepository: Repository<Tenant>,
  ) {}

  async seed(): Promise<void> {
    this.logger.log('🏢 Seeding asset profiles...');

    const tenants = await this.tenantRepository.find();

    if (tenants.length === 0) {
      this.logger.warn('⚠️  No tenants found. Please seed tenants first.');
      return;
    }

    let created = 0;
    let updated = 0;

    for (const tenant of tenants) {
      for (const definition of PROFILE_DEFINITIONS) {
        const existing = await this.assetProfileRepository.findOne({
          where: { name: definition.name, tenantId: tenant.id },
        });

        if (existing) {
          // Backfill the new columns on databases seeded before they existed.
          existing.type = definition.type;
          existing.schema = definition.schema;
          existing.description = definition.description;
          if (definition.hierarchyConfig)
            existing.hierarchyConfig = definition.hierarchyConfig;
          if (definition.mapConfig) existing.mapConfig = definition.mapConfig;
          if (definition.additionalInfo)
            existing.additionalInfo = definition.additionalInfo;
          await this.assetProfileRepository.save(existing);
          updated++;
          continue;
        }

        const profile = this.assetProfileRepository.create({
          tenantId: tenant.id,
          name: definition.name,
          description: definition.description,
          type: definition.type,
          schema: definition.schema,
          default: definition.default ?? false,
          hierarchyConfig: definition.hierarchyConfig,
          mapConfig: definition.mapConfig,
          additionalInfo: definition.additionalInfo,
          locationConfig: {
            required: false,
            requireCoordinates: false,
            allowManualEntry: true,
            defaultZoom: 15,
          },
          deviceConfig: { allowDevices: true },
        });

        await this.assetProfileRepository.save(profile);
        created++;
      }
    }

    this.logger.log(
      `🎉 Asset profile seeding complete — ${created} created, ${updated} updated ` +
        `(${PROFILE_DEFINITIONS.length} profiles × ${tenants.length} tenant(s)).`,
    );
  }
}
