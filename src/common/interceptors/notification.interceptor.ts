// src/common/interceptors/notification.interceptor.ts
import {
  Injectable,
  NestInterceptor,
  ExecutionContext,
  CallHandler,
  Logger,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Observable } from 'rxjs';
import { tap, catchError } from 'rxjs/operators';
import { NotificationsService } from '@modules/notifications/notifications.service';
import { NOTIFY_KEY, NotifyMetadata } from '@common/decorators/notify.decorator';
import { NotificationPriority, UserRole } from '@common/enums/index.enum';

@Injectable()
export class NotificationInterceptor implements NestInterceptor {
  private readonly logger = new Logger(NotificationInterceptor.name);

  constructor(
    private readonly notificationsService: NotificationsService,
    private readonly reflector: Reflector,
  ) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<any> {
    const request = context.switchToHttp().getRequest();
    const user = request.user;

    const notifyMetadata = this.reflector.get<NotifyMetadata>(
      NOTIFY_KEY,
      context.getHandler(),
    );

    if (!notifyMetadata) {
      return next.handle();
    }

    if (!user) {
      this.logger.warn('Cannot send notification: No authenticated user');
      return next.handle();
    }

    return next.handle().pipe(
      tap(async (response) => {
        // Only send on success if condition allows
        if (
          notifyMetadata.condition === 'failure' ||
          (notifyMetadata.condition &&
            notifyMetadata.condition !== 'success' &&
            notifyMetadata.condition !== 'always')
        ) {
          return;
        }

        const sendNotification = async () => {
          try {
            await this.processNotification(
              notifyMetadata,
              request,
              response,
              user,
              true, // success
            );
          } catch (error) {
            this.logger.error(`Failed to send notification: ${error.message}`);
          }
        };

        // Send async by default
        if (notifyMetadata.async !== false) {
          setImmediate(() => sendNotification());
        } else {
          await sendNotification();
        }
      }),
      catchError(async (error) => {
        // Only send on failure if condition allows
        if (
          notifyMetadata.condition === 'success' ||
          (notifyMetadata.condition &&
            notifyMetadata.condition !== 'failure' &&
            notifyMetadata.condition !== 'always')
        ) {
          throw error;
        }

        try {
          await this.processNotification(
            notifyMetadata,
            request,
            null,
            user,
            false, // failure
            error,
          );
        } catch (notificationError) {
          this.logger.error(
            `Failed to send failure notification: ${notificationError.message}`,
          );
        }

        throw error;
      }),
    );
  }

  private async processNotification(
    metadata: NotifyMetadata,
    request: any,
    response: any,
    user: any,
    success: boolean,
    error?: any,
  ): Promise<void> {
    const entityId = request.params?.id || response?.data?.id || response?.id;
    const entityName =
      response?.data?.name ||
      response?.data?.title ||
      response?.data?.email ||
      response?.name ||
      'Unknown';

    const title = this.replacePlaceholders(metadata.title, {
      entityName,
      entityId,
      userName: user.name,
      action: success ? 'created' : 'failed',
      entityType: metadata.entityType || 'item',
    });

    const message = this.replacePlaceholders(metadata.message, {
      entityName,
      entityId,
      userName: user.name,
      action: success ? 'successfully' : 'failed',
      entityType: metadata.entityType || 'item',
      error: error?.message || '',
    });

    let action: any = undefined;
    if (metadata.action && entityId) {
      action = {
        label: metadata.action.label,
        url: metadata.action.urlTemplate.replace('{entityId}', entityId),
        type: 'button' as const,
      };
    }

    // Resolve recipients — delegated to service instead of private DB access
    const recipients = await this.getRecipients(
      metadata.recipients,
      user,
      response,
    );

    if (recipients.length === 0) {
      this.logger.warn(
        `No recipients found for notification: ${metadata.recipients}`,
      );
      return;
    }

    // Send notification through each channel
    for (const channel of metadata.channels) {
      try {
        if (recipients.length > 1) {
          await this.notificationsService.sendBulk({
            userIds: recipients,
            type: metadata.type,
            channel,
            priority: metadata.priority || NotificationPriority.NORMAL,
            title,
            message,
            htmlContent: metadata.htmlContent
              ? this.replacePlaceholders(metadata.htmlContent, {
                  entityName,
                  entityId,
                  userName: user.name,
                })
              : undefined,
            metadata: {
              entityId,
              entityType: metadata.entityType,
              triggeredBy: user.id,
              success,
            },
          });
        } else {
          await this.notificationsService.create(
            {
              userId: recipients[0],
              type: metadata.type,
              channel,
              priority: metadata.priority || NotificationPriority.NORMAL,
              title,
              message,
              htmlContent: metadata.htmlContent
                ? this.replacePlaceholders(metadata.htmlContent, {
                    entityName,
                    entityId,
                    userName: user.name,
                  })
                : undefined,
              relatedEntityType: metadata.entityType,
              relatedEntityId: entityId,
              action,
              metadata: {
                entityId,
                entityType: metadata.entityType,
                triggeredBy: user.id,
                success,
              },
            },
            user,
          );
        }

        this.logger.debug(
          `Sent ${channel} notification to ${recipients.length} recipient(s)`,
        );
      } catch (error) {
        this.logger.error(
          `Failed to send ${channel} notification: ${error.message}`,
        );
      }
    }
  }

  private replacePlaceholders(
    template: string,
    values: Record<string, string>,
  ): string {
    let result = template;
    for (const [key, value] of Object.entries(values)) {
      result = result.replace(new RegExp(`{${key}}`, 'g'), value);
    }
    return result;
  }

  private async getRecipients(
    recipientType: NotifyMetadata['recipients'],
    user: any,
    response: any,
  ): Promise<string[]> {
    switch (recipientType) {
      case 'self':
        return [user.id];

      case 'tenant':
        // NotificationsService must expose this method publicly
        const tenantUsers = await this.notificationsService.getUsersByTenant(
          user.tenantId,
        );
        return tenantUsers.map((u) => u.id);

      case 'customer':
        if (!user.customerId) {
          this.logger.warn('User has no customerId, cannot notify customer');
          return [];
        }
        const customerUsers =
          await this.notificationsService.getUsersByCustomer(user.customerId);
        return customerUsers.map((u) => u.id);

      case 'admins':
        // Filter by enum, not hardcoded strings
        const admins = await this.notificationsService.getUsersByTenant(
          user.tenantId,
        );
        return admins
          .filter((u) => u.role === UserRole.TENANT_ADMIN || u.role === UserRole.SUPER_ADMIN)
          .map((u) => u.id);

      case 'related':
        const relatedUserIds =
          response?.data?.userIds ||
          response?.userIds ||
          (response?.data?.userId ? [response.data.userId] : []);
        return relatedUserIds.length > 0 ? relatedUserIds : [user.id];

      default:
        return [user.id];
    }
  }
}