import { Entity, Column, Index, ManyToOne, JoinColumn } from 'typeorm';
import { BaseEntity } from '@common/entities/base.entity'
import { Tenant, User } from '@modules/index.entities';
import { ShareType, ShareResourceType, AccessLevel } from '@/common/enums/index.enum';

@Entity('shares')
@Index(['sharedBy', 'resourceType'])
@Index(['token'])
@Index(['sharedWith'])
@Index(['tenantId', 'resourceType'])
export class Share extends BaseEntity {
  // ══════════════════════════════════════════════════════════════════════════
  // TENANT SCOPING (REQUIRED)
  // ══════════════════════════════════════════════════════════════════════════
  
  @Column()
  @Index()
  tenantId: string;

  @ManyToOne(() => Tenant)
  @JoinColumn({ name: 'tenantId' })
  tenant: Tenant;
  
  // ══════════════════════════════════════════════════════════════════════════
  // OWNER
  // ══════════════════════════════════════════════════════════════════════════
  
  @Column()
  @Index()
  sharedBy: string;  // User ID who created the share

  @ManyToOne(() => User)
  @JoinColumn({ name: 'sharedBy' })
  owner: User;  

  // ══════════════════════════════════════════════════════════════════════════
  // RESOURCE REFERENCE
  // ══════════════════════════════════════════════════════════════════════════
  
  @Column({
    type: 'enum',
    enum: ShareResourceType,
  })
  @Index()
  resourceType: ShareResourceType;

  @Column()
  @Index()
  resourceId: string;

  // ══════════════════════════════════════════════════════════════════════════
  // SHARE CONFIGURATION
  // ══════════════════════════════════════════════════════════════════════════

  @Column({
    type: 'enum',
    enum: ShareType,
  })
  shareType: ShareType;

  @Column({
    type: 'enum',
    enum: AccessLevel,
    default: AccessLevel.VIEW,
  })
  accessLevel: AccessLevel;

  // ══════════════════════════════════════════════════════════════════════════
  // RECIPIENT (for email shares)
  // ══════════════════════════════════════════════════════════════════════════
  
  @Column({ nullable: true })
  @Index()
  sharedWith?: string;  // Email address  

  // ══════════════════════════════════════════════════════════════════════════
  // LINK SHARING
  // ══════════════════════════════════════════════════════════════════════════
  
  @Column({ nullable: true, unique: true })
  @Index()
  token?: string;  // For link shares

  @Column({ default: false })
  isPublic: boolean;

  @Column({ type: 'timestamp', nullable: true })
  expiresAt?: Date;

  // ══════════════════════════════════════════════════════════════════════════
  // STATISTICS
  // ══════════════════════════════════════════════════════════════════════════
  
  @Column({ default: 0 })
  views: number;

  @Column({ type: 'timestamp', nullable: true })
  lastViewedAt?: Date;

  // ══════════════════════════════════════════════════════════════════════════
  // METADATA
  // ══════════════════════════════════════════════════════════════════════════
  
  @Column({ type: 'jsonb', nullable: true })
  metadata?: {
    resourceName?: string;
    message?: string;
    permissions?: string[];
  };

  // ══════════════════════════════════════════════════════════════════════════
  // HELPER METHODS
  // ══════════════════════════════════════════════════════════════════════════

  isExpired(): boolean {
    if (!this.expiresAt) return false;
    return new Date() > this.expiresAt;
  }

  isValid(): boolean {
    return !this.isExpired();
  }

  incrementViews(): void {
    this.views += 1;
    this.lastViewedAt = new Date();
  }
}
