// src/modules/notifications/entities/notification.entity.ts
import { Entity, Column, ManyToOne, JoinColumn, Index } from 'typeorm';
import {
  NotificationChannel,
  NotificationPriority,
  NotificationStatus,
  NotificationType,
} from '@common/enums/index.enum';
import { BaseEntity } from '@common/entities/base.entity';
import { User, Tenant, Customer } from '@modules/index.entities';

@Entity('notifications')
@Index(['userId', 'status'])
@Index(['userId', 'isRead'])
@Index(['type', 'createdAt'])
@Index(['tenantId', 'createdAt'])
@Index(['customerId', 'createdAt'])
@Index(['tenantId', 'userId'])
@Index(['scheduledFor'])
@Index(['status', 'scheduledFor'])
export class Notification extends BaseEntity {
  // ══════════════════════════════════════════════════════════════════════════
  // TENANT SCOPING (REQUIRED)
  // ══════════════════════════════════════════════════════════════════════════

  @Column()

  tenantId: string;

  @ManyToOne(() => Tenant)
  @JoinColumn({ name: 'tenantId' })
  tenant: Tenant;

  // ══════════════════════════════════════════════════════════════════════════
  // CUSTOMER SCOPING (OPTIONAL)
  // ══════════════════════════════════════════════════════════════════════════

  @Column({ nullable: true })

  customerId?: string;

  @ManyToOne(() => Customer, { nullable: true })
  @JoinColumn({ name: 'customerId' })
  customer?: Customer;

  // ══════════════════════════════════════════════════════════════════════════
  // USER (RECIPIENT)
  // ══════════════════════════════════════════════════════════════════════════

  @Column()

  userId: string;

  @ManyToOne(() => User, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'userId' })
  user: User;

  // ══════════════════════════════════════════════════════════════════════════
  // NOTIFICATION CLASSIFICATION
  // ══════════════════════════════════════════════════════════════════════════

  @Column({
    type: 'enum',
    enum: NotificationType,
    default: NotificationType.SYSTEM,
  })

  type: NotificationType;

  @Column({
    type: 'enum',
    enum: NotificationChannel,
  })

  channel: NotificationChannel;

  @Column({
    type: 'enum',
    enum: NotificationPriority,
    default: NotificationPriority.NORMAL,
  })

  priority: NotificationPriority;

  @Column({
    type: 'enum',
    enum: NotificationStatus,
    default: NotificationStatus.PENDING,
  })

  status: NotificationStatus;

  // ══════════════════════════════════════════════════════════════════════════
  // NOTIFICATION CONTENT
  // ══════════════════════════════════════════════════════════════════════════

  @Column()
  title: string;

  @Column({ type: 'text' })
  message: string;

  @Column({ type: 'text', nullable: true })
  htmlContent?: string;

  // ══════════════════════════════════════════════════════════════════════════
  // RELATED ENTITY (OPTIONAL)
  // ══════════════════════════════════════════════════════════════════════════

  @Column({ nullable: true })

  relatedEntityType?: string;

  @Column({ nullable: true })

  relatedEntityId?: string;

  // ══════════════════════════════════════════════════════════════════════════
  // ACTION (OPTIONAL)
  // ══════════════════════════════════════════════════════════════════════════

  @Column({ type: 'jsonb', nullable: true })
  action?: {
    label: string;
    url: string;
    type?: 'link' | 'button';
  };

  @Column({ type: 'jsonb', nullable: true })
  metadata?: Record<string, any>;

  // ══════════════════════════════════════════════════════════════════════════
  // DELIVERY DETAILS
  // ══════════════════════════════════════════════════════════════════════════

  @Column({ nullable: true })
  recipientEmail?: string;

  @Column({ nullable: true })
  recipientPhone?: string;

  @Column({ nullable: true })
  recipientDeviceToken?: string;

  @Column({ nullable: true })
  webhookUrl?: string;

  // ══════════════════════════════════════════════════════════════════════════
  // READ STATUS
  // ══════════════════════════════════════════════════════════════════════════

  @Column({ default: false })

  isRead: boolean;

  @Column({ type: 'timestamp', nullable: true })
  readAt?: Date;

  // ══════════════════════════════════════════════════════════════════════════
  // DELIVERY TRACKING
  // ══════════════════════════════════════════════════════════════════════════

  @Column({ type: 'timestamp', nullable: true })
  sentAt?: Date;

  @Column({ type: 'timestamp', nullable: true })
  deliveredAt?: Date;

  @Column({ type: 'timestamp', nullable: true })
  failedAt?: Date;

  @Column({ type: 'text', nullable: true })
  errorMessage?: string;

  // ══════════════════════════════════════════════════════════════════════════
  // RETRY LOGIC
  // ══════════════════════════════════════════════════════════════════════════

  @Column({ type: 'int', default: 0 })
  retryCount: number;

  @Column({ type: 'int', default: 3 })
  maxRetries: number;

  // ══════════════════════════════════════════════════════════════════════════
  // SCHEDULING
  // ══════════════════════════════════════════════════════════════════════════

  @Column({ type: 'timestamp', nullable: true })

  scheduledFor?: Date;

  @Column({ type: 'timestamp', nullable: true })
  expiresAt?: Date;

  // ══════════════════════════════════════════════════════════════════════════
  // HELPER METHODS
  // ══════════════════════════════════════════════════════════════════════════

  /**
   * Mark notification as read
   */
  markAsRead(): void {
    this.isRead = true;
    this.readAt = new Date();
    if (this.status === NotificationStatus.DELIVERED) {
      this.status = NotificationStatus.READ;
    }
  }

  /**
   * Mark notification as sent
   */
  markAsSent(): void {
    this.status = NotificationStatus.SENT;
    this.sentAt = new Date();
  }

  /**
   * Mark notification as delivered
   */
  markAsDelivered(): void {
    this.status = NotificationStatus.DELIVERED;
    this.deliveredAt = new Date();
  }

  /**
   * Mark notification as failed with error
   */
  markAsFailed(error: string): void {
    this.status = NotificationStatus.FAILED;
    this.failedAt = new Date();
    this.errorMessage = error;
    this.retryCount++;
  }

  /**
   * Check if notification can be retried
   */
  canRetry(): boolean {
    return (
      this.status === NotificationStatus.FAILED &&
      this.retryCount < this.maxRetries
    );
  }

  /**
   * Check if notification is expired
   */
  isExpired(): boolean {
    return this.expiresAt ? new Date() > this.expiresAt : false;
  }

  /**
   * Check if notification is scheduled for future
   */
  isScheduled(): boolean {
    return this.scheduledFor ? new Date() < this.scheduledFor : false;
  }

  /**
   * Check if user can access this notification
   */
  canBeAccessedBy(userTenantId?: string, userCustomerId?: string, userRole?: string): boolean {
    // Must be same tenant
    if (this.tenantId !== userTenantId) return false;

    // If notification has no customer, only tenant admins can see it
    if (!this.customerId && userRole !== 'TENANT_ADMIN') {
      return false;
    }

    // If notification is customer-scoped, user must be in that customer
    if (this.customerId && this.customerId !== userCustomerId) {
      return false;
    }

    return true;
  }

  /**
   * Get notification age in hours
   */
  getAgeInHours(): number {
    const now = new Date().getTime();
    const created = new Date(this.createdAt).getTime();
    return Math.floor((now - created) / (1000 * 60 * 60));
  }

  /**
   * Check if notification is urgent
   */
  isUrgent(): boolean {
    return this.priority === NotificationPriority.URGENT;
  }

  /**
   * Check if notification is pending
   */
  isPending(): boolean {
    return this.status === NotificationStatus.PENDING;
  }
}