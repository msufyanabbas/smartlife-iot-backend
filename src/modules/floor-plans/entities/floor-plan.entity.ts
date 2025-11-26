import { Entity, Column, Index } from 'typeorm';
import { BaseEntity } from '../../../common/entities/base.entity';

export enum FloorPlanStatus {
  ACTIVE = 'active',
  DRAFT = 'draft',
  ARCHIVED = 'archived',
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
}
