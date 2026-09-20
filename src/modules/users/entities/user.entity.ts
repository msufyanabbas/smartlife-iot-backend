// src/modules/users/entities/user.entity.ts
import { getBcryptRounds } from '@common/utils/password.util';
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
import type { Relation } from 'typeorm';
import { Exclude } from 'class-transformer';
import * as bcrypt from 'bcrypt';
import { BaseEntity } from '@common/entities/base.entity';
import type { Tenant } from '../../tenants/entities/tenant.entity';
import type { Customer } from '../../customers/entities/customers.entity';
import type { Role } from '../../roles/entities/roles.entity';
import type { Permission } from '../../permissions/entities/permissions.entity';
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

  @ManyToOne('Tenant', 'users', {
    nullable: true,
    onDelete: 'CASCADE',
  })
  @JoinColumn({ name: 'tenantId' })
  tenant?: Relation<Tenant>;

  // ══════════════════════════════════════════════════════════════════════════
  // CUSTOMER SCOPE
  // ══════════════════════════════════════════════════════════════════════════

  @Column({ nullable: true })

  customerId?: string;

  @ManyToOne('Customer', 'users', {
    nullable: true,
    onDelete: 'SET NULL',
  })
  @JoinColumn({ name: 'customerId' })
  customer?: Relation<Customer>;

  // ══════════════════════════════════════════════════════════════════════════
  // ROLE-BASED PERMISSIONS (ManyToMany with auto junction table)
  // ══════════════════════════════════════════════════════════════════════════

  @ManyToMany('Role', 'users', { eager: true })  // ← Add eager loading
  @JoinTable({
    name: 'user_roles',
    joinColumn: { name: 'userId', referencedColumnName: 'id' },
    inverseJoinColumn: { name: 'roleId', referencedColumnName: 'id' },
  })
  roles?: Relation<Role>[];

  // ══════════════════════════════════════════════════════════════════════════
  // DIRECT PERMISSIONS
  // ══════════════════════════════════════════════════════════════════════════

  @ManyToMany('Permission', 'users', { eager: true })
  @JoinTable({
    name: 'user_permissions',
    joinColumn: { name: 'userId', referencedColumnName: 'id' },
    inverseJoinColumn: { name: 'permissionId', referencedColumnName: 'id' },
  })
  directPermissions?: Relation<Permission>[];

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

  @Column({ nullable: true })
  @Exclude()
  setPasswordToken?: string;         // one-time token sent in the invitation email

  @Column({ type: 'timestamp', nullable: true })
  setPasswordExpires?: Date;         // 7-day window (generous, since this is first login)

  @Column({ type: 'jsonb', nullable: true })
  preferences?: Record<string, any>;

  // ══════════════════════════════════════════════════════════════════════════
  // HOOKS
  // ══════════════════════════════════════════════════════════════════════════

  @BeforeInsert()
  @BeforeUpdate()
  async hashPassword() {
    // The `$2b$` guard also has to cover `$2a$` and `$2y$`: hashes produced by
    // other bcrypt implementations use those prefixes, and an imported user
    // whose hash starts with `$2a$` would have been re-hashed here — hashing the
    // hash, and permanently locking that account out.
    if (this.password && !/^\$2[aby]\$/.test(this.password)) {
      const salt = await bcrypt.genSalt(getBcryptRounds());
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
    return this.role === UserRole.CUSTOMER;
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