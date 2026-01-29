import { BaseEntity } from "@/common/entities/base.entity";
import { Role } from "@/modules/roles/entities/roles.entity";
import { Column, Entity, Index, ManyToMany } from "typeorm";

@Entity('permissions')
export class Permission extends BaseEntity {
  @Column()
  resource: string; // e.g., 'devices', 'customers', 'dashboards'
  
  @Column()
  action: string; // e.g., 'create', 'read', 'update', 'delete'
  
  @Column({ type: 'text', nullable: true })
  description?: string;
  
  @Column({ default: true })
  isSystem: boolean;
  
  @ManyToMany(() => Role, role => role.permissions)
  roles?: Role[];
  
  // ✅ Composite unique constraint
  // @Index(['resource', 'action'], { unique: true })
  
  // Helper to get permission string
  get permissionString(): string {
    return `${this.resource}:${this.action}`;
  }
}