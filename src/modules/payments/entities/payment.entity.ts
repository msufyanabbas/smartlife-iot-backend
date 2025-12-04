// src/modules/payments/entities/payment.entity.ts
import { Entity, Column, Index } from 'typeorm';
import { BaseEntity } from '../../../common/entities/base.entity';

export enum PaymentStatus {
  PENDING = 'pending',
  SUCCEEDED = 'succeeded',
  FAILED = 'failed',
  REFUNDED = 'refunded',
  CANCELLED = 'cancelled',
}

export enum PaymentMethod {
  CARD = 'card',
  MADA = 'mada',
  APPLE_PAY = 'apple_pay',
  STC_PAY = 'stc_pay',
  OTHER = 'other',
}

export enum PaymentProvider {
  MOYASAR = 'moyasar',
  STRIPE = 'stripe',
}

@Entity('payments')
@Index(['userId', 'status'])
@Index(['subscriptionId'])
@Index(['paymentIntentId'])
export class Payment extends BaseEntity {
  @Column({ name: 'user_id' })
  @Index()
  userId: string;

  @Column({ name: 'subscription_id' })
  subscriptionId: string;

  // Renamed for flexibility (works with both Moyasar and Stripe)
  @Column({ name: 'payment_intent_id', unique: true })
  paymentIntentId: string;

  @Column({ name: 'customer_id', nullable: true })
  customerId?: string;

  @Column({ 
    type: 'enum', 
    enum: PaymentProvider, 
    default: PaymentProvider.MOYASAR 
  })
  provider: PaymentProvider;

  @Column({ type: 'decimal', precision: 10, scale: 2 })
  amount: number;

  @Column({ length: 3, default: 'SAR' })
  currency: string;

  @Column({
    type: 'enum',
    enum: PaymentStatus,
    default: PaymentStatus.PENDING,
  })
  status: PaymentStatus;

  @Column({
    type: 'enum',
    enum: PaymentMethod,
    default: PaymentMethod.CARD,
  })
  method: PaymentMethod;

  @Column({ type: 'text', nullable: true })
  description?: string;

  @Column({ type: 'jsonb', nullable: true })
  metadata?: {
    plan?: string;
    billingPeriod?: string;
    invoiceId?: string;
    refundId?: string;
    refundReason?: string;
    [key: string]: any;
  };

  @Column({ name: 'paid_at', type: 'timestamp', nullable: true })
  paidAt?: Date;

  @Column({ name: 'refunded_at', type: 'timestamp', nullable: true })
  refundedAt?: Date;

  @Column({ name: 'failure_reason', type: 'text', nullable: true })
  failureReason?: string;
}