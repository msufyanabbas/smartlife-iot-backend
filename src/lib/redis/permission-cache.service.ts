import { Injectable, Logger } from '@nestjs/common';
import { RedisService } from './redis.service';

/**
 * ─────────────────────────────────────────────────────────────────────────────
 * Cached effective-permission sets, invalidated by epoch
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * ## What this is for
 *
 * `PermissionGuard.resolveEffectivePermissions()` runs on every request to a
 * route carrying `@RequirePermissions()` — which, after §4k, is most of the
 * API. Each run is:
 *
 *   1. `users.findOne` with relations `roles`, `roles.permissions`,
 *      `directPermissions` — a four-table join through two junction tables,
 *   2. plus, for a customer-scoped user, `customers.findOne` with
 *      `grantedPermissions` — another join.
 *
 * Two multi-join queries per request, for data that changes when an
 * administrator edits a role: perhaps a few times a month. This is the
 * strongest caching case in the codebase.
 *
 * ## Why invalidation is the whole design, not an afterthought
 *
 * A cached permission set that outlives a revocation is a security bug: the
 * administrator who removed `devices:delete` from a role is told it is gone,
 * and the holder keeps using it. So a per-user key with a TTL is not good
 * enough on its own — the dangerous mutation is a change to a *role*, which
 * affects every user holding it, and finding those users means a query that
 * the cache was supposed to avoid.
 *
 * Hence an **epoch**: one integer per tenant, part of every cache key.
 *
 *     perm:{tenantId}:{epoch}:{userId}  →  the resolved set
 *     perm:epoch:{tenantId}             →  the integer
 *
 * `INCR` on the epoch orphans every cached set in that tenant in a single
 * round trip, with no SCAN, no key enumeration and no possibility of missing a
 * user. The orphans are never read again and expire on their own TTL.
 *
 * This deliberately invalidates **more** than strictly necessary — changing
 * one user's direct permissions also drops every other user's cached set in
 * that tenant. That is the right trade: the cost is one rebuilt query per
 * active user, once, and the alternative (reasoning per mutation about exactly
 * whose set is affected) is where a missed case becomes a privilege that
 * outlives its revocation.
 *
 * ## What invalidates an entry — the complete list
 *
 * Every one of these calls `bumpTenant()`:
 *
 *   | Mutation                                   | Call site                     |
 *   |--------------------------------------------|-------------------------------|
 *   | role created with permissions              | `RolesService.create`         |
 *   | role's permission set replaced             | `RolesService.update`         |
 *   | permissions added to a role                | `RolesService.addPermissions` |
 *   | permissions removed from a role            | `RolesService.removePermissions` |
 *   | role deleted                               | `RolesService.remove`         |
 *   | role assigned to a user                    | `UsersService.assignRole`     |
 *   | role removed from a user                   | `UsersService.removeRole`     |
 *   | user's direct permissions changed          | `UsersService.updateUserPermissions` |
 *   | user updated (may toggle enforcePermissions)| `UsersService.update`        |
 *
 * `npm run check:infra-wiring` asserts that each of those call sites is still
 * there, because the failure mode of forgetting one is silent and the symptom
 * appears up to a TTL later, somewhere else.
 *
 * Two cases are covered by the TTL rather than an explicit bump, and both are
 * stated here rather than left to be discovered:
 *
 *   • **`customers.grantedPermissions`** — the customer permission ceiling.
 *     It is set at customer creation and is explicitly excluded from bulk
 *     update (`customers.service.ts`), so there is no routine mutation path
 *     to hook. A change made directly in the database is picked up within the
 *     TTL.
 *   • **Subscription feature flags**, which filter the set
 *     (`filterBySubscriptionFeatures`). A downgrade narrows permissions within
 *     the TTL. A plan change is already a minutes-scale operation involving a
 *     payment provider, so a 60-second lag adds nothing material.
 *
 * ## Failure behaviour
 *
 * Every Redis operation here is wrapped. A Redis error means a cache miss,
 * never a grant and never a denial — the guard falls through to its database
 * resolution. Failing open to the DB is safe because the DB is the authority;
 * failing open to "allow" would not be, and is not possible from here: this
 * service can only ever return a set it previously stored, or nothing.
 */

/**
 * 60 seconds. The epoch makes correctness independent of this number, so the
 * TTL is only a bound on the two unhooked mutations above and a ceiling on how
 * long an orphaned entry occupies memory.
 */
const TTL_SECONDS = Number(process.env.PERMISSION_CACHE_TTL_SECONDS ?? 60);

/** A tenant whose epoch key has been evicted restarts from here. */
const EPOCH_FALLBACK = '0';

@Injectable()
export class PermissionCacheService {
  private readonly logger = new Logger(PermissionCacheService.name);
  private readonly enabled =
    (process.env.PERMISSION_CACHE_ENABLED ?? 'true').toLowerCase() !== 'false';

  constructor(private readonly redis: RedisService) {
    if (!this.enabled) {
      this.logger.warn(
        'PERMISSION_CACHE_ENABLED=false — every request will resolve ' +
          'permissions from Postgres.',
      );
    }
  }

  private epochKey(tenantId: string): string {
    return `perm:epoch:${tenantId}`;
  }

  /**
   * Keys carry TWO epochs, `{global}.{tenant}`, and the second one alone is
   * not sufficient.
   *
   * A **system role** (`roles.tenantId IS NULL`) is shared by every tenant on
   * the platform. Editing its permission set changes what users in dozens of
   * tenants may do, and a per-tenant epoch cannot express that: bumping the
   * role's own `tenantId` is a bump of `null`, and bumping every tenant means
   * enumerating tenants on a path that exists to avoid queries.
   *
   * So `bumpGlobal()` increments one shared counter and orphans the entire
   * platform's cached sets at once. Both epochs are read in a single `MGET`,
   * so this costs no extra round trip over the per-tenant scheme.
   */
  private static readonly GLOBAL_EPOCH_KEY = 'perm:epoch:global';

  private async epoch(tenantId: string): Promise<string> {
    try {
      const [global, tenant] = await this.redis.mget(
        PermissionCacheService.GLOBAL_EPOCH_KEY,
        this.epochKey(tenantId),
      );
      return `${global ?? EPOCH_FALLBACK}.${tenant ?? EPOCH_FALLBACK}`;
    } catch {
      // A failed epoch read must not be treated as epoch 0 — that would let a
      // Redis blip resurrect entries written before the last bump, which is
      // exactly the stale-privilege case the epoch exists to prevent.
      // Returning null makes the caller treat it as a miss.
      return '';
    }
  }

  /**
   * Read a cached set.
   *
   * `userId` alone would be enough to identify the entry, but the tenant is in
   * the key so that the epoch and the entries it governs share a namespace —
   * which is what makes "everything this bump invalidates" inspectable with a
   * single `perm:{tenantId}:*` glob when someone is debugging.
   */
  async get(
    tenantId: string | undefined | null,
    userId: string,
  ): Promise<Set<string> | null> {
    // A user with no tenant is never cached: the epoch is per tenant, so there
    // would be nothing to invalidate it with. In practice this is SUPER_ADMIN,
    // which the guard short-circuits before it ever reaches the cache.
    if (!this.enabled || !tenantId) return null;

    try {
      const epoch = await this.epoch(tenantId);
      if (!epoch) return null; // epoch unreadable — treat as a miss
      const raw = await this.redis.get(`perm:${tenantId}:${epoch}:${userId}`);
      if (!raw) return null;

      const parsed = JSON.parse(raw);
      // A corrupt entry must not authorise anything. Returning null sends the
      // guard to the database, which is the only safe interpretation of
      // "I cannot tell what this user is allowed to do".
      if (!Array.isArray(parsed)) return null;
      return new Set<string>(parsed.filter((p) => typeof p === 'string'));
    } catch (error) {
      this.logger.debug(
        `permission cache read failed for ${userId}: ${(error as Error).message}`,
      );
      return null;
    }
  }

  async set(
    tenantId: string | undefined | null,
    userId: string,
    permissions: Set<string>,
  ): Promise<void> {
    if (!this.enabled || !tenantId) return;

    try {
      const epoch = await this.epoch(tenantId);
      if (!epoch) return;
      await this.redis.set(
        `perm:${tenantId}:${epoch}:${userId}`,
        JSON.stringify([...permissions]),
        TTL_SECONDS,
      );
    } catch (error) {
      this.logger.debug(
        `permission cache write failed for ${userId}: ${(error as Error).message}`,
      );
    }
  }

  /**
   * Invalidate every cached set in a tenant. One `INCR`.
   *
   * Call this from any mutation that can change what anyone in the tenant is
   * allowed to do. Over-calling it costs one query per active user; under-
   * calling it is a privilege that outlives its revocation, so when in doubt,
   * call it.
   *
   * It never throws. A failed bump is logged at **error** rather than debug —
   * unlike a failed read, it is not benign: it leaves stale grants readable
   * until their TTL expires, and whoever performed the revocation has already
   * been told it succeeded.
   */
  async bumpTenant(tenantId: string | undefined | null): Promise<void> {
    if (!this.enabled || !tenantId) return;

    try {
      const next = await this.redis.increment(this.epochKey(tenantId));
      // The epoch itself must not expire while entries keyed on it are still
      // alive — an evicted epoch falls back to '0' and could collide with
      // entries written under an earlier '0'. Keeping it an order of magnitude
      // longer than the entry TTL makes that unreachable.
      await this.redis.expire(this.epochKey(tenantId), TTL_SECONDS * 100);
      this.logger.debug(`permission epoch for tenant ${tenantId} → ${next}`);
    } catch (error) {
      this.logger.error(
        `Could not bump the permission epoch for tenant ${tenantId}: ` +
          `${(error as Error).message}. Stale permission sets may be served ` +
          `for up to ${TTL_SECONDS}s.`,
      );
    }
  }

  /**
   * Invalidate every cached set on the platform.
   *
   * For changes to a **system role** (`roles.tenantId IS NULL`), which every
   * tenant may hold — the per-tenant epoch cannot reach those, and a system
   * role's permission set is exactly the kind of change that must not linger.
   * Also the correct call for a change to the permission catalogue itself.
   *
   * Coarse by design and rare in practice: a system role is edited by a
   * platform operator, not in normal use.
   */
  async bumpGlobal(): Promise<void> {
    if (!this.enabled) return;

    try {
      const next = await this.redis.increment(
        PermissionCacheService.GLOBAL_EPOCH_KEY,
      );
      await this.redis.expire(
        PermissionCacheService.GLOBAL_EPOCH_KEY,
        TTL_SECONDS * 100,
      );
      this.logger.log(`global permission epoch → ${next}`);
    } catch (error) {
      this.logger.error(
        `Could not bump the global permission epoch: ${(error as Error).message}. ` +
          `Stale permission sets may be served for up to ${TTL_SECONDS}s.`,
      );
    }
  }

  /** For diagnostics and the guard script — not used on any request path. */
  getTtlSeconds(): number {
    return TTL_SECONDS;
  }
}
