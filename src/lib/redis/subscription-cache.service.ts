import { Injectable, Logger } from '@nestjs/common';
import { RedisService } from './redis.service';
import { Subscription } from '@modules/subscriptions/entities/subscription.entity';

/**
 * ─────────────────────────────────────────────────────────────────────────────
 * Cached subscription rows — with one deliberate hole in the middle
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * ## The read being cached
 *
 * `SubscriptionGuard` loads the tenant's subscription on **every** request —
 * not only when `@RequireSubscription()` is present, because `FeatureLimitGuard`
 * and `SubscriptionLimitGuard` both read `req.subscription` downstream. That is
 * one `subscriptions` SELECT per request, for a row that changes when someone
 * upgrades, cancels or renews.
 *
 * ## Why this cache must NOT be used on quota-checked routes
 *
 * This is the case where caching the obvious thing would be a correctness bug,
 * and it is worth stating precisely.
 *
 * The subscription row carries `usage` — live counters (`devices`, `users`,
 * `dashboards`, …) that `SubscriptionLimitGuard` compares against the plan's
 * limits to decide whether a create is allowed. Those counters are mutated by
 * `incrementTenantUsage()` on every create.
 *
 * Serve that row from a cache with a TTL of T and the quota stops being a
 * quota: a tenant on a 5-device plan can create as many devices as it can push
 * through in T seconds, because every one of those requests reads the same
 * stale `usage.devices` and every one of them passes. Multiply by replicas. A
 * hard limit silently becomes a soft one, and a plan boundary that the whole
 * billing model rests on becomes a function of request rate.
 *
 * So the cache is **bypassed for any route carrying
 * `@RequireSubscriptionLimit()`** — the guard decides this and calls
 * `SubscriptionsService` directly. That is exactly the set of routes that
 * enforce a counter, and it is a small set: creates. Every other request —
 * the reads, which are the overwhelming majority of traffic and which never
 * consult `usage` — comes from here.
 *
 * ## What invalidates an entry
 *
 * One tenant-scoped key, dropped by `invalidate(tenantId)`, called from
 * `SubscriptionsService` after every write to the row. Unlike permissions
 * there is no epoch, because there is no fan-out: a subscription belongs to
 * exactly one tenant and only that tenant's entry can go stale.
 *
 * | Mutation                        | Hooked by                        |
 * |---------------------------------|----------------------------------|
 * | create / getOrCreateFree        | `SubscriptionsService`           |
 * | upgrade / upgradeAfterPayment   | `SubscriptionsService`           |
 * | renew / markRenewalPaymentFailed| `SubscriptionsService`           |
 * | cancel / scheduleDowngrade      | `SubscriptionsService`           |
 * | startTrial / setAutoRenew       | `SubscriptionsService`           |
 * | reverseAfterRefund              | `SubscriptionsService`           |
 * | the expiry / downgrade sweeps   | `SubscriptionsService`           |
 * | usage increment / decrement     | `SubscriptionsService`           |
 *
 * `usage` is in that list even though quota-checked routes bypass the cache:
 * `FeatureLimitGuard` and the dashboard both read counters off the cached row
 * for *display*, and a counter that visibly lags by a minute looks like a bug
 * to the person reading it.
 *
 * The TTL is the backstop for the one thing no hook can catch: a row changed
 * directly in the database, or by another replica running a migration script.
 *
 * ## Failure behaviour
 *
 * Every operation is wrapped. A Redis error is a cache miss, and the guard
 * falls through to Postgres. The cache can only return a row it previously
 * read from Postgres, so it cannot grant a plan nobody has — the worst it can
 * do is serve a subscription that was accurate up to TTL seconds ago, and the
 * `isActive()` / `isTrialExpired()` checks then run against that snapshot.
 * With the default 30s that is the window in which a just-cancelled
 * subscription still permits reads. Lowering SUBSCRIPTION_CACHE_TTL_SECONDS
 * narrows it; 0 disables the cache entirely.
 */

const TTL_SECONDS = Number(
  process.env.SUBSCRIPTION_CACHE_TTL_SECONDS ?? 30,
);

/** Columns that must come back as `Date`, not as the strings JSON leaves. */
const DATE_FIELDS = [
  'nextBillingDate',
  'trialEndsAt',
  'cancelledAt',
  'createdAt',
  'updatedAt',
  'deletedAt',
] as const;

@Injectable()
export class SubscriptionCacheService {
  private readonly logger = new Logger(SubscriptionCacheService.name);
  private readonly enabled = TTL_SECONDS > 0;

  constructor(private readonly redis: RedisService) {
    if (!this.enabled) {
      this.logger.warn(
        'SUBSCRIPTION_CACHE_TTL_SECONDS=0 — every request will load the ' +
          'subscription row from Postgres.',
      );
    }
  }

  private key(tenantId: string): string {
    return `subscription:tenant:${tenantId}`;
  }

  /**
   * Rehydrate into a real `Subscription` instance.
   *
   * This is the part a plain `JSON.parse` gets wrong, and it fails loudly
   * rather than subtly: `SubscriptionGuard` calls `subscription.isActive()`
   * immediately, so a plain object throws `isActive is not a function` on the
   * first request and every route 500s. Less obviously, the date columns come
   * back as ISO strings — the entity methods happen to wrap them in
   * `new Date(...)` defensively, but `getAccessEndsAt()` returns one to the
   * caller, so they are converted here and the cached row is indistinguishable
   * from a loaded one.
   */
  private rehydrate(raw: string): Subscription | null {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return null;

    const entity = Object.assign(new Subscription(), parsed) as any;
    for (const field of DATE_FIELDS) {
      if (entity[field]) entity[field] = new Date(entity[field]);
    }
    return entity as Subscription;
  }

  async get(tenantId: string | undefined | null): Promise<Subscription | null> {
    if (!this.enabled || !tenantId) return null;

    try {
      const raw = await this.redis.get(this.key(tenantId));
      if (!raw) return null;
      return this.rehydrate(raw);
    } catch (error) {
      this.logger.debug(
        `subscription cache read failed for tenant ${tenantId}: ${(error as Error).message}`,
      );
      return null;
    }
  }

  async set(
    tenantId: string | undefined | null,
    subscription: Subscription,
  ): Promise<void> {
    if (!this.enabled || !tenantId) return;

    try {
      await this.redis.set(
        this.key(tenantId),
        JSON.stringify(subscription),
        TTL_SECONDS,
      );
    } catch (error) {
      this.logger.debug(
        `subscription cache write failed for tenant ${tenantId}: ${(error as Error).message}`,
      );
    }
  }

  /**
   * Drop a tenant's cached row. Never throws.
   *
   * Logged at **error** on failure: a failed invalidation means the caller has
   * already been told their upgrade or cancellation succeeded while the old
   * plan is still being served.
   */
  async invalidate(tenantId: string | undefined | null): Promise<void> {
    if (!this.enabled || !tenantId) return;

    try {
      await this.redis.del(this.key(tenantId));
    } catch (error) {
      this.logger.error(
        `Could not invalidate the cached subscription for tenant ${tenantId}: ` +
          `${(error as Error).message}. The previous plan may be served for up ` +
          `to ${TTL_SECONDS}s.`,
      );
    }
  }

  getTtlSeconds(): number {
    return TTL_SECONDS;
  }
}
