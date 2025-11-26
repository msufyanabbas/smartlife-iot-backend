import { Entity, Column, Index } from 'typeorm';
import { BaseEntity } from '../../../common/entities/base.entity';

export enum ResourceType {
  DASHBOARD = 'dashboard',
  DEVICE = 'device',
  ASSET = 'asset',
  REPORT = 'report',
  FLOOR_PLAN = 'floor_plan',
}

export enum ShareType {
  EMAIL = 'email',
  LINK = 'link',
}

export enum AccessLevel {
  VIEW = 'view',
  EDIT = 'edit',
  ADMIN = 'admin',
}

@Entity('shares')
@Index(['sharedBy', 'resourceType'])
// @Index(['token'])
@Index(['sharedWith'])
export class Share extends BaseEntity {
  @Column({
    type: 'enum',
    enum: ResourceType,
  })
  resourceType: ResourceType;

  @Column({ name: 'resource_id' })
  resourceId: string;

  @Column({
    type: 'enum',
    enum: ShareType,
  })
  shareType: ShareType;

  @Column({ name: 'shared_with', nullable: true })
  sharedWith?: string; // Email address for email shares

  @Column({
    type: 'enum',
    enum: AccessLevel,
    default: AccessLevel.VIEW,
  })
  accessLevel: AccessLevel;

  @Column({ nullable: true, unique: true })
  @Index()
  token?: string; // For link shares

  @Column({ name: 'expires_at', type: 'timestamp', nullable: true })
  expiresAt?: Date;

  @Column({ default: 0 })
  views: number;

  @Column({ name: 'is_public', default: false })
  isPublic: boolean;

  @Column({ name: 'shared_by' })
  @Index()
  sharedBy: string;

  @Column({ name: 'user_id' })
  @Index()
  userId: string;

  @Column({ name: 'tenant_id', nullable: true })
  @Index()
  tenantId?: string;

  @Column({ type: 'jsonb', nullable: true })
  metadata?: {
    resourceName?: string;
    message?: string;
    permissions?: string[];
  };
}
