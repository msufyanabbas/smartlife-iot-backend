// src/modules/auth/entities/refresh-token.entity.ts
import { Entity, Column, ManyToOne, JoinColumn, Index } from 'typeorm';
import { BaseEntity } from '@common/entities/base.entity';
import { User, Tenant } from '@modules/index.entities';

@Entity('refresh_tokens')
@Index(['userId'])       // revoke all tokens for a user (logout from all devices)
@Index(['expiresAt'])    // cleanup cron: DELETE WHERE expiresAt < NOW()
@Index(['tenantId'])     // revoke all tokens for a tenant (suspension, plan cancellation)
@Index(['tenantId', 'userId'])  // tenant-scoped user tokens
@Index(['token'])        // fast token lookup
export class RefreshToken extends BaseEntity {
  // ══════════════════════════════════════════════════════════════════════════
  // TENANT SCOPING (REQUIRED - denormalized from user)
  // ══════════════════════════════════════════════════════════════════════════

  @Column()

  tenantId: string;

  @ManyToOne(() => Tenant)
  @JoinColumn({ name: 'tenantId' })
  tenant: Tenant;

  // ══════════════════════════════════════════════════════════════════════════
  // TOKEN
  // ══════════════════════════════════════════════════════════════════════════

  @Column({ unique: true })

  token: string;

  // ══════════════════════════════════════════════════════════════════════════
  // USER LINK
  // ══════════════════════════════════════════════════════════════════════════

  @Column()

  userId: string;

  @ManyToOne(() => User, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'userId' })
  user: User;

  // ══════════════════════════════════════════════════════════════════════════
  // LIFECYCLE
  // ══════════════════════════════════════════════════════════════════════════

  @Column({ type: 'timestamp' })

  expiresAt: Date;

  @Column({ default: false })

  isRevoked: boolean;

  @Column({ type: 'timestamp', nullable: true })
  revokedAt?: Date;

  // ══════════════════════════════════════════════════════════════════════════
  // DEVICE CONTEXT (JSONB)
  // ══════════════════════════════════════════════════════════════════════════

  @Column({ type: 'jsonb', nullable: true })
  deviceInfo?: {
    userAgent?: string;
    browser?: string;    // parsed from userAgent (e.g., "Chrome 120")
    os?: string;         // parsed from userAgent (e.g., "Windows 10")
    device?: string;     // 'mobile' | 'tablet' | 'desktop'
    ipAddress?: string;
    country?: string;    // resolved via GeoIP (e.g., "Saudi Arabia")
    city?: string;       // resolved via GeoIP (e.g., "Riyadh")
    lastUsedAt?: string; // ISO timestamp
  };

  // ══════════════════════════════════════════════════════════════════════════
  // HELPER METHODS
  // ══════════════════════════════════════════════════════════════════════════

  /**
   * Check if token is expired
   */
  isExpired(): boolean {
    return new Date() > this.expiresAt;
  }

  /**
   * Check if token is valid (not revoked and not expired)
   */
  isValid(): boolean {
    return !this.isRevoked && !this.isExpired();
  }

  /**
   * Revoke this token
   */
  revoke(): void {
    this.isRevoked = true;
    this.revokedAt = new Date();
  }

  /**
   * Get human-readable device description
   */
  getDeviceDescription(): string {
    if (!this.deviceInfo) return 'Unknown Device';

    const parts: string[] = [];

    if (this.deviceInfo.device) {
      parts.push(this.deviceInfo.device);
    }

    if (this.deviceInfo.os) {
      parts.push(this.deviceInfo.os);
    }

    if (this.deviceInfo.browser) {
      parts.push(this.deviceInfo.browser);
    }

    return parts.join(' • ') || 'Unknown Device';
  }

  /**
   * Get location description
   */
  getLocationDescription(): string {
    if (!this.deviceInfo) return 'Unknown Location';

    const parts: string[] = [];

    if (this.deviceInfo.city) {
      parts.push(this.deviceInfo.city);
    }

    if (this.deviceInfo.country) {
      parts.push(this.deviceInfo.country);
    }

    if (this.deviceInfo.ipAddress && parts.length === 0) {
      return this.deviceInfo.ipAddress;
    }

    return parts.join(', ') || 'Unknown Location';
  }

  /**
   * Update last used timestamp
   */
  updateLastUsed(): void {
    if (!this.deviceInfo) {
      this.deviceInfo = {};
    }
    this.deviceInfo.lastUsedAt = new Date().toISOString();
  }
}