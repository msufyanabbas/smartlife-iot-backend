// src/modules/users/entities/user.entity.ts
import {
  Entity,
  Column,
  Index,
  BeforeInsert,
  BeforeUpdate,
  ManyToOne,
  JoinColumn,
} from 'typeorm';
import { Exclude } from 'class-transformer';
import * as bcrypt from 'bcrypt';
import { BaseEntity } from '../../../common/entities/base.entity';
import { Tenant } from '../../tenants/entities/tenant.entity';
import { Customer } from '../../customers/entities/customers.entity'; // ✅ Fixed import path

export enum UserRole {
  SUPER_ADMIN = 'super_admin',
  TENANT_ADMIN = 'tenant_admin',
  CUSTOMER_ADMIN = 'customer_admin',
  CUSTOMER_USER = 'customer_user',
  USER = 'user',
}

export enum UserStatus {
  ACTIVE = 'active',
  INACTIVE = 'inactive',
  SUSPENDED = 'suspended',
}

@Entity('users')
@Index(['role'])
@Index(['status'])
export class User extends BaseEntity {
  @Column({ unique: true })
  @Index()
  email: string;

  @Column()
  @Exclude() // Exclude password from response
  password: string;

  @Column()
  name: string;

  @Column({ nullable: true, unique: true })
  phone?: string;

  @Column({
    type: 'enum',
    enum: UserRole,
    default: UserRole.TENANT_ADMIN,
  })
  role: UserRole;

  @Column({
    type: 'enum',
    enum: UserStatus,
    default: UserStatus.ACTIVE,
  })
  status: UserStatus;

  // ✅ Tenant relationship
  @Column({ nullable: true })
  @Index()
  tenantId?: string | any;

  @ManyToOne(() => Tenant, (tenant) => tenant.users, {
    nullable: true,
    onDelete: 'CASCADE',
  })
  @JoinColumn({ name: 'tenantId' })
  tenant?: Tenant;

  // ✅ Customer relationship
  @Column({ nullable: true })
  @Index()
  customerId?: string;

  @ManyToOne(() => Customer, (customer) => customer.users, {
    nullable: true,
    onDelete: 'CASCADE',
  })
  @JoinColumn({ name: 'customerId' })
  customer?: Customer;

  @Column({ nullable: true })
  avatar?: string;

  @Column({ type: 'timestamp', nullable: true })
  lastLoginAt?: Date;

  @Column({ default: false })
  emailVerified: boolean;

  @Column({ nullable: true })
  emailVerificationToken?: string;

  @Column({ nullable: true })
  passwordResetToken?: string;

  @Column({ type: 'timestamp', nullable: true })
  passwordResetExpires?: Date;

  @Column({ type: 'jsonb', nullable: true })
  preferences?: Record<string, any>;

  // Hash password before insert
  @BeforeInsert()
  @BeforeUpdate()
  async hashPassword() {
    if (this.password && !this.password.startsWith('$2b$')) {
      const salt = await bcrypt.genSalt(10);
      this.password = await bcrypt.hash(this.password, salt);
    }
  }

  // Method to compare passwords
  async comparePassword(attemptedPassword: string): Promise<boolean> {
    return await bcrypt.compare(attemptedPassword, this.password);
  }

  // Method to check if user is active
  isActive(): boolean {
    return this.status === UserStatus.ACTIVE;
  }

  // Method to check if user has role
  hasRole(role: UserRole): boolean {
    return this.role === role;
  }

  // Check if user is a customer user
  isCustomerUser(): boolean {
    return (
      this.role === UserRole.CUSTOMER_USER ||
      this.role === UserRole.CUSTOMER_ADMIN
    );
  }

  // Check if user is admin (tenant or super)
  isAdmin(): boolean {
    return (
      this.role === UserRole.SUPER_ADMIN ||
      this.role === UserRole.TENANT_ADMIN
    );
  }

  // ✅ Check if user can manage tenant
  canManageTenant(): boolean {
    return (
      this.role === UserRole.SUPER_ADMIN ||
      this.role === UserRole.TENANT_ADMIN
    );
  }

  // ✅ Check if user can manage customers
  canManageCustomers(): boolean {
    return (
      this.role === UserRole.SUPER_ADMIN ||
      this.role === UserRole.TENANT_ADMIN
    );
  }

  // ✅ Check access to specific tenant
  hasAccessToTenant(tenantId: string): boolean {
    if (this.role === UserRole.SUPER_ADMIN) return true;
    return this.tenantId === tenantId;
  }

  // ✅ Check access to specific customer
  hasAccessToCustomer(customerId: string): boolean {
    if (this.role === UserRole.SUPER_ADMIN) return true;
    if (this.role === UserRole.TENANT_ADMIN && this.tenantId) {
      // Tenant admin can access all customers in their tenant
      // Need to verify customer belongs to tenant (done in service layer)
      return true;
    }
    return this.customerId === customerId;
  }

  // Method to update last login
  updateLastLogin() {
    this.lastLoginAt = new Date();
  }

  // ✅ NEW: Check if user belongs to tenant
  belongsToTenant(tenantId: string): boolean {
    return this.tenantId === tenantId;
  }

  // ✅ NEW: Check if user belongs to customer
  belongsToCustomer(customerId: string): boolean {
    return this.customerId === customerId;
  }
}