// src/modules/subscriptions/entities/subscription.entity.ts
import { Entity, Column, Index, OneToOne, JoinColumn, Unique } from 'typeorm';
import type { Relation } from 'typeorm';
import { BaseEntity } from '@common/entities/base.entity';
import type { Tenant } from '../../tenants/entities/tenant.entity';
import {
  SubscriptionPlan,
  SubscriptionStatus,
  BillingPeriod,
} from '@common/enums/index.enum';
import {
  EMPTY_USAGE,
  type SubscriptionFeatures,
  type SubscriptionLimits,
  type SubscriptionUsage,
  USAGE_TO_LIMIT_KEY,
} from '@/common/interfaces/index.interface';
@Entity('subscriptions')
@Unique(['tenantId'])
@Index(['status'])
export class Subscription extends BaseEntity {
  // ── Tenant Link ────────────────────────────────────────────────────────────
  // Subscription belongs to the TENANT org, not to any individual user.
  // The tenant admin is just the person who manages it — they're identified
  // by having role=TENANT_ADMIN and the same tenantId on their user row.
  @Column({ nullable: false })
  tenantId: string;

  @OneToOne('Tenant', 'subscription', {
    onDelete: 'CASCADE',
  })
  @JoinColumn({ name: 'tenantId' })
  tenant: Relation<Tenant>;

  // ── Plan & Status ──────────────────────────────────────────────────────────
  @Column({
    type: 'enum',
    enum: SubscriptionPlan,
    default: SubscriptionPlan.FREE,
  })
  plan: SubscriptionPlan;

  @Column({
    type: 'enum',
    enum: SubscriptionStatus,
    default: SubscriptionStatus.ACTIVE,
  })
  status: SubscriptionStatus;

  @Column({ type: 'enum', enum: BillingPeriod, default: BillingPeriod.MONTHLY })
  billingPeriod: BillingPeriod;

  @Column({ type: 'decimal', precision: 10, scale: 2, default: 0 })
  price: number;

  // ── Limits ─────────────────────────────────────────────────────────────────
  // Hard ceilings for this tenant across ALL their customers combined.
  // Individual customer ceilings live in Customer.allocatedLimits.
  // These never decrease below current usage — enforced in SubscriptionsService.
  @Column({ type: 'jsonb' })
  limits: SubscriptionLimits;

  // ── Usage Counters ─────────────────────────────────────────────────────────
  // Denormalized counters updated by AssignmentService inside transactions.
  // Reading these is always O(1) — no COUNT(*) ever needed in guards.
  @Column({
    type: 'jsonb',
    default: () => `'${JSON.stringify(EMPTY_USAGE)}'`,
  })
  usage: SubscriptionUsage;

  // ── Feature Flags ──────────────────────────────────────────────────────────
  // Controls which modules are available for this plan.
  // false → permissions for that resource hidden from API, assignment blocked.
  @Column({ type: 'jsonb' })
  features: SubscriptionFeatures;

  // ── Billing Dates ──────────────────────────────────────────────────────────
  @Column({ type: 'timestamp', nullable: true })
  nextBillingDate?: Date;

  @Column({ type: 'timestamp', nullable: true })
  trialEndsAt?: Date;

  @Column({ type: 'timestamp', nullable: true })
  cancelledAt?: Date;

  // ── Metadata ───────────────────────────────────────────────────────────────
  //
  // The whole subscription LIFECYCLE is recorded here rather than in new
  // columns: `metadata` is already jsonb, so none of this needs a migration,
  // and every key below is read through a helper on this class rather than
  // being poked at from a dozen call sites.
  @Column({ type: 'jsonb', nullable: true })
  metadata?: {
    scheduledDowngrade?: {
      plan: SubscriptionPlan;
      effectiveDate: Date;
    };
    lastUsageReset?: Date;
    paymentProvider?: string;
    externalSubscriptionId?: string; // e.g. Moyasar subscription ID

    /**
     * Auto-renew flag. ABSENT MEANS ON — every row written before this existed
     * was on a renewing subscription, so absent must not read as "off" (that
     * would silently stop renewing every existing tenant). Read it through
     * `isAutoRenewEnabled()`, never directly.
     */
    autoRenew?: boolean;

    /**
     * Trial ledger. `usedAt` is what stops a second trial — it survives
     * cancellation, expiry and renewal, unlike `trialEndsAt`, which
     * `renewAfterPayment()` clears.
     */
    trial?: {
      usedAt?: string;
      plan?: SubscriptionPlan;
      endsAt?: string;
      expiredAt?: string;
      /** Plan the tenant was on when the trial started; restored on expiry. */
      fromPlan?: SubscriptionPlan;
    };

    /**
     * The plan held immediately before the current one, written by
     * `upgradeAfterPayment()`. This is what a refund reverses TO; without it a
     * refund could only ever drop the tenant to FREE.
     */
    previousPlan?: {
      plan: SubscriptionPlan;
      billingPeriod: BillingPeriod;
      /** Period end of the plan being replaced, ISO. */
      nextBillingDate?: string | null;
      at: string;
      paymentId?: string;
    };

    /**
     * Payment-id keyed ledger of money events already applied to this
     * subscription. This is the renewal/upgrade idempotency key: a webhook
     * WILL be delivered twice, and a double-applied renewal is a month of
     * service given away.
     */
    appliedPayments?: Record<
      string,
      { kind: 'upgrade' | 'renewal'; at: string; periodEnd?: string | null }
    >;

    /** Payment ids whose plan change has already been reversed. */
    reversedPayments?: string[];

    /** Audit trail of refund/chargeback reversals, newest last. */
    reversals?: Array<{
      paymentId: string;
      kind: 'refund' | 'partial_refund' | 'chargeback' | 'void';
      at: string;
      fromPlan: SubscriptionPlan;
      toPlan: SubscriptionPlan;
      reason?: string;
      overQuota?: string[];
    }>;

    /**
     * Set when a renewal payment failed or the period ended with no renewal.
     * The plan is kept until `graceEndsAt`, then the sweep drops it to FREE.
     */
    pastDue?: {
      since: string;
      graceEndsAt: string;
      reason: string;
      attempts?: number;
    };

    /** Set by the sweep when a cancellation's paid period actually ran out. */
    cancellation?: { cancelledAt: string; completedAt?: string };

    [key: string]: any;
  };

  // ── Helper Methods ─────────────────────────────────────────────────────────

  /**
   * Auto-renew state. Absent → true (see the field doc).
   */
  isAutoRenewEnabled(): boolean {
    return this.metadata?.autoRenew !== false;
  }

  /**
   * True once this tenant has ever started a trial. Checked before granting
   * one, so cancelling and re-subscribing cannot farm a second trial.
   */
  hasUsedTrial(): boolean {
    return !!this.metadata?.trial?.usedAt;
  }

  /**
   * The date the tenant keeps paid access until, or null if it keeps renewing.
   * This is the "your plan ends on X" the frontend shows once auto-renew is off
   * or the subscription has been cancelled.
   */
  getAccessEndsAt(): Date | null {
    if (this.status === SubscriptionStatus.TRIAL && this.trialEndsAt) {
      return new Date(this.trialEndsAt);
    }
    if (this.plan === SubscriptionPlan.FREE) return null;
    if (this.status === SubscriptionStatus.CANCELLED || !this.isAutoRenewEnabled()) {
      return this.nextBillingDate ? new Date(this.nextBillingDate) : null;
    }
    if (this.metadata?.pastDue?.graceEndsAt) {
      return new Date(this.metadata.pastDue.graceEndsAt);
    }
    return null;
  }

  isPastDue(): boolean {
    return !!this.metadata?.pastDue;
  }

  /**
   * Usage keys that are over their plan limit RIGHT NOW.
   *
   * A downgrade (scheduled, refunded or swept) never deletes resources, so a
   * tenant can legitimately sit above the ceiling of the plan they are on. The
   * guards already handle that correctly — `isLimitReached()` blocks NEW
   * creation while every read path is untouched — and this is what reports it.
   */
  getOverQuotaResources(): Array<keyof SubscriptionUsage> {
    const over: Array<keyof SubscriptionUsage> = [];
    for (const key of Object.keys(this.usage ?? {}) as Array<
      keyof SubscriptionUsage
    >) {
      const limitKey = USAGE_TO_LIMIT_KEY[key];
      if (!limitKey) continue;
      const limit = this.limits?.[limitKey] as number | undefined;
      if (limit === undefined || limit === -1) continue;
      if ((this.usage[key] ?? 0) > limit) over.push(key);
    }
    return over;
  }

  /**
   * Returns true if the subscription is in a usable state.
   * Both ACTIVE and TRIAL are considered active (until trial expires).
   *
   * CANCELLED counts too, but only while the period the tenant has already
   * PAID FOR is still running. `POST /subscriptions/cancel` is documented as
   * "access continues until end of billing period", and the expiry sweep is
   * what actually ends it — without this clause, clicking cancel locked the
   * tenant out of their own data instantly (every guard rejects a subscription
   * that fails this check, reads included) while the billing screen told them
   * they kept their features until the period end. Once the period passes the
   * sweep moves the row to FREE/ACTIVE, so this window cannot be used to keep
   * a cancelled plan alive.
   */
  isActive(): boolean {
    if (
      this.status === SubscriptionStatus.ACTIVE ||
      this.status === SubscriptionStatus.TRIAL
    ) {
      return true;
    }

    return (
      this.status === SubscriptionStatus.CANCELLED &&
      !!this.nextBillingDate &&
      new Date(this.nextBillingDate) > new Date()
    );
  }

  /**
   * Returns true if the trial period has ended.
   * Only meaningful when status === TRIAL.
   */
  isTrialExpired(): boolean {
    if (this.status !== SubscriptionStatus.TRIAL) return false;
    if (!this.trialEndsAt) return false;
    return new Date() > new Date(this.trialEndsAt);
  }

  /**
   * Returns true if a resource limit is -1 (unlimited).
   * Used by SubscriptionGuard to skip quota checks for enterprise plans.
   */
  isUnlimited(resource: keyof SubscriptionUsage): boolean {
    const limitKey = USAGE_TO_LIMIT_KEY[resource];
    return (this.limits[limitKey] as number) === -1;
  }

  /**
   * Returns true if the current usage has reached or exceeded the plan limit.
   * Used by SubscriptionLimitGuard and AssignmentService (Gate 2).
   *
   * @param resource — a key from SubscriptionUsage (e.g. 'devices', 'apiCalls')
   */
  isLimitReached(resource: keyof SubscriptionUsage): boolean {
    if (this.isUnlimited(resource)) return false;
    const limitKey = USAGE_TO_LIMIT_KEY[resource];
    const limit = this.limits[limitKey] as number;
    const current = this.usage[resource] ?? 0;
    return current >= limit;
  }

  /**
   * Returns the number of remaining slots for a resource.
   * Returns Infinity if the resource is unlimited.
   * Returns 0 if at or over the limit.
   *
   * Used in error messages to tell the user how many slots remain.
   */
  getRemainingCapacity(resource: keyof SubscriptionUsage): number {
    if (this.isUnlimited(resource)) return Infinity;
    const limitKey = USAGE_TO_LIMIT_KEY[resource];
    const limit = this.limits[limitKey] as number;
    const current = this.usage[resource] ?? 0;
    return Math.max(0, limit - current);
  }

  /**
   * Returns true if a feature/module is enabled in this plan.
   * Missing keys default to true (available) — only explicitly set false keys
   * are treated as disabled.
   *
   * Used by FeatureGuard and AssignmentService (Gate 1).
   */
  hasFeature(feature: keyof SubscriptionFeatures): boolean {
    if (!(feature in this.features)) return true; // missing = available
    return this.features[feature] === true;
  }

  /**
   * Returns the raw limit number for a resource.
   * -1 means unlimited. Useful for display in UI.
   */
  getLimitValue(resource: keyof SubscriptionUsage): number {
    const limitKey = USAGE_TO_LIMIT_KEY[resource];
    return this.limits[limitKey] as number;
  }
}
