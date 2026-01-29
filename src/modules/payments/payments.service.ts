// src/modules/payments/payments.service.ts
import {
  Injectable,
  NotFoundException,
  BadRequestException,
  InternalServerErrorException,
  Logger,
  ConflictException,
} from '@nestjs/common';
import axios from 'axios';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, DataSource } from 'typeorm';
import { ConfigService, SubscriptionsService } from '@modules/index.service';
import * as crypto from 'crypto';
import { Payment } from '@modules/index.entities';
import { 
  PaymentStatus, 
  PaymentProvider 
} from './entities/payment.entity';
import {
  CreatePaymentIntentDto,
  RefundPaymentDto,
} from './dto/create-payment.dto';
import { SubscriptionPlan, BillingPeriod } from '@common/enums/index.enum'

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
    private readonly dataSource: DataSource,
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
   * Validates upgrade eligibility BEFORE creating payment
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

      // CRITICAL: Validate this is an upgrade or renewal, NOT a downgrade
      if (plan !== SubscriptionPlan.FREE) {
        const isUpgrade = this.subscriptionsService.isUpgrade(subscription.plan, plan);
        const isRenewal = this.subscriptionsService.isRenewal(subscription.plan, plan);

        if (!isUpgrade && !isRenewal) {
          throw new BadRequestException(
            `Cannot create payment for downgrade from ${subscription.plan} to ${plan}. ` +
            `Please use the downgrade scheduling feature instead.`
          );
        }

        this.logger.log(
          `Payment intent validation: ${isUpgrade ? 'UPGRADE' : 'RENEWAL'} from ${subscription.plan} to ${plan}`
        );
      }

      // Calculate amount
      const amount = this.subscriptionsService.getPlanPricing(plan, billingPeriod);

      if (amount === 0) {
        throw new BadRequestException('Cannot create payment for free plan');
      }

      // Check if there's already a pending payment for this exact upgrade
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

          // Check if invoice is still valid (not expired/cancelled)
          if (response.data.status === 'pending') {
            return {
              paymentUrl: response.data.url,
              invoiceId: existingPending.paymentIntentId,
              amount: existingPending.amount,
              currency: existingPending.currency,
              description: existingPending.description || '',
            };
          } else {
            // Invoice expired/cancelled, create new one
            this.logger.log(`Existing invoice ${response.data.status}, creating new one`);
          }
        } catch (fetchError) {
          this.logger.warn(`Could not fetch existing invoice, creating new one`);
        }
      }

      // Convert to halalas (must end with 0 for Moyasar)
      let amountInHalalas = Math.round(amount * 100);
      if (amountInHalalas % 10 !== 0) {
        amountInHalalas = Math.ceil(amountInHalalas / 10) * 10;
      }

      this.logger.log(
        `Creating invoice for user ${userId}: ${amountInHalalas / 100} SAR (${plan} - ${billingPeriod})`
      );

      // Callback URL
      const frontendUrl = this.configService.get('FRONTEND_URL');
      const callbackUrl = `${frontendUrl}`;
      const backUrl = `${frontendUrl}/subscription-plans`;
      const successUrl = `${frontendUrl}/payment-status`;
      

      // Create invoice payload
      const invoicePayload = {
        amount: amountInHalalas,
        currency: 'SAR',
        description: `Smart Life ${plan.charAt(0).toUpperCase() + plan.slice(1)} Plan - ${billingPeriod}`,
        callback_url: null,
        back_url: backUrl,
        success_url: successUrl,
        logo_url: 'https://dev.smart-life.sa/assets/smartlife-text-black-THaafVXq.png',
        
        
        metadata: {
          user_id: userId,
          subscription_id: subscription.id,
          plan: plan,
          billing_period: billingPeriod,
          original_plan: subscription.plan, // Track original plan for validation
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
          originalPlan: subscription.plan,
          createdAt: new Date().toISOString(),
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

      if (error instanceof BadRequestException) {
        throw error;
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
   * Process successful payment with transaction and proper error handling
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

    this.logger.log(`💰 Payment ${payment.paymentIntentId} is PAID - processing with transaction`);

    // Use transaction to ensure atomicity
    const queryRunner = this.dataSource.createQueryRunner();
    await queryRunner.connect();
    await queryRunner.startTransaction();

    try {
      // Update payment status first (within transaction)
      payment.status = PaymentStatus.SUCCEEDED;
      payment.paidAt = new Date(invoice.paid_at || invoice.updated_at);
      const updatedPayment = await queryRunner.manager.save(Payment, payment);

      // Process subscription upgrade/renewal
      if (payment.metadata?.plan && payment.metadata?.billingPeriod) {
        const targetPlan = payment.metadata.plan as SubscriptionPlan;
        const targetBilling = payment.metadata.billingPeriod as BillingPeriod;

        this.logger.log(`Processing subscription change: ${targetPlan} - ${targetBilling}`);

        // Call subscription service with query runner for transaction
        await this.subscriptionsService.processSubscriptionAfterPayment(
          payment.userId,
          targetPlan,
          targetBilling,
          payment.amount,
          queryRunner,
        );

        this.logger.log(`✅ Subscription updated successfully within transaction`);
      }

      // Commit transaction
      await queryRunner.commitTransaction();
      
      this.logger.log(`✅ Transaction committed successfully for payment ${payment.id}`);

      return updatedPayment;

    } catch (error) {
      // Rollback transaction on error
      await queryRunner.rollbackTransaction();
      
      this.logger.error(
        `❌ Transaction rolled back: ${error.message}`,
        error.stack,
      );

      // Mark payment as succeeded but with error flag for manual review
      payment.status = PaymentStatus.SUCCEEDED;
      payment.paidAt = new Date(invoice.paid_at || invoice.updated_at);
      payment.metadata = {
        ...payment.metadata,
        subscriptionUpdateError: error.message,
        requiresManualReview: true,
        errorTimestamp: new Date().toISOString(),
      };
      
      await this.paymentRepository.save(payment);
      
      this.logger.error(
        `🚨 CRITICAL: Payment ${payment.id} succeeded but subscription update failed! ` +
        `Marked for manual review.`
      );

      // Throw error to notify caller
      throw new InternalServerErrorException(
        'Payment processed but subscription update failed. Our team will review this shortly.'
      );

    } finally {
      await queryRunner.release();
    }
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
        const invoiceId = payload.data?.invoice_id;
        
        if (!invoiceId) {
          this.logger.error('❌ Webhook missing invoice ID');
          return { received: false, message: 'Missing invoice ID' };
        }

        this.logger.log(`Processing webhook for invoice: ${invoiceId}`);

        // Verify and process the payment (with transaction)
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
   * Refund payment with subscription downgrade handling
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

    const queryRunner = this.dataSource.createQueryRunner();
    await queryRunner.connect();
    await queryRunner.startTransaction();

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

      await queryRunner.manager.save(Payment, payment);

      // TODO: Handle subscription downgrade if needed based on refund
      // This would depend on your business logic

      await queryRunner.commitTransaction();

      this.logger.log(`✅ Payment refunded: ${paymentId}`);

      return payment;
    } catch (error) {
      await queryRunner.rollbackTransaction();

      if (axios.isAxiosError(error)) {
        const errorData = error.response?.data;
        this.logger.error(`Moyasar refund error: ${JSON.stringify(errorData)}`);
        
        throw new BadRequestException(
          errorData?.message || 'Failed to process refund',
        );
      }
      
      this.logger.error(`Refund failed: ${error.message}`, error.stack);
      throw new InternalServerErrorException('Failed to process refund');
    } finally {
      await queryRunner.release();
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
      .orderBy('payment.createdAt', 'DESC')
      .getMany();
  }

  /**
   * Manually retry failed subscription update for a payment
   * ADMIN ONLY
   */
  async retrySubscriptionUpdate(paymentId: string): Promise<Payment> {
    const payment = await this.paymentRepository.findOne({
      where: { id: paymentId },
    });

    if (!payment) {
      throw new NotFoundException('Payment not found');
    }

    if (payment.status !== PaymentStatus.SUCCEEDED) {
      throw new BadRequestException('Can only retry for succeeded payments');
    }

    if (!payment.metadata?.requiresManualReview) {
      throw new BadRequestException('Payment does not require manual review');
    }

    const queryRunner = this.dataSource.createQueryRunner();
    await queryRunner.connect();
    await queryRunner.startTransaction();

    try {
      const targetPlan = payment.metadata.plan as SubscriptionPlan;
      const targetBilling = payment.metadata.billingPeriod as BillingPeriod;

      await this.subscriptionsService.processSubscriptionAfterPayment(
        payment.userId,
        targetPlan,
        targetBilling,
        payment.amount,
        queryRunner,
      );

      // Clear manual review flag
      payment.metadata = {
        ...payment.metadata,
        requiresManualReview: false,
        manuallyResolvedAt: new Date().toISOString(),
      };

      await queryRunner.manager.save(Payment, payment);
      await queryRunner.commitTransaction();

      this.logger.log(`✅ Manually resolved payment ${paymentId}`);

      return payment;
    } catch (error) {
      await queryRunner.rollbackTransaction();
      
      this.logger.error(`Failed to retry subscription update: ${error.message}`);
      throw new InternalServerErrorException('Failed to retry subscription update');
    } finally {
      await queryRunner.release();
    }
  }
}