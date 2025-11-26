import { Entity, Column, Index } from 'typeorm';
import { BaseEntity } from '../../../common/entities/base.entity';

export enum TemplateCategory {
  SMART_FACTORY = 'smart_factory',
  SMART_HOME = 'smart_home',
  SMART_BUILDING = 'smart_building',
  SMART_CITY = 'smart_city',
  AGRICULTURE = 'agriculture',
  HEALTHCARE = 'healthcare',
  ENERGY = 'energy',
  LOGISTICS = 'logistics',
  RETAIL = 'retail',
  WATER = 'water',
  CLIMATE = 'climate',
  EDUCATION = 'education',
}

@Entity('solution_templates')
@Index(['category'])
@Index(['isPremium'])
@Index(['installs'])
export class SolutionTemplate extends BaseEntity {
  @Column()
  name: string;

  @Column({ type: 'text' })
  description: string;

  @Column({
    type: 'enum',
    enum: TemplateCategory,
  })
  category: TemplateCategory;

  @Column()
  icon: string;

  @Column({ type: 'decimal', precision: 3, scale: 2, default: 0 })
  rating: number;

  @Column({ default: 0 })
  installs: number;

  @Column({ default: '1.0.0' })
  version: string;

  @Column({
    name: 'last_updated',
    type: 'timestamp',
    default: () => 'CURRENT_TIMESTAMP',
  })
  lastUpdated: Date;

  @Column()
  author: string;

  @Column({ type: 'jsonb', default: '[]' })
  features: string[];

  @Column({ default: 0 })
  devices: number;

  @Column({ default: 0 })
  dashboards: number;

  @Column({ default: 0 })
  rules: number;

  @Column({ type: 'jsonb', default: '[]' })
  tags: string[];

  @Column({ name: 'is_premium', default: false })
  isPremium: boolean;

  @Column({ name: 'is_system', default: true })
  isSystem: boolean; // System templates vs user-created

  @Column({ type: 'jsonb', nullable: true })
  configuration: {
    devices?: any[];
    dashboards?: any[];
    rules?: any[];
    widgets?: any[];
  };

  @Column({ name: 'preview_image', nullable: true })
  previewImage?: string;

  @Column({ name: 'user_id', nullable: true })
  @Index()
  userId?: string;

  @Column({ name: 'tenant_id', nullable: true })
  @Index()
  tenantId?: string;
}
