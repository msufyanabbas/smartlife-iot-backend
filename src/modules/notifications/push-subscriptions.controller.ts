import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import {
  IsIn,
  IsObject,
  IsOptional,
  IsString,
  MaxLength,
  MinLength,
  ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';
import { Roles } from '@common/decorators/index.decorator';
import { RequirePermissions } from '@common/decorators/permission.decorator';
import { CurrentUser } from '@common/decorators/current-user.decorator';
import { UserRole } from '@common/enums/index.enum';
import { User } from '@modules/index.entities';
import { PushSubscriptionsService } from './push-subscriptions.service';
import { PushChannel } from './channels/push.channel';
import {
  PUSH_PLATFORMS,
  type PushPlatform,
} from './entities/push-subscription.entity';

class WebPushKeysDto {
  @IsString() @MinLength(8) p256dh: string;
  @IsString() @MinLength(8) auth: string;
}

class RegisterPushSubscriptionDto {
  /** FCM registration token, or a Web Push endpoint URL. */
  @IsString() @MinLength(20) @MaxLength(2000) token: string;

  // `enumName` is not needed here (this is a body, not a @Query/@Param), but
  // the literal union is declared with IsIn rather than a TS enum because the
  // platform list is a const array — see §4h for the Swagger trap on enums.
  @IsOptional() @IsIn(PUSH_PLATFORMS) platform?: PushPlatform;

  @IsOptional()
  @ValidateNested()
  @Type(() => WebPushKeysDto)
  keys?: WebPushKeysDto;

  @IsOptional() @IsObject() deviceInfo?: Record<string, unknown>;
}

class UnregisterPushSubscriptionDto {
  @IsString() @MinLength(20) @MaxLength(2000) token: string;
}

/**
 * Device registration for push notifications.
 *
 * Its own top-level path rather than `notifications/push-subscriptions`:
 * `NotificationsController` declares `@Get(':id')`, and a sibling path under
 * the same prefix would be shadowed by it depending on controller
 * registration order.
 *
 * Every handler carries `@Roles(...)`. An undecorated handler is open to every
 * authenticated account on the platform (§4g) — and these routes write a row
 * that decides where a user's notifications are delivered, so an open one
 * would let anyone point another tenant's alerts at their own device.
 *
 * All four roles are listed because this is self-service: each caller manages
 * only its own devices, and the service pins every query to
 * `(tenantId, userId)` taken from the JWT, never from the body.
 */
const SELF_SERVICE_ROLES = [
  UserRole.SUPER_ADMIN,
  UserRole.TENANT_ADMIN,
  UserRole.CUSTOMER,
  UserRole.CUSTOMER_USER,
  UserRole.USER,
] as const;

@ApiTags('notifications')
@Controller('push-subscriptions')
@ApiBearerAuth()
export class PushSubscriptionsController {
  constructor(
    private readonly subscriptions: PushSubscriptionsService,
    private readonly pushChannel: PushChannel,
  ) {}

  @Get('status')
  @Roles(...SELF_SERVICE_ROLES)
  @RequirePermissions('notifications:read')
  @ApiOperation({
    summary: 'Which push transports this deployment can actually use',
    description:
      'Reports FCM and Web Push separately, plus the absence of a direct ' +
      'APNs transport. The client uses this to decide whether to ask the ' +
      'browser or the OS for permission at all.',
  })
  @ApiResponse({ status: 200, description: 'Push transport status' })
  status() {
    return this.pushChannel.getStatus();
  }

  @Get()
  @Roles(...SELF_SERVICE_ROLES)
  @RequirePermissions('notifications:read')
  @ApiOperation({ summary: "The caller's own registered devices" })
  @ApiResponse({ status: 200, description: 'Registered push subscriptions' })
  findMine(@CurrentUser() user: User) {
    return this.subscriptions.findMine(user);
  }

  @Post()
  @Roles(...SELF_SERVICE_ROLES)
  @RequirePermissions('notifications:create')
  @ApiOperation({
    summary: 'Register (or refresh) this device for push notifications',
    description:
      'Idempotent on the token: calling it again refreshes lastSeenAt and ' +
      're-enables a subscription a provider had reported as unregistered.',
  })
  @ApiResponse({ status: 201, description: 'Subscription registered' })
  register(
    @CurrentUser() user: User,
    @Body() dto: RegisterPushSubscriptionDto,
  ) {
    return this.subscriptions.register(user, dto);
  }

  @Delete()
  @HttpCode(HttpStatus.OK)
  @Roles(...SELF_SERVICE_ROLES)
  @RequirePermissions('notifications:delete')
  @ApiOperation({
    summary: 'Unregister a device by token',
    description:
      'The token goes in the body because a Web Push endpoint is a URL and ' +
      'does not survive being a path parameter.',
  })
  @ApiResponse({ status: 200, description: 'Subscription removed' })
  @ApiResponse({ status: 404, description: 'Not registered to this caller' })
  unregister(
    @CurrentUser() user: User,
    @Body() dto: UnregisterPushSubscriptionDto,
  ) {
    return this.subscriptions.unregister(user, dto.token);
  }

  @Delete(':id')
  @HttpCode(HttpStatus.OK)
  @Roles(...SELF_SERVICE_ROLES)
  @RequirePermissions('notifications:delete')
  @ApiOperation({ summary: 'Unregister one of the caller\'s devices by id' })
  @ApiResponse({ status: 200, description: 'Subscription removed' })
  @ApiResponse({ status: 404, description: 'Not registered to this caller' })
  unregisterById(
    @CurrentUser() user: User,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.subscriptions.unregisterById(user, id);
  }
}
