import { BaseEntity } from "@/common/entities/base.entity";
import { Role } from "@/modules/index.entities";
import { Permission } from "@/modules/permissions/entities/permissions.entity";
import { Column, Index, JoinColumn, ManyToOne } from "typeorm";

export class RolePermission extends BaseEntity {
    @Column({ nullable: true })
    @Index()
    roleId?: string;

    @ManyToOne(() => Role, (role) => role.hasId, {
    nullable: true,
    onDelete: 'CASCADE',
    })
    @JoinColumn({ name: 'roleId' })
    role?: Role;

    @Column({ nullable: true })
    @Index()
    permissionId?: string;

    @ManyToOne(() => Permission, (permission) => permission.hasId, {
    nullable: true,
    onDelete: 'CASCADE',
    })
    @JoinColumn({ name: 'permissionId' })
    permission?: Permission;
}