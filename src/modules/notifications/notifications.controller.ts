import {
  Controller,
  Get,
  Post,
  Body,
  Patch,
  Param,
  Delete,
  UseGuards,
  Query,
  HttpCode,
  HttpStatus,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import {
  ApiTags,
  ApiOperation,
  ApiResponse,
  ApiBearerAuth,
} from '@nestjs/swagger';
import { NotificationsService } from './notifications.service';
import {
  CreateNotificationDto,
  NotificationQueryDto,
  MarkAsReadDto,
  SendBulkNotificationDto,
} from './dto/notification.dto';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { User } from '../users/entities/user.entity';
import { ParseIdPipe } from '../../common/pipes/parse-id.pipe';
import { Roles } from '@common/decorators/roles.decorator';
import { UserRole } from '@common/enums/index.enum';
import { BulkResultDto } from '@common/dto/bulk-operation.dto';
import {
  BulkDeleteNotificationsDto,
  BulkUpdateNotificationsDto,
} from './dto/bulk-notification.dto';
import { RequirePermissions } from '@common/decorators/permission.decorator';

@ApiTags('notifications')
@Controller('notifications')
@UseGuards(JwtAuthGuard)
@ApiBearerAuth()
export class NotificationsController {
  constructor(private readonly notificationsService: NotificationsService) {}

  @Post()
  @RequirePermissions('notifications:create')
  @ApiOperation({ summary: 'Create new notification' })
  @ApiResponse({ status: 201, description: 'Notification created' })
  create(@Body() createDto: CreateNotificationDto) {
    return this.notificationsService.create(createDto);
  }

  @Get()
  @RequirePermissions('notifications:list')
  @ApiOperation({ summary: 'Get all notifications' })
  @ApiResponse({ status: 200, description: 'List of notifications' })
  findAll(@CurrentUser() user: User, @Query() query: NotificationQueryDto) {
    return this.notificationsService.findAll(user, query);
  }

  @Get('unread-count')
  @RequirePermissions('notifications:list')
  @ApiOperation({ summary: 'Get unread notification count' })
  @ApiResponse({ status: 200, description: 'Unread count' })
  getUnreadCount(@CurrentUser() user: User) {
    return this.notificationsService.getUnreadCount(user);
  }

  @Get('statistics')
  @RequirePermissions('notifications:list')
  @ApiOperation({ summary: 'Get notification statistics' })
  @ApiResponse({ status: 200, description: 'Notification statistics' })
  getStatistics(@CurrentUser() user: User) {
    return this.notificationsService.getStatistics(user);
  }

  @Get(':id')
  @RequirePermissions('notifications:read')
  @ApiOperation({ summary: 'Get notification by ID' })
  @ApiResponse({ status: 200, description: 'Notification found' })
  @ApiResponse({ status: 404, description: 'Notification not found' })
  findOne(@Param('id', ParseIdPipe) id: string, @CurrentUser() user: User) {
    return this.notificationsService.findOne(id, user);
  }

  @Patch(':id/read')
  @RequirePermissions('notifications:update')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Mark notification as read' })
  @ApiResponse({ status: 200, description: 'Notification marked as read' })
  markAsRead(@Param('id', ParseIdPipe) id: string, @CurrentUser() user: User) {
    return this.notificationsService.markAsRead(id, user);
  }

  @Patch('read/multiple')
  @RequirePermissions('notifications:update')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Mark multiple notifications as read' })
  @ApiResponse({ status: 200, description: 'Notifications marked as read' })
  markMultipleAsRead(@CurrentUser() user: User, @Body() dto: MarkAsReadDto) {
    return this.notificationsService.markMultipleAsRead(user, dto);
  }

  @Patch('read/all')
  @RequirePermissions('notifications:update')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Mark all notifications as read' })
  @ApiResponse({ status: 200, description: 'All notifications marked as read' })
  markAllAsRead(@CurrentUser() user: User) {
    return this.notificationsService.markAllAsRead(user);
  }

  @Delete(':id')
  @RequirePermissions('notifications:delete')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Delete notification' })
  @ApiResponse({ status: 204, description: 'Notification deleted' })
  remove(@Param('id', ParseIdPipe) id: string, @CurrentUser() user: User) {
    return this.notificationsService.remove(id, user);
  }

  // ── Bulk operations (declared before ':id' routes) ────────────────────────
  //
  // Explicit @Roles listing every role, not an omission: RolesGuard returns
  // TRUE for a handler with no @Roles metadata, so leaving it off would look
  // identical but say nothing. A notification belongs to its recipient, so
  // every authenticated role may act on its own — the scope is enforced in
  // NotificationsService.resolveForBulk(), not by the role list.

  @Post('bulk/delete')
  @RequirePermissions('notifications:delete')
  @Roles(
    UserRole.SUPER_ADMIN,
    UserRole.TENANT_ADMIN,
    UserRole.CUSTOMER,
    UserRole.CUSTOMER_USER,
    UserRole.USER,
  )
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Bulk soft-delete notifications (max 100 per request)',
    description:
      'Partial success is the normal outcome: always answers 200 with one entry ' +
      'per requested id in `outcomes`. Every id is re-resolved server-side ' +
      "against the caller's own scope — tenant for a TENANT_ADMIN, customer for " +
      'a CUSTOMER, own rows for everyone else, and the tenant predicate is ' +
      'always applied. An id belonging to another tenant comes back as ' +
      '`not_found` and is NOT deleted. At most 100 ids — more is a 400. ' +
      'Deletes are soft (`deleted_at` is set).\n\n' +
      'Nothing cascades and nothing blocks: no table has a foreign key to ' +
      'notifications and a notification consumes no quota, so there is no ' +
      'counter to maintain. One transaction per id.',
  })
  @ApiResponse({ status: 200, description: 'Per-id outcomes', type: BulkResultDto })
  @ApiResponse({ status: 400, description: 'More than 100 ids, or a malformed id' })
  bulkDelete(
    @CurrentUser() user: User,
    @Body() dto: BulkDeleteNotificationsDto,
  ) {
    return this.notificationsService.bulkDelete(dto, user);
  }

  @Patch('bulk')
  @RequirePermissions('notifications:update')
  @Roles(
    UserRole.SUPER_ADMIN,
    UserRole.TENANT_ADMIN,
    UserRole.CUSTOMER,
    UserRole.CUSTOMER_USER,
    UserRole.USER,
  )
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Bulk update notifications (max 100 per request)',
    description:
      'ONLY `isRead` is bulk-updatable, and it is the only field that belongs ' +
      'to the reader rather than the delivery pipeline. `status`, `sentAt`, ' +
      '`deliveredAt`, `retryCount` and `failureReason` are written by ' +
      'NotificationsService when it sends — a client that could set them could ' +
      'claim a notification was delivered when it was not, which is also what ' +
      'the retry cron reads. `title`, `message`, `channel`, `type` and ' +
      '`priority` describe an event that already happened.\n\n' +
      'Setting `isRead: true` stamps `readAt`; `false` clears it. A ' +
      'notification already in the requested state is `skipped` and counts as ' +
      'a success. Same server-side scope re-check and 100-id cap as ' +
      'POST /notifications/bulk/delete. One transaction per id.\n\n' +
      'Prefer this over PATCH /notifications/read/multiple, which reports only ' +
      'a count and cannot mark anything unread.',
  })
  @ApiResponse({ status: 200, description: 'Per-id outcomes', type: BulkResultDto })
  @ApiResponse({
    status: 400,
    description: 'More than 100 ids, a malformed id, or isRead not supplied',
  })
  bulkUpdate(
    @CurrentUser() user: User,
    @Body() dto: BulkUpdateNotificationsDto,
  ) {
    return this.notificationsService.bulkUpdate(dto, user);
  }

  @Delete('read/all')
  @RequirePermissions('notifications:delete')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Delete all read notifications' })
  @ApiResponse({ status: 200, description: 'Read notifications deleted' })
  deleteAllRead(@CurrentUser() user: User) {
    return this.notificationsService.deleteAllRead(user);
  }

  @Post('bulk')
  @RequirePermissions('notifications:create')
@HttpCode(HttpStatus.OK)
@ApiOperation({ summary: 'Send bulk notifications' })
@ApiResponse({ status: 200, description: 'Bulk notifications sent' })
sendBulk(@Body() dto: SendBulkNotificationDto, @CurrentUser() user: User) {
  return this.notificationsService.sendBulk(dto);
}

/**
 * Broadcast to a whole tenant.
 *
 * Both of these took their target straight out of the URL and passed it
 * through, with no `@Roles` on the handler — and `RolesGuard` returns TRUE for
 * an undecorated handler. So **any authenticated user could send a
 * notification to every user of any tenant on the platform**, simply by
 * putting someone else's tenant id in the path. That is a spam and phishing
 * channel into other customers' accounts, delivered by this platform's own
 * branding.
 *
 * Now: TENANT_ADMIN and above, and a non-SUPER_ADMIN may only target their own
 * tenant.
 */
@Post('bulk/tenant/:tenantId')
@RequirePermissions('notifications:update')
@Roles(UserRole.SUPER_ADMIN, UserRole.TENANT_ADMIN)
@HttpCode(HttpStatus.OK)
@ApiOperation({
  summary: 'Send bulk notifications to all tenant users',
  description:
    'TENANT_ADMIN may only target their own tenant; SUPER_ADMIN may target any.',
})
@ApiResponse({ status: 200, description: 'Bulk notifications sent to tenant' })
sendBulkToTenant(
  @Param('tenantId') tenantId: string,
  @Body() dto: Omit<SendBulkNotificationDto, 'userIds'>,
  @CurrentUser() user: User,
) {
  if (user.role !== UserRole.SUPER_ADMIN && tenantId !== user.tenantId) {
    throw new ForbiddenException(
      'You can only send notifications within your own tenant',
    );
  }
  return this.notificationsService.sendBulkToTenant(tenantId, dto);
}

/**
 * Broadcast to a customer. Same hole as above: the customer id came from the
 * URL unchecked. A customer is verified to belong to the caller's tenant
 * before anything is sent.
 */
@Post('bulk/customer/:customerId')
@RequirePermissions('notifications:update')
@Roles(UserRole.SUPER_ADMIN, UserRole.TENANT_ADMIN, UserRole.CUSTOMER)
@HttpCode(HttpStatus.OK)
@ApiOperation({
  summary: 'Send bulk notifications to all customer users',
  description:
    'The customer must belong to the caller’s tenant. A CUSTOMER may only ' +
    'target their own customer.',
})
@ApiResponse({ status: 200, description: 'Bulk notifications sent to customer' })
async sendBulkToCustomer(
  @Param('customerId') customerId: string,
  @Body() dto: Omit<SendBulkNotificationDto, 'userIds'>,
  @CurrentUser() user: User,
) {
  if (user.role === UserRole.CUSTOMER && customerId !== user.customerId) {
    throw new ForbiddenException(
      'You can only send notifications within your own customer',
    );
  }

  if (user.role !== UserRole.SUPER_ADMIN) {
    // 404 rather than 403 for a foreign customer, so the endpoint cannot be
    // used to probe which customer ids exist in other tenants.
    const belongs = await this.notificationsService.customerBelongsToTenant(
      customerId,
      user.tenantId,
    );
    if (!belongs) {
      throw new NotFoundException('Customer not found');
    }
  }

  return this.notificationsService.sendBulkToCustomer(customerId, dto);
}

  @Post('retry-failed')
  @RequirePermissions('notifications:create')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Retry failed notifications' })
  @ApiResponse({ status: 200, description: 'Failed notifications retried' })
  retryFailed() {
    return this.notificationsService.retryFailed();
  }
}
