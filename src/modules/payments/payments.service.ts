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
import { Payment, User } from '@modules/index.entities';
import {
  PaymentStatus,
  PaymentProvider
} from '@common/enums/index.enum';
import {
  CreatePaymentIntentDto,
  RefundPaymentDto,
} from './dto/create-payment.dto';
import { SubscriptionPlan, BillingPeriod } from '@common/enums/index.enum'
import { PaginatedResponseDto } from '@common/dto/pagination.dto';

@Injectable()
export class PaymentsService {
  // ── Moyasar webhook event names ────────────────────────────────────────────
  //
  // Grouped rather than matched inline so that every event that moves money is
  // visible in one place. Both the `payment_*` and `invoice_*` spellings are
  // listed: which one is delivered depends on how the charge was created
  // (hosted invoice vs direct payment) and on the account's webhook settings,
  // and a refund that arrives under an unlisted name would silently leave the
  // tenant on a plan they no longer paid for — the exact bug this fixes.
  private static readonly PAID_EVENTS = [
    'invoice_paid',
    'payment_paid',
    'payment_captured',
  ];
  private static readonly REFUND_EVENTS = [
    'payment_refunded',
    'invoice_refunded',
    'payment_voided',
    'invoice_voided',
    'payment_partially_refunded',
  ];
  private static readonly CHARGEBACK_EVENTS = [
    'payment_chargeback',
    'chargeback_created',
    'dispute_created',
    'payment_disputed',
  ];
  private static readonly FAILED_EVENTS = [
    'payment_failed',
    'payment_abandoned',
    'invoice_canceled',
    'invoice_cancelled',
    'invoice_expired',
  ];

  private readonly moyasarApiUrl: string;
  private readonly moyasarApiKey: string;
  private readonly moyasarWebhookSecret: string;
  private readonly currency: string;
  private readonly logoUrl?: string;
  private readonly frontendUrl: string;
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

    // The API base was hardcoded to the live endpoint, which meant there was no
    // way to point the service at a sandbox — testing the payment flow required
    // editing source. It keeps the live default so nothing changes unless set.
    this.moyasarApiUrl = (
      this.configService.get<string>('MOYASAR_API_URL') ??
      'https://api.moyasar.com/v1'
    ).replace(/\/+$/, '');

    // Was 'SAR' in four separate places. One source, so adding a second market
    // is a config change rather than a search-and-replace.
    this.currency = this.configService.get<string>('PAYMENT_CURRENCY') ?? 'SAR';

    // Was pinned to a dev-environment asset URL, so production invoices and
    // hosted payment pages rendered the dev logo.
    this.logoUrl = this.configService.get<string>('PAYMENT_LOGO_URL');

    const frontendUrl = this.configService.get<string>('FRONTEND_URL');
    if (!frontendUrl) {
      // Not optional: this builds the URL the customer is returned to after
      // paying. Undefined here produces "undefined/payment-status" and strands
      // them on a broken page after their card has been charged.
      throw new Error(
        'FRONTEND_URL must be configured — it builds the post-payment redirect URLs',
      );
    }
    this.frontendUrl = frontendUrl.replace(/\/+$/, '');

    if (!this.moyasarWebhookSecret) {
      this.logger.warn('⚠️ MOYASAR_WEBHOOK_SECRET not set - webhook signature verification disabled');
    }
  }

  /**
   * Create a Moyasar invoice (hosted payment page)
   * Validates upgrade eligibility BEFORE creating payment
   */
  async createPaymentIntent(
    user: User,
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
        .findCurrent(user.id)
        .catch(() => null);

      if (!subscription) {
        if (!user.tenantId) {
          // A subscription belongs to a TENANT. An account with no tenant
          // (a platform super admin) has nothing to bill.
          throw new BadRequestException(
            'This account is not associated with a tenant, so it cannot hold a subscription.',
          );
        }
        this.logger.log(
          `Creating free subscription for tenant ${user.tenantId} before payment`,
        );
        // `user.tenantId`, NOT `user.id`: getOrCreateFreeSubscription() takes a
        // TENANT id and writes it to `subscriptions.tenantId`, which carries a
        // foreign key to tenants(id) (the entity declares @OneToOne('Tenant')
        // against it). Passing a user id made this fallback fail on that
        // constraint — a 500 on the first payment of any tenant whose
        // subscription row was missing, which is exactly when it runs.
        subscription = await this.subscriptionsService.getOrCreateFreeSubscription(
          user.tenantId,
        );
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

      const {id: userId} = user;

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

      // Callback URLs — resolved from FRONTEND_URL, validated in the constructor.
      const backUrl = `${this.frontendUrl}${this.configService.get<string>('PAYMENT_CANCEL_PATH') ?? '/subscription-plans'}`;
      const successUrl = `${this.frontendUrl}${this.configService.get<string>('PAYMENT_SUCCESS_PATH') ?? '/payment-status'}`;


      // Create invoice payload
      const invoicePayload = {
        amount: amountInHalalas,
        currency: this.currency,
        description: `${this.configService.get<string>('APP_BRAND_NAME') ?? 'Smart Life'} ${plan.charAt(0).toUpperCase() + plan.slice(1)} Plan - ${billingPeriod}`,
        callback_url: null,
        back_url: backUrl,
        success_url: successUrl,
        // Omitted rather than sent empty when unset — Moyasar renders its own
        // default, which is better than a broken image on the payment page.
        ...(this.logoUrl ? { logo_url: this.logoUrl } : {}),


        metadata: {
          user_id: userId,
          tenantId: user.tenantId,
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
        tenantId: user.tenantId,
        subscriptionId: subscription.id,
        paymentIntentId: invoice.id,
        provider: PaymentProvider.MOYASAR,
        amount: amountInHalalas / 100,
        currency: this.currency,
        status: PaymentStatus.PENDING,
        description: invoicePayload.description,
        metadata: {
          plan,
          billingPeriod,
          invoiceId: invoice.id,
          // The plan to put the tenant back on if this payment is refunded.
          originalPlan: subscription.plan,
          // Whether this payment buys a higher tier or another period of the
          // same one. A failed RENEWAL opens a grace period; a failed upgrade
          // changes nothing, because the upgrade never landed.
          intent: this.subscriptionsService.isUpgrade(subscription.plan, plan)
            ? 'upgrade'
            : 'renewal',
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

      // Capture the underlying PAYMENT id off the invoice while it is in hand.
      // `paymentIntentId` holds the INVOICE id, and Moyasar's refund endpoint
      // is `/payments/{payment_id}/refund` — without this the refund call has
      // only the invoice id to send. See `providerPaymentId()`.
      const paidMoyasarPayment = Array.isArray(invoice.payments)
        ? invoice.payments.find((p: any) => p?.status === 'paid') ??
          invoice.payments[0]
        : undefined;
      if (paidMoyasarPayment?.id) {
        payment.metadata = {
          ...payment.metadata,
          moyasarPaymentId: paidMoyasarPayment.id,
        };
      }

      const updatedPayment = await queryRunner.manager.save(Payment, payment);

      // Process subscription upgrade/renewal
      if (payment.metadata?.plan && payment.metadata?.billingPeriod) {
        const targetPlan = payment.metadata.plan as SubscriptionPlan;
        const targetBilling = payment.metadata.billingPeriod as BillingPeriod;

        this.logger.log(`Processing subscription change: ${targetPlan} - ${targetBilling}`);

        // Call subscription service with query runner for transaction.
        // `payment.id` is the idempotency key — a webhook WILL arrive twice and
        // the early return above is a read-then-write with no lock.
        await this.subscriptionsService.processSubscriptionAfterPayment(
          payment.tenantId,
          targetPlan,
          targetBilling,
          Number(payment.amount),
          queryRunner,
          payment.id,
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

    // A failed UPGRADE needs no handling: the upgrade is only applied from a
    // confirmed payment, so the tenant simply stays where they are. A failed
    // RENEWAL is different — the period they are on has been paid for only up
    // to `nextBillingDate`, and nothing is coming. Open the grace window.
    if (payment.metadata?.intent === 'renewal') {
      await this.subscriptionsService
        .markRenewalPaymentFailed(
          payment.tenantId,
          `renewal invoice ${invoice.status} (payment ${payment.id})`,
        )
        .catch((err) =>
          // Never let this fail the webhook: Moyasar would retry, and the
          // payment row is already correct.
          this.logger.error(
            `Could not mark renewal failure for tenant ${payment.tenantId}: ${err.message}`,
          ),
        );
    }

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

      const type: string = payload.type ?? '';

      // ── Money in ───────────────────────────────────────────────────────────
      if (PaymentsService.PAID_EVENTS.includes(type)) {
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
      }

      // ── Money back out ─────────────────────────────────────────────────────
      //
      // This is the second half of the refund bug. The direct
      // POST /payments/refund path was not the only way a refund happened —
      // a refund issued from the Moyasar dashboard, a void, or a cardholder
      // dispute arrives here and nowhere else, and this handler used to answer
      // "Event type not handled" and leave the tenant on the paid plan with the
      // money returned.
      if (
        PaymentsService.REFUND_EVENTS.includes(type) ||
        PaymentsService.CHARGEBACK_EVENTS.includes(type)
      ) {
        const kind: 'refund' | 'chargeback' | 'void' =
          PaymentsService.CHARGEBACK_EVENTS.includes(type)
            ? 'chargeback'
            : type.includes('void')
              ? 'void'
              : 'refund';

        const payment = await this.findPaymentFromWebhook(payload);
        if (!payment) {
          this.logger.error(
            `❌ ${type} webhook could not be matched to a payment row: ${JSON.stringify(payload.data ?? {})}`,
          );
          return { received: true, message: 'Payment not found' };
        }

        // Moyasar reports the refunded total in halalas. A dispute payload may
        // carry no amount at all, in which case treat it as the full amount —
        // a chargeback takes the whole charge.
        const refundedMinor =
          payload.data?.refunded ??
          payload.data?.refunded_amount ??
          payload.data?.amount;
        const refundedAmount =
          kind === 'chargeback' || refundedMinor === undefined
            ? Number(payment.amount)
            : Number(refundedMinor) / 100;

        await this.applyRefundOutcome(payment, {
          kind,
          refundedAmount,
          reason: `Moyasar ${type}`,
          refundId:
            payload.data?.refund_id ?? payload.data?.id ?? `${type}:${payment.paymentIntentId}`,
        });

        return { received: true, message: `${kind} processed` };
      }

      // ── Money never arrived ────────────────────────────────────────────────
      if (PaymentsService.FAILED_EVENTS.includes(type)) {
        const payment = await this.findPaymentFromWebhook(payload);
        if (!payment) {
          this.logger.warn(`${type} webhook matched no payment row`);
          return { received: true, message: 'Payment not found' };
        }
        if (payment.status === PaymentStatus.SUCCEEDED) {
          // Paid first, then a late failure event for the same invoice. Trust
          // the money, not the ordering.
          this.logger.warn(
            `Ignoring ${type} for payment ${payment.id} which is already SUCCEEDED`,
          );
          return { received: true, message: 'Already paid' };
        }
        await this.processFailedPayment(payment, {
          status: type.replace(/^.*_/, ''),
        });
        return { received: true, message: 'Failure recorded' };
      }

      this.logger.log(`ℹ️ Unhandled webhook type: ${type}`);
      return { received: true, message: 'Event type not handled' };
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
  ): Promise<PaginatedResponseDto<Payment>> {
    const [payments, total] = await this.paymentRepository.findAndCount({
      where: { userId },
      order: { createdAt: 'DESC' },
      skip: (page - 1) * limit,
      take: limit,
    });

    return PaginatedResponseDto.create(payments, page, limit, total);
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
   * Refund a payment, in full or in part, and reverse what it bought.
   *
   * ### The plan change is reversed here — it was not before
   *
   * This method used to end with `// TODO: Handle subscription downgrade if
   * needed based on refund`, so a tenant could upgrade, be refunded in full,
   * and keep the paid tier for ever. Every refund path now funnels through
   * `applyRefundOutcome()` → `SubscriptionsService.reverseAfterRefund()`:
   * this method, the Moyasar webhook (`payment_refunded` / `payment_voided`),
   * a chargeback (`recordChargeback()`), and repeated partial refunds that add
   * up to the whole charge.
   *
   * ### A PARTIAL refund does not change the plan
   *
   * Decided deliberately. A partial refund is a price adjustment — a goodwill
   * credit, a proration, a duplicated line — and the tenant is still a paying
   * customer of that tier. Downgrading on a 10 SAR courtesy credit against a
   * 499 SAR plan would take away capability they did pay for. What it does do
   * is accumulate: `metadata.refundedTotal` is tracked, and the moment the
   * refunded total reaches the amount charged, the plan is reversed exactly as
   * a single full refund would have reversed it.
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

    const charged = Number(payment.amount);
    const alreadyRefunded = Number(payment.metadata?.refundedTotal ?? 0);
    const requested = amount ?? charged - alreadyRefunded;

    if (requested <= 0) {
      throw new BadRequestException('Refund amount must be greater than zero');
    }

    // Refusing to over-refund is the cheap half of this check. The expensive
    // half is that an over-refund would also read as a full refund and reverse
    // the plan on the strength of money that was never returned.
    if (alreadyRefunded + requested > charged + 0.01) {
      throw new BadRequestException(
        `Refund of ${requested} exceeds the refundable balance of ` +
          `${(charged - alreadyRefunded).toFixed(2)} ${payment.currency} ` +
          `(charged ${charged}, already refunded ${alreadyRefunded})`,
      );
    }

    const refundMinor = Math.round(requested * 100);

    this.logger.log(
      `💸 Refunding payment ${paymentId}: ${requested} ${payment.currency} ` +
        `(charged ${charged}, previously refunded ${alreadyRefunded})`,
    );

    // The provider call is made OUTSIDE the database transaction on purpose.
    // It used to sit inside one, so a refund Moyasar had accepted but whose
    // commit then failed left the money returned and the row untouched —
    // invisible, and refundable a second time. Now: provider first, then one
    // transaction that records the refund and reverses the plan together.
    let refundId: string;
    try {
      const refundResponse = await axios.post(
        `${this.moyasarApiUrl}/payments/${this.providerPaymentId(payment)}/refund`,
        { amount: refundMinor },
        {
          auth: {
            username: this.moyasarApiKey,
            password: '',
          },
        },
      );
      refundId = refundResponse.data?.id ?? `refund:${payment.paymentIntentId}`;
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

    return this.applyRefundOutcome(payment, {
      kind: 'refund',
      refundedAmount: requested,
      reason,
      refundId,
    });
  }

  /**
   * Record a chargeback. The money is already gone — there is no provider call
   * to make and no partial case: a dispute takes the whole charge.
   *
   * Reachable from the `payment_chargeback` / `dispute_created` webhook and
   * from `POST /payments/admin/chargeback` for a dispute that arrived by email
   * from the acquirer instead of as an event.
   */
  async recordChargeback(paymentId: string, reason?: string): Promise<Payment> {
    const payment = await this.paymentRepository.findOne({
      where: { id: paymentId },
    });

    if (!payment) {
      throw new NotFoundException('Payment not found');
    }

    return this.applyRefundOutcome(payment, {
      kind: 'chargeback',
      refundedAmount: Number(payment.amount),
      reason: reason ?? 'chargeback',
      refundId: `chargeback:${payment.paymentIntentId}`,
    });
  }

  /**
   * THE single place money-out is recorded and a plan change reversed.
   *
   * Every path lands here: direct refund, webhook refund, webhook void,
   * chargeback, and the partial refund that completes a full one. One
   * transaction covers the payment row and the subscription, so the two cannot
   * disagree about whether a refund happened.
   */
  private async applyRefundOutcome(
    payment: Payment,
    outcome: {
      kind: 'refund' | 'chargeback' | 'void';
      refundedAmount: number;
      reason?: string;
      refundId: string;
    },
  ): Promise<Payment> {
    const charged = Number(payment.amount);
    const previouslyRefunded = Number(payment.metadata?.refundedTotal ?? 0);
    const refundedTotal = Math.min(
      charged,
      previouslyRefunded + Number(outcome.refundedAmount),
    );

    // A chargeback always takes the whole charge; otherwise "full" means the
    // refunded total has reached the amount charged. The 0.01 tolerance covers
    // the halala rounding `createPaymentIntent()` applies — Moyasar requires an
    // amount ending in 0, so a refunded total can land a halala short of the
    // charge and must still count as full.
    const isFull =
      outcome.kind === 'chargeback' || refundedTotal >= charged - 0.01;

    const queryRunner = this.dataSource.createQueryRunner();
    await queryRunner.connect();
    await queryRunner.startTransaction();

    try {
      const repo = queryRunner.manager.getRepository(Payment);

      payment.metadata = {
        ...payment.metadata,
        refundId: outcome.refundId,
        refundReason: outcome.reason ?? '',
        refundAmount: Number(outcome.refundedAmount),
        refundedTotal,
        refundKind: outcome.kind,
        partialRefund: !isFull,
        refunds: [
          ...((payment.metadata?.refunds as any[]) ?? []),
          {
            at: new Date().toISOString(),
            amount: Number(outcome.refundedAmount),
            kind: outcome.kind,
            refundId: outcome.refundId,
            reason: outcome.reason ?? null,
          },
        ],
      };

      if (isFull) {
        payment.status = PaymentStatus.REFUNDED;
        payment.refundedAt = new Date();
      } else {
        // Status stays SUCCEEDED. There is no PARTIALLY_REFUNDED member in
        // PaymentStatus, and adding one needs `ALTER TYPE ... ADD VALUE` on
        // payments_status_enum before any row could store it — while marking a
        // partially refunded charge REFUNDED would both misreport revenue and
        // make the remaining balance unrefundable (`canRefund()` is
        // SUCCEEDED-only). The amounts in `metadata` are the record.
        this.logger.log(
          `Partial refund recorded on payment ${payment.id}: ${refundedTotal}/${charged} ${payment.currency} — plan unchanged`,
        );
      }

      const saved = await repo.save(payment);

      if (isFull) {
        await this.subscriptionsService.reverseAfterRefund(
          payment.tenantId,
          {
            paymentId: payment.id,
            kind: outcome.kind,
            originalPlan:
              (payment.metadata?.originalPlan as SubscriptionPlan) ?? null,
            reason: outcome.reason,
          },
          queryRunner,
        );
      }

      await queryRunner.commitTransaction();

      this.logger.log(
        `✅ ${outcome.kind} applied to payment ${payment.id} ` +
          `(${isFull ? 'FULL — plan reversed' : 'partial — plan kept'})`,
      );

      return saved;
    } catch (error) {
      await queryRunner.rollbackTransaction();

      // The money has already moved by this point, so losing the record is the
      // worst outcome available. Flag the row for review outside the failed
      // transaction rather than letting the refund vanish.
      this.logger.error(
        `🚨 CRITICAL: ${outcome.kind} of ${outcome.refundedAmount} on payment ${payment.id} ` +
          `was accepted by the provider but could not be recorded: ${error.message}`,
        error.stack,
      );

      const reviewMetadata: Payment['metadata'] = {
        ...payment.metadata,
        refundId: outcome.refundId,
        refundKind: outcome.kind,
        refundAmount: Number(outcome.refundedAmount),
        requiresManualReview: true,
        refundReversalError: error.message,
        errorTimestamp: new Date().toISOString(),
      };

      await this.paymentRepository
        // `metadata` is a jsonb bag with an index signature; TypeORM's
        // QueryDeepPartialEntity cannot express that, hence the cast.
        .update(payment.id, { metadata: reviewMetadata as any })
        .catch(() => undefined);

      throw new InternalServerErrorException(
        'Refund was processed by the payment provider but could not be applied to the subscription. Our team will review this shortly.',
      );
    } finally {
      await queryRunner.release();
    }
  }

  /**
   * Finds the payment row a money-out webhook refers to.
   *
   * Moyasar identifies the charge differently depending on the event: an
   * invoice event carries `invoice_id`, a payment event carries the payment's
   * own `id`, and `payments.paymentIntentId` holds whichever of the two the
   * charge was created with (an invoice id, for everything this service
   * creates). Both are tried, plus `metadata.moyasarPaymentId` for a row whose
   * underlying payment id has been recorded.
   */
  private async findPaymentFromWebhook(payload: any): Promise<Payment | null> {
    const candidates = [
      payload?.data?.invoice_id,
      payload?.data?.payment_id,
      payload?.data?.id,
    ].filter((value): value is string => typeof value === 'string' && !!value);

    for (const candidate of candidates) {
      const byIntent = await this.paymentRepository.findOne({
        where: { paymentIntentId: candidate },
      });
      if (byIntent) return byIntent;

      const byProviderId = await this.paymentRepository
        .createQueryBuilder('payment')
        .where("payment.metadata->>'moyasarPaymentId' = :candidate", {
          candidate,
        })
        .getOne();
      if (byProviderId) return byProviderId;
    }

    return null;
  }

  /**
   * The id to call the provider's refund endpoint with.
   *
   * `paymentIntentId` holds the INVOICE id for everything `createPaymentIntent`
   * creates, and Moyasar's refund endpoint is `/payments/{payment_id}/refund` —
   * an invoice id there is rejected. `metadata.moyasarPaymentId` is preferred
   * when a row has it recorded; the invoice id stays as the fallback so nothing
   * changes for rows that do not. This mismatch is pre-existing and cannot be
   * verified without live credentials — see the report.
   */
  private providerPaymentId(payment: Payment): string {
    return (
      (payment.metadata?.moyasarPaymentId as string) ?? payment.paymentIntentId
    );
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

      // `payment.tenantId`, NOT `payment.userId` — the first parameter of
      // processSubscriptionAfterPayment is a tenant id, and passing a user id
      // meant the retry looked up a subscription by a userId, found nothing and
      // threw NotFoundException every single time. The admin retry route could
      // never resolve anything.
      await this.subscriptionsService.processSubscriptionAfterPayment(
        payment.tenantId,
        targetPlan,
        targetBilling,
        Number(payment.amount),
        queryRunner,
        payment.id,
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