// src/modules/auth/entities/token-blacklist.entity.ts
import { BaseEntity } from '@common/entities/base.entity';
import {
  Entity,
  Column,
  Index,
} from 'typeorm';

// ─────────────────────────────────────────────────────────────────────────────
// TokenBlacklist
//
// Stores invalidated access tokens until they naturally expire.
// Only access tokens go here — refresh tokens are revoked via RefreshToken.isRevoked.
//
// Why blacklist access tokens?
//   Access tokens are stateless JWTs. When a user logs out or an admin force-
//   revokes a session, the access token remains cryptographically valid until
//   it expires. The blacklist lets JwtAuthGuard reject it immediately.
//
// Performance note:
//   JwtAuthGuard checks this table on EVERY authenticated request.
//   Keep it lean — the cleanup cron must run frequently to remove expired rows.
//   Consider Redis for this in production for O(1) lookups.
// ─────────────────────────────────────────────────────────────────────────────

@Entity('token_blacklist')
@Index(['expiresAt']) // cleanup cron: DELETE WHERE expiresAt < NOW()
export class TokenBlacklist extends BaseEntity {
  // @Column unique: true already creates a unique index
  // Using text type because JWT tokens are long strings.
  @Column({ type: 'text', unique: true })
  token: string;

  // The user who owned this token — for audit purposes
  @Column()
  userId: string;

  // Denormalized tenantId — allows purging all blacklisted tokens for a tenant
  // without joining through users (e.g. tenant account deletion)
  @Column({ nullable: true })

  tenantId?: string;

  // When the original access token would have naturally expired.
  // The cleanup cron deletes rows where expiresAt < NOW() — once a token
  // has expired naturally it no longer needs to be in the blacklist.
  @Column({ type: 'timestamp' })
  expiresAt: Date;

  // Why the token was blacklisted — useful for audit logs
  @Column({ nullable: true })
  reason?: string; // 'logout' | 'force_revoke' | 'password_change' | 'account_suspended'

  // ── Helpers ────────────────────────────────────────────────────────────────
  // A blacklisted token is only relevant while it would still be valid.
  // Once past its expiry, it can be safely removed from the table.
  isCleanupEligible(): boolean {
    return new Date() > this.expiresAt;
  }
}
