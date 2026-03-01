// src/modules/subscriptions/entities/subscription.entity.ts
import { Entity, Column, Index, OneToOne, JoinColumn, Unique } from 'typeorm';
import { BaseEntity } from '@common/entities/base.entity';
import { Tenant } from '@modules/index.entities';
import { SubscriptionPlan, SubscriptionStatus, BillingPeriod } from '@common/enums/index.enum';
import { EMPTY_USAGE, type SubscriptionFeatures, type SubscriptionLimits, type SubscriptionUsage, USAGE_TO_LIMIT_KEY } from '@/common/interfaces/index.interface';
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

  @OneToOne(() => Tenant, (tenant) => tenant.subscription, {
    onDelete: 'CASCADE',
  })
  @JoinColumn({ name: 'tenantId' })
  tenant: Tenant;

  // ── Plan & Status ──────────────────────────────────────────────────────────
  @Column({ type: 'enum', enum: SubscriptionPlan, default: SubscriptionPlan.FREE })
  plan: SubscriptionPlan;

  @Column({ type: 'enum', enum: SubscriptionStatus, default: SubscriptionStatus.ACTIVE })
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
  @Column({ type: 'jsonb', nullable: true })
  metadata?: {
    scheduledDowngrade?: {
      plan: SubscriptionPlan;
      effectiveDate: Date;
    };
    lastUsageReset?: Date;
    paymentProvider?: string;
    externalSubscriptionId?: string; // e.g. Moyasar subscription ID
    [key: string]: any;
  };

    // ── Helper Methods ─────────────────────────────────────────────────────────

  /**
   * Returns true if the subscription is in a usable state.
   * Both ACTIVE and TRIAL are considered active (until trial expires).
   */
  isActive(): boolean {
    return (
      this.status === SubscriptionStatus.ACTIVE ||
      this.status === SubscriptionStatus.TRIAL
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