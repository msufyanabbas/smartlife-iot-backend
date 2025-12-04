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
} from '@nestjs/common';
import {
  ApiTags,
  ApiOperation,
  ApiResponse,
  ApiBearerAuth,
  ApiQuery,
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
  @ApiOperation({ summary: 'Create a payment invoice' })
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
  @ApiResponse({ status: 400, description: 'Bad request' })
  @ApiResponse({ status: 404, description: 'Subscription not found' })
  createPayment(
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
  @ApiOperation({ summary: 'Verify payment status and upgrade subscription' })
  @ApiResponse({ 
    status: 200, 
    description: 'Payment verified',
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
  verifyPayment(
    @CurrentUser() user: User,
    @Param('invoiceId') invoiceId: string,
  ) {
    return this.paymentsService.verifyPayment(invoiceId);
  }

  @Get('history')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Get payment history' })
  @ApiResponse({ status: 200, description: 'Payment history retrieved' })
  @ApiQuery({ name: 'page', required: false, type: Number, example: 1 })
  @ApiQuery({ name: 'limit', required: false, type: Number, example: 10 })
  getPaymentHistory(
    @CurrentUser() user: User,
    @Query('page') page?: number,
    @Query('limit') limit?: number,
  ) {
    return this.paymentsService.getPaymentHistory(user.id, page, limit);
  }

  @Get(':id')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Get payment details by ID' })
  @ApiResponse({ status: 200, description: 'Payment details retrieved' })
  @ApiResponse({ status: 404, description: 'Payment not found' })
  findOne(@CurrentUser() user: User, @Param('id') id: string) {
    return this.paymentsService.findOne(user.id, id);
  }

  @Post('refund')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Refund a payment' })
  @ApiResponse({ status: 200, description: 'Payment refunded successfully' })
  @ApiResponse({ status: 400, description: 'Cannot refund this payment' })
  @ApiResponse({ status: 404, description: 'Payment not found' })
  refundPayment(@CurrentUser() user: User, @Body() refundDto: RefundPaymentDto) {
    return this.paymentsService.refundPayment(user.id, refundDto);
  }

  // ⚠️ PUBLIC ENDPOINT - No auth required (Moyasar calls this)
  @Post('webhook')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Moyasar webhook endpoint (called by Moyasar servers)' })
  @ApiResponse({ status: 200, description: 'Webhook processed successfully' })
  @ApiResponse({ status: 400, description: 'Webhook processing failed' })
  async handleWebhook(@Body() payload: any) {
    return this.paymentsService.handleWebhook(payload);
  }
}