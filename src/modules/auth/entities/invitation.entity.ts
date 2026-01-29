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
import { UserRole } from '@common/enums/index.enum';

export enum InvitationStatus {
  PENDING = 'pending',
  ACCEPTED = 'accepted',
  EXPIRED = 'expired',
  REVOKED = 'revoked',
}

@Entity('invitations')
@Index(['token'], { unique: true })
@Index(['email'])
@Index(['status'])
export class Invitation extends BaseEntity {
  @Column({ unique: true })
  token: string;

  @Column()
  email: string;

  @Column({
    type: 'enum',
    enum: UserRole,
  })
  role: UserRole;

  @Column()
  @Index()
  tenantId: string;

  @ManyToOne(() => Tenant, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'tenantId' })
  tenant: Tenant;

  @Column({ nullable: true })
  @Index()
  customerId?: string;

  @ManyToOne(() => Customer, { nullable: true, onDelete: 'CASCADE' })
  @JoinColumn({ name: 'customerId' })
  customer?: Customer;

  @Column({ nullable: true })
  invitedBy?: string;

  @ManyToOne(() => User, { nullable: true, onDelete: 'SET NULL' })
  @JoinColumn({ name: 'invitedBy' })
  inviter?: User;

  @Column({ nullable: true })
  inviteeName?: string;

  @Column({
    type: 'enum',
    enum: InvitationStatus,
    default: InvitationStatus.PENDING,
  })
  status: InvitationStatus;

  @Column({ type: 'timestamp' })
  expiresAt: Date;

  @Column({ type: 'timestamp', nullable: true })
  acceptedAt?: Date;

  // ✅ Auto-set expiration (7 days)
  @BeforeInsert()
  setExpiration() {
    if (!this.expiresAt) {
      const expiryDate = new Date();
      expiryDate.setDate(expiryDate.getDate() + 7);
      this.expiresAt = expiryDate;
    }
  }

  isExpired(): boolean {
    return new Date() > this.expiresAt;
  }

  isValid(): boolean {
    return this.status === InvitationStatus.PENDING && !this.isExpired();
  }

  canBeAcceptedBy(email: string): boolean {
    return this.isValid() && this.email.toLowerCase() === email.toLowerCase();
  }
}