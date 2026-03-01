// src/modules/users/entities/user.entity.ts
import {
  Entity,
  Column,
  Index,
  BeforeInsert,
  BeforeUpdate,
  ManyToOne,
  JoinColumn,
  ManyToMany,
  JoinTable,
} from 'typeorm';
import { Exclude } from 'class-transformer';
import * as bcrypt from 'bcrypt';
import { BaseEntity } from '@common/entities/base.entity';
import { Tenant, Customer, Role, Permission } from '@modules/index.entities';
import { UserRole, UserStatus } from '@common/enums/index.enum';

@Entity('users')
@Index(['role'])
@Index(['status'])
@Index(['tenantId'])
@Index(['customerId'])
export class User extends BaseEntity {
  @Column({ unique: true })

  email: string;

  @Column()
  @Exclude()
  password: string;

  @Column()
  name: string;

  @Column({ nullable: true, unique: true })
  phone?: string;

  // ══════════════════════════════════════════════════════════════════════════
  // ROLE & STATUS
  // ══════════════════════════════════════════════════════════════════════════

  @Column({ type: 'enum', enum: UserRole, default: UserRole.CUSTOMER_USER })

  role: UserRole;

  @Column({ type: 'enum', enum: UserStatus, default: UserStatus.ACTIVE })

  status: UserStatus;

  // ══════════════════════════════════════════════════════════════════════════
  // TENANT SCOPE
  // ══════════════════════════════════════════════════════════════════════════

  @Column({ nullable: true })

  tenantId?: string;

  @ManyToOne(() => Tenant, (tenant) => tenant.users, {
    nullable: true,
    onDelete: 'CASCADE',
  })
  @JoinColumn({ name: 'tenantId' })
  tenant?: Tenant;

  // ══════════════════════════════════════════════════════════════════════════
  // CUSTOMER SCOPE
  // ══════════════════════════════════════════════════════════════════════════

  @Column({ nullable: true })

  customerId?: string;

  @ManyToOne(() => Customer, (customer) => customer.users, {
    nullable: true,
    onDelete: 'SET NULL',
  })
  @JoinColumn({ name: 'customerId' })
  customer?: Customer;

  // ══════════════════════════════════════════════════════════════════════════
  // ROLE-BASED PERMISSIONS (ManyToMany with auto junction table)
  // ══════════════════════════════════════════════════════════════════════════

  @ManyToMany(() => Role, (role) => role.users, { eager: true })  // ← Add eager loading
  @JoinTable({
    name: 'user_roles',
    joinColumn: { name: 'userId', referencedColumnName: 'id' },
    inverseJoinColumn: { name: 'roleId', referencedColumnName: 'id' },
  })
  roles?: Role[];

  // ══════════════════════════════════════════════════════════════════════════
  // DIRECT PERMISSIONS
  // ══════════════════════════════════════════════════════════════════════════

  @ManyToMany(() => Permission, (permission) => permission.users, { eager: true })
  @JoinTable({
    name: 'user_permissions',
    joinColumn: { name: 'userId', referencedColumnName: 'id' },
    inverseJoinColumn: { name: 'permissionId', referencedColumnName: 'id' },
  })
  directPermissions?: Permission[];

  // ══════════════════════════════════════════════════════════════════════════
  // AUTH FIELDS
  // ══════════════════════════════════════════════════════════════════════════

  @Column({ type: 'timestamp', nullable: true })
  lastLoginAt?: Date;

  @Column({ default: false })
  emailVerified: boolean;

  @Column({ nullable: true })
  @Exclude()
  emailVerificationToken?: string;

  @Column({ nullable: true })
  @Exclude()
  passwordResetToken?: string;

  @Column({ type: 'timestamp', nullable: true })
  passwordResetExpires?: Date;

  @Column({ type: 'jsonb', nullable: true })
  preferences?: Record<string, any>;

  // ══════════════════════════════════════════════════════════════════════════
  // HOOKS
  // ══════════════════════════════════════════════════════════════════════════

  @BeforeInsert()
  @BeforeUpdate()
  async hashPassword() {
    if (this.password && !this.password.startsWith('$2b$')) {
      const salt = await bcrypt.genSalt(10);
      this.password = await bcrypt.hash(this.password, salt);
    }
  }

  // ══════════════════════════════════════════════════════════════════════════
  // HELPER METHODS
  // ══════════════════════════════════════════════════════════════════════════

  async comparePassword(attemptedPassword: string): Promise<boolean> {
    return bcrypt.compare(attemptedPassword, this.password);
  }

  isActive(): boolean {
    return this.status === UserStatus.ACTIVE;
  }

  isSuperAdmin(): boolean {
    return this.role === UserRole.SUPER_ADMIN;
  }

  isTenantAdmin(): boolean {
    return this.role === UserRole.TENANT_ADMIN;
  }

  isCustomerAdmin(): boolean {
    return this.role === UserRole.CUSTOMER_ADMIN;
  }

  isCustomerUser(): boolean {
    return this.role === UserRole.CUSTOMER_USER;
  }

  isCustomerScoped(): boolean {
    return !!this.customerId;
  }

  hasAccessToTenant(tenantId: string): boolean {
    if (this.isSuperAdmin()) return true;
    return this.tenantId === tenantId;
  }

  hasAccessToCustomer(customerId: string): boolean {
    if (this.isSuperAdmin()) return true;
    if (this.isTenantAdmin()) return true;
    return this.customerId === customerId;
  }

  updateLastLogin(): void {
    this.lastLoginAt = new Date();
  }

  belongsToTenant(tenantId: string): boolean {
    return this.tenantId === tenantId;
  }

  belongsToCustomer(customerId: string): boolean {
    return this.customerId === customerId;
  }

  /**
   * Get all effective permissions for this user
   * Combines role permissions + direct permissions
   */
  getEffectivePermissions(): Permission[] {
    const rolePermissions = this.roles?.flatMap(r => r.permissions || []) || [];
    const directPermissions = this.directPermissions || [];

    // Combine and deduplicate by permission ID
    const allPermissions = [...rolePermissions, ...directPermissions];
    const uniquePermissions = Array.from(
      new Map(allPermissions.map(p => [p.id, p])).values()
    );

    return uniquePermissions;
  }

  /**
   * Check if user has a specific permission
   */
  hasPermission(resource: string, action: string): boolean {
    const permissions = this.getEffectivePermissions();
    return permissions.some(p =>
      p.resource === resource && p.action === action
    );
  }
}