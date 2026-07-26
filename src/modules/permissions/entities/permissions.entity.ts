// src/modules/permissions/entities/permission.entity.ts
import { Entity, Column, Index, ManyToMany, ManyToOne, JoinColumn, Unique } from 'typeorm';
import type { Relation } from 'typeorm';
import { BaseEntity } from '@common/entities/base.entity';
import type { Role } from '../../roles/entities/roles.entity';
import type { User } from '../../users/entities/user.entity';
import type { Tenant } from '../../tenants/entities/tenant.entity';

@Entity('permissions')
@Unique(['tenantId', 'resource', 'action']) // Unique per tenant (null for system)
@Index(['resource'])
@Index(['action'])
@Index(['isSystem'])
@Index(['tenantId'])
export class Permission extends BaseEntity {
  // ══════════════════════════════════════════════════════════════════════════
  // TENANT SCOPING (OPTIONAL - null for system permissions)
  // ══════════════════════════════════════════════════════════════════════════

  /**
   * Tenant ID for custom permissions. Null for system permissions.
   * - null = System permission (available to all tenants)
   * - non-null = Custom permission (only for this tenant)
   */
  @Column({ nullable: true })

  tenantId?: string | null;

  @ManyToOne('Tenant', { nullable: true, onDelete: 'CASCADE' })
  @JoinColumn({ name: 'tenantId' })
  tenant?: Relation<Tenant>;

  // ══════════════════════════════════════════════════════════════════════════
  // PERMISSION DEFINITION
  // ══════════════════════════════════════════════════════════════════════════

  /**
   * The resource this permission controls.
   * Must match a key in SubscriptionFeatures when the resource is feature-gated.
   * Examples: 'devices', 'dashboards', 'floor_plans', 'automations', 'assets'
   */
  @Column()

  resource: string;

  /**
   * The action allowed on the resource.
   * Standard CRUD: 'create' | 'read' | 'update' | 'delete' | 'list'
   * Extended: 'assign' | 'export' | 'configure' | 'manage' | 'control' | 'share' | 'acknowledge'
   */
  @Column()

  action: string;

  @Column({ type: 'text', nullable: true })
  description?: string;

  // ══════════════════════════════════════════════════════════════════════════
  // SYSTEM FLAG
  // ══════════════════════════════════════════════════════════════════════════

  /**
   * System permissions are seeded at startup and cannot be deleted.
   * System permissions have tenantId = null and are available to all tenants.
   * Custom permissions have isSystem = false and tenantId set.
   */
  @Column({ default: true })

  isSystem: boolean;

  // ══════════════════════════════════════════════════════════════════════════
  // RELATIONSHIPS
  // ══════════════════════════════════════════════════════════════════════════

  /**
   * Inverse side of the Role <-> Permission many-to-many.
   * JoinTable is defined on Role side.
   */
  @ManyToMany('Role', 'permissions')
  roles?: Relation<Role>[];

  /**
   * Inverse side of the User <-> Permission many-to-many (direct permissions).
   * JoinTable is defined on User side.
   */
  @ManyToMany('User', 'directPermissions')
  users?: Relation<User>[];

  // ══════════════════════════════════════════════════════════════════════════
  // HELPER METHODS
  // ══════════════════════════════════════════════════════════════════════════

  /**
   * Get the combined permission string used in @RequirePermissions() decorator.
   * e.g., 'devices:create', 'floor_plans:read', 'dashboards:manage'
   */
  get permissionString(): string {
    return `${this.resource}:${this.action}`;
  }

  /**
   * Check if this is a system permission
   */
  isSystemPermission(): boolean {
    return this.isSystem;
  }

  /**
   * Check if this is a custom tenant permission
   */
  isCustomPermission(): boolean {
    return !this.isSystem && !!this.tenantId;
  }

  /**
   * Check if this permission can be modified
   */
  canBeModified(): boolean {
    return !this.isSystem;
  }

  /**
   * Check if this permission can be deleted
   */
  canBeDeleted(): boolean {
    return !this.isSystem;
  }

  /**
   * Check if this is a CRUD action
   */
  isCrudAction(): boolean {
    return ['create', 'read', 'update', 'delete', 'list'].includes(this.action);
  }

  /**
   * Get a human-readable label
   */
  getLabel(): string {
    const resourceLabel = this.resource.replace(/-/g, ' ').replace(/_/g, ' ');
    const actionLabel = this.action.replace(/-/g, ' ').replace(/_/g, ' ');
    return `${actionLabel} ${resourceLabel}`.toLowerCase();
  }

  /**
   * Check if this permission is available to a specific tenant
   */
  isAvailableToTenant(tenantId: string): boolean {
    // System permissions are available to all tenants
    if (this.isSystem) return true;

    // Custom permissions only available to their tenant
    return this.tenantId === tenantId;
  }
}