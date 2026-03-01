import { Entity, Column, Index, ManyToOne, JoinColumn } from 'typeorm';
import { BaseEntity } from '@common/entities/base.entity';
import { Tenant } from '@/modules/index.entities';

@Entity('asset_profiles')
@Index(['tenantId', 'name'])
@Index(['tenantId', 'default'])
export class AssetProfile extends BaseEntity {
  // ══════════════════════════════════════════════════════════════════════════
  // TENANT SCOPING (REQUIRED)
  // ══════════════════════════════════════════════════════════════════════════

  @Column()

  tenantId: string;

  @ManyToOne(() => Tenant)
  @JoinColumn({ name: 'tenantId' })
  tenant: Tenant;

  // ══════════════════════════════════════════════════════════════════════════
  // BASIC INFO
  // ══════════════════════════════════════════════════════════════════════════

  @Column()

  name: string;

  @Column({ type: 'text', nullable: true })
  description?: string;

  @Column({ default: false })

  default: boolean;

  @Column({ nullable: true })
  image?: string;

  // ══════════════════════════════════════════════════════════════════════════
  // HIERARCHY RULES (What can be parent/child of this asset type?)
  // ══════════════════════════════════════════════════════════════════════════

  @Column({ type: 'jsonb', nullable: true })
  hierarchyConfig?: {
    allowChildren: boolean;            // Can this asset have children?
    allowedChildTypes?: string[];      // What types can be children?
    requireParent?: boolean;           // Must this asset have a parent?
    allowedParentTypes?: string[];     // What types can be parents?
    maxDepth?: number;                 // Max nesting level
    inheritAttributesFromParent?: boolean;
    inheritDevicesFromParent?: boolean;
  };

  // Example for "Building Profile":
  // hierarchyConfig: {
  //   allowChildren: true,
  //   allowedChildTypes: ['floor', 'zone', 'parking'],
  //   requireParent: false,           // Buildings are root assets
  //   allowedParentTypes: [],
  //   maxDepth: 5
  // }
  //
  // Example for "Floor Profile":
  // hierarchyConfig: {
  //   allowChildren: true,
  //   allowedChildTypes: ['room', 'office', 'hallway'],
  //   requireParent: true,            // Floors must be in a building
  //   allowedParentTypes: ['building'],
  //   maxDepth: 3,
  //   inheritAttributesFromParent: true
  // }
  //
  // Example for "Room Profile":
  // hierarchyConfig: {
  //   allowChildren: false,           // Rooms can't have children
  //   requireParent: true,
  //   allowedParentTypes: ['floor']
  // }

  // ══════════════════════════════════════════════════════════════════════════
  // LOCATION RULES (Is location required? What format?)
  // ══════════════════════════════════════════════════════════════════════════

  @Column({ type: 'jsonb', nullable: true })
  locationConfig?: {
    required: boolean;                 // Must asset have location?
    requireAddress?: boolean;          // Must have street address?
    requireCoordinates?: boolean;      // Must have lat/lng?
    allowManualEntry?: boolean;        // Can user type address manually?
    defaultZoom?: number;              // Map zoom level
    restrictToRegion?: {               // Limit to specific area?
      northEast?: { lat: number; lng: number };
      southWest?: { lat: number; lng: number };
    };
  };
  // Example for "Building Profile":
  // locationConfig: {
  //   required: true,
  //   requireAddress: true,
  //   requireCoordinates: true,
  //   allowManualEntry: true,
  //   defaultZoom: 15,
  //   restrictToRegion: {
  //     northEast: { lat: 24.9, lng: 46.9 },  // Riyadh bounds
  //     southWest: { lat: 24.5, lng: 46.5 }
  //   }
  // }
  //
  // Example for "Room Profile":
  // locationConfig: {
  //   required: false,                // Rooms inherit from floor
  //   requireCoordinates: false
  // }

  // ══════════════════════════════════════════════════════════════════════════
  // MAP DISPLAY (How to show this asset on a map)
  // ══════════════════════════════════════════════════════════════════════════

  @Column({ type: 'jsonb', nullable: true })
  mapConfig?: {
    icon?: string;                     // Icon name or URL
    iconColor?: string;                // Hex color #FF5733
    markerType?: 'pin' | 'circle' | 'square' | 'custom';
    showLabel?: boolean;               // Show name on map?
    labelField?: string;               // Which attribute to show
    clusterThreshold?: number;         // When to cluster markers
    popupTemplate?: string;            // HTML template for popup
  };

  // Example for "Building Profile":
  // mapConfig: {
  //   icon: 'building',
  //   iconColor: '#3B82F6',           // Blue
  //   markerType: 'pin',
  //   showLabel: true,
  //   labelField: 'name',
  //   clusterThreshold: 10,
  //   popupTemplate: '<h3>{{name}}</h3><p>Floors: {{attributes.floorCount}}</p>'
  // }

  // ══════════════════════════════════════════════════════════════════════════
  // DEVICE ASSOCIATION RULES (Can devices be assigned?)
  // ══════════════════════════════════════════════════════════════════════════

  @Column({ type: 'jsonb', nullable: true })
  deviceConfig?: {
    allowDevices: boolean;             // Can devices be assigned?
    maxDevices?: number;               // Max devices allowed
    allowedDeviceProfileIds?: string[]; // Only specific device types
    requireDevices?: boolean;          // Must have at least 1 device?
    minDevices?: number;
    inheritDevicesToChildren?: boolean;
    autoAssignByLocation?: boolean;    // Auto-assign nearby devices?
    locationProximityMeters?: number;  // How close is "nearby"?
  };
  // Example for "Room Profile":
  // deviceConfig: {
  //   allowDevices: true,
  //   maxDevices: 10,
  //   allowedDeviceProfileIds: ['temp-sensor-profile', 'occupancy-sensor-profile'],
  //   requireDevices: false,
  //   autoAssignByLocation: true,
  //   locationProximityMeters: 50       // Auto-assign devices within 50m
  // }

  // ══════════════════════════════════════════════════════════════════════════
  // ATTRIBUTES SCHEMA (What custom fields can assets of this profile have?)
  // ══════════════════════════════════════════════════════════════════════════

  @Column({ type: 'jsonb', nullable: true })
  attributesSchema?: {
    required: Array<{
      key: string;
      label: string;
      type: 'string' | 'number' | 'boolean' | 'date' | 'json' | 'select';
      description?: string;
      validation?: Record<string, any>;
      options?: Array<{ label: string; value: any }>;
      defaultValue?: any;
    }>;
    optional: Array<{
      key: string;
      label: string;
      type: 'string' | 'number' | 'boolean' | 'date' | 'json' | 'select';
      description?: string;
      validation?: Record<string, any>;
      options?: Array<{ label: string; value: any }>;
      defaultValue?: any;
    }>;
  };

  // Example for "Building Profile":
  // attributesSchema: {
  //   required: [
  //     {
  //       key: 'buildingCode',
  //       label: 'Building Code',
  //       type: 'string',
  //       description: 'Unique building identifier',
  //       validation: { pattern: '^[A-Z]-[0-9]{3}$' }
  //     },
  //     {
  //       key: 'floorCount',
  //       label: 'Number of Floors',
  //       type: 'number',
  //       validation: { min: 1, max: 200 }
  //     }
  //   ],
  //   optional: [
  //     {
  //       key: 'hvacZone',
  //       label: 'HVAC Zone',
  //       type: 'select',
  //       options: [
  //         { label: 'Zone A', value: 'zone-a' },
  //         { label: 'Zone B', value: 'zone-b' }
  //       ]
  //     },
  //     {
  //       key: 'hasFireSprinklers',
  //       label: 'Has Fire Sprinklers',
  //       type: 'boolean',
  //       defaultValue: true
  //     }
  //   ]
  // }

  // ══════════════════════════════════════════════════════════════════════════
  // CALCULATED FIELDS (Auto-computed values)
  // ══════════════════════════════════════════════════════════════════════════

  @Column({ type: 'jsonb', nullable: true })
  calculatedFields?: Array<{
    id: string;
    name: string;
    type: 'number' | 'string' | 'boolean';
    expression: string;                // JavaScript expression
    description?: string;
    unit?: string;
    decimalPlaces?: number;
    updateInterval?: number;           // Seconds between updates
  }>;
  // Example:
  // calculatedFields: [
  //   {
  //     id: 'total-area',
  //     name: 'Total Area',
  //     type: 'number',
  //     expression: 'children.sum(child => child.attributes.area)',
  //     description: 'Sum of all room areas',
  //     unit: 'm²',
  //     decimalPlaces: 2,
  //     updateInterval: 3600           // Update every hour
  //   },
  //   {
  //     id: 'occupancy-rate',
  //     name: 'Occupancy Rate',
  //     type: 'number',
  //     expression: '(devices.active / attributes.capacity) * 100',
  //     unit: '%',
  //     decimalPlaces: 1
  //   }
  // ]

  // ══════════════════════════════════════════════════════════════════════════
  // DASHBOARD & RULE CHAINS 
  // ══════════════════════════════════════════════════════════════════════════

  @Column({ nullable: true })
  defaultDashboardId?: string;

  @Column({ nullable: true })
  mobileDashboardId?: string;

  @Column({ nullable: true })
  defaultRuleChainId?: string;

  @Column({ nullable: true })
  defaultQueueName?: string;

  // ══════════════════════════════════════════════════════════════════════════
  // ALARM RULES (Templates - NOT actual alarms!)
  // ══════════════════════════════════════════════════════════════════════════

  @Column({ type: 'jsonb', nullable: true })
  alarmRules?: Array<{
    id: string;
    alarmType: string;
    severity: 'CRITICAL' | 'MAJOR' | 'MINOR' | 'WARNING' | 'INDETERMINATE';
    createCondition: {
      condition: any;
      spec?: {
        type: string;
        unit?: string;
        value?: any;
        predicate?: any;
      };
    };
    clearCondition?: {
      condition: any;
      spec?: any;
    };
    propagate: any;
    propagateToParent?: boolean;
    propagateToChildren?: boolean;
    schedule?: {
      type: 'ALWAYS' | 'SPECIFIC_TIME' | 'CUSTOM';
      timezone?: string;
      daysOfWeek?: number[];
      startsOn?: number;
      endsOn?: number;
    };
    alarmDetails?: string;
    dashboardId?: string;
  }>;
  // Example:
  // alarmRules: [
  //   {
  //     id: 'high-temperature',
  //     alarmType: 'HIGH_TEMPERATURE',
  //     severity: 'CRITICAL',
  //     createCondition: {
  //       condition: [
  //         {
  //           key: { key: 'temperature', type: 'ATTRIBUTE' },
  //           valueType: 'NUMERIC',
  //           predicate: { operation: 'GREATER', value: { defaultValue: 30 } }
  //         }
  //       ],
  //       spec: { type: 'SIMPLE' }
  //     },
  //     clearCondition: {
  //       condition: [
  //         {
  //           key: { key: 'temperature', type: 'ATTRIBUTE' },
  //           predicate: { operation: 'LESS_OR_EQUAL', value: { defaultValue: 25 } }
  //         }
  //       ]
  //     },
  //     propagateToParent: true,
  //     schedule: {
  //       type: 'ALWAYS',
  //       timezone: 'Asia/Riyadh'
  //     }
  //   }
  // ]
  // NOTE: This is a TEMPLATE. When condition is met, an actual Alarm entity is created.

  // ══════════════════════════════════════════════════════════════════════════
  // METADATA
  // ══════════════════════════════════════════════════════════════════════════

  @Column({ type: 'jsonb', nullable: true })
  additionalInfo?: Record<string, any>;
  // Example:
  // additionalInfo: {
  //   icon: 'building-icon.svg',
  //   category: 'real-estate',
  //   tags: ['commercial', 'office'],
  //   documentation: 'https://docs.smartlife.sa/asset-profiles/building'
  // }
}