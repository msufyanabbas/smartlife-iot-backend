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
  Req,
  RawBodyRequest,
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
    summary: 'Create a payment invoice',
    description: 'Creates a Moyasar invoice for upgrading or renewing a subscription. Returns a payment URL where the user can complete the payment.'
  })
  @ApiResponse({ 
    status: 201, 
    description: 'Payment invoice created successfully',
    schema: {
      example: {
        paymentUrl: 'https://moyasar.com/invoice/inv_xxxxx',
        invoiceId: 'inv_xxxxx',
        amount: 49,
        currency: 'SAR',
        description: 'Smart Life Starter Plan - monthly'
      }
    }
  })
  @ApiResponse({ status: 400, description: 'Bad request - Invalid plan or already have pending payment' })
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
    description: 'Checks the payment status with Moyasar and updates the subscription if payment succeeded. Call this after user returns from payment page.'
  })
  @ApiResponse({ 
    status: 200, 
    description: 'Payment verified and subscription updated',
    schema: {
      example: {
        id: 'uuid',
        status: 'succeeded',
        amount: 49,
        paidAt: '2025-12-03T10:30:00Z',
        metadata: {
          plan: 'starter',
          billingPeriod: 'monthly'
        }
      }
    }
  })
  @ApiResponse({ status: 404, description: 'Payment not found' })
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
            amount: 49,
            status: 'succeeded',
            createdAt: '2025-12-03T10:00:00Z',
            paidAt: '2025-12-03T10:30:00Z'
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
    description: 'Processes a full or partial refund for a successful payment'
  })
  @ApiResponse({ 
    status: 200, 
    description: 'Payment refunded successfully',
    schema: {
      example: {
        id: 'uuid',
        status: 'refunded',
        refundedAt: '2025-12-03T11:00:00Z',
        metadata: {
          refundId: 'ref_xxxxx',
          refundReason: 'Customer request',
          refundAmount: 49
        }
      }
    }
  })
  @ApiResponse({ status: 400, description: 'Cannot refund this payment - not successful or already refunded' })
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
    summary: 'Moyasar webhook endpoint',
    description: 'Called by Moyasar servers when payment status changes. This endpoint is PUBLIC and does not require authentication.'
  })
  @ApiHeader({
    name: 'x-moyasar-signature',
    description: 'Webhook signature for verification',
    required: false,
  })
  @ApiResponse({ 
    status: 200, 
    description: 'Webhook processed successfully',
    schema: {
      example: {
        received: true,
        message: 'Payment processed'
      }
    }
  })
  @ApiResponse({ 
    status: 200, 
    description: 'Webhook processing failed but acknowledged',
    schema: {
      example: {
        received: true,
        message: 'Error: Payment not found'
      }
    }
  })
  async handleWebhook(
    @Body() payload: any,
    @Headers('x-moyasar-signature') signature?: string,
  ) {
    return this.paymentsService.handleWebhook(payload, signature);
  }

  // ADMIN ENDPOINT: Get payments requiring manual review
  @Get('admin/review-required')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({ 
    summary: 'Get payments requiring manual review (Admin)',
    description: 'Returns payments where the payment succeeded but subscription update failed'
  })
  @ApiResponse({ status: 200, description: 'List of payments requiring review' })
  async getPaymentsRequiringReview() {
    // TODO: Add admin role guard
    return this.paymentsService.getPaymentsRequiringReview();
  }
}