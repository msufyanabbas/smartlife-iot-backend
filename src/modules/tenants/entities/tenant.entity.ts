// src/modules/tenants/entities/tenant.entity.ts
import {
  Entity,
  Column,
  Index,
  OneToMany,
  OneToOne,
} from 'typeorm';
import { BaseEntity } from '@common/entities/base.entity';
import { User, Customer, Subscription } from '@modules/index.entities';
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
  @OneToMany(() => User, user => user.tenant)
  users?: User[];

  @OneToMany(() => Customer, customer => customer.tenant)
  customers?: Customer[];  

  @OneToOne(() => Subscription, subscription => subscription.tenant)
  subscription?: Subscription;

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