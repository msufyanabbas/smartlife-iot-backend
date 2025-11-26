import { Entity, Column, Index, OneToMany } from 'typeorm';
import { BaseEntity } from '../../../common/entities/base.entity';

@Entity('widget_bundles')
export class WidgetBundle extends BaseEntity {
  @Column({ unique: true })
  @Index()
  title: string;

  @Column({ nullable: true })
  description?: string;

  @Column({ nullable: true })
  @Index()
  tenantId?: string;

  // Image/icon
  @Column({ nullable: true })
  image?: string;

  // Order for sorting
  @Column({ default: 0 })
  order: number;

  // System bundle (can't be deleted)
  @Column({ default: false })
  system: boolean;

  // Additional info
  @Column({ type: 'jsonb', nullable: true })
  additionalInfo?: Record<string, any>;
}
