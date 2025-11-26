import {
  Controller,
  Get,
  Post,
  Body,
  UseGuards,
  HttpCode,
  HttpStatus,
} from '@nestjs/common';
import {
  ApiTags,
  ApiOperation,
  ApiResponse,
  ApiBearerAuth,
} from '@nestjs/swagger';
import { SubscriptionsService } from './subscriptions.service';
import {
  CreateSubscriptionDto,
  UpgradeSubscriptionDto,
} from './dto/create-subscription.dto';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { User } from '../users/entities/user.entity';

@ApiTags('subscriptions')
@Controller('subscriptions')
@UseGuards(JwtAuthGuard)
@ApiBearerAuth()
export class SubscriptionsController {
  constructor(private readonly subscriptionsService: SubscriptionsService) {}

  @Post()
  @ApiOperation({ summary: 'Create a new subscription' })
  @ApiResponse({
    status: 201,
    description: 'Subscription created successfully',
  })
  @ApiResponse({ status: 409, description: 'User already has a subscription' })
  create(
    @CurrentUser() user: User,
    @Body() createSubscriptionDto: CreateSubscriptionDto,
  ) {
    return this.subscriptionsService.create(user.id, createSubscriptionDto);
  }

  @Get()
  @ApiOperation({ summary: 'Get current subscription' })
  @ApiResponse({ status: 200, description: 'Current subscription details' })
  @ApiResponse({ status: 404, description: 'No subscription found' })
  findCurrent(@CurrentUser() user: User) {
    return this.subscriptionsService.findCurrent(user.id);
  }

  @Get('plans')
  @ApiOperation({ summary: 'Get all available subscription plans' })
  @ApiResponse({ status: 200, description: 'List of subscription plans' })
  getPlans() {
    return this.subscriptionsService.getPlans();
  }

  @Get('usage')
  @ApiOperation({ summary: 'Get current usage statistics' })
  @ApiResponse({ status: 200, description: 'Usage statistics' })
  getUsage(@CurrentUser() user: User) {
    return this.subscriptionsService.getUsage(user.id);
  }

  @Post('upgrade')
  @ApiOperation({ summary: 'Upgrade subscription plan' })
  @ApiResponse({
    status: 200,
    description: 'Subscription upgraded successfully',
  })
  @ApiResponse({ status: 404, description: 'No subscription found' })
  @ApiResponse({
    status: 409,
    description: 'Cannot downgrade using this endpoint',
  })
  upgrade(
    @CurrentUser() user: User,
    @Body() upgradeDto: UpgradeSubscriptionDto,
  ) {
    return this.subscriptionsService.upgrade(user.id, upgradeDto);
  }

  @Post('cancel')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Cancel subscription' })
  @ApiResponse({
    status: 200,
    description: 'Subscription cancelled successfully',
  })
  @ApiResponse({ status: 404, description: 'No subscription found' })
  @ApiResponse({ status: 409, description: 'Subscription already cancelled' })
  cancel(@CurrentUser() user: User) {
    return this.subscriptionsService.cancel(user.id);
  }

  @Get('invoices')
  @ApiOperation({ summary: 'Get subscription invoices' })
  @ApiResponse({ status: 200, description: 'List of invoices' })
  getInvoices(@CurrentUser() user: User) {
    return this.subscriptionsService.getInvoices(user.id);
  }
}
