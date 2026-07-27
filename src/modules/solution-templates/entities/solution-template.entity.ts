// src/modules/solution-templates/entities/solution-template.entity.ts
import { Entity, Column, Index, ManyToOne, JoinColumn } from 'typeorm';
import { BaseEntity } from '@common/entities/base.entity';
import { SolutionTemplateCategory } from '@common/enums/index.enum';
import type { Relation } from 'typeorm';
import type { Tenant } from '../../tenants/entities/tenant.entity';
import type { User } from '../../users/entities/user.entity';
import type { TemplateConfiguration } from '../interfaces/template-configuration.interface';
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

  @ManyToOne('Tenant', { nullable: true })
  @JoinColumn({ name: 'tenantId' })
  tenant?: Relation<Tenant>;

  // ══════════════════════════════════════════════════════════════════════════
  // CREATOR (OPTIONAL - null for system templates)
  // ══════════════════════════════════════════════════════════════════════════

  @Column({ nullable: true })
  userId?: string;

  @ManyToOne('User', { nullable: true })
  @JoinColumn({ name: 'userId' })
  user?: Relation<User>;

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

  /** Running average of `ratings`, recomputed on every rate() call. */
  @Column({ type: 'decimal', precision: 3, scale: 2, default: 0 })
  rating: number;

  /** Per-user ratings keyed by userId, so a user can revise but not stuff the average. */
  @Column({ type: 'jsonb', default: {} })
  ratings: Record<string, number>;

  @Column({ type: 'int', default: 0 })
  ratingCount: number;

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

  /**
   * Declarative provisioning spec consumed by SolutionTemplatesService.install().
   * Previously an untyped `any[]` bag that nothing ever read.
   */
  @Column({ type: 'jsonb', nullable: true })
  configuration?: TemplateConfiguration;

  // ══════════════════════════════════════════════════════════════════════════
  // FLAGS
  // ══════════════════════════════════════════════════════════════════════════

  @Column({ default: false })
  isPremium: boolean;

  @Column({ default: true })
  isSystem: boolean; // true = system template, false = user-created

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
