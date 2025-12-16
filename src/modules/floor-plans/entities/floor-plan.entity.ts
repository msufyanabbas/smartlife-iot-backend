import { Entity, Column, Index } from 'typeorm';
import { BaseEntity } from '../../../common/entities/base.entity';

export enum FloorPlanStatus {
  ACTIVE = 'active',
  DRAFT = 'draft',
  ARCHIVED = 'archived',
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

@Entity('floor_plans')
@Index(['userId', 'status'])
export class FloorPlan extends BaseEntity {
  @Column()
  name: string;

  @Column()
  building: string;

  @Column()
  floor: string;

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
  };

  @Column({ nullable: true })
  scale?: string;

  @Column({ type: 'jsonb', default: '[]' })
  devices: Array<{
    deviceId: string;
    name: string;
    type: string;
    position: { x: number; y: number };
  }>;

  @Column({ type: 'jsonb', default: '[]' })
  zones: Array<{
    id: string;
    name: string;
    color: string;
    boundaries: Array<{ x: number; y: number }>;
  }>;

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
