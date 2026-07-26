// src/modules/roles/entities/role.entity.ts
import {
  Entity,
  Column,
  Index,
  ManyToOne,
  JoinColumn,
  ManyToMany,
  JoinTable,
  Unique,
} from 'typeorm';
import type { Relation } from 'typeorm';
import { BaseEntity } from '@common/entities/base.entity';
import type { Tenant } from '../../tenants/entities/tenant.entity';
import type { User } from '../../users/entities/user.entity';
import type { Permission } from '../../permissions/entities/permissions.entity';

@Entity('roles')
@Unique(['tenantId', 'name'])
@Index(['tenantId'])
@Index(['isSystem'])
export class Role extends BaseEntity {
  @Column()
  name: string;

  @Column({ type: 'text', nullable: true })
  description?: string;

  // ══════════════════════════════════════════════════════════════════════════
  // TENANT SCOPING (OPTIONAL - null for system roles)
  // ══════════════════════════════════════════════════════════════════════════

  @Column({ nullable: true })
  tenantId?: string;

  @ManyToOne('Tenant', { nullable: true, onDelete: 'CASCADE' })
  @JoinColumn({ name: 'tenantId' })
  tenant?: Relation<Tenant>;

  // ══════════════════════════════════════════════════════════════════════════
  // FLAGS
  // ══════════════════════════════════════════════════════════════════════════

  @Column({ default: false })
  isSystem: boolean;

  // ══════════════════════════════════════════════════════════════════════════
  // PERMISSIONS
  // ══════════════════════════════════════════════════════════════════════════

  @ManyToMany('Permission', 'roles', {
    eager: true,
  })
  @JoinTable({
    name: 'role_permissions',
    joinColumn: { name: 'roleId', referencedColumnName: 'id' },
    inverseJoinColumn: { name: 'permissionId', referencedColumnName: 'id' },
  })
  permissions?: Relation<Permission>[];

  // ══════════════════════════════════════════════════════════════════════════
  // INVERSE RELATIONSHIPS (NO @JoinTable!)
  // ══════════════════════════════════════════════════════════════════════════

  @ManyToMany('User', 'roles')
  users?: Relation<User>[];

  // ══════════════════════════════════════════════════════════════════════════
  // HELPER METHODS
  // ══════════════════════════════════════════════════════════════════════════

  isSystemRole(): boolean {
    return this.isSystem;
  }

  canBeModified(): boolean {
    return !this.isSystem;
  }

  canBeDeleted(): boolean {
    return !this.isSystem;
  }

  hasPermission(resource: string, action: string): boolean {
    return (
      this.permissions?.some(
        (p) => p.resource === resource && p.action === action,
      ) ?? false
    );
  }
}
