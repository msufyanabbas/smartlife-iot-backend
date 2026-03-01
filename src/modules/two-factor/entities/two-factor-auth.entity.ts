// src/modules/auth/entities/two-factor-auth.entity.ts
import {
  Entity,
  Column,
  Index,
  OneToOne,
  JoinColumn,
  ManyToOne,
} from 'typeorm';
import { BaseEntity } from '@common/entities/base.entity';
import { User, Tenant } from '@modules/index.entities';
import { TwoFactorMethod } from '@/common/enums/index.enum';

@Entity('two_factor_auth')
@Index(['userId'])
@Index(['tenantId'])
export class TwoFactorAuth extends BaseEntity {
  // ══════════════════════════════════════════════════════════════════════════
  // TENANT SCOPING (REQUIRED)
  // ══════════════════════════════════════════════════════════════════════════
  
  @Column()
  @Index()
  tenantId: string;

  @ManyToOne(() => Tenant)
  @JoinColumn({ name: 'tenantId' })
  tenant: Tenant;

  // ══════════════════════════════════════════════════════════════════════════
  // USER RELATIONSHIP
  // ══════════════════════════════════════════════════════════════════════════
  
  @Column({ unique: true })
  @Index()
  userId: string;

  @OneToOne(() => User, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'userId' })
  user: User;

  // ══════════════════════════════════════════════════════════════════════════
  // 2FA SETTINGS
  // ══════════════════════════════════════════════════════════════════════════
  
  @Column({ default: false })
  isEnabled: boolean;

  @Column({
    type: 'enum',
    enum: TwoFactorMethod,
    nullable: true,
  })
  method?: TwoFactorMethod;

  // ══════════════════════════════════════════════════════════════════════════
  // AUTHENTICATOR (TOTP)
  // ══════════════════════════════════════════════════════════════════════════
  
  @Column({ nullable: true, select: false })
  secret?: string;  // Base32 encoded secret for TOTP (sensitive)

  @Column({ type: 'text', nullable: true, select: false })
  backupCodes?: string;  // JSON array of hashed backup codes

  // ══════════════════════════════════════════════════════════════════════════
  // SMS
  // ══════════════════════════════════════════════════════════════════════════
  
  @Column({ nullable: true })
  phoneNumber?: string;

  @Column({ default: false })
  phoneVerified: boolean;

  // ══════════════════════════════════════════════════════════════════════════
  // TEMPORARY VERIFICATION CODES (SMS/Email)
  // ══════════════════════════════════════════════════════════════════════════
  
  @Column({ nullable: true, select: false })
  tempCode?: string;

  @Column({ type: 'timestamp', nullable: true })
  tempCodeExpiry?: Date;

  @Column({ default: 0 })
  tempCodeAttempts: number;

  // ══════════════════════════════════════════════════════════════════════════
  // TRACKING
  // ══════════════════════════════════════════════════════════════════════════
  
  @Column({ type: 'timestamp', nullable: true })
  lastVerifiedAt?: Date;

  @Column({ type: 'timestamp', nullable: true })
  enabledAt?: Date;

  // ══════════════════════════════════════════════════════════════════════════
  // HELPER METHODS
  // ══════════════════════════════════════════════════════════════════════════

  isTempCodeValid(): boolean {
    if (!this.tempCode || !this.tempCodeExpiry) return false;
    return new Date() < this.tempCodeExpiry;
  }

  incrementAttempts(): void {
    this.tempCodeAttempts += 1;
  }

  resetAttempts(): void {
    this.tempCodeAttempts = 0;
    this.tempCode = undefined;
    this.tempCodeExpiry = undefined;
  }

  isLocked(): boolean {
    return this.tempCodeAttempts >= 5;
  }

  canRetry(): boolean {
    return !this.isLocked() && this.isTempCodeValid();
  }
}