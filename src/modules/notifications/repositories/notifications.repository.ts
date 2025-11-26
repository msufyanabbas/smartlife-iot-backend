import { Injectable } from '@nestjs/common';
import { DataSource, Repository } from 'typeorm';
import {
  Notification,
  NotificationStatus,
} from '../entities/notification.entity';

/**
 * Custom repository for complex notification queries
 */
@Injectable()
export class NotificationsRepository extends Repository<Notification> {
  constructor(private dataSource: DataSource) {
    super(Notification, dataSource.createEntityManager());
  }

  /**
   * Find pending notifications that should be sent now
   */
  async findPendingToSend(): Promise<Notification[]> {
    return await this.createQueryBuilder('notification')
      .where('notification.status = :status', {
        status: NotificationStatus.PENDING,
      })
      .andWhere(
        '(notification.scheduledFor IS NULL OR notification.scheduledFor <= NOW())',
      )
      .andWhere(
        '(notification.expiresAt IS NULL OR notification.expiresAt > NOW())',
      )
      .orderBy('notification.priority', 'ASC') // Urgent first
      .addOrderBy('notification.createdAt', 'ASC') // Oldest first
      .take(100) // Process in batches
      .getMany();
  }

  /**
   * Find failed notifications that can be retried
   */
  async findRetryable(): Promise<Notification[]> {
    return await this.createQueryBuilder('notification')
      .where('notification.status = :status', {
        status: NotificationStatus.FAILED,
      })
      .andWhere('notification.retryCount < notification.maxRetries')
      .andWhere(
        '(notification.expiresAt IS NULL OR notification.expiresAt > NOW())',
      )
      .orderBy('notification.failedAt', 'ASC')
      .take(50)
      .getMany();
  }

  /**
   * Get unread count for user
   */
  async getUnreadCount(userId: string): Promise<number> {
    return await this.count({
      where: {
        userId,
        isRead: false,
      },
    });
  }

  /**
   * Mark notifications as read
   */
  async markAsRead(notificationIds: string[]): Promise<void> {
    await this.createQueryBuilder()
      .update(Notification)
      .set({ isRead: true, readAt: new Date() })
      .where('id IN (:...ids)', { ids: notificationIds })
      .execute();
  }

  /**
   * Delete old read notifications
   */
  async deleteOldRead(daysOld: number = 30): Promise<number> {
    const cutoffDate = new Date();
    cutoffDate.setDate(cutoffDate.getDate() - daysOld);

    const result = await this.createQueryBuilder()
      .delete()
      .from(Notification)
      .where('isRead = :isRead', { isRead: true })
      .andWhere('readAt < :cutoffDate', { cutoffDate })
      .execute();

    return result.affected || 0;
  }

  /**
   * Get notification statistics by channel
   */
  async getChannelStatistics(userId: string): Promise<any[]> {
    return await this.createQueryBuilder('notification')
      .select('notification.channel', 'channel')
      .addSelect('COUNT(*)', 'count')
      .addSelect(
        'SUM(CASE WHEN notification.status = :delivered THEN 1 ELSE 0 END)',
        'delivered',
      )
      .addSelect(
        'SUM(CASE WHEN notification.status = :failed THEN 1 ELSE 0 END)',
        'failed',
      )
      .where('notification.userId = :userId', { userId })
      .setParameter('delivered', NotificationStatus.DELIVERED)
      .setParameter('failed', NotificationStatus.FAILED)
      .groupBy('notification.channel')
      .getRawMany();
  }

  /**
   * Find notifications by related entity
   */
  async findByRelatedEntity(
    relatedEntityType: string,
    relatedEntityId: string,
  ): Promise<Notification[]> {
    return await this.find({
      where: {
        relatedEntityType,
        relatedEntityId,
      },
      order: { createdAt: 'DESC' },
    });
  }
}
