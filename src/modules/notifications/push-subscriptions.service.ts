import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { IsNull, Repository } from 'typeorm';
import {
  PUSH_PLATFORMS,
  PushSubscription,
  type PushPlatform,
} from './entities/push-subscription.entity';

export interface RegisterPushSubscriptionInput {
  token: string;
  platform?: PushPlatform;
  keys?: { p256dh: string; auth: string };
  deviceInfo?: Record<string, unknown>;
}

export interface PushSubscriptionOwner {
  id: string;
  tenantId?: string;
  customerId?: string;
}

/**
 * The device registry behind PushChannel.
 *
 * ─── Tenant scoping ───────────────────────────────────────────────────────
 * A subscription is identified globally by its token (one browser
 * subscription, one app install), but every query here is pinned to the
 * CALLER's tenant and user. A register call for a token that already belongs
 * to another user **moves** it: a token identifies a device, and a device
 * changes hands when someone else signs in on it. Leaving the old row in place
 * would send that user's notifications to the new signed-in user's phone.
 *
 * Reads and deletes are scoped to `(tenantId, userId)` and answer 404 — never
 * 403 — for a row outside that scope, so the route cannot be used to test
 * whether a token exists elsewhere (CLAUDE.md §4g).
 */
@Injectable()
export class PushSubscriptionsService {
  private readonly logger = new Logger(PushSubscriptionsService.name);

  constructor(
    @InjectRepository(PushSubscription)
    private readonly repository: Repository<PushSubscription>,
  ) {}

  // ══════════════════════════════════════════════════════════════════════════
  // REGISTER
  // ══════════════════════════════════════════════════════════════════════════

  async register(
    owner: PushSubscriptionOwner,
    input: RegisterPushSubscriptionInput,
  ): Promise<PushSubscription> {
    const tenantId = this.requireTenant(owner);
    const token = input.token?.trim();

    if (!token) throw new BadRequestException('A push token is required');

    const platform = this.resolvePlatform(token, input.platform);

    if (platform === 'web' && (!input.keys?.p256dh || !input.keys?.auth)) {
      // Without the keys, web-push cannot encrypt a payload, so the row would
      // be unusable. Refuse at registration rather than at the first send.
      throw new BadRequestException(
        'A web push subscription needs its keys — send ' +
          '{ token: <endpoint>, keys: { p256dh, auth } } from the browser ' +
          "subscription's toJSON().",
      );
    }

    // Upsert on the token, across every tenant — see the class comment.
    const existing = await this.repository.findOne({
      where: { token },
      withDeleted: true,
    });

    if (existing) {
      const movedUser = existing.userId !== owner.id;
      existing.deletedAt = null as unknown as undefined;
      existing.tenantId = tenantId;
      existing.customerId = owner.customerId ?? null;
      existing.userId = owner.id;
      existing.platform = platform;
      existing.keys = input.keys ?? (platform === 'web' ? existing.keys : null);
      if (input.deviceInfo) existing.deviceInfo = input.deviceInfo;
      // Re-registering is the device saying it is alive again, so a row that a
      // provider error disabled comes back.
      existing.enabled = true;
      existing.lastError = null;
      existing.lastErrorAt = null;
      existing.touch();

      const saved = await this.repository.save(existing);
      this.logger.log(
        `Push subscription refreshed (${platform}) for user ${owner.id}` +
          (movedUser ? ' — token reassigned from another user' : ''),
      );
      return saved;
    }

    const created = this.repository.create({
      tenantId,
      customerId: owner.customerId ?? null,
      userId: owner.id,
      token,
      platform,
      keys: input.keys ?? null,
      deviceInfo: input.deviceInfo ?? null,
      enabled: true,
      lastSeenAt: new Date(),
    });

    const saved = await this.repository.save(created);
    this.logger.log(
      `Push subscription registered (${platform}) for user ${owner.id}`,
    );
    return saved;
  }

  // ══════════════════════════════════════════════════════════════════════════
  // READ
  // ══════════════════════════════════════════════════════════════════════════

  /** The caller's own devices. */
  async findMine(owner: PushSubscriptionOwner): Promise<PushSubscription[]> {
    const tenantId = this.requireTenant(owner);
    return this.repository.find({
      where: { tenantId, userId: owner.id, deletedAt: IsNull() },
      order: { lastSeenAt: 'DESC', createdAt: 'DESC' },
    });
  }

  /**
   * Deliverable tokens for a set of users — what a fan-out send reads.
   *
   * Tenant-scoped on purpose: a caller holding a user id from another tenant
   * gets an empty list, not that tenant's devices.
   */
  async findTokensForUsers(
    tenantId: string,
    userIds: string[],
  ): Promise<PushSubscription[]> {
    if (!tenantId || userIds.length === 0) return [];
    return this.repository
      .createQueryBuilder('ps')
      .where('ps.tenantId = :tenantId', { tenantId })
      .andWhere('ps.userId IN (:...userIds)', { userIds })
      .andWhere('ps.enabled = true')
      .andWhere('ps.deleted_at IS NULL')
      .getMany();
  }

  // ══════════════════════════════════════════════════════════════════════════
  // UNREGISTER
  // ══════════════════════════════════════════════════════════════════════════

  /**
   * Remove a device, by token.
   *
   * A soft delete, like every delete in this codebase — and the register path
   * undeletes, so a sign-out followed by a sign-in on the same device reuses
   * the row instead of colliding with the unique index on `token`.
   */
  async unregister(
    owner: PushSubscriptionOwner,
    token: string,
  ): Promise<{ message: string }> {
    const tenantId = this.requireTenant(owner);
    const subscription = await this.repository.findOne({
      where: { token: token?.trim(), tenantId, userId: owner.id, deletedAt: IsNull() },
    });

    // 404 rather than 403 for someone else's token: a 403 would confirm the
    // token is registered to another account (§4g).
    if (!subscription) {
      throw new NotFoundException('Push subscription not found');
    }

    await this.repository.softRemove(subscription);
    this.logger.log(
      `Push subscription removed (${subscription.platform}) for user ${owner.id}`,
    );
    return { message: 'Push subscription removed' };
  }

  async unregisterById(
    owner: PushSubscriptionOwner,
    id: string,
  ): Promise<{ message: string }> {
    const tenantId = this.requireTenant(owner);
    const subscription = await this.repository.findOne({
      where: { id, tenantId, userId: owner.id, deletedAt: IsNull() },
    });
    if (!subscription) {
      throw new NotFoundException('Push subscription not found');
    }
    await this.repository.softRemove(subscription);
    return { message: 'Push subscription removed' };
  }

  // ══════════════════════════════════════════════════════════════════════════
  // INTERNALS
  // ══════════════════════════════════════════════════════════════════════════

  /**
   * A falsy tenant must deny, not widen the query (§4g). SUPER_ADMIN is the
   * only legitimately tenant-less role, and a platform administrator
   * registering a phone still has to do it inside a tenant.
   */
  private requireTenant(owner: PushSubscriptionOwner): string {
    if (!owner?.tenantId) {
      throw new BadRequestException(
        'A push subscription belongs to a tenant. Sign in as a user of a ' +
          'tenant to register a device.',
      );
    }
    return owner.tenantId;
  }

  private resolvePlatform(
    token: string,
    declared?: PushPlatform,
  ): PushPlatform {
    if (declared && (PUSH_PLATFORMS as readonly string[]).includes(declared)) {
      return declared;
    }
    // An https endpoint is a Web Push subscription; an FCM registration token
    // never is.
    return /^https?:\/\//i.test(token) ? 'web' : 'unknown';
  }
}
