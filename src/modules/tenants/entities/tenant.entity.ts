// src/modules/tenants/entities/tenant.entity.ts
import {
  Entity,
  Column,
  Index,
  OneToMany,
  ManyToOne,
  JoinColumn,
  OneToOne,
} from 'typeorm';
import { BaseEntity } from '../../../common/entities/base.entity';
import { User } from '../../users/entities/user.entity';
import { Customer } from '../../customers/entities/customers.entity';
import { Subscription } from '@/modules/index.entities';

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

  @Column({ unique: true })
  email: string;

  @Column({ nullable: true })
  phone?: string;

  @Column({
    type: 'enum',
    enum: TenantStatus,
    default: TenantStatus.ACTIVE,
  })
  status: TenantStatus;

  // ✅ Relations
  @OneToMany(() => User, user => user.tenant)
  users?: User[];

  @OneToMany(() => Customer, customer => customer.tenant)
  customers?: Customer[];  

  @OneToOne(() => Subscription, subscription => subscription.tenant)
  subscription?: Subscription;

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

  // ✅ Helper methods
  isActive(): boolean {
    return this.status === TenantStatus.ACTIVE;
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