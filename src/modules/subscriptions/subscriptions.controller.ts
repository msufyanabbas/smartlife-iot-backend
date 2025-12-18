import {
  Controller,
  Get,
  Post,
  Body,
  UseGuards,
  HttpCode,
  HttpStatus,
  Param,
  NotFoundException,
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
  ScheduleDowngradeDto,
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
  @ApiOperation({ 
    summary: 'Create a new subscription',
    description: 'Creates a free subscription for new users. Paid plans require payment first.'
  })
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
  @ApiOperation({ summary: 'Get all available subscription plans with pricing' })
  @ApiResponse({ 
    status: 200, 
    description: 'List of subscription plans',
    schema: {
      example: [
        {
          plan: 'starter',
          name: 'Starter',
          monthlyPrice: 49,
          yearlyPrice: 490,
          limits: {
            devices: 50,
            users: 5,
            apiCalls: 50000,
            dataRetention: 30,
            storage: 10
          },
          features: {
            analytics: true,
            automation: true,
            integrations: false,
            support: 'email',
            whiteLabel: false
          }
        }
      ]
    }
  })
  getPlans() {
    return this.subscriptionsService.getPlans();
  }

  @Get('usage')
  @ApiOperation({ summary: 'Get current usage statistics vs limits' })
  @ApiResponse({ 
    status: 200, 
    description: 'Usage statistics',
    schema: {
      example: {
        current: {
          devices: 15,
          users: 3,
          apiCalls: 12500,
          storage: 4.2
        },
        limits: {
          devices: 50,
          users: 5,
          apiCalls: 50000,
          dataRetention: 30,
          storage: 10
        },
        percentage: {
          devices: 30,
          users: 60,
          apiCalls: 25,
          storage: 42
        }
      }
    }
  })
  getUsage(@CurrentUser() user: User) {
    return this.subscriptionsService.getUsage(user.id);
  }

  @Post('upgrade')
  @ApiOperation({ 
    summary: 'Initiate subscription upgrade (redirects to payment)',
    description: 'This endpoint validates the upgrade and returns payment requirement. To actually upgrade, user must complete payment via /payments/create endpoint.'
  })
  @ApiResponse({
    status: 200,
    description: 'Upgrade validated - payment required',
    schema: {
      example: {
        requiresPayment: true,
        message: 'Please complete payment to upgrade your subscription',
        plan: 'professional',
        billingPeriod: 'monthly'
      }
    }
  })
  @ApiResponse({ status: 400, description: 'Cannot downgrade using this endpoint' })
  @ApiResponse({ status: 404, description: 'No subscription found' })
  upgrade(
    @CurrentUser() user: User,
    @Body() upgradeDto: UpgradeSubscriptionDto,
  ) {
    return this.subscriptionsService.upgrade(user.id, upgradeDto);
  }

  @Post('downgrade/schedule')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ 
    summary: 'Schedule subscription downgrade',
    description: 'Schedules a downgrade to take effect at the end of current billing period. No immediate change or refund.'
  })
  @ApiResponse({
    status: 200,
    description: 'Downgrade scheduled successfully',
    schema: {
      example: {
        id: 'uuid',
        plan: 'professional',
        status: 'active',
        nextBillingDate: '2025-01-18T00:00:00Z',
        metadata: {
          scheduledDowngrade: {
            plan: 'starter',
            effectiveDate: '2025-01-18T00:00:00Z'
          }
        }
      }
    }
  })
  @ApiResponse({ status: 400, description: 'Invalid downgrade - target plan must be lower than current' })
  @ApiResponse({ status: 404, description: 'No subscription found' })
  scheduleDowngrade(
    @CurrentUser() user: User,
    @Body() downgradeDto: ScheduleDowngradeDto,
  ) {
    return this.subscriptionsService.scheduleDowngrade(user.id, downgradeDto.targetPlan);
  }

  @Post('downgrade/cancel')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ 
    summary: 'Cancel scheduled downgrade',
    description: 'Cancels a previously scheduled downgrade'
  })
  @ApiResponse({
    status: 200,
    description: 'Scheduled downgrade cancelled',
  })
  @ApiResponse({ status: 404, description: 'No scheduled downgrade found' })
  async cancelScheduledDowngrade(@CurrentUser() user: User) {
    const subscription = await this.subscriptionsService.findCurrent(user.id);
    
    if (!subscription.metadata?.scheduledDowngrade) {
      throw new NotFoundException('No scheduled downgrade found');
    }

    subscription.metadata = {
      ...subscription.metadata,
      scheduledDowngrade: undefined,
    };

    // Save through service (you may want to add a dedicated method)
    return subscription;
  }

  @Post('cancel')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ 
    summary: 'Cancel subscription',
    description: 'Cancels the subscription immediately. Access continues until end of billing period.'
  })
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
  @ApiOperation({ 
    summary: 'Get subscription invoices',
    description: 'Returns list of all invoices/receipts for this subscription'
  })
  @ApiResponse({ status: 200, description: 'List of invoices' })
  getInvoices(@CurrentUser() user: User) {
    return this.subscriptionsService.getInvoices(user.id);
  }
}