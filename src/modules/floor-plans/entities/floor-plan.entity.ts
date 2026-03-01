// src/modules/floor-plans/entities/floor-plan.entity.ts
import { Entity, Column, Index, ManyToOne, JoinColumn } from 'typeorm';
import { BaseEntity } from '@common/entities/base.entity';
import { Tenant, Customer, User, Asset } from '@modules/index.entities';
import {
  FloorPlanStatus,
  DeviceAnimationType
} from '@common/enums/index.enum';
import type {
  FloorPlanSettings,
  DWGGeometry,
  Device3DData,
  Building3DMetadata,
} from '@common/interfaces/index.interface';

@Entity('floor_plans')
@Index(['tenantId', 'status'])
@Index(['tenantId', 'userId'])
@Index(['tenantId', 'customerId'])
@Index(['tenantId', 'assetId'])
@Index(['tenantId', 'building', 'floor'])
export class FloorPlan extends BaseEntity {
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
  // OWNERSHIP
  // ══════════════════════════════════════════════════════════════════════════

  @Column()

  userId: string;

  @ManyToOne(() => User)
  @JoinColumn({ name: 'userId' })
  user: User;

  // ══════════════════════════════════════════════════════════════════════════
  // ASSET ASSOCIATION
  // ══════════════════════════════════════════════════════════════════════════

  @Column()

  assetId: string;

  @ManyToOne(() => Asset)
  @JoinColumn({ name: 'assetId' })
  asset: Asset;

  // ══════════════════════════════════════════════════════════════════════════
  // BASIC INFO
  // ══════════════════════════════════════════════════════════════════════════

  @Column()
  name: string;  // "Main Office Floor Plan"

  @Column()
  building: string;  // "Building A"

  @Column()
  floor: string;  // "Floor 3", "Ground Floor"

  @Column({ type: 'int', nullable: true })
  floorNumber?: number;  // 3, 1, 0 (for ordering)

  @Column({ nullable: true })
  category?: string;  // "office", "warehouse", "factory"

  @Column({ type: 'text', nullable: true })
  description?: string;

  @Column({ type: 'enum', enum: FloorPlanStatus, default: FloorPlanStatus.DRAFT })

  status: FloorPlanStatus;

  // ══════════════════════════════════════════════════════════════════════════
  // DWG FILE STORAGE
  // ══════════════════════════════════════════════════════════════════════════

  @Column({ nullable: true })
  dwgFileUrl?: string;  // "https://storage.../floor-plan.dwg"

  @Column({ type: 'bigint', nullable: true })
  dwgFileSizeBytes?: number;

  @Column({ type: 'timestamp', nullable: true })
  dwgUploadedAt?: Date;

  @Column({ type: 'text', nullable: true })
  parsingError?: string;  // Error message if DWG parsing failed

  // ══════════════════════════════════════════════════════════════════════════
  // PARSED DWG GEOMETRY
  // ══════════════════════════════════════════════════════════════════════════

  @Column({ type: 'jsonb', nullable: true })
  parsedGeometry?: DWGGeometry;
  // Contains: walls, doors, windows, rooms, stairs, furniture

  // ══════════════════════════════════════════════════════════════════════════
  // PREVIEW IMAGES
  // ══════════════════════════════════════════════════════════════════════════

  @Column({ nullable: true })
  thumbnailUrl?: string;  // Small preview (200x200)

  @Column({ nullable: true })
  imageUrl?: string;  // Full-size 2D render

  // ══════════════════════════════════════════════════════════════════════════
  // DIMENSIONS & SCALE
  // ══════════════════════════════════════════════════════════════════════════

  @Column({ type: 'jsonb' })
  dimensions: {
    width: number;
    height: number;
    unit?: 'meters' | 'feet';
  };
  // Example: { width: 50, height: 30, unit: 'meters' }

  @Column({ nullable: true })
  scale?: string;  // "1:100", "1:50"

  // ══════════════════════════════════════════════════════════════════════════
  // 3D DEVICES (With animations and telemetry bindings)
  // ══════════════════════════════════════════════════════════════════════════

  @Column({ type: 'jsonb', default: [] })
  devices: Device3DData[];
  // Example:
  // devices: [
  //   {
  //     deviceId: 'device-123',
  //     name: 'Temperature Sensor 1',
  //     type: 'temperature_sensor',
  //     position: { x: 10, y: 5, z: 2.5 },
  //     rotation: { x: 0, y: 0, z: 0 },
  //     scale: { x: 1, y: 1, z: 1 },
  //     model3DUrl: 'https://storage.../sensor.glb',
  //     animationType: 'temperature_gradient',
  //     animationConfig: {
  //       intensity: 0.5,
  //       speed: 1.0,
  //       color: '#FF5733'
  //     },
  //     telemetryBindings: {
  //       temperature: {
  //         animationProperty: 'intensity',
  //         min: 0,
  //         max: 50
  //       }
  //     },
  //     status: 'online'
  //   }
  // ]

  // ══════════════════════════════════════════════════════════════════════════
  // ZONES (Grouping areas on floor plan)
  // ══════════════════════════════════════════════════════════════════════════

  @Column({ type: 'jsonb', default: [] })
  zones: Array<{
    id: string;
    name: string;
    color: string;
    boundaries: Array<{ x: number; y: number }>;
    floor?: string;
    deviceIds?: string[];
    area?: number;  // Square meters/feet
  }>;
  // Example:
  // zones: [
  //   {
  //     id: 'zone-1',
  //     name: 'Office Area',
  //     color: '#3b82f6',
  //     boundaries: [
  //       { x: 0, y: 0 },
  //       { x: 20, y: 0 },
  //       { x: 20, y: 15 },
  //       { x: 0, y: 15 }
  //     ],
  //     floor: 'Floor 3',
  //     deviceIds: ['device-1', 'device-2'],
  //     area: 300
  //   }
  // ]

  // ══════════════════════════════════════════════════════════════════════════
  // BUILDING 3D METADATA (Shared across floors)
  // ══════════════════════════════════════════════════════════════════════════

  @Column({ type: 'jsonb', nullable: true })
  building3DMetadata?: Building3DMetadata;
  // Example:
  // building3DMetadata: {
  //   buildingName: 'Smart Tower',
  //   totalFloors: 10,
  //   floorHeight: 3.5,
  //   buildingDimensions: {
  //     width: 50,
  //     length: 40,
  //     height: 35
  //   },
  //   exteriorModel: 'https://storage.../building.glb',
  //   floorOrder: ['Ground', 'Floor 1', 'Floor 2', ..., 'Floor 9']
  // }

  // ══════════════════════════════════════════════════════════════════════════
  // SETTINGS
  // ══════════════════════════════════════════════════════════════════════════

  @Column({
    type: 'jsonb',
    default: {
      measurementUnit: 'metric',
      autoSave: true,
      gridSettings: {
        showGrid: true,
        snapToGrid: true,
        gridSize: 1,
      },
      defaultColors: {
        gateways: '#22c55e',
        sensorsToGateway: '#f59e0b',
        zones: '#3b82f6',
        sensorsToGrid: '#a855f7',
      },
    },
  })
  settings: FloorPlanSettings;

  // ══════════════════════════════════════════════════════════════════════════
  // METADATA
  // ══════════════════════════════════════════════════════════════════════════

  @Column({ type: 'simple-array', nullable: true })
  tags?: string[];  // ['3d-enabled', 'hvac', 'security']

  @Column({ type: 'jsonb', nullable: true })
  additionalInfo?: Record<string, any>;

  // ══════════════════════════════════════════════════════════════════════════
  // HELPER METHODS
  // ══════════════════════════════════════════════════════════════════════════

  /**
   * Check if floor plan is active
   */
  isActive(): boolean {
    return this.status === FloorPlanStatus.ACTIVE;
  }

  /**
   * Check if floor plan is processing DWG
   */
  isProcessing(): boolean {
    return this.status === FloorPlanStatus.PROCESSING;
  }

  /**
   * Check if DWG parsing failed
   */
  hasFailed(): boolean {
    return this.status === FloorPlanStatus.FAILED;
  }

  /**
   * Get device by ID
   */
  getDevice(deviceId: string): Device3DData | undefined {
    return this.devices.find(d => d.deviceId === deviceId);
  }

  /**
   * Add device to floor plan
   */
  addDevice(device: Device3DData): void {
    if (!this.devices) {
      this.devices = [];
    }
    this.devices.push(device);
  }

  /**
   * Remove device from floor plan
   */
  removeDevice(deviceId: string): void {
    if (this.devices) {
      this.devices = this.devices.filter(d => d.deviceId !== deviceId);
    }
  }

  /**
   * Update device position
   */
  updateDevicePosition(
    deviceId: string,
    position: { x: number; y: number; z: number },
  ): void {
    const device = this.getDevice(deviceId);
    if (device) {
      device.position = position;
    }
  }

  /**
   * Get all devices in a zone
   */
  getDevicesInZone(zoneId: string): Device3DData[] {
    const zone = this.zones.find(z => z.id === zoneId);
    if (!zone?.deviceIds) return [];

    return this.devices.filter(d => zone.deviceIds?.includes(d.deviceId));
  }

  /**
   * Add zone
   */
  addZone(zone: FloorPlan['zones'][0]): void {
    if (!this.zones) {
      this.zones = [];
    }
    this.zones.push(zone);
  }

  /**
   * Remove zone
   */
  removeZone(zoneId: string): void {
    if (this.zones) {
      this.zones = this.zones.filter(z => z.id !== zoneId);
    }
  }

  /**
   * Get total floor area
   */
  getTotalArea(): number {
    return this.dimensions.width * this.dimensions.height;
  }

  /**
   * Check if has 3D data
   */
  has3DData(): boolean {
    return this.devices.length > 0 && this.devices.some(d => d.model3DUrl);
  }
}