// src/modules/auth/entities/invitation.entity.ts
import {
  Entity,
  Column,
  ManyToOne,
  JoinColumn,
  Index,
  BeforeInsert,
} from 'typeorm';
import { BaseEntity } from '@/common/entities/base.entity';
import { User, Customer, Tenant } from '@modules/index.entities';
import { UserRole, InvitationStatus } from '@common/enums/index.enum';
@Entity('invitations')
@Index(['email'])
@Index(['status'])
@Index(['tenantId', 'status']) // common query: "all pending invitations for this tenant"
export class Invitation extends BaseEntity {
  // ── Token ──────────────────────────────────────────────────────────────────
  // Unique token sent in the invitation email link.
  // @Column unique: true creates one index
  @Column({ unique: true })
  token: string;

  // ── Invitee info ───────────────────────────────────────────────────────────
  @Column()
  email: string;

  @Column({ nullable: true })
  inviteeName?: string;

  @Column({
    type: 'enum',
    enum: UserRole,
  })
  role: UserRole;

  // ── Tenant scope ───────────────────────────────────────────────────────────
  @Column()

  tenantId: string;

  @ManyToOne(() => Tenant, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'tenantId' })
  tenant: Tenant;

  // ── Customer scope (null for tenant-level invites) ─────────────────────────
  // Required when inviting a CUSTOMER_USER.
  @Column({ nullable: true })

  customerId?: string;

  @ManyToOne(() => Customer, { nullable: true, onDelete: 'CASCADE' })
  @JoinColumn({ name: 'customerId' })
  customer?: Customer;

  // ── Who sent the invite ────────────────────────────────────────────────────
  // FK column name follows [relation]Id convention
  @Column({ nullable: true })
  invitedById?: string;

  @ManyToOne(() => User, { nullable: true, onDelete: 'SET NULL' })
  @JoinColumn({ name: 'invitedById' })
  inviter?: User;

  // ── Status & lifecycle ─────────────────────────────────────────────────────
  @Column({ type: 'enum', enum: InvitationStatus, default: InvitationStatus.PENDING })
  status: InvitationStatus;

  @Column({ type: 'timestamp' })
  expiresAt: Date;

  @Column({ type: 'timestamp', nullable: true })
  acceptedAt?: Date;

  // ── Pre-configured permissions for the invitee ────────────────────────────
  // When a tenant admin sends an invitation, they can pre-configure:
  //   - Which roles the invitee will be assigned
  //   - Which resource permissions they'll get (for customer-scoped users)
  // These are applied by AuthService.acceptInvitation() when the user registers.
  @Column({ type: 'jsonb', nullable: true })
  metadata?: {
    roleIds?: string[];           // pre-assigned custom roles
    permissionIds?: string[];     // pre-assigned direct permissions
    message?: string;             // personal message from the inviter
    [key: string]: any;
  };

  // ── Hooks ──────────────────────────────────────────────────────────────────
  @BeforeInsert()
  setExpiration() {
    if (!this.expiresAt) {
      const date = new Date();
      date.setDate(date.getDate() + 7); // 7-day expiry
      this.expiresAt = date;
    }
  }

  // ── Helpers ────────────────────────────────────────────────────────────────
  isExpired(): boolean {
    return new Date() > this.expiresAt;
  }

  isValid(): boolean {
    return this.status === InvitationStatus.PENDING && !this.isExpired();
  }

  canBeAcceptedBy(email: string): boolean {
    // trim() prevents rejecting valid invites due to whitespace in stored email
    return (
      this.isValid() &&
      this.email.trim().toLowerCase() === email.trim().toLowerCase()
    );
  }
}