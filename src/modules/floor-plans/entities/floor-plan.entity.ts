import { Entity, Column, Index, ManyToOne, JoinColumn } from 'typeorm';
import { BaseEntity } from '../../../common/entities/base.entity';

export enum FloorPlanStatus {
  ACTIVE = 'active',
  DRAFT = 'draft',
  ARCHIVED = 'archived',
  PROCESSING = 'processing', // For DWG parsing
  FAILED = 'failed',
}

export enum DeviceAnimationType {
  SMOKE = 'smoke',
  DOOR_OPEN_CLOSE = 'door_open_close',
  LIGHT_PULSE = 'light_pulse',
  WATER_LEAK = 'water_leak',
  TEMPERATURE_GRADIENT = 'temperature_gradient',
  MOTION_WAVE = 'motion_wave',
  ALARM_FLASH = 'alarm_flash',
  NONE = 'none',
}

export interface FloorPlanSettings {
  measurementUnit: 'metric' | 'imperial';
  autoSave: boolean;
  gridSettings: {
    showGrid: boolean;
    snapToGrid: boolean;
    gridSize: number;
  };
  defaultColors: {
    gateways: string;
    sensorsToGateway: string;
    zones: string;
    sensorsToGrid: string;
  };
}

export interface DWGGeometry {
  walls: Array<{
    id: string;
    points: Array<{ x: number; y: number; z?: number }>;
    thickness: number;
    height: number;
    material?: string;
  }>;
  doors: Array<{
    id: string;
    position: { x: number; y: number; z?: number };
    width: number;
    height: number;
    rotation: number;
    type: 'single' | 'double' | 'sliding';
  }>;
  windows: Array<{
    id: string;
    position: { x: number; y: number; z?: number };
    width: number;
    height: number;
    rotation: number;
  }>;
  rooms: Array<{
    id: string;
    name: string;
    boundaries: Array<{ x: number; y: number }>;
    area: number;
    floor: string;
  }>;
  stairs: Array<{
    id: string;
    points: Array<{ x: number; y: number; z?: number }>;
    width: number;
    steps: number;
  }>;
  furniture?: Array<{
    id: string;
    type: string;
    position: { x: number; y: number; z?: number };
    rotation: number;
    dimensions: { width: number; height: number; depth: number };
  }>;
}

export interface Device3DData {
  deviceId: string;
  name: string;
  type: string;
  position: { x: number; y: number; z: number };
  rotation?: { x: number; y: number; z: number };
  scale?: { x: number; y: number; z: number };
  model3DUrl?: string; // URL to 3D model file (GLB/GLTF)
  animationType: DeviceAnimationType;
  animationConfig?: {
    intensity?: number;
    speed?: number;
    color?: string;
    particleCount?: number;
    radius?: number;
  };
  telemetryBindings?: {
    [telemetryKey: string]: {
      animationProperty: string; // e.g., 'intensity', 'speed', 'color'
      min: number;
      max: number;
    };
  };
  status?: 'online' | 'offline' | 'alarm';
}

export interface Building3DMetadata {
  buildingName: string;
  totalFloors: number;
  floorHeight: number; // Height of each floor in meters
  buildingDimensions: {
    width: number;
    length: number;
    height: number;
  };
  exteriorModel?: string; // URL to building exterior 3D model
  floorOrder: string[]; // Array of floor identifiers in order (bottom to top)
}

@Entity('floor_plans')
@Index(['userId', 'status'])
// @Index(['assetId'])
export class FloorPlan extends BaseEntity {
  @Column()
  name: string;

  @Column()
  building: string;

  @Column()
  floor: string;

  @Column({ name: 'floor_number', type: 'int', nullable: true })
  floorNumber?: number; // Numeric order for floor selection

  // Asset Association
  @Column({ name: 'asset_id' })
  @Index()
  assetId: string;

  // DWG File Storage
  @Column({ name: 'dwg_file_url', nullable: true })
  dwgFileUrl?: string;

  @Column({ name: 'dwg_file_size', type: 'bigint', nullable: true })
  dwgFileSizeBytes?: number;

  @Column({ name: 'dwg_uploaded_at', type: 'timestamp', nullable: true })
  dwgUploadedAt?: Date;

  // Parsed DWG Data
  @Column({ type: 'jsonb', nullable: true })
  parsedGeometry?: DWGGeometry;

  @Column({ name: 'parsing_error', type: 'text', nullable: true })
  parsingError?: string;

  // Preview/Thumbnail
  @Column({ name: 'thumbnail_url', nullable: true })
  thumbnailUrl?: string;

  @Column({ name: 'image_url', nullable: true })
  imageUrl?: string;

  @Column()
  category: string;

  @Column({
    type: 'enum',
    enum: FloorPlanStatus,
    default: FloorPlanStatus.DRAFT,
  })
  status: FloorPlanStatus;

  @Column({ type: 'jsonb' })
  dimensions: {
    width: number;
    height: number;
    unit?: 'meters' | 'feet';
  };

  @Column({ nullable: true })
  scale?: string;

  // 3D Devices with animation data
  @Column({ type: 'jsonb', default: '[]' })
  devices: Device3DData[];

  // Zones for grouping areas
  @Column({ type: 'jsonb', default: '[]' })
  zones: Array<{
    id: string;
    name: string;
    color: string;
    boundaries: Array<{ x: number; y: number }>;
    floor?: string;
    deviceIds?: string[]; // Devices in this zone
  }>;

  // Building-level 3D metadata (shared across floors of same building)
  @Column({ type: 'jsonb', nullable: true })
  building3DMetadata?: Building3DMetadata;

  @Column({ name: 'user_id' })
  @Index()
  userId: string;

  @Column({ name: 'tenant_id', nullable: true })
  @Index()
  tenantId?: string;

  @Column({
    type: 'jsonb',
    nullable: true,
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
}