// src/common/decorators/notify.decorator.ts
import { SetMetadata } from '@nestjs/common';
import {
  NotificationType,
  NotificationChannel,
  NotificationPriority,
} from '@/modules/notifications/entities/notification.entity';

export interface NotifyMetadata {
  /**
   * Type of notification
   */
  type: NotificationType;

  /**
   * Notification channel(s)
   */
  channels: NotificationChannel[];

  /**
   * Priority level
   */
  priority?: NotificationPriority;

  /**
   * Title template (supports placeholders: {entityName}, {userName}, {action})
   */
  title: string;

  /**
   * Message template (supports placeholders: {entityName}, {userName}, {action}, {entityType})
   */
  message: string;

  /**
   * HTML content template (optional)
   */
  htmlContent?: string;

  /**
   * Who should receive the notification
   * - 'self' = Only the user performing the action
   * - 'tenant' = All users in the tenant
   * - 'customer' = All users in the customer
   * - 'admins' = Only admins (tenant + super admins)
   * - 'related' = Users related to the entity (extracted from response)
   */
  recipients: 'self' | 'tenant' | 'customer' | 'admins' | 'related';

  /**
   * Related entity info
   */
  entityType?: string;

  /**
   * Action configuration
   */
  action?: {
    label: string;
    urlTemplate: string; // e.g., '/devices/{entityId}'
  };

  /**
   * Condition to send notification (optional)
   * - 'success' = Only on success
   * - 'failure' = Only on failure
   * - 'always' = Both success and failure
   */
  condition?: 'success' | 'failure' | 'always';

  /**
   * Should notification be sent async (default: true)
   */
  async?: boolean;
}

export const NOTIFY_KEY = 'notify';

/**
 * Decorator to automatically send notifications on endpoint execution
 *
 * @example
 * ```typescript
 * @Notify({
 *   type: NotificationType.DEVICE,
 *   channels: [NotificationChannel.IN_APP, NotificationChannel.EMAIL],
 *   priority: NotificationPriority.HIGH,
 *   title: 'Device Created',
 *   message: 'Device "{entityName}" has been created successfully',
 *   recipients: 'self',
 *   entityType: 'device',
 *   action: {
 *     label: 'View Device',
 *     urlTemplate: '/devices/{entityId}'
 *   }
 * })
 * ```
 */
export const Notify = (metadata: NotifyMetadata) =>
  SetMetadata(NOTIFY_KEY, metadata);