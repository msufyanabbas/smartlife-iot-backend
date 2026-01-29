import { Entity, Column, Index, OneToOne, JoinColumn } from 'typeorm';
import { BaseEntity } from '@common/entities/base.entity';
import { Tenant } from '@modules/index.entities';
import { SubscriptionPlan, SubscriptionStatus, BillingPeriod } from '@common/enums/index.enum';
import type { SubscriptionFeatures, SubscriptionLimits } from '@/common/interfaces/index.interface';
@Entity('subscriptions')
@Index(['userId', 'status'])
@Index(['tenantId'])
export class Subscription extends BaseEntity {
  @Column({ name: 'tenant_id', nullable: true })
  tenantId?: string;

  @OneToOne(() => Tenant, tenant => tenant.subscription, {
    onDelete: 'CASCADE',
  })
  @JoinColumn({ name: 'tenantId' })
  tenant: Tenant;

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

  @Column({
    type: 'enum',
    enum: BillingPeriod,
    default: BillingPeriod.MONTHLY,
  })
  billingPeriod: BillingPeriod;

  @Column({ type: 'decimal', precision: 10, scale: 2, default: 0 })
  price: number;

  @Column({ type: 'jsonb' })
  limits: SubscriptionLimits;

  @Column({ type: 'jsonb' })
  usage: {
    devices: number;
    users: number;
    customers: number;
    apiCalls: number;
    storage: number;
    smsNotifications: number;
  };

  @Column({ type: 'jsonb' })
  features: SubscriptionFeatures;

  @Column({ type: 'jsonb', nullable: true })
  metadata?: {
    scheduledDowngrade?: {
      plan: SubscriptionPlan;
      effectiveDate: Date | undefined;
    };
    lastUsageReset?: Date;
    [key: string]: any;
  };

  @Column({ name: 'next_billing_date', type: 'timestamp', nullable: true })
  nextBillingDate?: Date;

  @Column({ name: 'trial_ends_at', type: 'timestamp', nullable: true })
  trialEndsAt?: Date;

  @Column({ name: 'cancelled_at', type: 'timestamp', nullable: true })
  cancelledAt?: Date;

  @Column({ name: 'user_id' })
  userId: string;

  // Helper method to check if unlimited
  isUnlimited(resource: keyof SubscriptionLimits): boolean {
    return (this.limits[resource] as number) === -1;
  }

  // Helper method to check if limit reached
  isLimitReached(
    resource: 'devices' | 'users' | 'customers' | 'apiCalls' | 'storage' | 'smsNotifications',
  ): boolean {
    const limit = this.getLimitValue(resource);
    if (limit === -1) return false; // unlimited
    return this.usage[resource] >= limit;
  }

  private getLimitValue(
    resource: 'devices' | 'users' | 'customers' | 'apiCalls' | 'storage' | 'smsNotifications',
  ): number {
    switch (resource) {
      case 'devices':
        return this.limits.devices;
      case 'users':
        return this.limits.users;
      case 'customers':
        return this.limits.customers;
      case 'apiCalls':
        return this.limits.apiCallsPerMonth;
      case 'storage':
        return this.limits.storageGB;
      case 'smsNotifications':
        return this.limits.smsNotificationsPerMonth;
      default:
        return 0;
    }
  }
}