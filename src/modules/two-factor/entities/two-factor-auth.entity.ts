import {
  Entity,
  Column,
  PrimaryGeneratedColumn,
  CreateDateColumn,
  UpdateDateColumn,
  Index,
  OneToOne,
  JoinColumn,
} from 'typeorm';
import { User } from '../../users/entities/user.entity';

export enum TwoFactorMethod {
  AUTHENTICATOR = 'authenticator', // Google Authenticator, Authy, etc.
  SMS = 'sms',
  EMAIL = 'email',
}

@Entity('two_factor_auth')
export class TwoFactorAuth {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ unique: true })
  @Index()
  userId: string;

  @OneToOne(() => User)
  @JoinColumn({ name: 'userId' })
  user: User;

  @Column({ default: false })
  isEnabled: boolean;

  @Column({
    type: 'enum',
    enum: TwoFactorMethod,
    nullable: true,
  })
  method?: TwoFactorMethod;

  // For TOTP (Authenticator app)
  @Column({ nullable: true })
  secret?: string; // Base32 encoded secret for TOTP

  @Column({ nullable: true })
  backupCodes?: string; // JSON array of backup codes (hashed)

  // For SMS
  @Column({ nullable: true })
  phoneNumber?: string;

  @Column({ default: false })
  phoneVerified: boolean;

  // For temporary verification codes (SMS/Email)
  @Column({ nullable: true })
  tempCode?: string;

  @Column({ type: 'timestamp', nullable: true })
  tempCodeExpiry?: Date;

  @Column({ default: 0 })
  tempCodeAttempts: number;

  // Tracking
  @Column({ type: 'timestamp', nullable: true })
  lastVerifiedAt?: Date;

  @Column({ type: 'timestamp', nullable: true })
  enabledAt?: Date;

  @CreateDateColumn()
  createdAt: Date;

  @UpdateDateColumn()
  updatedAt: Date;

  // Helper methods
  isTempCodeValid(): boolean {
    if (!this.tempCode || !this.tempCodeExpiry) {
      return false;
    }
    return new Date() < this.tempCodeExpiry;
  }

  incrementAttempts(): void {
    this.tempCodeAttempts += 1;
  }

  resetAttempts(): void {
    this.tempCodeAttempts = 0;
  }

  isLocked(): boolean {
    return this.tempCodeAttempts >= 5; // Lock after 5 failed attempts
  }
}