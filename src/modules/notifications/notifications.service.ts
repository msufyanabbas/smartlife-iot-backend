import {
  Injectable,
  NotFoundException,
  BadRequestException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, In, LessThan, MoreThan } from 'typeorm';
import {
  Notification,
  NotificationStatus,
  NotificationChannel,
} from './entities/notification.entity';
import {
  CreateNotificationDto,
  NotificationQueryDto,
  MarkAsReadDto,
  SendBulkNotificationDto,
} from './dto/notification.dto';
import { EventEmitter2, OnEvent } from '@nestjs/event-emitter';
import { MailService } from '../../modules/mail/mail.service';
import { EmailChannel } from './channels/email.channel';
import { SmsChannel } from './channels/sms.channel';
import { PushChannel } from './channels/push.channel';

@Injectable()
export class NotificationsService {
  constructor(
    @InjectRepository(Notification)
    private notificationRepository: Repository<Notification>,
    private eventEmitter: EventEmitter2,
    private mailService: MailService,
    private emailChannel: EmailChannel,
    private smsChannel: SmsChannel,
    private pushChannel: PushChannel,
  ) {}

  /**
   * Create new notification
   */
  async create(createDto: CreateNotificationDto): Promise<Notification> {
    // Check if scheduled or immediate
    const isScheduled =
      createDto.scheduledFor && createDto.scheduledFor > new Date();

    const notification = this.notificationRepository.create({
      ...createDto,
      status: isScheduled
        ? NotificationStatus.PENDING
        : NotificationStatus.PENDING,
    });

    const saved = await this.notificationRepository.save(notification);

    // If not scheduled, send immediately
    if (!isScheduled) {
      await this.sendNotification(saved);
    }

    return saved;
  }

  /**
   * Send notification through appropriate channel
   */
  private async sendNotification(notification: Notification): Promise<void> {
    try {
      switch (notification.channel) {
        case NotificationChannel.EMAIL:
          await this.sendEmail(notification);
          break;

        case NotificationChannel.SMS:
          await this.sendSMS(notification);
          break;

        case NotificationChannel.PUSH:
          await this.sendPush(notification);
          break;

        case NotificationChannel.WEBHOOK:
          await this.sendWebhook(notification);
          break;

        case NotificationChannel.IN_APP:
          // In-app notifications are already saved, just mark as sent
          notification.markAsSent();
          notification.markAsDelivered();
          await this.notificationRepository.save(notification);
          break;

        default:
          throw new Error(`Unsupported channel: ${notification.channel}`);
      }

      // Emit event
      this.eventEmitter.emit('notification.sent', { notification });
    } catch (error) {
      notification.markAsFailed(error.message);
      await this.notificationRepository.save(notification);

      // Retry if possible
      if (notification.canRetry()) {
        this.eventEmitter.emit('notification.retry', { notification });
      }
    }
  }

  /**
   * Send email notification
   */
  private async sendEmail(notification: Notification): Promise<void> {
    await this.emailChannel.send(notification);
    notification.markAsSent();
    notification.markAsDelivered();
    await this.notificationRepository.save(notification);
  }

  /**
   * Send SMS notification (placeholder - implement with Twilio/AWS SNS)
   */
  private async sendSMS(notification: Notification): Promise<void> {
    await this.smsChannel.send(notification);
    notification.markAsSent();
    notification.markAsDelivered();
    await this.notificationRepository.save(notification);
  }

  /**
   * Send push notification (placeholder - implement with FCM/APNS)
   */
  private async sendPush(notification: Notification): Promise<void> {
    await this.pushChannel.send(notification);
    notification.markAsSent();
    notification.markAsDelivered();
    await this.notificationRepository.save(notification);
  }

  /**
   * Send webhook notification
   */
  private async sendWebhook(notification: Notification): Promise<void> {
    if (!notification.webhookUrl) {
      throw new Error('Webhook URL not provided');
    }

    // TODO: Implement HTTP POST to webhook
    console.log(`Sending webhook to ${notification.webhookUrl}`);

    notification.markAsSent();
    notification.markAsDelivered();
    await this.notificationRepository.save(notification);
  }

  /**
   * Find all notifications with filters
   */
  async findAll(userId: string, query: NotificationQueryDto) {
    const {
      page = 1,
      limit = 20,
      type,
      channel,
      status,
      isRead,
      search,
    } = query;

    const queryBuilder = this.notificationRepository
      .createQueryBuilder('notification')
      .where('notification.userId = :userId', { userId });

    // Filters
    if (type) {
      queryBuilder.andWhere('notification.type = :type', { type });
    }

    if (channel) {
      queryBuilder.andWhere('notification.channel = :channel', { channel });
    }

    if (status) {
      queryBuilder.andWhere('notification.status = :status', { status });
    }

    if (isRead !== undefined) {
      queryBuilder.andWhere('notification.isRead = :isRead', { isRead });
    }

    if (search) {
      queryBuilder.andWhere(
        '(notification.title ILIKE :search OR notification.message ILIKE :search)',
        { search: `%${search}%` },
      );
    }

    // Pagination
    const skip = (page - 1) * limit;
    queryBuilder.skip(skip).take(limit);

    // Order by priority and date
    queryBuilder
      .addOrderBy(
        `CASE notification.priority 
        WHEN 'urgent' THEN 1 
        WHEN 'high' THEN 2 
        WHEN 'normal' THEN 3 
        WHEN 'low' THEN 4 
        END`,
      )
      .addOrderBy('notification.createdAt', 'DESC');

    const [data, total] = await queryBuilder.getManyAndCount();

    return {
      data,
      total,
      page,
      limit,
      totalPages: Math.ceil(total / limit),
      unreadCount: await this.getUnreadCount(userId),
    };
  }

  /**
   * Get notification by ID
   */
  async findOne(id: string, userId: string): Promise<Notification> {
    const notification = await this.notificationRepository.findOne({
      where: { id, userId },
    });

    if (!notification) {
      throw new NotFoundException(`Notification with ID ${id} not found`);
    }

    return notification;
  }

  /**
   * Mark notification as read
   */
  async markAsRead(id: string, userId: string): Promise<Notification> {
    const notification = await this.findOne(id, userId);

    if (!notification.isRead) {
      notification.markAsRead();
      await this.notificationRepository.save(notification);
    }

    return notification;
  }

  /**
   * Mark multiple notifications as read
   */
  async markMultipleAsRead(
    userId: string,
    dto: MarkAsReadDto,
  ): Promise<{ success: number }> {
    const notifications = await this.notificationRepository.find({
      where: {
        id: In(dto.notificationIds),
        userId,
        isRead: false,
      },
    });

    for (const notification of notifications) {
      notification.markAsRead();
    }

    await this.notificationRepository.save(notifications);

    return { success: notifications.length };
  }

  /**
   * Mark all notifications as read
   */
  async markAllAsRead(userId: string): Promise<{ success: number }> {
    const result = await this.notificationRepository.update(
      { userId, isRead: false },
      { isRead: true, readAt: new Date() },
    );

    return { success: result.affected || 0 };
  }

  /**
   * Delete notification
   */
  async remove(id: string, userId: string): Promise<void> {
    const notification = await this.findOne(id, userId);
    await this.notificationRepository.softRemove(notification);
  }

  /**
   * Delete all read notifications
   */
  async deleteAllRead(userId: string): Promise<{ deleted: number }> {
    const notifications = await this.notificationRepository.find({
      where: { userId, isRead: true },
    });

    await this.notificationRepository.softRemove(notifications);

    return { deleted: notifications.length };
  }

  /**
   * Get unread count
   */
  async getUnreadCount(userId: string): Promise<number> {
    return await this.notificationRepository.count({
      where: { userId, isRead: false },
    });
  }

  /**
   * Get notification statistics
   */
  async getStatistics(userId: string) {
    const total = await this.notificationRepository.count({
      where: { userId },
    });
    const unread = await this.getUnreadCount(userId);
    const read = total - unread;

    // Count by type
    const byType = await this.notificationRepository
      .createQueryBuilder('notification')
      .select('notification.type', 'type')
      .addSelect('COUNT(*)', 'count')
      .where('notification.userId = :userId', { userId })
      .groupBy('notification.type')
      .getRawMany();

    // Count by channel
    const byChannel = await this.notificationRepository
      .createQueryBuilder('notification')
      .select('notification.channel', 'channel')
      .addSelect('COUNT(*)', 'count')
      .where('notification.userId = :userId', { userId })
      .groupBy('notification.channel')
      .getRawMany();

    return {
      total,
      unread,
      read,
      byType,
      byChannel,
    };
  }

  /**
   * Send bulk notifications
   */
  async sendBulk(dto: SendBulkNotificationDto): Promise<{ sent: number }> {
    const notifications = dto.userIds.map((userId) =>
      this.notificationRepository.create({
        userId,
        type: dto.type,
        channel: dto.channel,
        priority: dto.priority,
        title: dto.title,
        message: dto.message,
        htmlContent: dto.htmlContent,
        metadata: dto.metadata,
      }),
    );

    const saved = await this.notificationRepository.save(notifications);

    // Send all notifications
    for (const notification of saved) {
      await this.sendNotification(notification);
    }

    return { sent: saved.length };
  }

  /**
   * Process scheduled notifications (called by cron job)
   */
  async processScheduledNotifications(): Promise<void> {
    const scheduled = await this.notificationRepository.find({
      where: {
        status: NotificationStatus.PENDING,
        scheduledFor: LessThan(new Date()),
      },
      take: 100, // Process in batches
    });

    for (const notification of scheduled) {
      if (!notification.isExpired()) {
        await this.sendNotification(notification);
      } else {
        notification.markAsFailed('Notification expired');
        await this.notificationRepository.save(notification);
      }
    }
  }

  /**
   * Retry failed notifications
   */
  async retryFailed(): Promise<{ retried: number }> {
    const failed = await this.notificationRepository.find({
      where: {
        status: NotificationStatus.FAILED,
      },
      take: 50,
    });

    let retried = 0;
    for (const notification of failed) {
      if (notification.canRetry() && !notification.isExpired()) {
        await this.sendNotification(notification);
        retried++;
      }
    }

    return { retried };
  }

  /**
   * Listen for alarm triggered events
   */
  @OnEvent('alarm.triggered')
  async handleAlarmTriggered(payload: any) {
    const { alarm } = payload;

    // Send notifications based on alarm configuration
    if (alarm.notifications?.email && alarm.recipients?.emails) {
      for (const email of alarm.recipients.emails) {
        await this.create({
          userId: alarm.userId,
          type: 'alarm' as any,
          channel: NotificationChannel.EMAIL,
          priority:
            alarm.severity === 'critical' ? ('urgent' as any) : ('high' as any),
          title: `Alarm: ${alarm.name}`,
          message: alarm.message || `Alarm ${alarm.name} has been triggered`,
          recipientEmail: email,
          relatedEntityType: 'alarm',
          relatedEntityId: alarm.id,
          action: {
            label: 'View Alarm',
            url: `/alarms/${alarm.id}`,
            type: 'button',
          },
        });
      }
    }

    // Send push notifications
    if (alarm.notifications?.push && alarm.recipients?.userIds) {
      for (const userId of alarm.recipients.userIds) {
        await this.create({
          userId,
          type: 'alarm' as any,
          channel: NotificationChannel.PUSH,
          priority:
            alarm.severity === 'critical' ? ('urgent' as any) : ('high' as any),
          title: `Alarm: ${alarm.name}`,
          message: alarm.message || `Alarm ${alarm.name} has been triggered`,
          relatedEntityType: 'alarm',
          relatedEntityId: alarm.id,
        });
      }
    }

    // Send webhook
    if (alarm.notifications?.webhook) {
      await this.create({
        userId: alarm.userId,
        type: 'alarm' as any,
        channel: NotificationChannel.WEBHOOK,
        priority:
          alarm.severity === 'critical' ? ('urgent' as any) : ('high' as any),
        title: `Alarm: ${alarm.name}`,
        message: alarm.message || `Alarm ${alarm.name} has been triggered`,
        webhookUrl: alarm.notifications.webhook,
        relatedEntityType: 'alarm',
        relatedEntityId: alarm.id,
        metadata: {
          alarm: {
            id: alarm.id,
            name: alarm.name,
            severity: alarm.severity,
            deviceId: alarm.deviceId,
            currentValue: alarm.currentValue,
          },
        },
      });
    }
  }
}
