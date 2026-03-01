// src/modules/payments/entities/payment.entity.ts
import { Entity, Column, Index, ManyToOne, JoinColumn } from 'typeorm';
import { BaseEntity } from '@common/entities/base.entity';
import { Tenant, User, Subscription } from '@/modules/index.entities';
import { PaymentMethod, PaymentProvider, PaymentStatus } from '@common/enums/index.enum'

@Entity('payments')
@Index(['userId', 'status'])
@Index(['subscriptionId'])
@Index(['paymentIntentId'])
@Index(['tenantId', 'status'])
@Index(['createdAt'])
export class Payment extends BaseEntity {
  // ══════════════════════════════════════════════════════════════════════════
  // TENANT SCOPING (REQUIRED)
  // ══════════════════════════════════════════════════════════════════════════

  @Column()
  @Index()
  tenantId: string;

  @ManyToOne(() => Tenant)
  @JoinColumn({ name: 'tenantId' })
  tenant: Tenant;

  // ══════════════════════════════════════════════════════════════════════════
  // USER & SUBSCRIPTION
  // ══════════════════════════════════════════════════════════════════════════
  
  @Column()
  @Index()
  userId: string;

  @ManyToOne(() => User)
  @JoinColumn({ name: 'userId' })
  user: User;  

  @Column()
  @Index()
  subscriptionId: string;

  @ManyToOne(() => Subscription)
  @JoinColumn({ name: 'subscriptionId' })
  subscription: Subscription;
  
  // ══════════════════════════════════════════════════════════════════════════
  // PAYMENT PROVIDER
  // ══════════════════════════════════════════════════════════════════════════
    
  @Column({ 
    type: 'enum', 
    enum: PaymentProvider, 
    default: PaymentProvider.MOYASAR 
  })
  provider: PaymentProvider;  

  @Column({ unique: true })
  @Index()
  paymentIntentId: string;  // Moyasar payment ID or Stripe payment intent ID

  @Column({ nullable: true })
  customerId?: string;  // Provider's customer ID

  // ══════════════════════════════════════════════════════════════════════════
  // PAYMENT DETAILS
  // ══════════════════════════════════════════════════════════════════════════
  
  @Column({ type: 'decimal', precision: 10, scale: 2 })
  amount: number;

  @Column({ length: 3, default: 'SAR' })
  currency: string;

  @Column({
    type: 'enum',
    enum: PaymentStatus,
    default: PaymentStatus.PENDING,
  })
  @Index()
  status: PaymentStatus;

  @Column({
    type: 'enum',
    enum: PaymentMethod,
    default: PaymentMethod.CARD,
  })
  method: PaymentMethod;

  @Column({ type: 'text', nullable: true })
  description?: string;

  // ══════════════════════════════════════════════════════════════════════════
  // METADATA
  // ══════════════════════════════════════════════════════════════════════════
    
  @Column({ type: 'jsonb', nullable: true })
  metadata?: {
    plan?: string;
    billingPeriod?: string;
    invoiceId?: string;
    refundId?: string;
    refundReason?: string;
    [key: string]: any;
  }; 

  // ══════════════════════════════════════════════════════════════════════════
  // TIMESTAMPS
  // ══════════════════════════════════════════════════════════════════════════
  
  @Column({ type: 'timestamp', nullable: true })
  paidAt?: Date;

  @Column({ type: 'timestamp', nullable: true })
  refundedAt?: Date;

  @Column({ type: 'text', nullable: true })
  failureReason?: string;

  // ══════════════════════════════════════════════════════════════════════════
  // HELPER METHODS
  // ══════════════════════════════════════════════════════════════════════════

  isPending(): boolean {
    return this.status === PaymentStatus.PENDING;
  }

  isSucceeded(): boolean {
    return this.status === PaymentStatus.SUCCEEDED;
  }

  isFailed(): boolean {
    return this.status === PaymentStatus.FAILED;
  }

  isRefunded(): boolean {
    return this.status === PaymentStatus.REFUNDED;
  }

  canRefund(): boolean {
    return this.status === PaymentStatus.SUCCEEDED;
  }

  markAsSucceeded(): void {
    this.status = PaymentStatus.SUCCEEDED;
    this.paidAt = new Date();
    this.failureReason = undefined;
  }

  markAsFailed(reason: string): void {
    this.status = PaymentStatus.FAILED;
    this.failureReason = reason;
  }

  markAsRefunded(refundId: string, reason?: string): void {
    this.status = PaymentStatus.REFUNDED;
    this.refundedAt = new Date();
    this.metadata = {
      ...this.metadata,
      refundId,
      refundReason: reason,
    };
  }
}