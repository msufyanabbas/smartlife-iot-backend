// src/modules/notifications/notifications.service.ts
import {
  Injectable,
  NotFoundException,
  ForbiddenException,
  Logger,
  BadRequestException,
  forwardRef,
  Inject,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, Repository, In } from 'typeorm';
import { NotificationChannel, NotificationStatus, NotificationType } from '@common/enums/index.enum';
import {
  Notification,
  User
} from '@modules/index.entities';
import {
  CreateNotificationDto,
  NotificationQueryDto,
  MarkAsReadDto,
  SendBulkNotificationDto,
} from './dto/notification.dto';
import { EventEmitter2, OnEvent } from '@nestjs/event-emitter';
import { EmailChannel } from './channels/email.channel';
import { SmsChannel } from './channels/sms.channel';
import { PushChannel } from './channels/push.channel';
import { PushSubscriptionsService } from './push-subscriptions.service';
import { WhatsappChannel } from './channels/whatsapp.channel';
import { NotificationsRepository } from './repositories/notifications.repository';
import { UserRole } from '@common/enums/index.enum';
import { Cron, CronExpression } from '@nestjs/schedule';
import { UsersService } from '@modules/users/users.service';
import { PaginatedResponseDto } from '@common/dto/pagination.dto';
import {
  BulkResultBuilder,
  BulkResultDto,
} from '@common/dto/bulk-operation.dto';
import {
  BulkDeleteNotificationsDto,
  BulkUpdateNotificationsDto,
} from './dto/bulk-notification.dto';

@Injectable()
export class NotificationsService {
  private readonly logger = new Logger(NotificationsService.name);

  constructor(
    @InjectRepository(Notification)
    private notificationRepository: Repository<Notification>,
    private notificationsRepo: NotificationsRepository,
    private eventEmitter: EventEmitter2,
    private emailChannel: EmailChannel,
    // NOTE: type written as InstanceType<typeof UsersService> so SWC emits
    // `Object` for design:paramtypes instead of eagerly reading the UsersService
    // binding — that read TDZ-crashes on the UsersService <-> NotificationsService
    // import cycle. The forwardRef below still resolves the real DI token.
    @Inject(forwardRef(() => UsersService))
    private userService: InstanceType<typeof UsersService>,
    private smsChannel: SmsChannel,
    private pushChannel: PushChannel,
    // Resolves a user's registered devices when a push notification carries no
    // explicit token — see sendPush().
    private pushSubscriptions: PushSubscriptionsService,
    private whatsappChannel: WhatsappChannel,
    // Bulk operations commit one transaction per item — see bulkDelete.
    private readonly dataSource: DataSource,
  ) { }

  /**
   * Does this customer belong to this tenant?
   *
   * Used by the bulk-to-customer broadcast, which previously took the customer
   * id straight from the URL and sent to whoever it named — in any tenant.
   * Queried through `dataSource` rather than by importing `CustomersModule`,
   * which would add an import cycle for one existence check (the same reason
   * `AssignmentService` reaches other modules' tables directly).
   */
  async customerBelongsToTenant(
    customerId: string,
    tenantId?: string,
  ): Promise<boolean> {
    if (!customerId || !tenantId) return false;

    const rows = await this.dataSource.query(
      `SELECT 1 FROM customers
        WHERE id = $1 AND "tenantId" = $2 AND deleted_at IS NULL
        LIMIT 1`,
      [customerId, tenantId],
    );

    return rows.length > 0;
  }

  /**
   * ✅ ENHANCED: Create notification with tenant/customer context
   */
  async create(
    createDto: CreateNotificationDto,
    user?: User,
  ): Promise<Notification> {
    // Get user details if not provided
    if (!user && createDto.userId) {
      user = await this.getUserById(createDto.userId);
    }

    if (!user) {
      throw new Error('User context required for notification creation');
    }

    const isScheduled =
      createDto.scheduledFor && createDto.scheduledFor > new Date();

    const notification = this.notificationRepository.create({
      ...createDto,
      tenantId: user.tenantId,
      customerId: user.customerId,
      status: isScheduled
        ? NotificationStatus.PENDING
        : NotificationStatus.PENDING,
    });

    const saved = await this.notificationRepository.save(notification);

    // If not scheduled, send immediately
    if (!isScheduled) {
      await this.sendNotification(saved);
    }

    this.logger.log(
      `Notification created: ${saved.id} for user ${user.email} in tenant ${user.tenantId}`,
    );

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

        case NotificationChannel.WHATSAPP:
          await this.sendWhatsApp(notification);
          break;

        case NotificationChannel.WEBHOOK:
          await this.sendWebhook(notification);
          break;

        case NotificationChannel.IN_APP:
          notification.markAsSent();
          notification.markAsDelivered();
          await this.notificationRepository.save(notification);
          break;

        default:
          throw new Error(`Unsupported channel: ${notification.channel}`);
      }

      this.eventEmitter.emit('notification.sent', { notification });
    } catch (error) {
      this.logger.error(
        `Failed to send notification ${notification.id}: ${error.message}`,
      );
      notification.markAsFailed(error.message);
      await this.notificationRepository.save(notification);

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
   * Send SMS notification
   */
  private async sendSMS(notification: Notification): Promise<void> {
    await this.smsChannel.send(notification);
    notification.markAsSent();
    notification.markAsDelivered();
    await this.notificationRepository.save(notification);
  }

  /**
   * Send push notification.
   *
   * ─── Why this is not just `pushChannel.send()` ──────────────────────────
   * `Notification.recipientDeviceToken` has to be supplied by whoever creates
   * the notification, and nothing in the platform ever did — the alarm
   * escalation path, for instance, fills `recipientEmail` and `recipientPhone`
   * and has no token to give. So a PUSH notification could only ever fail with
   * "Recipient device token is required", and the push channel was unreachable
   * in practice even once its FCM calls were real.
   *
   * With `push_subscriptions` in place there is somewhere to look: when no
   * explicit token is given, every device the recipient has registered is
   * used. A person with a phone and a laptop browser gets both.
   *
   * Delivery is "at least one device accepted it". A single dead token among
   * several must not mark the notification failed — the provider's own
   * unregistered-token reporting prunes it, and the user did get the
   * notification. Zero devices, or zero successes, is a failure and throws.
   */
  private async sendPush(notification: Notification): Promise<void> {
    if (notification.recipientDeviceToken) {
      await this.pushChannel.send(notification);
      notification.markAsSent();
      notification.markAsDelivered();
      await this.notificationRepository.save(notification);
      return;
    }

    const subscriptions = await this.pushSubscriptions.findTokensForUsers(
      notification.tenantId,
      [notification.userId],
    );

    if (subscriptions.length === 0) {
      throw new Error(
        'No push subscription is registered for this user, so the ' +
          'notification could not be delivered. The client registers one with ' +
          'POST /push-subscriptions.',
      );
    }

    const result = await this.pushChannel.sendToMultipleDevices(
      subscriptions.map((subscription) => subscription.token),
      notification,
    );

    if (result.success === 0) {
      // Every device rejected it. The first provider message is carried
      // through because "push failed" alone is not diagnosable.
      const reason =
        result.outcomes.find((outcome) => outcome.error)?.error ??
        'every registered device rejected the message';
      throw new Error(`Push delivery failed: ${reason}`);
    }

    this.logger.log(
      `Push notification ${notification.id} delivered to ${result.success} of ` +
        `${subscriptions.length} registered device(s)`,
    );

    notification.markAsSent();
    notification.markAsDelivered();
    await this.notificationRepository.save(notification);
  }

  /**
   * Send WhatsApp notification (Unifonic)
   */
  private async sendWhatsApp(notification: Notification): Promise<void> {
    await this.whatsappChannel.send(notification);
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
    this.logger.log(`Sending webhook to ${notification.webhookUrl}`);

    notification.markAsSent();
    notification.markAsDelivered();
    await this.notificationRepository.save(notification);
  }

  /**
   * ✅ ENHANCED: Find all with proper access control
   */
  async findAll(user: User, query: NotificationQueryDto) {
    const { page = 1, limit = 20, type, status, isRead } = query;

    const skip = (page - 1) * limit;

    const [data, total] = await Promise.all([
      this.notificationsRepo.findAllForUser(user, {
        type,
        status,
        isRead,
        skip,
        take: limit,
      }),
      this.notificationsRepo.getCountForUser(user, { type, status, isRead }),
    ]);

    // Standard { data, meta } wrapper. `unreadCount` is carried alongside it
    // rather than dropped — it is a genuine payload the notification bell needs,
    // and it does not belong in PaginationMetaDto (it is not page-scoped).
    return Object.assign(
      PaginatedResponseDto.create(data, page, limit, total),
      { unreadCount: await this.getUnreadCount(user) },
    );
  }

  /**
   * ✅ ENHANCED: Find one with access control
   */
  async findOne(id: string, user: User): Promise<Notification> {
    const notification = await this.notificationRepository.findOne({
      where: { id },
    });

    if (!notification) {
      throw new NotFoundException(`Notification with ID ${id} not found`);
    }

    // Check access
    if (!notification.canBeAccessedBy(user.tenantId)) {
      throw new ForbiddenException(
        'You do not have permission to access this notification',
      );
    }

    return notification;
  }

  /**
   * ✅ ENHANCED: Mark as read with access control
   */
  async markAsRead(id: string, user: User): Promise<Notification> {
    const notification = await this.findOne(id, user);

    if (!notification.isRead) {
      notification.markAsRead();
      await this.notificationRepository.save(notification);
    }

    return notification;
  }

  /**
   * Mark multiple as read
   */
  async markMultipleAsRead(
    user: User,
    dto: MarkAsReadDto,
  ): Promise<{ success: number }> {
    const notifications = await this.notificationRepository.find({
      where: {
        id: In(dto.notificationIds),
        isRead: false,
      },
    });

    // Filter by access
    const accessibleNotifications = notifications.filter((n) =>
      n.canBeAccessedBy(user.tenantId),
    );

    for (const notification of accessibleNotifications) {
      notification.markAsRead();
    }

    await this.notificationRepository.save(accessibleNotifications);

    return { success: accessibleNotifications.length };
  }

  /**
   * ✅ FIXED: Mark all as read with access control
   */
  async markAllAsRead(user: User): Promise<{ success: number }> {
    // Build the WHERE conditions based on user role
    const whereConditions: any = { isRead: false };

    if (user.role === UserRole.TENANT_ADMIN) {
      whereConditions.tenantId = user.tenantId;
    } else if (user.role === UserRole.CUSTOMER) {
      whereConditions.customerId = user.customerId;
    } else {
      whereConditions.userId = user.id;
    }

    // Use simple update instead of query builder
    const result = await this.notificationRepository.update(whereConditions, {
      isRead: true,
      readAt: new Date(),
    });

    return { success: result.affected || 0 };
  }

  /**
   * Delete notification with access control
   */
  async remove(id: string, user: User): Promise<void> {
    const notification = await this.findOne(id, user);
    await this.notificationRepository.softRemove(notification);
  }

  /**
   * Delete all read notifications
   */
  async deleteAllRead(user: User): Promise<{ deleted: number }> {
    const whereConditions: any = { isRead: true };

    if (user.role === UserRole.TENANT_ADMIN) {
      whereConditions.tenantId = user.tenantId;
    } else if (user.role === UserRole.CUSTOMER) {
      whereConditions.customerId = user.customerId;
    } else {
      whereConditions.userId = user.id;
    }

    const notifications = await this.notificationRepository.find({
      where: whereConditions,
    });

    if (notifications.length > 0) {
      await this.notificationRepository.softRemove(notifications);
    }

    return { deleted: notifications.length };
  }

  // ── Bulk delete / bulk update (per-id outcomes) ────────────────────────────
  //
  // TRANSACTION GRANULARITY: ONE TRANSACTION PER ITEM, for the same reason as
  // the other bulk routes — a per-batch transaction would roll back 49 good
  // deletes because the 50th id belonged to another tenant.
  //
  // SCOPING: resolveForBulk() applies the same role-based rule the rest of
  // this service uses (SUPER_ADMIN everything, TENANT_ADMIN its tenant,
  // CUSTOMER its customer, everyone else only their own rows) — but it ALWAYS
  // adds the tenant predicate as well. `markAllAsRead()` and
  // `deleteAllRead()` filter by `customerId` or `userId` ALONE, which is only
  // safe because those are uuids; a bulk route taking ids from a request body
  // cannot rely on that.
  //
  // NOTHING CASCADES and NOTHING BLOCKS: no table has a foreign key to
  // `notifications`, and a notification carries no quota. There is therefore
  // no counter to maintain here, which is why this module's bulk delete is
  // the simplest of the four.

  async bulkDelete(
    dto: BulkDeleteNotificationsDto,
    user: User,
  ): Promise<BulkResultDto> {
    const result = new BulkResultBuilder(dto.ids);
    const notifications = await this.resolveForBulk(result.ids, user);

    for (const id of result.ids) {
      const notification = notifications.get(id);

      if (!notification) {
        result.notFound(id, 'Notification not found in your scope');
        continue;
      }

      try {
        await this.dataSource.transaction(async (manager) => {
          await manager.softRemove(notification);
        });
        result.success(id);
      } catch (err) {
        this.logger.error(
          `Bulk delete failed for notification ${id}: ${(err as Error).message}`,
        );
        result.failed(id, (err as Error).message);
      }
    }

    return result.build();
  }

  async bulkUpdate(
    dto: BulkUpdateNotificationsDto,
    user: User,
  ): Promise<BulkResultDto> {
    if (dto.isRead === undefined) {
      throw new BadRequestException({
        message: 'No updatable field supplied',
        errors: [
          'Supply isRead',
          'Delivery fields (status, sentAt, deliveredAt, retryCount) are written by the delivery pipeline and are not client-writable',
        ],
      });
    }

    const result = new BulkResultBuilder(dto.ids);
    const notifications = await this.resolveForBulk(result.ids, user);

    for (const id of result.ids) {
      const notification = notifications.get(id);

      if (!notification) {
        result.notFound(id, 'Notification not found in your scope');
        continue;
      }

      if (notification.isRead === dto.isRead) {
        result.skipped(
          id,
          dto.isRead ? 'Already read' : 'Already unread',
        );
        continue;
      }

      try {
        await this.dataSource.transaction(async (manager) => {
          await manager.update(
            Notification,
            { id: notification.id },
            {
              isRead: dto.isRead,
              // Mirrors Notification.markAsRead(): the timestamp is part of
              // the flag, and leaving a stale readAt on an un-read row would
              // misreport when it was seen.
              // `null`, not `undefined`: TypeORM's update() treats undefined
              // as "leave this column alone", so marking a row unread would
              // keep a stale readAt and misreport when it was seen.
              readAt: dto.isRead ? new Date() : (null as any),
            },
          );
        });
        result.success(id);
      } catch (err) {
        this.logger.error(
          `Bulk update failed for notification ${id}: ${(err as Error).message}`,
        );
        result.failed(id, (err as Error).message);
      }
    }

    return result.build();
  }

  /**
   * Re-resolves every requested id inside the caller's own scope. This is the
   * security boundary of the bulk routes: the body is a bare uuid array.
   */
  private async resolveForBulk(
    ids: string[],
    user: User,
  ): Promise<Map<string, Notification>> {
    if (ids.length === 0) return new Map();

    if (user.role === UserRole.SUPER_ADMIN) {
      const rows = await this.notificationRepository.find({
        where: { id: In(ids) },
      });
      return new Map(rows.map((n) => [n.id, n]));
    }

    if (!user.tenantId) {
      this.logger.warn(
        `Bulk notification request from ${user.id} with role ${user.role} and no tenantId — denied`,
      );
      return new Map();
    }

    const where: Record<string, unknown> = {
      id: In(ids),
      tenantId: user.tenantId,
    };

    if (user.role === UserRole.TENANT_ADMIN) {
      // Tenant-wide, nothing further.
    } else if (user.role === UserRole.CUSTOMER) {
      if (!user.customerId) return new Map();
      where.customerId = user.customerId;
    } else {
      where.userId = user.id;
    }

    const rows = await this.notificationRepository.find({ where: where as any });
    return new Map(rows.map((n) => [n.id, n]));
  }

  /**
   * Get unread count
   */
  async getUnreadCount(user: User): Promise<number> {
    return await this.notificationsRepo.getUnreadCountForUser(user);
  }

  /**
   * Get notification statistics
   */
  async getStatistics(user: User) {
    const queryBuilder = this.notificationRepository.createQueryBuilder(
      'notification',
    );

    // Apply access control
    if (user.role === UserRole.SUPER_ADMIN) {
      // No filter
    } else if (user.role === UserRole.TENANT_ADMIN) {
      queryBuilder.where('notification.tenantId = :tenantId', {
        tenantId: user.tenantId,
      });
    } else if (user.role === UserRole.CUSTOMER) {
      queryBuilder.where('notification.customerId = :customerId', {
        customerId: user.customerId,
      });
    } else {
      queryBuilder.where('notification.userId = :userId', {
        userId: user.id,
      });
    }

    const total = await queryBuilder.getCount();
    const unread = await this.getUnreadCount(user);
    const read = total - unread;

    // Count by type
    const byType = await queryBuilder
      .clone()
      .select('notification.type', 'type')
      .addSelect('COUNT(*)', 'count')
      .groupBy('notification.type')
      .getRawMany();

    // Count by channel
    const byChannel = await queryBuilder
      .clone()
      .select('notification.channel', 'channel')
      .addSelect('COUNT(*)', 'count')
      .groupBy('notification.channel')
      .getRawMany();

    return {
      total,
      unread,
      read,
      byType: byType.reduce((acc, { type, count }) => {
        acc[type] = parseInt(count);
        return acc;
      }, {}),
      byChannel: byChannel.reduce((acc, { channel, count }) => {
        acc[channel] = parseInt(count);
        return acc;
      }, {}),
    };
  }

  /**
   * ✅ NEW: Send bulk notifications (main method)
   */
  async sendBulk(dto: SendBulkNotificationDto): Promise<{ sent: number }> {
    if (!dto.userIds || dto.userIds.length === 0) {
      throw new BadRequestException('userIds array is required and cannot be empty');
    }

    this.logger.log(`Sending bulk notifications to ${dto.userIds.length} users`);

    // Get all target users
    const users = await this.userService.findByIds(dto.userIds);

    if (users.length === 0) {
      throw new NotFoundException('No users found with provided IDs');
    }

    if (users.length !== dto.userIds.length) {
      this.logger.warn(
        `Some users not found. Expected: ${dto.userIds.length}, Found: ${users.length}`,
      );
    }

    // Create notifications for all users
    const notifications = users.map((user) =>
      this.notificationRepository.create({
        userId: user.id,
        tenantId: user.tenantId,
        customerId: user.customerId,
        type: dto.type,
        channel: dto.channel,
        priority: dto.priority,
        title: dto.title,
        message: dto.message,
        htmlContent: dto.htmlContent,
        metadata: dto.metadata,
      }),
    );

    // Save all notifications
    const saved = await this.notificationRepository.save(notifications);

    this.logger.log(`Created ${saved.length} bulk notifications`);

    // Send all notifications asynchronously
    const sendPromises = saved.map((notification) =>
      this.sendNotification(notification).catch((error) => {
        this.logger.error(
          `Failed to send bulk notification ${notification.id}: ${error.message}`,
        );
      }),
    );

    // Wait for all to complete
    await Promise.allSettled(sendPromises);

    return { sent: saved.length };
  }

  /**
   * ✅ NEW: Send bulk notifications to tenant users
   */
  async sendBulkToTenant(
    tenantId: string,
    dto: Omit<SendBulkNotificationDto, 'userIds'>,
  ): Promise<{ sent: number }> {
    this.logger.log(`Sending bulk notifications to all users in tenant ${tenantId}`);

    // Get all users in tenant
    const users = await this.getUsersByTenant(tenantId);

    if (users.length === 0) {
      this.logger.warn(`No users found in tenant ${tenantId}`);
      return { sent: 0 };
    }

    const notifications = users.map((user) =>
      this.notificationRepository.create({
        userId: user.id,
        tenantId: user.tenantId,
        customerId: user.customerId,
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
      await this.sendNotification(notification).catch((error) => {
        this.logger.error(
          `Failed to send notification ${notification.id}: ${error.message}`,
        );
      });
    }

    return { sent: saved.length };
  }

  /**
   * ✅ NEW: Send bulk notifications to customer users
   */
  async sendBulkToCustomer(
    customerId: string,
    dto: Omit<SendBulkNotificationDto, 'userIds'>,
  ): Promise<{ sent: number }> {
    this.logger.log(`Sending bulk notifications to all users in customer ${customerId}`);

    // Get all users in customer
    const users = await this.getUsersByCustomer(customerId);

    if (users.length === 0) {
      this.logger.warn(`No users found in customer ${customerId}`);
      return { sent: 0 };
    }

    const notifications = users.map((user) =>
      this.notificationRepository.create({
        userId: user.id,
        tenantId: user.tenantId,
        customerId: user.customerId,
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
      await this.sendNotification(notification).catch((error) => {
        this.logger.error(
          `Failed to send notification ${notification.id}: ${error.message}`,
        );
      });
    }

    return { sent: saved.length };
  }

  /**
   * Process scheduled notifications (runs every minute)
   */
  @Cron(CronExpression.EVERY_MINUTE)
  async processScheduledNotifications(): Promise<void> {
    try {
      const scheduled = await this.notificationsRepo.findPendingToSend();

      if (scheduled.length === 0) {
        return;
      }

      this.logger.log(`Processing ${scheduled.length} scheduled notifications`);

      for (const notification of scheduled) {
        if (!notification.isExpired()) {
          await this.sendNotification(notification);
        } else {
          notification.markAsFailed('Notification expired');
          await this.notificationRepository.save(notification);
        }
      }
    } catch (error) {
      this.logger.error(
        `Error processing scheduled notifications: ${error.message}`,
      );
    }
  }

  /**
   * Retry failed notifications
   */
  async retryFailed(): Promise<{ retried: number }> {
    const failed = await this.notificationsRepo.findRetryable();

    if (failed.length === 0) {
      this.logger.log('No failed notifications to retry');
      return { retried: 0 };
    }

    this.logger.log(`Retrying ${failed.length} failed notifications`);

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
   * ✅ NEW: Listen for device events
   */
  @OnEvent('device.offline')
  async handleDeviceOffline(payload: { device: any; user: User }) {
    const { device, user } = payload;

    await this.create(
      {
        userId: user.id,
        type: NotificationType.DEVICE,
        channel: NotificationChannel.IN_APP,
        priority: 'high' as any,
        title: `Device Offline: ${device.name}`,
        message: `Device "${device.name}" has gone offline`,
        relatedEntityType: 'device',
        relatedEntityId: device.id,
        action: {
          label: 'View Device',
          url: `/devices/${device.id}`,
          type: 'button',
        },
        metadata: {
          deviceId: device.id,
          deviceName: device.name,
          deviceType: device.type,
        },
      },
      user,
    );
  }

  /**
   * ✅ NEW: Listen for device connection
   */
  @OnEvent('device.connected')
  async handleDeviceConnected(payload: { device: any; user: User }) {
    const { device, user } = payload;

    await this.create(
      {
        userId: user.id,
        type: NotificationType.DEVICE,
        channel: NotificationChannel.IN_APP,
        priority: 'normal' as any,
        title: `Device Connected: ${device.name}`,
        message: `Device "${device.name}" is now online`,
        relatedEntityType: 'device',
        relatedEntityId: device.id,
        action: {
          label: 'View Device',
          url: `/devices/${device.id}`,
          type: 'button',
        },
        metadata: {
          deviceId: device.id,
          deviceName: device.name,
          deviceType: device.type,
        },
      },
      user,
    );
  }

  /**
   * Listen for alarm triggered events
   */
  @OnEvent('alarm.triggered')
  async handleAlarmTriggered(payload: any) {
    const { alarm } = payload;

    // The Alarm entity has no `userId` column and AlarmsService emits
    // { alarm } with no `user`, so the previous `alarm.userId` / `payload.user`
    // were undefined on every alarm notification. `createdBy` (from
    // BaseEntity) is the owning user, and the actor is that same user here
    // since the trigger is system-initiated.
    const owningUserId = alarm.createdBy ?? alarm.acknowledgedBy ?? null;
    const user = payload.user ?? { id: owningUserId, tenantId: alarm.tenantId };

    // Send notifications based on alarm configuration
    if (alarm.notifications?.email && alarm.recipients?.emails) {
      for (const email of alarm.recipients.emails) {
        await this.create(
          {
            userId: owningUserId,
            type: NotificationType.ALARM,
            channel: NotificationChannel.EMAIL,
            priority:
              alarm.severity === 'critical' ? 'urgent' : ('high' as any),
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
          },
          user,
        );
      }
    }

    // Send push notifications
    if (alarm.notifications?.push && alarm.recipients?.userIds) {
      for (const userId of alarm.recipients.userIds) {
        const recipientUser = await this.getUserById(userId);
        await this.create(
          {
            userId,
            type: NotificationType.ALARM,
            channel: NotificationChannel.PUSH,
            priority:
              alarm.severity === 'critical' ? 'urgent' : ('high' as any),
            title: `Alarm: ${alarm.name}`,
            message: alarm.message || `Alarm ${alarm.name} has been triggered`,
            relatedEntityType: 'alarm',
            relatedEntityId: alarm.id,
          },
          recipientUser,
        );
      }
    }
  }

  // ✅ Helper methods
  async getUserById(userId: string): Promise<User> {
    return this.userService.findOne(userId);
  }

  async getUsersByTenant(tenantId: string): Promise<User[]> {
    return this.userService.findByTenant(tenantId);
  }

  getUsersByCustomer(customerId: string): Promise<User[]> {
    return this.userService.findByCustomer(customerId);
  }
}