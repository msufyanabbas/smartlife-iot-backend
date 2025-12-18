// src/modules/payments/payments.controller.ts
import {
  Controller,
  Get,
  Post,
  Body,
  Param,
  Query,
  UseGuards,
  HttpCode,
  HttpStatus,
  Headers,
} from '@nestjs/common';
import {
  ApiTags,
  ApiOperation,
  ApiResponse,
  ApiBearerAuth,
  ApiQuery,
  ApiHeader,
} from '@nestjs/swagger';
import { PaymentsService } from './payments.service';
import {
  CreatePaymentIntentDto,
  RefundPaymentDto,
} from './dto/create-payment.dto';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { User } from '../users/entities/user.entity';

@ApiTags('payments')
@Controller('payments')
export class PaymentsController {
  constructor(private readonly paymentsService: PaymentsService) {}

  @Post('create')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({ 
    summary: 'Create a payment invoice for subscription upgrade/renewal',
    description: `
      Creates a Moyasar invoice for upgrading or renewing a subscription. 
      
      **Important Notes:**
      - This endpoint validates that the request is an UPGRADE or RENEWAL (not downgrade)
      - Downgrades are not allowed and must be scheduled via /subscriptions/downgrade/schedule
      - Returns a payment URL where the user completes the payment
      - After payment, subscription is automatically updated via webhook or verify endpoint
      
      **Flow:**
      1. User calls this endpoint with desired plan
      2. System validates upgrade eligibility
      3. Returns payment URL
      4. User completes payment on Moyasar
      5. Webhook or verify endpoint processes payment and updates subscription
    `
  })
  @ApiResponse({ 
    status: 201, 
    description: 'Payment invoice created successfully',
    schema: {
      example: {
        paymentUrl: 'https://moyasar.com/invoice/inv_xxxxx',
        invoiceId: 'inv_xxxxx',
        amount: 149,
        currency: 'SAR',
        description: 'Smart Life Professional Plan - monthly'
      }
    }
  })
  @ApiResponse({ 
    status: 400, 
    description: 'Bad request - Cannot create payment for downgrade, free plan, or invalid parameters' 
  })
  @ApiResponse({ status: 404, description: 'Subscription not found' })
  async createPayment(
    @CurrentUser() user: User,
    @Body() createPaymentIntentDto: CreatePaymentIntentDto,
  ) {
    return this.paymentsService.createPaymentIntent(
      user.id,
      createPaymentIntentDto,
    );
  }

  @Get('verify/:invoiceId')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({ 
    summary: 'Verify payment status and update subscription',
    description: `
      Checks the payment status with Moyasar and updates the subscription if payment succeeded.
      
      **When to call:**
      - After user returns from Moyasar payment page
      - To check status of pending payment
      
      **What it does:**
      - Fetches invoice status from Moyasar
      - If paid: Updates subscription with transaction (atomic)
      - If failed: Marks payment as cancelled
      - Idempotent: Safe to call multiple times
      
      **Transaction Safety:**
      - Uses database transaction to ensure payment + subscription update are atomic
      - If subscription update fails, payment is marked for manual review
    `
  })
  @ApiResponse({ 
    status: 200, 
    description: 'Payment verified',
    schema: {
      example: {
        id: 'uuid',
        status: 'succeeded',
        amount: 149,
        paidAt: '2025-12-18T10:30:00Z',
        metadata: {
          plan: 'professional',
          billingPeriod: 'monthly'
        }
      }
    }
  })
  @ApiResponse({ status: 404, description: 'Payment not found' })
  @ApiResponse({ 
    status: 500, 
    description: 'Payment processed but subscription update failed - marked for manual review' 
  })
  async verifyPayment(
    @CurrentUser() user: User,
    @Param('invoiceId') invoiceId: string,
  ) {
    return this.paymentsService.verifyPayment(invoiceId);
  }

  @Get('history')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({ 
    summary: 'Get payment history',
    description: 'Returns a paginated list of all payments made by the user'
  })
  @ApiResponse({ 
    status: 200, 
    description: 'Payment history retrieved',
    schema: {
      example: {
        payments: [
          {
            id: 'uuid',
            amount: 149,
            status: 'succeeded',
            createdAt: '2025-12-03T10:00:00Z',
            paidAt: '2025-12-03T10:30:00Z',
            description: 'Smart Life Professional Plan - monthly'
          }
        ],
        pagination: {
          total: 5,
          page: 1,
          limit: 10,
          totalPages: 1
        }
      }
    }
  })
  @ApiQuery({ name: 'page', required: false, type: Number, example: 1, description: 'Page number' })
  @ApiQuery({ name: 'limit', required: false, type: Number, example: 10, description: 'Items per page' })
  async getPaymentHistory(
    @CurrentUser() user: User,
    @Query('page') page?: number,
    @Query('limit') limit?: number,
  ) {
    return this.paymentsService.getPaymentHistory(user.id, page, limit);
  }

  @Get(':id')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({ 
    summary: 'Get payment details by ID',
    description: 'Returns detailed information about a specific payment'
  })
  @ApiResponse({ status: 200, description: 'Payment details retrieved' })
  @ApiResponse({ status: 404, description: 'Payment not found' })
  async findOne(@CurrentUser() user: User, @Param('id') id: string) {
    return this.paymentsService.findOne(user.id, id);
  }

  @Post('refund')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ 
    summary: 'Refund a payment',
    description: `
      Processes a full or partial refund for a successful payment.
      
      **Business Logic:**
      - Only successful payments can be refunded
      - Refunds are processed through Moyasar
      - Uses transaction to ensure atomicity
      
      **TODO:** Implement subscription downgrade logic after refund based on your business rules
    `
  })
  @ApiResponse({ 
    status: 200, 
    description: 'Payment refunded successfully',
    schema: {
      example: {
        id: 'uuid',
        status: 'refunded',
        refundedAt: '2025-12-18T11:00:00Z',
        metadata: {
          refundId: 'ref_xxxxx',
          refundReason: 'Customer request',
          refundAmount: 149
        }
      }
    }
  })
  @ApiResponse({ 
    status: 400, 
    description: 'Cannot refund this payment - not successful or already refunded' 
  })
  @ApiResponse({ status: 404, description: 'Payment not found' })
  async refundPayment(
    @CurrentUser() user: User, 
    @Body() refundDto: RefundPaymentDto
  ) {
    return this.paymentsService.refundPayment(user.id, refundDto);
  }

  // ⚠️ PUBLIC ENDPOINT - No auth required (Moyasar calls this)
  @Post('webhook')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ 
    summary: 'Moyasar webhook endpoint (PUBLIC)',
    description: `
      Called by Moyasar servers when payment status changes.
      
      **Security:**
      - Verifies webhook signature if MOYASAR_WEBHOOK_SECRET is configured
      - Idempotent - safe for Moyasar to retry
      
      **What it does:**
      - Receives payment status updates from Moyasar
      - Calls verifyPayment to process the update
      - Uses same transaction logic as verify endpoint
      
      **This endpoint is PUBLIC** - no authentication required as Moyasar doesn't support auth headers
    `
  })
  @ApiHeader({
    name: 'x-moyasar-signature',
    description: 'Webhook signature for verification',
    required: false,
  })
  @ApiResponse({ 
    status: 200, 
    description: 'Webhook acknowledged (always returns 200 to Moyasar)',
    schema: {
      example: {
        received: true,
        message: 'Payment processed'
      }
    }
  })
  async handleWebhook(
    @Body() payload: any,
    @Headers('x-moyasar-signature') signature?: string,
  ) {
    return this.paymentsService.handleWebhook(payload, signature);
  }

  // ============================================================================
  // ADMIN ENDPOINTS
  // ============================================================================

  @Get('admin/review-required')
  @UseGuards(JwtAuthGuard) // TODO: Add AdminGuard
  @ApiBearerAuth()
  @ApiOperation({ 
    summary: '[ADMIN] Get payments requiring manual review',
    description: `
      Returns payments where the payment succeeded but subscription update failed.
      These require manual intervention.
      
      **TODO:** Add admin role guard to restrict access
    `
  })
  @ApiResponse({ 
    status: 200, 
    description: 'List of payments requiring review',
    schema: {
      example: [
        {
          id: 'uuid',
          userId: 'user-uuid',
          status: 'succeeded',
          paidAt: '2025-12-18T10:30:00Z',
          metadata: {
            requiresManualReview: true,
            subscriptionUpdateError: 'Cannot downgrade using upgrade endpoint',
            errorTimestamp: '2025-12-18T10:30:05Z'
          }
        }
      ]
    }
  })
  async getPaymentsRequiringReview() {
    return this.paymentsService.getPaymentsRequiringReview();
  }

  @Post('admin/retry/:paymentId')
  @UseGuards(JwtAuthGuard) // TODO: Add AdminGuard
  @ApiBearerAuth()
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ 
    summary: '[ADMIN] Manually retry failed subscription update',
    description: `
      Attempts to reprocess the subscription update for a payment that previously failed.
      
      **Use case:**
      - Payment succeeded but subscription update failed due to temporary error
      - Admin reviews the issue and manually retries
      
      **TODO:** Add admin role guard to restrict access
    `
  })
  @ApiResponse({ 
    status: 200, 
    description: 'Subscription update retried successfully' 
  })
  @ApiResponse({ 
    status: 400, 
    description: 'Payment not eligible for retry' 
  })
  @ApiResponse({ status: 404, description: 'Payment not found' })
  async retrySubscriptionUpdate(
    @Param('paymentId') paymentId: string,
  ) {
    return this.paymentsService.retrySubscriptionUpdate(paymentId);
  }
}