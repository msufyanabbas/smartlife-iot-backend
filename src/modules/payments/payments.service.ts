// src/modules/payments/payments.service.ts
import {
  Injectable,
  NotFoundException,
  BadRequestException,
  InternalServerErrorException,
  Logger,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { ConfigService } from '@nestjs/config';
import axios from 'axios';
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
  private readonly logger = new Logger(PaymentsService.name);

  constructor(
    @InjectRepository(Payment)
    private readonly paymentRepository: Repository<Payment>,
    private readonly subscriptionsService: SubscriptionsService,
    private readonly configService: ConfigService,
  ) {
    const apiKey = this.configService.get<string>('MOYASAR_API_KEY');
    
    if (!apiKey) {
      throw new Error('MOYASAR_API_KEY must be configured in environment variables');
    }
    
    this.moyasarApiKey = apiKey;
  }

  /**
   * Create a Moyasar invoice (hosted payment page)
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

      // Get subscription
      const subscription = await this.subscriptionsService.findCurrent(userId);

      // Calculate amount
      const amount = this.calculateAmount(plan, billingPeriod);

      if (amount === 0) {
        throw new BadRequestException('Cannot create payment for free plan');
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

      this.logger.log(`Invoice created: ${invoice.id} - URL: ${invoice.url}`);

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
   * Verify payment/invoice status
   * Called by: Frontend after redirect OR Webhook
   */
  async verifyPayment(invoiceId: string): Promise<Payment> {
    try {
      this.logger.log(`Verifying payment: ${invoiceId}`);

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

      // Find payment in database
      const payment = await this.paymentRepository.findOne({
        where: { paymentIntentId: invoiceId },
      });

      if (!payment) {
        throw new NotFoundException(`Payment not found for invoice: ${invoiceId}`);
      }

      // Only process if status changed
      if (payment.status === PaymentStatus.SUCCEEDED) {
        this.logger.log(`Payment ${invoiceId} already processed`);
        return payment;
      }

      // Update based on invoice status
      if (invoice.status === 'paid') {
        this.logger.log(`Payment ${invoiceId} is PAID - processing subscription`);

        payment.status = PaymentStatus.SUCCEEDED;
        payment.paidAt = new Date(invoice.paid_at || invoice.updated_at);

        // Save first
        await this.paymentRepository.save(payment);

        // Then upgrade/renew subscription
        if (payment.metadata?.plan && payment.metadata?.billingPeriod) {
          try {
            const targetPlan = payment.metadata.plan as SubscriptionPlan;
            const targetBilling = payment.metadata.billingPeriod as BillingPeriod;

            // Get current subscription to check if this is an upgrade or renewal
            const currentSub = await this.subscriptionsService.findCurrent(payment.userId);

            const isUpgrade = currentSub.plan !== targetPlan;
            const isRenewal = currentSub.plan === targetPlan;

            if (isUpgrade) {
              this.logger.log(`Upgrading subscription from ${currentSub.plan} to ${targetPlan}`);
              
              await this.subscriptionsService.upgrade(payment.userId, {
                plan: targetPlan,
                billingPeriod: targetBilling,
              });
            } else if (isRenewal) {
              this.logger.log(`Renewing subscription for ${targetPlan} plan`);
              
              // For renewals, extend the next billing date
              await this.subscriptionsService.renew(payment.userId, targetBilling);
            }
            
            this.logger.log(
              `✅ Subscription ${isUpgrade ? 'upgraded' : 'renewed'} for user ${payment.userId}`
            );
          } catch (upgradeError) {
            this.logger.error(
              `Failed to process subscription: ${upgradeError.message}`,
              upgradeError.stack,
            );
            // Payment is marked as succeeded but subscription update failed
            // This should trigger an alert/notification for manual review
          }
        }
      } else if (invoice.status === 'expired' || invoice.status === 'canceled') {
        this.logger.warn(`Payment ${invoiceId} is ${invoice.status.toUpperCase()}`);
        
        payment.status = PaymentStatus.CANCELLED;
        payment.failureReason = `Invoice ${invoice.status}`;
        
        await this.paymentRepository.save(payment);
      } else if (invoice.status === 'pending') {
        this.logger.log(`Payment ${invoiceId} still PENDING`);
        // Keep as pending
      }

      return payment;
    } catch (error) {
      this.logger.error(`Verification failed: ${error.message}`, error.stack);
      
      if (error instanceof NotFoundException) {
        throw error;
      }
      
      throw new InternalServerErrorException('Failed to verify payment');
    }
  }

  /**
   * Webhook handler - Called by Moyasar when payment status changes
   * CRITICAL: This runs independently of user actions
   */
  async handleWebhook(payload: any): Promise<{ received: boolean }> {
    try {
      this.logger.log(`📥 Webhook received: ${payload.type}`);
      this.logger.debug(`Webhook payload: ${JSON.stringify(payload)}`);

      // Moyasar sends different event types
      if (payload.type === 'invoice_paid' || payload.type === 'payment_paid') {
        // Use invoice_id instead of id (payment id)
        const invoiceId = payload.data?.invoice_id;
        
        if (!invoiceId) {
          this.logger.error('Webhook missing invoice ID');
          return { received: false };
        }

        this.logger.log(`Processing webhook for invoice: ${invoiceId}`);

        // Verify and process the payment
        await this.verifyPayment(invoiceId);

        this.logger.log(`✅ Webhook processed successfully for: ${invoiceId}`);
      } else {
        this.logger.log(`Unhandled webhook type: ${payload.type}`);
      }

      return { received: true };
    } catch (error) {
      this.logger.error(
        `❌ Webhook processing failed: ${error.message}`,
        error.stack,
      );
      
      // Don't throw - we still want to return 200 to Moyasar
      // Log error for manual review
      return { received: false };
    }
  }

  /**
   * Get payment history
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

    if (payment.status !== PaymentStatus.SUCCEEDED) {
      throw new BadRequestException('Can only refund successful payments');
    }

    try {
      const refundAmount = amount
        ? Math.round(amount * 100)
        : Math.round(payment.amount * 100);

      this.logger.log(`Refunding payment ${paymentId}: ${refundAmount / 100} SAR`);

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
      };

      await this.paymentRepository.save(payment);

      this.logger.log(`✅ Payment refunded: ${paymentId}`);

      return payment;
    } catch (error) {
      this.logger.error(`Refund failed: ${error.message}`, error.stack);
      throw new InternalServerErrorException('Failed to process refund');
    }
  }

  /**
   * Calculate amount based on plan
   */
  private calculateAmount(
    plan: SubscriptionPlan,
    billingPeriod: BillingPeriod,
  ): number {
    const pricing = {
      [SubscriptionPlan.FREE]: { monthly: 0, yearly: 0 },
      [SubscriptionPlan.STARTER]: { monthly: 49, yearly: 490 },
      [SubscriptionPlan.PROFESSIONAL]: { monthly: 149, yearly: 1490 },
      [SubscriptionPlan.ENTERPRISE]: { monthly: 499, yearly: 4990 },
    };

    return pricing[plan][billingPeriod];
  }
}