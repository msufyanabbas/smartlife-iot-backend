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

@ApiTags('notifications')
@Controller('notifications')
@UseGuards(JwtAuthGuard)
@ApiBearerAuth()
export class NotificationsController {
  constructor(private readonly notificationsService: NotificationsService) {}

  @Post()
  @ApiOperation({ summary: 'Create new notification' })
  @ApiResponse({ status: 201, description: 'Notification created' })
  create(@Body() createDto: CreateNotificationDto) {
    return this.notificationsService.create(createDto);
  }

  @Get()
  @ApiOperation({ summary: 'Get all notifications' })
  @ApiResponse({ status: 200, description: 'List of notifications' })
  findAll(@CurrentUser() user: User, @Query() query: NotificationQueryDto) {
    return this.notificationsService.findAll(user, query);
  }

  @Get('unread-count')
  @ApiOperation({ summary: 'Get unread notification count' })
  @ApiResponse({ status: 200, description: 'Unread count' })
  getUnreadCount(@CurrentUser() user: User) {
    return this.notificationsService.getUnreadCount(user);
  }

  @Get('statistics')
  @ApiOperation({ summary: 'Get notification statistics' })
  @ApiResponse({ status: 200, description: 'Notification statistics' })
  getStatistics(@CurrentUser() user: User) {
    return this.notificationsService.getStatistics(user);
  }

  @Get(':id')
  @ApiOperation({ summary: 'Get notification by ID' })
  @ApiResponse({ status: 200, description: 'Notification found' })
  @ApiResponse({ status: 404, description: 'Notification not found' })
  findOne(@Param('id', ParseIdPipe) id: string, @CurrentUser() user: User) {
    return this.notificationsService.findOne(id, user);
  }

  @Patch(':id/read')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Mark notification as read' })
  @ApiResponse({ status: 200, description: 'Notification marked as read' })
  markAsRead(@Param('id', ParseIdPipe) id: string, @CurrentUser() user: User) {
    return this.notificationsService.markAsRead(id, user);
  }

  @Patch('read/multiple')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Mark multiple notifications as read' })
  @ApiResponse({ status: 200, description: 'Notifications marked as read' })
  markMultipleAsRead(@CurrentUser() user: User, @Body() dto: MarkAsReadDto) {
    return this.notificationsService.markMultipleAsRead(user, dto);
  }

  @Patch('read/all')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Mark all notifications as read' })
  @ApiResponse({ status: 200, description: 'All notifications marked as read' })
  markAllAsRead(@CurrentUser() user: User) {
    return this.notificationsService.markAllAsRead(user);
  }

  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Delete notification' })
  @ApiResponse({ status: 204, description: 'Notification deleted' })
  remove(@Param('id', ParseIdPipe) id: string, @CurrentUser() user: User) {
    return this.notificationsService.remove(id, user);
  }

  @Delete('read/all')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Delete all read notifications' })
  @ApiResponse({ status: 200, description: 'Read notifications deleted' })
  deleteAllRead(@CurrentUser() user: User) {
    return this.notificationsService.deleteAllRead(user);
  }

  @Post('bulk')
@HttpCode(HttpStatus.OK)
@ApiOperation({ summary: 'Send bulk notifications' })
@ApiResponse({ status: 200, description: 'Bulk notifications sent' })
sendBulk(@Body() dto: SendBulkNotificationDto, @CurrentUser() user: User) {
  return this.notificationsService.sendBulk(dto);
}

@Post('bulk/tenant/:tenantId')
@HttpCode(HttpStatus.OK)
@ApiOperation({ summary: 'Send bulk notifications to all tenant users' })
@ApiResponse({ status: 200, description: 'Bulk notifications sent to tenant' })
sendBulkToTenant(
  @Param('tenantId') tenantId: string,
  @Body() dto: Omit<SendBulkNotificationDto, 'userIds'>,
) {
  return this.notificationsService.sendBulkToTenant(tenantId, dto);
}

@Post('bulk/customer/:customerId')
@HttpCode(HttpStatus.OK)
@ApiOperation({ summary: 'Send bulk notifications to all customer users' })
@ApiResponse({ status: 200, description: 'Bulk notifications sent to customer' })
sendBulkToCustomer(
  @Param('customerId') customerId: string,
  @Body() dto: Omit<SendBulkNotificationDto, 'userIds'>,
) {
  return this.notificationsService.sendBulkToCustomer(customerId, dto);
}

  @Post('retry-failed')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Retry failed notifications' })
  @ApiResponse({ status: 200, description: 'Failed notifications retried' })
  retryFailed() {
    return this.notificationsService.retryFailed();
  }
}
