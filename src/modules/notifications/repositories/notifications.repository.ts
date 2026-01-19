// src/modules/notifications/repositories/notifications.repository.ts
import { Injectable } from '@nestjs/common';
import { DataSource, Repository } from 'typeorm';
import {
  Notification,
  NotificationStatus,
} from '../entities/notification.entity';
import { User, UserRole } from '../../users/entities/user.entity';

@Injectable()
export class NotificationsRepository extends Repository<Notification> {
  constructor(private dataSource: DataSource) {
    super(Notification, dataSource.createEntityManager());
  }

  /**
   * ✅ NEW: Build query with proper tenant/customer filtering
   */
  private applyAccessControl(
    queryBuilder: any,
    user: User,
    alias: string = 'notification',
  ) {
    if (user.role === UserRole.SUPER_ADMIN) {
      // Super admin sees everything
      return queryBuilder;
    }

    if (user.role === UserRole.TENANT_ADMIN) {
      // Tenant admin sees all notifications in their tenant
      queryBuilder.andWhere(`${alias}.tenantId = :tenantId`, {
        tenantId: user.tenantId,
      });
    } else if (user.role === UserRole.CUSTOMER_ADMIN) {
      // Customer admin sees notifications for their customer
      queryBuilder.andWhere(`${alias}.customerId = :customerId`, {
        customerId: user.customerId,
      });
    } else if (user.role === UserRole.CUSTOMER_USER) {
      // Customer user sees only their own notifications
      queryBuilder.andWhere(`${alias}.userId = :userId`, {
        userId: user.id,
      });
    } else {
      // Regular user sees only their own
      queryBuilder.andWhere(`${alias}.userId = :userId`, {
        userId: user.id,
      });
    }

    return queryBuilder;
  }

  /**
   * Find pending notifications with access control
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
      .orderBy('notification.priority', 'ASC')
      .addOrderBy('notification.createdAt', 'ASC')
      .take(100)
      .getMany();
  }

  /**
   * ✅ NEW: Get unread count with access control
   */
  async getUnreadCountForUser(user: User): Promise<number> {
    const queryBuilder = this.createQueryBuilder('notification').where(
      'notification.isRead = :isRead',
      { isRead: false },
    );

    this.applyAccessControl(queryBuilder, user);

    return await queryBuilder.getCount();
  }

  /**
   * ✅ NEW: Find all with access control
   */
  async findAllForUser(user: User, options: any): Promise<Notification[]> {
    const queryBuilder = this.createQueryBuilder('notification');

    this.applyAccessControl(queryBuilder, user);

    // Apply additional filters
    if (options.type) {
      queryBuilder.andWhere('notification.type = :type', { type: options.type });
    }

    if (options.status) {
      queryBuilder.andWhere('notification.status = :status', {
        status: options.status,
      });
    }

    if (options.isRead !== undefined) {
      queryBuilder.andWhere('notification.isRead = :isRead', {
        isRead: options.isRead,
      });
    }

    queryBuilder
      .orderBy('notification.createdAt', 'DESC')
      .skip(options.skip)
      .take(options.take);

    return await queryBuilder.getMany();
  }

  /**
   * ✅ NEW: Get count for user with filters
   */
  async getCountForUser(user: User, options: any): Promise<number> {
    const queryBuilder = this.createQueryBuilder('notification');

    this.applyAccessControl(queryBuilder, user);

    if (options.type) {
      queryBuilder.andWhere('notification.type = :type', { type: options.type });
    }

    if (options.status) {
      queryBuilder.andWhere('notification.status = :status', {
        status: options.status,
      });
    }

    if (options.isRead !== undefined) {
      queryBuilder.andWhere('notification.isRead = :isRead', {
        isRead: options.isRead,
      });
    }

    return await queryBuilder.getCount();
  }

  /**
   * Find retryable notifications
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
}