import { Entity, Column, ManyToOne, JoinColumn, Index } from 'typeorm';
import { BaseEntity } from '../../../common/entities/base.entity';
import { User } from '../../users/entities/user.entity';

export enum NotificationType {
  ALARM = 'alarm',
  DEVICE = 'device',
  SYSTEM = 'system',
  USER = 'user',
  REPORT = 'report',
}

export enum NotificationChannel {
  EMAIL = 'email',
  SMS = 'sms',
  PUSH = 'push',
  WEBHOOK = 'webhook',
  IN_APP = 'in_app',
}

export enum NotificationPriority {
  LOW = 'low',
  NORMAL = 'normal',
  HIGH = 'high',
  URGENT = 'urgent',
}

export enum NotificationStatus {
  PENDING = 'pending',
  SENT = 'sent',
  DELIVERED = 'delivered',
  FAILED = 'failed',
  READ = 'read',
}

@Entity('notifications')
@Index(['userId', 'status'])
@Index(['userId', 'isRead'])
@Index(['type', 'createdAt'])
export class Notification extends BaseEntity {
  @Column()
  userId: string;

  @ManyToOne(() => User)
  @JoinColumn({ name: 'userId' })
  user: User;

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

  // HTML content for emails
  @Column({ type: 'text', nullable: true })
  htmlContent?: string;

  // Related entity information
  @Column({ nullable: true })
  relatedEntityType?: string; // 'alarm', 'device', 'user', etc.

  @Column({ nullable: true })
  relatedEntityId?: string;

  // For actions/links in notifications
  @Column({ type: 'jsonb', nullable: true })
  action?: {
    label: string;
    url: string;
    type?: 'link' | 'button';
  };

  // Additional data
  @Column({ type: 'jsonb', nullable: true })
  metadata?: Record<string, any>;

  // Delivery details
  @Column({ nullable: true })
  recipientEmail?: string;

  @Column({ nullable: true })
  recipientPhone?: string;

  @Column({ nullable: true })
  recipientDeviceToken?: string; // For push notifications

  @Column({ nullable: true })
  webhookUrl?: string;

  // Tracking
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
  scheduledFor?: Date; // For scheduled notifications

  @Column({ type: 'timestamp', nullable: true })
  expiresAt?: Date; // When notification expires

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
}
