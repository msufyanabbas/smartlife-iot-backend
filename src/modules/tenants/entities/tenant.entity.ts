// src/modules/tenants/entities/tenant.entity.ts
import {
  Entity,
  Column,
  Index,
  OneToMany,
  ManyToOne,
  JoinColumn,
} from 'typeorm';
import { BaseEntity } from '../../../common/entities/base.entity';
import { User } from '../../users/entities/user.entity';
import { Customer } from '../../customers/entities/customers.entity';

export enum TenantStatus {
  ACTIVE = 'active',
  INACTIVE = 'inactive',
  SUSPENDED = 'suspended',
}

@Entity('tenants')
@Index(['status'])
@Index(['email'])
@Index(['name'])
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
    maxCustomers?: number;
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

  // ✅ Relations - Fixed mapping
  @OneToMany(() => User, (user) => user.tenant)
  users?: User[];

  @OneToMany(() => Customer, (customer) => customer.tenant)
  customers?: Customer[];

  @ManyToOne(() => User, { nullable: true })
  @JoinColumn({ name: 'tenant_admin_id' })
  tenantAdmin?: User;

  // ✅ Helper methods
  isActive(): boolean {
    return this.status === TenantStatus.ACTIVE;
  }

  getFullAddress(): string {
    const parts = [this.address, this.address2, this.city, this.state, this.zip]
      .filter(Boolean)
      .join(', ');
    return parts || 'No address provided';
  }

  // ✅ Check if tenant has reached limits
  hasReachedDeviceLimit(currentCount: number): boolean {
    return (
      this.configuration?.maxDevices !== undefined &&
      currentCount >= this.configuration.maxDevices
    );
  }

  hasReachedUserLimit(currentCount: number): boolean {
    return (
      this.configuration?.maxUsers !== undefined &&
      currentCount >= this.configuration.maxUsers
    );
  }

  hasReachedCustomerLimit(currentCount: number): boolean {
    // Assuming you might want this
    return (
      this.configuration?.maxCustomers !== undefined &&
      currentCount >= this.configuration.maxCustomers
    );
  }
}