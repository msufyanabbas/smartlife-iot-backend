// src/modules/payments/payments.service.ts
import {
  Injectable,
  NotFoundException,
  BadRequestException,
  InternalServerErrorException,
  Logger,
  ConflictException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { ConfigService } from '@nestjs/config';
import axios from 'axios';
import * as crypto from 'crypto';
import { 
  Payment, 
  PaymentStatus, 
  PaymentProvider 
} from './entities/payment.entity';
import { SubscriptionsService } from '../subscriptions/subscriptions.service';
import {
  CreatePaymentIntentDto,
  RefundPaymentDto,
} from './dto/create-payment.dto';
import {
  SubscriptionPlan,
  BillingPeriod,
} from '../subscriptions/entities/subscription.entity';

@Injectable()
export class PaymentsService {
  private readonly moyasarApiUrl = 'https://api.moyasar.com/v1';
  private readonly moyasarApiKey: string;
  private readonly moyasarWebhookSecret: string;
  private readonly logger = new Logger(PaymentsService.name);

  constructor(
    @InjectRepository(Payment)
    private readonly paymentRepository: Repository<Payment>,
    private readonly subscriptionsService: SubscriptionsService,
    private readonly configService: ConfigService,
  ) {
    const apiKey = this.configService.get<string>('MOYASAR_API_KEY');
    const webhookSecret = this.configService.get<string>('MOYASAR_WEBHOOK_SECRET');
    
    if (!apiKey) {
      throw new Error('MOYASAR_API_KEY must be configured in environment variables');
    }
    
    this.moyasarApiKey = apiKey;
    this.moyasarWebhookSecret = webhookSecret || '';
    
    if (!this.moyasarWebhookSecret) {
      this.logger.warn('⚠️ MOYASAR_WEBHOOK_SECRET not set - webhook signature verification disabled');
    }
  }

  /**
   * Create a Moyasar invoice (hosted payment page)
   * Ensures user has a subscription before creating payment
   */
  async createPaymentIntent(
    userId: string,
    createPaymentIntentDto: CreatePaymentIntentDto,
  ): Promise<{
    paymentUrl: string;
    invoiceId: string;
    amount: number;
    currency: string;
    description: string;
  }> {
    try {
      const { plan, billingPeriod } = createPaymentIntentDto;

      // Ensure user has a subscription (create free one if not exists)
      let subscription = await this.subscriptionsService
        .findCurrent(userId)
        .catch(() => null);

      if (!subscription) {
        this.logger.log(`Creating free subscription for user ${userId} before payment`);
        subscription = await this.subscriptionsService.getOrCreateFreeSubscription(userId);
      }

      // Calculate amount
      const amount = this.subscriptionsService.getPlanPricing(plan, billingPeriod);

      if (amount === 0) {
        throw new BadRequestException('Cannot create payment for free plan');
      }

      // Check if there's already a pending payment for this upgrade
      const existingPending = await this.paymentRepository
  .createQueryBuilder('payment')
  .where('payment.userId = :userId', { userId })
  .andWhere('payment.status = :status', { status: PaymentStatus.PENDING })
  .andWhere("payment.metadata->>'plan' = :plan", { plan })
  .andWhere("payment.metadata->>'billingPeriod' = :billingPeriod", { billingPeriod })
  .getOne();

      if (existingPending) {
        this.logger.warn(`Reusing existing pending payment: ${existingPending.paymentIntentId}`);
        
        // Fetch the invoice URL from Moyasar
        try {
          const response = await axios.get(
            `${this.moyasarApiUrl}/invoices/${existingPending.paymentIntentId}`,
            {
              auth: {
                username: this.moyasarApiKey,
                password: '',
              },
            },
          );

          return {
            paymentUrl: response.data.url,
            invoiceId: existingPending.paymentIntentId,
            amount: existingPending.amount,
            currency: existingPending.currency,
            description: existingPending.description || '',
          };
        } catch (fetchError) {
          this.logger.warn(`Could not fetch existing invoice, creating new one`);
          // Continue to create new invoice
        }
      }

      // Convert to halalas (must end with 0)
      let amountInHalalas = Math.round(amount * 100);
      if (amountInHalalas % 10 !== 0) {
        amountInHalalas = Math.ceil(amountInHalalas / 10) * 10;
      }

      this.logger.log(
        `Creating invoice for user ${userId}: ${amountInHalalas / 100} SAR (${plan} - ${billingPeriod})`
      );

      // Callback URL
      const frontendUrl = this.configService.get('FRONTEND_URL') || 'http://localhost:3001';
      const callbackUrl = `${frontendUrl}/payment/callback`;

      // Create invoice payload
      const invoicePayload = {
        amount: amountInHalalas,
        currency: 'SAR',
        description: `Smart Life ${plan.charAt(0).toUpperCase() + plan.slice(1)} Plan - ${billingPeriod}`,
        callback_url: callbackUrl,
        metadata: {
          user_id: userId,
          subscription_id: subscription.id,
          plan: plan,
          billing_period: billingPeriod,
        },
      };

      // Create invoice with Moyasar
      const response = await axios.post(
        `${this.moyasarApiUrl}/invoices`,
        invoicePayload,
        {
          auth: {
            username: this.moyasarApiKey,
            password: '',
          },
          headers: {
            'Content-Type': 'application/json',
          },
        },
      );

      const invoice = response.data;

      this.logger.log(`✅ Invoice created: ${invoice.id} - URL: ${invoice.url}`);

      // Save payment record (status: PENDING)
      const payment = this.paymentRepository.create({
        userId,
        subscriptionId: subscription.id,
        paymentIntentId: invoice.id,
        provider: PaymentProvider.MOYASAR,
        amount: amountInHalalas / 100,
        currency: 'SAR',
        status: PaymentStatus.PENDING,
        description: invoicePayload.description,
        metadata: {
          plan,
          billingPeriod,
          invoiceId: invoice.id,
        },
        createdBy: userId,
      });

      await this.paymentRepository.save(payment);

      this.logger.log(`Payment record saved: ${payment.id}`);

      return {
        paymentUrl: invoice.url,
        invoiceId: invoice.id,
        amount: amountInHalalas / 100,
        currency: 'SAR',
        description: invoicePayload.description,
      };
    } catch (error) {
      if (axios.isAxiosError(error)) {
        const errorData = error.response?.data;
        this.logger.error(`Moyasar API Error: ${JSON.stringify(errorData)}`);
        
        throw new BadRequestException(
          errorData?.message || 'Failed to create payment',
        );
      }

      this.logger.error(`Payment creation failed: ${error.message}`, error.stack);
      throw new InternalServerErrorException('Failed to create payment');
    }
  }

  /**
   * Verify payment/invoice status with idempotency protection
   * Called by: Frontend after redirect OR Webhook
   */
  async verifyPayment(invoiceId: string): Promise<Payment> {
    try {
      this.logger.log(`🔍 Verifying payment: ${invoiceId}`);

      // Find payment in database first
      const payment = await this.paymentRepository.findOne({
        where: { paymentIntentId: invoiceId },
      });

      if (!payment) {
        throw new NotFoundException(`Payment not found for invoice: ${invoiceId}`);
      }

      // IDEMPOTENCY: If already processed successfully, return immediately
      if (payment.status === PaymentStatus.SUCCEEDED && payment.paidAt) {
        this.logger.log(`✅ Payment ${invoiceId} already processed successfully`);
        return payment;
      }

      // Fetch invoice from Moyasar
      const response = await axios.get(
        `${this.moyasarApiUrl}/invoices/${invoiceId}`,
        {
          auth: {
            username: this.moyasarApiKey,
            password: '',
          },
        },
      );

      const invoice = response.data;
      this.logger.debug(`Invoice status from Moyasar: ${invoice.status}`);

      // Process based on invoice status
      if (invoice.status === 'paid') {
        return await this.processSuccessfulPayment(payment, invoice);
      } else if (invoice.status === 'expired' || invoice.status === 'canceled') {
        return await this.processFailedPayment(payment, invoice);
      } else if (invoice.status === 'pending') {
        this.logger.log(`Payment ${invoiceId} still PENDING`);
        return payment;
      }

      return payment;
    } catch (error) {
      this.logger.error(`❌ Verification failed: ${error.message}`, error.stack);
      
      if (error instanceof NotFoundException) {
        throw error;
      }
      
      throw new InternalServerErrorException('Failed to verify payment');
    }
  }

  /**
   * Process successful payment with proper locking and error handling
   */
  private async processSuccessfulPayment(
    payment: Payment,
    invoice: any,
  ): Promise<Payment> {
    // Double-check status to prevent race conditions
    if (payment.status === PaymentStatus.SUCCEEDED) {
      this.logger.log(`Payment ${payment.paymentIntentId} already marked as succeeded`);
      return payment;
    }

    this.logger.log(`💰 Payment ${payment.paymentIntentId} is PAID - processing subscription`);

    // Update payment status first
    payment.status = PaymentStatus.SUCCEEDED;
    payment.paidAt = new Date(invoice.paid_at || invoice.updated_at);
    await this.paymentRepository.save(payment);

    // Process subscription upgrade/renewal
    if (payment.metadata?.plan && payment.metadata?.billingPeriod) {
      try {
        const targetPlan = payment.metadata.plan as SubscriptionPlan;
        const targetBilling = payment.metadata.billingPeriod as BillingPeriod;

        // Get current subscription
        const currentSub = await this.subscriptionsService.findCurrent(payment.userId);

         // 🔍 ADD THESE DEBUG LOGS
      this.logger.log(`Current subscription: ${JSON.stringify({
        plan: currentSub.plan,
        billingPeriod: currentSub.billingPeriod,
        status: currentSub.status
      })}`);
      
      this.logger.log(`Target: ${targetPlan} - ${targetBilling}`);

        // Determine if this is an upgrade or renewal
        const planOrder = [
          SubscriptionPlan.FREE,
          SubscriptionPlan.STARTER,
          SubscriptionPlan.PROFESSIONAL,
          SubscriptionPlan.ENTERPRISE,
        ];
        
        const currentPlanIndex = planOrder.indexOf(currentSub.plan);
        const targetPlanIndex = planOrder.indexOf(targetPlan);

        this.logger.log(`Plan indices - Current: ${currentPlanIndex}, Target: ${targetPlanIndex}`);

        if (targetPlanIndex > currentPlanIndex) {
          // UPGRADE
          this.logger.log(`⬆️ Upgrading subscription from ${currentSub.plan} to ${targetPlan}`);
          
           const upgraded = await this.subscriptionsService.upgrade(payment.userId, {
          plan: targetPlan,
          billingPeriod: targetBilling,
        });

        this.logger.log(`✅ Upgrade completed: ${JSON.stringify({
          id: upgraded.id,
          plan: upgraded.plan,
          status: upgraded.status,
          nextBillingDate: upgraded.nextBillingDate
        })}`);
        
        } else if (targetPlanIndex === currentPlanIndex) {
          // RENEWAL
          this.logger.log(`🔄 Renewing subscription for ${targetPlan} plan`);
          
          await this.subscriptionsService.renew(payment.userId, targetBilling);
        } else {
          // DOWNGRADE (shouldn't happen through normal flow)
          this.logger.warn(`⚠️ Payment for downgrade detected: ${currentSub.plan} → ${targetPlan}`);
          
          // For downgrades, we still process as renewal of current billing period
          await this.subscriptionsService.renew(payment.userId, targetBilling);
        }
        
        this.logger.log(`✅ Subscription updated successfully for user ${payment.userId}`);
      } catch (subscriptionError) {
        this.logger.error(
          `❌ Failed to update subscription: ${subscriptionError.message}`,
          subscriptionError.stack,
        );
        
        // Payment succeeded but subscription update failed
        // Mark payment with error metadata for manual review
        payment.metadata = {
          ...payment.metadata,
          subscriptionUpdateError: subscriptionError.message,
          requiresManualReview: true,
        };
        
        await this.paymentRepository.save(payment);
        
        // Don't throw - payment is still successful
        // But log for alerting/monitoring
        this.logger.error(`🚨 ALERT: Payment ${payment.id} succeeded but subscription update failed!`);
      }
    }

    return payment;
  }

  /**
   * Process failed/cancelled payment
   */
  private async processFailedPayment(payment: Payment, invoice: any): Promise<Payment> {
    this.logger.warn(`❌ Payment ${payment.paymentIntentId} is ${invoice.status.toUpperCase()}`);
    
    payment.status = PaymentStatus.CANCELLED;
    payment.failureReason = `Invoice ${invoice.status}`;
    
    await this.paymentRepository.save(payment);
    
    return payment;
  }

  /**
   * Webhook handler - Called by Moyasar when payment status changes
   * CRITICAL: This runs independently of user actions
   */
  async handleWebhook(
    payload: any,
    signature?: string,
  ): Promise<{ received: boolean; message?: string }> {
    try {
      this.logger.log(`📥 Webhook received: ${payload.type}`);
      this.logger.debug(`Webhook payload: ${JSON.stringify(payload)}`);

      // Verify webhook signature if secret is configured
      if (this.moyasarWebhookSecret && signature) {
        const isValid = this.verifyWebhookSignature(payload, signature);
        if (!isValid) {
          this.logger.error('❌ Invalid webhook signature');
          return { received: false, message: 'Invalid signature' };
        }
        this.logger.log('✅ Webhook signature verified');
      }

      // Moyasar sends different event types
      if (payload.type === 'invoice_paid' || payload.type === 'payment_paid') {
        // Extract invoice ID from payload
        const invoiceId = payload.data?.id || payload.data?.invoice_id;
        
        if (!invoiceId) {
          this.logger.error('❌ Webhook missing invoice ID');
          return { received: false, message: 'Missing invoice ID' };
        }

        this.logger.log(`Processing webhook for invoice: ${invoiceId}`);

        // Verify and process the payment
        await this.verifyPayment(invoiceId);

        this.logger.log(`✅ Webhook processed successfully for: ${invoiceId}`);
        
        return { received: true, message: 'Payment processed' };
      } else {
        this.logger.log(`ℹ️ Unhandled webhook type: ${payload.type}`);
        return { received: true, message: 'Event type not handled' };
      }
    } catch (error) {
      this.logger.error(
        `❌ Webhook processing failed: ${error.message}`,
        error.stack,
      );
      
      // Return success to Moyasar to prevent retries for permanent errors
      // But log for manual investigation
      return { received: true, message: `Error: ${error.message}` };
    }
  }

  /**
   * Verify Moyasar webhook signature
   */
  private verifyWebhookSignature(payload: any, signature: string): boolean {
    try {
      const payloadString = JSON.stringify(payload);
      const hmac = crypto
        .createHmac('sha256', this.moyasarWebhookSecret)
        .update(payloadString)
        .digest('hex');
      
      return hmac === signature;
    } catch (error) {
      this.logger.error(`Signature verification error: ${error.message}`);
      return false;
    }
  }

  /**
   * Get payment history with pagination
   */
  async getPaymentHistory(
    userId: string,
    page: number = 1,
    limit: number = 10,
  ) {
    const [payments, total] = await this.paymentRepository.findAndCount({
      where: { userId },
      order: { createdAt: 'DESC' },
      skip: (page - 1) * limit,
      take: limit,
    });

    return {
      payments,
      pagination: {
        total,
        page,
        limit,
        totalPages: Math.ceil(total / limit),
      },
    };
  }

  /**
   * Get single payment
   */
  async findOne(userId: string, paymentId: string): Promise<Payment> {
    const payment = await this.paymentRepository.findOne({
      where: { id: paymentId, userId },
    });

    if (!payment) {
      throw new NotFoundException('Payment not found');
    }

    return payment;
  }

  /**
   * Refund payment
   */
  async refundPayment(
    userId: string,
    refundDto: RefundPaymentDto,
  ): Promise<Payment> {
    const { paymentId, amount, reason } = refundDto;

    const payment = await this.paymentRepository.findOne({
      where: { id: paymentId, userId },
    });

    if (!payment) {
      throw new NotFoundException('Payment not found');
    }

    // Check if already refunded first
    if (payment.status === PaymentStatus.REFUNDED) {
      throw new ConflictException('Payment already refunded');
    }

    // Then check if it's eligible for refund
    if (payment.status !== PaymentStatus.SUCCEEDED) {
      throw new BadRequestException('Can only refund successful payments');
    }

    try {
      const refundAmount = amount
        ? Math.round(amount * 100)
        : Math.round(payment.amount * 100);

      this.logger.log(`💸 Refunding payment ${paymentId}: ${refundAmount / 100} SAR`);

      const refundResponse = await axios.post(
        `${this.moyasarApiUrl}/payments/${payment.paymentIntentId}/refund`,
        { amount: refundAmount },
        {
          auth: {
            username: this.moyasarApiKey,
            password: '',
          },
        },
      );

      payment.status = PaymentStatus.REFUNDED;
      payment.refundedAt = new Date();
      payment.metadata = {
        ...payment.metadata,
        refundId: refundResponse.data.id,
        refundReason: reason || '',
        refundAmount: refundAmount / 100,
      };

      await this.paymentRepository.save(payment);

      this.logger.log(`✅ Payment refunded: ${paymentId}`);

      return payment;
    } catch (error) {
      if (axios.isAxiosError(error)) {
        const errorData = error.response?.data;
        this.logger.error(`Moyasar refund error: ${JSON.stringify(errorData)}`);
        
        throw new BadRequestException(
          errorData?.message || 'Failed to process refund',
        );
      }
      
      this.logger.error(`Refund failed: ${error.message}`, error.stack);
      throw new InternalServerErrorException('Failed to process refund');
    }
  }

  /**
   * Check for payments that require manual review
   */
  async getPaymentsRequiringReview(): Promise<Payment[]> {
  return await this.paymentRepository
    .createQueryBuilder('payment')
    .where('payment.status = :status', { status: PaymentStatus.SUCCEEDED })
    .andWhere("payment.metadata->>'requiresManualReview' = 'true'")
    .getMany();
}
}