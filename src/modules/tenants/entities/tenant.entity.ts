// src/modules/tenants/entities/tenant.entity.ts
import {
  Entity,
  Column,
  Index,
  OneToMany,
  OneToOne,
} from 'typeorm';
import type { Relation } from 'typeorm';
import { BaseEntity } from '@common/entities/base.entity';
import type { User } from '../../users/entities/user.entity';
import type { Customer } from '../../customers/entities/customers.entity';
import type { Subscription } from '../../subscriptions/entities/subscription.entity';
import { TenantStatus } from '@/common/enums/index.enum';

@Entity('tenants')
@Index(['email', 'status'])
export class Tenant extends BaseEntity {
  @Column({ unique: true })
  name: string;

  @Column({ unique: true })
  email: string;

  @Column({ nullable: true })
  phone?: string;

  @Column({ nullable: true })
  logo?: string;

  @Column({ nullable: true })
  website?: string;

  @Column({ nullable: true })
  country?: string;

  @Column({ nullable: true })
  state?: string;

  @Column({ nullable: true })
  city?: string;

  @Column({ nullable: true })
  address?: string;

  @Column({ nullable: true })
  zip?: string;

  @Column({ type: 'enum', enum: TenantStatus, default: TenantStatus.ACTIVE })
  status: TenantStatus;

  // ✅ Relations
  @OneToMany('User', 'tenant')
  users?: Relation<User>[];

  @OneToMany('Customer', 'tenant')
  customers?: Relation<Customer>[];

  @OneToOne('Subscription', 'tenant')
  subscription?: Relation<Subscription>;

  @Column({ type: 'jsonb', default: '{}' })
  configuration: {
    timezone?: string;
    language?: string;
    theme?: string;
  };

  // ✅ Helper methods
  isActive(): boolean {
    return this.status === TenantStatus.ACTIVE;
  }

  isSuspended(): boolean {
    return this.status === TenantStatus.SUSPENDED;
  }
}