import { Entity, Column, Index, OneToMany } from 'typeorm';
import { BaseEntity } from '../../../common/entities/base.entity';

export enum CustomerStatus {
  ACTIVE = 'active',
  INACTIVE = 'inactive',
  SUSPENDED = 'suspended',
}

@Entity('customers')
export class Customer extends BaseEntity {
  @Column()
  @Index()
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

  @Column()
  @Index()
  tenantId: string;

  @Column({ type: 'text', nullable: true })
  description?: string;

  @Column({ type: 'jsonb', nullable: true })
  additionalInfo?: Record<string, any>;

  @Column({ default: false })
  isPublic: boolean;

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
    return parts.join(', ');
  }
}