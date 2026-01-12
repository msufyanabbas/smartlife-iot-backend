// src/modules/customers/entities/customer.entity.ts
import { Entity, Column, Index, ManyToOne, JoinColumn, OneToMany } from 'typeorm';
import { BaseEntity } from '../../../common/entities/base.entity';
import { Tenant } from '../../tenants/entities/tenant.entity';
import { User } from '../../users/entities/user.entity';

export enum CustomerStatus {
  ACTIVE = 'active',
  INACTIVE = 'inactive',
  SUSPENDED = 'suspended',
}

@Entity('customers')
@Index(['tenantId'])
@Index(['status'])
@Index(['title'])
export class Customer extends BaseEntity {
  @Column()
  title: string;

  @Column({ nullable: true })
  country?: string;

  @Column({ nullable: true })
  state?: string;

  @Column({ nullable: true })
  city?: string;

  @Column({ nullable: true })
  address?: string;

  @Column({ nullable: true })
  address2?: string;

  @Column({ nullable: true })
  zip?: string;

  @Column({ nullable: true })
  phone?: string;

  @Column({ nullable: true })
  email?: string;

  @Column({
    type: 'enum',
    enum: CustomerStatus,
    default: CustomerStatus.ACTIVE,
  })
  status: CustomerStatus;

  // ✅ Fixed: Proper tenant relationship
  @Column()
  tenantId: string;

  @ManyToOne(() => Tenant, (tenant) => tenant.customers, {
    onDelete: 'CASCADE',
  })
  @JoinColumn({ name: 'tenantId' })
  tenant: Tenant;

  @Column({ type: 'text', nullable: true })
  description?: string;

  @Column({ type: 'jsonb', nullable: true })
  additionalInfo?: Record<string, any>;

  @Column({ default: false })
  isPublic: boolean;

  // ✅ Added: Users relationship
  @OneToMany(() => User, (user) => user.customer)
  users?: User[];

  // Method to check if customer is active
  isActive(): boolean {
    return this.status === CustomerStatus.ACTIVE;
  }

  // Method to get full address
  getFullAddress(): string {
    const parts = [
      this.address,
      this.address2,
      this.city,
      this.state,
      this.zip,
      this.country,
    ].filter(Boolean);
    return parts.length > 0 ? parts.join(', ') : 'No address provided';
  }

  // ✅ NEW: Convenience method
  belongsToTenant(tenantId: string): boolean {
    return this.tenantId === tenantId;
  }
}