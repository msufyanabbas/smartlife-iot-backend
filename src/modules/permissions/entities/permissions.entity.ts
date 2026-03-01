// src/modules/permissions/entities/permission.entity.ts
import { BaseEntity } from "@/common/entities/base.entity";
import { Role, User } from "@/modules/index.entities";
import { Column, Entity, Index, ManyToMany, Unique } from "typeorm";

@Entity('permissions')
@Unique(['resource', 'action']) // no duplicate resource:action pairs
export class Permission extends BaseEntity {
  // The resource this permission controls.
  // Must match a key in SubscriptionFeatures when the resource is feature-gated.
  // Examples: 'devices', 'dashboards', 'floor_plans', 'automations', 'assets'
  @Column()
  @Index()
  resource: string;
  
  // The action allowed on the resource.
  // Standard: 'create' | 'read' | 'update' | 'delete'
  // Extended: 'assign' | 'export' | 'configure' | 'manage'
  @Column()
  action: string;
  
  @Column({ type: 'text', nullable: true })
  description?: string;
  
  // System permissions are seeded at startup and cannot be deleted.
  // Tenant admins cannot modify isSystem=true permissions.
  @Column({ default: true })
  isSystem: boolean;
  
  // Inverse side of the Role <-> Permission many-to-many.
  // JoinTable is defined on Role side.
  @ManyToMany(() => Role, (role) => role.permissions)
  roles?: Role[];

  @ManyToMany(() => User, (user) => user.directPermissions)
  users?: User[];
  
  // The combined string used in @RequirePermissions() decorator.
  // e.g. 'devices:create', 'floor_plans:read', 'dashboards:manage'
  get permissionString(): string {
    return `${this.resource}:${this.action}`;
  }
}