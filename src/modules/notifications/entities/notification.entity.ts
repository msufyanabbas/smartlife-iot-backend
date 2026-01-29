// src/modules/notifications/entities/notification.entity.ts
import { Entity, Column, ManyToOne, JoinColumn, Index } from 'typeorm';
import { NotificationChannel, NotificationPriority, NotificationStatus, NotificationType } from '@common/enums/index.enum';
import { BaseEntity } from '@common/entities/base.entity';
import { User } from '@modules/index.entities';
@Entity('notifications')
@Index(['userId', 'status'])
@Index(['userId', 'isRead'])
@Index(['type', 'createdAt'])
@Index(['tenantId', 'createdAt']) 
@Index(['customerId', 'createdAt']) 
export class Notification extends BaseEntity {
  @Column()
  userId: string;

  @ManyToOne(() => User)
  @JoinColumn({ name: 'userId' })
  user: User;

  // ✅ NEW: Tenant and Customer tracking
  @Column()
  tenantId: string;

  @Column({ nullable: true })
  customerId?: string;

  @Column({
    type: 'enum',
    enum: NotificationType,
    default: NotificationType.SYSTEM,
  })
  type: NotificationType;

  @Column({ type: 'enum', enum: NotificationChannel })
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

  @Column()
  title: string;

  @Column({ type: 'text' })
  message: string;

  @Column({ type: 'text', nullable: true })
  htmlContent?: string;

  @Column({ nullable: true })
  relatedEntityType?: string;

  @Column({ nullable: true })
  relatedEntityId?: string;

  @Column({ type: 'jsonb', nullable: true })
  action?: {
    label: string;
    url: string;
    type?: 'link' | 'button';
  };

  @Column({ type: 'jsonb', nullable: true })
  metadata?: Record<string, any>;

  @Column({ nullable: true })
  recipientEmail?: string;

  @Column({ nullable: true })
  recipientPhone?: string;

  @Column({ nullable: true })
  recipientDeviceToken?: string;

  @Column({ nullable: true })
  webhookUrl?: string;

  @Column({ default: false })
  isRead: boolean;

  @Column({ type: 'timestamp', nullable: true })
  readAt?: Date;

  @Column({ type: 'timestamp', nullable: true })
  sentAt?: Date;

  @Column({ type: 'timestamp', nullable: true })
  deliveredAt?: Date;

  @Column({ type: 'timestamp', nullable: true })
  failedAt?: Date;

  @Column({ type: 'text', nullable: true })
  errorMessage?: string;

  @Column({ type: 'int', default: 0 })
  retryCount: number;

  @Column({ type: 'int', default: 3 })
  maxRetries: number;

  @Column({ type: 'timestamp', nullable: true })
  scheduledFor?: Date;

  @Column({ type: 'timestamp', nullable: true })
  expiresAt?: Date;

  // Helper methods
  markAsRead(): void {
    this.isRead = true;
    this.readAt = new Date();
    if (this.status === NotificationStatus.DELIVERED) {
      this.status = NotificationStatus.READ;
    }
  }

  markAsSent(): void {
    this.status = NotificationStatus.SENT;
    this.sentAt = new Date();
  }

  markAsDelivered(): void {
    this.status = NotificationStatus.DELIVERED;
    this.deliveredAt = new Date();
  }

  markAsFailed(error: string): void {
    this.status = NotificationStatus.FAILED;
    this.failedAt = new Date();
    this.errorMessage = error;
    this.retryCount++;
  }

  canRetry(): boolean {
    return this.retryCount < this.maxRetries;
  }

  isExpired(): boolean {
    return this.expiresAt ? new Date() > this.expiresAt : false;
  }

  // ✅ NEW: Check if user can access this notification
  canBeAccessedBy(user: User): boolean {
    // User owns the notification
    if (this.userId === user.id) return true;

    // Tenant admin can see all notifications in their tenant
    if (user.role === 'tenant_admin' && this.tenantId === user.tenantId) {
      return true;
    }

    // Customer admin can see notifications for their customer
    if (
      user.role === 'customer_admin' &&
      this.customerId === user.customerId
    ) {
      return true;
    }

    return false;
  }
}