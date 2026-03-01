// src/modules/auth/entities/refresh-token.entity.ts
import { Entity, Column, ManyToOne, JoinColumn, Index } from 'typeorm';
import { BaseEntity } from '@/common/entities/base.entity';
import { User } from '@/modules/users/entities/user.entity';

@Entity('refresh_tokens')
@Index(['userId'])       // revoke all tokens for a user (logout from all devices)
@Index(['expiresAt'])    // cleanup cron: DELETE WHERE expiresAt < NOW()
@Index(['tenantId'])     // revoke all tokens for a tenant (suspension, plan cancellation)
export class RefreshToken extends BaseEntity {
  // ── Token ──────────────────────────────────────────────────────────────────
  // @Column unique: true already creates a unique index
  @Column({ unique: true })
  token: string;

  // ── User link ──────────────────────────────────────────────────────────────
  @Column()
  userId: string;

  @ManyToOne(() => User, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'userId' })
  user: User;

  // ── Tenant scope ───────────────────────────────────────────────────────────
  // Denormalized from user.tenantId — avoids joining through users when
  // revoking all tokens for a tenant (e.g. tenant suspended, plan cancelled).
  @Column({ nullable: true })
  tenantId?: string;

  // ── Lifecycle ──────────────────────────────────────────────────────────────
  @Column({ type: 'timestamp' })
  expiresAt: Date;

  @Column({ default: false })
  isRevoked: boolean;

  @Column({ type: 'timestamp', nullable: true })
  revokedAt?: Date;

  // ── Device context ─────────────────────────────────────────────────────────
  // Structured instead of a single deviceInfo string so you can display
  // "iPhone — Safari — Saudi Arabia" in the active sessions UI.
  @Column({ type: 'jsonb', nullable: true })
  deviceInfo?: {
    userAgent?: string;
    browser?: string;    // parsed from userAgent
    os?: string;         // parsed from userAgent
    device?: string;     // 'mobile' | 'tablet' | 'desktop'
    ipAddress?: string;
    country?: string;    // resolved via GeoIP
    city?: string;
  };

  // ── Helpers ────────────────────────────────────────────────────────────────
  isExpired(): boolean {
    return new Date() > this.expiresAt;
  }

  isValid(): boolean {
    return !this.isRevoked && !this.isExpired();
  }

  revoke() {
    this.isRevoked = true;
    this.revokedAt = new Date();
  }
}
