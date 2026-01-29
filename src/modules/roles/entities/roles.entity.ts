import { BaseEntity } from "@/common/entities/base.entity";
import { Tenant, User } from "@/modules/index.entities";
import { Permission } from "@/modules/permissions/entities/permissions.entity";
import { Column, Entity, Index, JoinColumn, JoinTable, ManyToMany, ManyToOne } from "typeorm";

@Entity('roles')
export class Role extends BaseEntity {
  @Column()
  name: string;
  
  @Column({ type: 'text', nullable: true })
  description?: string;
  
  // ✅ Null = system role, otherwise tenant-specific
  @Column({ nullable: true })
  @Index()
  tenantId?: string;
  
  @ManyToOne(() => Tenant, { nullable: true, onDelete: 'CASCADE' })
  @JoinColumn({ name: 'tenantId' })
  tenant?: Tenant;
  
  @Column({ default: false })
  isSystem: boolean; // Built-in roles like 'Device Manager', 'Dashboard Viewer'
  
  @ManyToMany(() => Permission, permission => permission.roles)
  @JoinTable({ name: 'role_permissions' })
  permissions?: Permission[];
  
  @ManyToMany(() => User, user => user.roles)
  users?: User[];
}