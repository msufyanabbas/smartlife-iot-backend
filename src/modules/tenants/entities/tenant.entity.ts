import { Entity, Column, Index } from 'typeorm';
import { BaseEntity } from '../../../common/entities/base.entity';

export enum TenantStatus {
  ACTIVE = 'active',
  INACTIVE = 'inactive',
  SUSPENDED = 'suspended',
}

@Entity('tenants')
@Index(['status'])
export class Tenant extends BaseEntity {
  @Column({ unique: true })
  name: string;

  @Column({ nullable: true })
  title?: string;

  @Column({ type: 'text', nullable: true })
  description?: string;

  @Column({ unique: true })
  email: string;

  @Column({ nullable: true })
  phone?: string;

  @Column({ nullable: true })
  country?: string;

  @Column({ nullable: true })
  state?: string;

  @Column({ nullable: true })
  city?: string;

  @Column({ nullable: true })
  address?: string;

  @Column({ nullable: true, name: 'address2' })
  address2?: string;

  @Column({ nullable: true })
  zip?: string;

  @Column({
    type: 'enum',
    enum: TenantStatus,
    default: TenantStatus.ACTIVE,
  })
  status: TenantStatus;

  @Column({ type: 'jsonb', nullable: true })
  additionalInfo?: {
    logo?: string;
    website?: string;
    industry?: string;
    employeeCount?: number;
  };

  @Column({ type: 'jsonb', default: '{}' })
  configuration: {
    maxDevices?: number;
    maxUsers?: number;
    maxAssets?: number;
    maxDashboards?: number;
    maxRuleChains?: number;
    dataRetentionDays?: number;
    features?: string[];
  };

  @Column({ name: 'isolation_mode', default: 'full' })
  isolationMode: string; // 'full', 'shared'

  @Column({ name: 'tenant_admin_id', nullable: true })
  tenantAdminId?: string;
}
