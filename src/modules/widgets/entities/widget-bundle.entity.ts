// src/modules/widgets/entities/widget-bundle.entity.ts
import { Entity, Column, Index, OneToMany, ManyToOne, JoinColumn } from 'typeorm';
import { BaseEntity } from '@common/entities/base.entity';
import { Tenant } from '@modules/index.entities';
@Entity('widget_bundles')
@Index(['tenantId', 'title'])
export class WidgetBundle extends BaseEntity {
  // ══════════════════════════════════════════════════════════════════════════
  // TENANT SCOPING (OPTIONAL - null for system bundles)
  // ══════════════════════════════════════════════════════════════════════════

  @Column({ nullable: true })
  tenantId?: string;  // null = system bundle

  @ManyToOne(() => Tenant, { nullable: true })
  @JoinColumn({ name: 'tenantId' })
  tenant?: Tenant;

  // ══════════════════════════════════════════════════════════════════════════
  // BASIC INFO
  // ══════════════════════════════════════════════════════════════════════════

  @Column({ unique: true })
  title: string;  // "Charts", "Gauges", "Controls"

  @Column({ type: 'text', nullable: true })
  description?: string;  // "Chart widgets for data visualization"

  @Column({ nullable: true })
  image?: string;  // Bundle preview image

  @Column({ type: 'int', default: 0 })
  order: number;  // Display order in UI

  @Column({ default: false })
  system: boolean;  // System bundles can't be deleted

  @Column({ type: 'jsonb', nullable: true })
  additionalInfo?: Record<string, any>;
}
