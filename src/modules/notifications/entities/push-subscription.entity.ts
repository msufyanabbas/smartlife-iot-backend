// src/modules/notifications/entities/push-subscription.entity.ts
import { Entity, Column, Index, ManyToOne, JoinColumn } from 'typeorm';
import { BaseEntity } from '@common/entities/base.entity';
import type { Relation } from 'typeorm';
import type { Tenant } from '../../tenants/entities/tenant.entity';
import type { User } from '../../users/entities/user.entity';
import type { Customer } from '../../customers/entities/customers.entity';

export const PUSH_PLATFORMS = ['android', 'ios', 'web', 'unknown'] as const;
export type PushPlatform = (typeof PUSH_PLATFORMS)[number];

/**
 * Where a push notification can actually be delivered.
 *
 * Before this table existed, `PushChannel` had nowhere to read a device token
 * from: `Notification.recipientDeviceToken` had to be supplied by whoever
 * created the notification, and nothing in the platform ever collected one. So
 * the push channel was unreachable in practice even once the FCM calls were
 * real — there was no token to send to.
 *
 * ─── `token` means two different things ───────────────────────────────────
 * For `android` / `ios` it is the FCM registration token.
 * For `web` it is the Web Push **endpoint URL**, and the two VAPID key halves
 * live in `keys` ({ p256dh, auth }) because `web-push` needs all three. The
 * endpoint is what browsers treat as the subscription's identity, which is why
 * it is the column the unique index is on — one row per browser subscription.
 *
 * Platform is stored rather than inferred: iOS is delivered **through FCM**
 * (there is no APNs library in this repo — see push.channel.ts), and knowing a
 * row is iOS is what lets the APNs-specific payload block be attached.
 */
@Entity('push_subscriptions')
@Index(['tenantId', 'userId'])
@Index(['tenantId', 'platform'])
@Index(['userId', 'enabled'])
export class PushSubscription extends BaseEntity {
  // ══════════════════════════════════════════════════════════════════════════
  // SCOPING
  // ══════════════════════════════════════════════════════════════════════════

  @Column({ type: 'uuid' })
  tenantId: string;

  @ManyToOne('Tenant')
  @JoinColumn({ name: 'tenantId' })
  tenant: Relation<Tenant>;

  @Column({ type: 'uuid', nullable: true })
  customerId?: string | null;

  @ManyToOne('Customer', { nullable: true })
  @JoinColumn({ name: 'customerId' })
  customer?: Relation<Customer>;

  @Column({ type: 'uuid' })
  userId: string;

  @ManyToOne('User', { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'userId' })
  user: Relation<User>;

  // ══════════════════════════════════════════════════════════════════════════
  // THE SUBSCRIPTION
  // ══════════════════════════════════════════════════════════════════════════

  /** FCM registration token, or a Web Push endpoint URL. */
  @Column({ type: 'text' })
  token: string;

  @Column({ type: 'varchar', length: 16, default: 'unknown' })
  platform: PushPlatform;

  /**
   * Web Push only: `{ p256dh, auth }` from `PushSubscription.toJSON().keys` in
   * the browser. Null for FCM tokens.
   */
  @Column({ type: 'jsonb', nullable: true })
  keys?: { p256dh: string; auth: string } | null;

  /** Free-form client description — app version, model, user agent. */
  @Column({ type: 'jsonb', nullable: true })
  deviceInfo?: Record<string, unknown> | null;

  // ══════════════════════════════════════════════════════════════════════════
  // STATE
  // ══════════════════════════════════════════════════════════════════════════

  /**
   * Set false — not deleted — when a provider reports the token is gone
   * (FCM `registration-token-not-registered`, Web Push 404/410). Keeping the
   * row records that the device was once registered and stops it being
   * retried on every send; re-registering the same token revives it.
   */
  @Column({ type: 'boolean', default: true })
  enabled: boolean;

  @Column({ type: 'text', nullable: true })
  lastError?: string | null;

  @Column({ type: 'timestamp', nullable: true })
  lastErrorAt?: Date | null;

  /** Refreshed on every register call and every successful send. */
  @Column({ type: 'timestamp', nullable: true })
  lastSeenAt?: Date | null;

  /** True when this row can be sent to right now. */
  isDeliverable(): boolean {
    return this.enabled && !!this.token;
  }

  touch(): void {
    this.lastSeenAt = new Date();
  }

  disable(reason: string): void {
    this.enabled = false;
    this.lastError = reason;
    this.lastErrorAt = new Date();
  }
}
