// src/modules/solution-templates/entities/solution-template.entity.ts
import { Entity, Column, Index, ManyToOne, JoinColumn } from 'typeorm';
import { BaseEntity } from '@common/entities/base.entity';
import { SolutionTemplateCategory } from '@common/enums/index.enum';
import { Tenant, User } from '@/modules/index.entities';
@Entity('solution_templates')
@Index(['category'])
@Index(['isPremium'])
@Index(['installs'])
@Index(['tenantId', 'isSystem'])
export class SolutionTemplate extends BaseEntity {
  // ══════════════════════════════════════════════════════════════════════════
  // TENANT SCOPING (OPTIONAL - null for system templates)
  // ══════════════════════════════════════════════════════════════════════════

  @Column({ nullable: true })

  tenantId?: string;

  @ManyToOne(() => Tenant, { nullable: true })
  @JoinColumn({ name: 'tenantId' })
  tenant?: Tenant;

  // ══════════════════════════════════════════════════════════════════════════
  // CREATOR (OPTIONAL - null for system templates)
  // ══════════════════════════════════════════════════════════════════════════

  @Column({ nullable: true })

  userId?: string;

  @ManyToOne(() => User, { nullable: true })
  @JoinColumn({ name: 'userId' })
  user?: User;

  // ══════════════════════════════════════════════════════════════════════════
  // BASIC INFO
  // ══════════════════════════════════════════════════════════════════════════

  @Column()
  name: string;

  @Column({ type: 'text' })
  description: string;

  @Column({
    type: 'enum',
    enum: SolutionTemplateCategory,
  })

  category: SolutionTemplateCategory;

  @Column()
  icon: string;

  @Column({ nullable: true })
  previewImage?: string;

  @Column()
  author: string;

  // ══════════════════════════════════════════════════════════════════════════
  // STATISTICS
  // ══════════════════════════════════════════════════════════════════════════

  @Column({ type: 'decimal', precision: 3, scale: 2, default: 0 })
  rating: number;

  @Column({ default: 0 })
  installs: number;

  @Column({ default: '1.0.0' })
  version: string;

  @Column({ type: 'timestamp', default: () => 'CURRENT_TIMESTAMP' })
  lastUpdated: Date;

  // ══════════════════════════════════════════════════════════════════════════
  // TEMPLATE CONTENT
  // ══════════════════════════════════════════════════════════════════════════

  @Column({ type: 'jsonb', default: [] })
  features: string[];

  @Column({ type: 'jsonb', default: [] })
  tags: string[];

  @Column({ default: 0 })
  devices: number;

  @Column({ default: 0 })
  dashboards: number;

  @Column({ default: 0 })
  rules: number;

  @Column({ type: 'jsonb', nullable: true })
  configuration?: {
    devices?: any[];
    dashboards?: any[];
    rules?: any[];
    widgets?: any[];
  };

  // ══════════════════════════════════════════════════════════════════════════
  // FLAGS
  // ══════════════════════════════════════════════════════════════════════════

  @Column({ default: false })

  isPremium: boolean;

  @Column({ default: true })

  isSystem: boolean;  // true = system template, false = user-created

  // ══════════════════════════════════════════════════════════════════════════
  // HELPER METHODS
  // ══════════════════════════════════════════════════════════════════════════

  isUserTemplate(): boolean {
    return !this.isSystem && this.userId !== null;
  }

  canBeModifiedBy(userId: string, isSuperAdmin: boolean): boolean {
    if (this.isSystem) return isSuperAdmin;
    return this.userId === userId || isSuperAdmin;
  }
}
