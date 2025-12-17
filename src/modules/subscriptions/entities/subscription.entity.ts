import { Entity, Column, Index } from 'typeorm';
import { BaseEntity } from '../../../common/entities/base.entity';

export enum SubscriptionPlan {
  FREE = 'free',
  STARTER = 'starter',
  PROFESSIONAL = 'professional',
  ENTERPRISE = 'enterprise',
}

export enum SubscriptionStatus {
  ACTIVE = 'active',
  CANCELLED = 'cancelled',
  EXPIRED = 'expired',
  TRIAL = 'trial',
}

export enum BillingPeriod {
  MONTHLY = 'monthly',
  YEARLY = 'yearly',
}

@Entity('subscriptions')
@Index(['userId', 'status'])
// @Index(['tenantId'])
export class Subscription extends BaseEntity {
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
  limits: {
    devices: number;
    users: number;
    apiCalls: number;
    dataRetention: number;
    storage: number;
  };

  @Column({ type: 'jsonb' })
  usage: {
    devices: number;
    users: number;
    apiCalls: number;
    storage: number;
  };

  @Column({ type: 'jsonb', nullable: true })
  features: {
    analytics: boolean;
    automation: boolean;
    integrations: boolean;
    support: string;
    whiteLabel: boolean;
  };

  @Column({ type: 'jsonb', nullable: true })
  metadata?: {
    scheduledDowngrade?: {
      plan: SubscriptionPlan;
      effectiveDate: Date | undefined;
    };
    [key: string]: any;
  };

  @Column({ name: 'next_billing_date', type: 'timestamp', nullable: true })
  nextBillingDate?: Date;

  @Column({ name: 'trial_ends_at', type: 'timestamp', nullable: true })
  trialEndsAt?: Date;

  @Column({ name: 'cancelled_at', type: 'timestamp', nullable: true })
  cancelledAt?: Date;

  @Column({ name: 'user_id' })
  @Index()
  userId: string;

  @Column({ name: 'tenant_id', nullable: true })
  @Index()
  tenantId?: string;
}