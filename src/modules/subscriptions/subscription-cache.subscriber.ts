import { Injectable, Logger } from '@nestjs/common';
import {
  DataSource,
  EntitySubscriberInterface,
  InsertEvent,
  RemoveEvent,
  SoftRemoveEvent,
  UpdateEvent,
} from 'typeorm';
import { Subscription } from './entities/subscription.entity';
import { SubscriptionCacheService } from '@lib/redis/subscription-cache.service';

/**
 * ─────────────────────────────────────────────────────────────────────────────
 * Invalidation by ORM subscriber, not by 14 remembered call sites
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * `SubscriptionsService` writes the subscription row from **fourteen** places:
 * create, getOrCreateFree, upgrade, upgradeAfterPayment, renewAfterPayment,
 * scheduleDowngrade, cancelScheduledDowngrade, executeScheduledDowngrade,
 * cancel, startTrial, setAutoRenew, markRenewalPaymentFailed,
 * reverseAfterRefund, applyExpiry, downgradeToFree and processScheduledDowngrades
 * — some through `this.subscriptionRepository`, some through a transactional
 * `manager.getRepository()`.
 *
 * Adding `await cache.invalidate(tenantId)` after each one would work on the
 * day it was written and would then rot: the fifteenth write path would be
 * added by someone who has no reason to know a cache exists, and the symptom
 * would be a tenant served their previous plan for 30 seconds after an
 * upgrade — intermittent, unreproducible, and blamed on the payment provider.
 *
 * A subscriber attaches to the ORM instead, so every save goes through it by
 * construction. It covers paths in other modules too (`PaymentsService` and
 * the seeders both write this row).
 *
 * ## The two things a subscriber has to get right
 *
 * 1. **Transactions.** `afterUpdate` fires before `COMMIT`. Invalidating there
 *    alone leaves a window in which another request reads the row (still the
 *    old value, the transaction has not committed), caches it, and then the
 *    commit lands — leaving a cache entry that is stale for the full TTL and
 *    was written *after* the invalidation. So tenants touched inside a
 *    transaction are invalidated again on `afterTransactionCommit`.
 *
 * 2. **Raw SQL is invisible to it.** `incrementTenantUsage()` and
 *    `decrementTenantUsage()` issue `UPDATE subscriptions SET usage =
 *    jsonb_set(...)` through `dataSource.query()`, which does not go through
 *    the ORM and therefore fires no events. Those two call
 *    `SubscriptionCacheService.invalidate()` directly, and
 *    `npm run check:infra-wiring` asserts they still do.
 */
@Injectable()
export class SubscriptionCacheSubscriber
  implements EntitySubscriberInterface<Subscription>
{
  private readonly logger = new Logger(SubscriptionCacheSubscriber.name);

  /**
   * Tenants written inside an in-flight transaction, keyed by the query
   * runner that is running it — two concurrent transactions must not flush
   * each other's pending set.
   */
  private readonly pending = new WeakMap<object, Set<string>>();

  constructor(
    dataSource: DataSource,
    private readonly cache: SubscriptionCacheService,
  ) {
    // Nest's way of registering a subscriber that needs injection: TypeORM's
    // `subscribers` DataSource option only accepts classes it constructs
    // itself, which cannot receive SubscriptionCacheService.
    dataSource.subscribers.push(this);
  }

  listenTo(): typeof Subscription {
    return Subscription;
  }

  afterInsert(event: InsertEvent<Subscription>): void {
    this.note(event.queryRunner, event.entity?.tenantId);
  }

  afterUpdate(event: UpdateEvent<Subscription>): void {
    // `databaseEntity` is the row as it was BEFORE the update, and it is the
    // only place the tenant is guaranteed to appear: a partial update (a DTO
    // carrying only `status`) leaves `entity.tenantId` undefined, and
    // invalidating `undefined` is a silent no-op — the exact failure this
    // class exists to prevent.
    this.note(
      event.queryRunner,
      (event.entity as Subscription | undefined)?.tenantId ??
        event.databaseEntity?.tenantId,
    );
  }

  afterRemove(event: RemoveEvent<Subscription>): void {
    this.note(
      event.queryRunner,
      event.entity?.tenantId ?? event.databaseEntity?.tenantId,
    );
  }

  afterSoftRemove(event: SoftRemoveEvent<Subscription>): void {
    this.note(
      event.queryRunner,
      event.entity?.tenantId ?? event.databaseEntity?.tenantId,
    );
  }

  afterTransactionCommit(event: { queryRunner: object }): void {
    const tenants = this.pending.get(event.queryRunner);
    if (!tenants) return;
    this.pending.delete(event.queryRunner);
    for (const tenantId of tenants) void this.flush(tenantId);
  }

  afterTransactionRollback(event: { queryRunner: object }): void {
    // Nothing was committed, so nothing is stale. The already-issued
    // invalidation is harmless — it only costs the next reader one query.
    this.pending.delete(event.queryRunner);
  }

  /**
   * Invalidate now, and again after commit if this is inside a transaction.
   *
   * Invalidating twice is free; invalidating only after commit would leave the
   * stale entry readable for the length of the transaction.
   */
  private note(queryRunner: object | undefined, tenantId?: string): void {
    if (!tenantId) {
      this.logger.warn(
        'A subscriptions row was written with no resolvable tenantId — its ' +
          'cached copy could not be invalidated.',
      );
      return;
    }

    void this.flush(tenantId);

    if (queryRunner && (queryRunner as any).isTransactionActive) {
      const set = this.pending.get(queryRunner) ?? new Set<string>();
      set.add(tenantId);
      this.pending.set(queryRunner, set);
    }
  }

  private async flush(tenantId: string): Promise<void> {
    // `invalidate()` never throws, but this runs detached from any request, so
    // the guard is here rather than relying on that contract holding.
    await this.cache.invalidate(tenantId).catch((error: Error) =>
      this.logger.error(
        `Subscription cache invalidation failed for tenant ${tenantId}: ${error.message}`,
      ),
    );
  }
}
