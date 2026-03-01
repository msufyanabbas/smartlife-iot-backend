// src/modules/auth/entities/oauth-account.entity.ts
import { Entity, Column, ManyToOne, JoinColumn, Index } from 'typeorm';
import { BaseEntity } from '@common/entities/base.entity';
import { User } from '@modules/index.entities';
import { OAuthProviderEnum } from '@common/enums/index.enum';
import type { OAuthProfile } from '@/common/interfaces/oauth.interface';
@Entity('oauth_accounts')
@Index(['provider', 'providerId'], { unique: true }) // one account per provider per providerId
@Index(['userId'])                                    // look up all OAuth accounts for a user
export class OAuthAccount extends BaseEntity {
  // ── User link ──────────────────────────────────────────────────────────────
  @Column()
  userId: string;

  @ManyToOne(() => User, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'userId' })
  user: User;

  // ── Provider identity ──────────────────────────────────────────────────────
  @Column({ type: 'enum', enum: OAuthProviderEnum })
  provider: OAuthProviderEnum;

  @Column()
  providerId: string; // the ID returned by the OAuth provider (e.g. Google sub claim)

  @Column({ nullable: true })
  providerEmail?: string; // the email from the OAuth provider (may differ from user.email)

  // ── Tokens ─────────────────────────────────────────────────────────────────
  // SECURITY NOTE: These tokens should be encrypted at rest.
  // Consider using PostgreSQL pgcrypto extension or application-level encryption
  // (e.g. @nestjs/config with an encryption service) before storing here.
  // Storing plaintext OAuth tokens is a security risk if the DB is compromised.
  @Column({ type: 'text', nullable: true })
  accessToken?: string;

  @Column({ type: 'text', nullable: true })
  refreshToken?: string;

  @Column({ type: 'timestamp', nullable: true })
  tokenExpiresAt?: Date;

  // ── Provider profile snapshot ──────────────────────────────────────────────
  // Stores the raw profile returned by the OAuth provider at last login.
  // Used to sync name/avatar without re-fetching from the provider.
  @Column({ type: 'jsonb', nullable: true })
  profile?: OAuthProfile;

  // ── Helpers ────────────────────────────────────────────────────────────────
  isTokenExpired(): boolean {
    if (!this.tokenExpiresAt) return false;
    return new Date() > this.tokenExpiresAt;
  }
}
