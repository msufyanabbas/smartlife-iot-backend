// src/modules/notifications/dto/bulk-notification.dto.ts
import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsBoolean, IsOptional } from 'class-validator';
import { BulkIdsDto } from '@common/dto/bulk-operation.dto';

export class BulkDeleteNotificationsDto extends BulkIdsDto {}

/**
 * The allowed bulk notification patch — `isRead`, and nothing else.
 *
 * A notification is a record of something the platform did. `status`,
 * `sentAt`, `deliveredAt`, `retryCount` and `failureReason` are written by
 * the delivery pipeline (`NotificationsService.sendNotification`), and letting
 * a client set them would let it claim a notification was delivered when it
 * was not — which is also how the retry cron decides what to re-send.
 * `title`, `message`, `channel`, `type` and `priority` describe an event that
 * already happened; editing them after the fact rewrites history.
 *
 * `isRead` is the only field that belongs to the reader rather than the
 * sender, so it is the only one exposed here. Setting it also stamps
 * `readAt`.
 */
export class BulkUpdateNotificationsDto extends BulkIdsDto {
  @ApiPropertyOptional({
    description:
      'Mark every listed notification read (true) or unread (false). Also sets/clears readAt.',
    example: true,
  })
  @IsOptional()
  @IsBoolean()
  isRead?: boolean;
}
