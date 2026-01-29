import { BaseEntity } from "@/common/entities/base.entity";
import { Role, User } from "@/modules/index.entities";
import { Column, Index, JoinColumn, ManyToOne } from "typeorm";

export class UserRole extends BaseEntity {
    @Column({ nullable: true })
    @Index()
    userId?: string;

    @ManyToOne(() => User, (user) => user.hasId, {
    nullable: true,
    onDelete: 'CASCADE',
    })
    @JoinColumn({ name: 'userId' })
    user?: User;

    @Column({ nullable: true })
    @Index()
    roleId?: string;

    @ManyToOne(() => Role, (role) => role.hasId, {
    nullable: true,
    onDelete: 'CASCADE',
    })
    @JoinColumn({ name: 'roleId' })
    role?: Role;
}