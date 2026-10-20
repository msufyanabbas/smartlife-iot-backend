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
  Query,
  Res,
} from '@nestjs/common';
import type { Response } from 'express';
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
import {
  SubscriptionResponseDto,
  SubscriptionMessageResponseDto,
  PlansListResponseDto,
  UsageStatisticsResponseDto,
  UpgradeValidationResponseDto,
  InvoicesListResponseDto,
} from './dto/subscription-response.dto';
import { PaginationDto } from '@/common/dto/pagination.dto';
import { InvoicePdfService } from './invoice-pdf.service';
import {
  RenewSubscriptionDto,
  StartTrialDto,
  ToggleAutoRenewDto,
} from './dto/subscription-lifecycle.dto';
import { Roles } from '@common/decorators/index.decorator';
import { UserRole } from '@common/enums/index.enum';
import { RequirePermissions } from '@common/decorators/permission.decorator';

// ─────────────────────────────────────────────────────────────────────────────
// NOTE: All methods receive user.id from the JWT (@CurrentUser()).
// The service resolves tenantId from userId internally.
// Controller never handles tenantId directly.
//
// ROLES: this controller carried no @Roles metadata at all, and RolesGuard
// returns TRUE for a handler without it — so every route here, cancellation and
// plan changes included, was open to any authenticated user, CUSTOMER_USER
// included. Billing WRITES are now TENANT_ADMIN only.
//
// The read routes keep CUSTOMER_USER deliberately: GET /subscriptions is what
// populates the frontend's feature-flag store, and the sidebar hides any item
// whose flag is not strictly true. Locking that route to admins would empty the
// navigation for every end user in the tenant.
// ─────────────────────────────────────────────────────────────────────────────

const BILLING_READERS = [
  UserRole.TENANT_ADMIN,
  UserRole.CUSTOMER,
  UserRole.CUSTOMER_USER,
] as const;

@ApiTags('subscriptions')
@Controller('subscriptions')
@UseGuards(JwtAuthGuard)
@ApiBearerAuth()
export class SubscriptionsController {
  constructor(
    private readonly subscriptionsService: SubscriptionsService,
    private readonly invoicePdfService: InvoicePdfService,
  ) {}

  @Post()
  @RequirePermissions('billing:manage')
  @Roles(UserRole.SUPER_ADMIN, UserRole.TENANT_ADMIN)
  @ApiOperation({
    summary: 'Create a new subscription',
    description:
      'Creates a free subscription for new users. Paid plans require payment first.',
  })
  @ApiResponse({
    status: 201,
    description: 'Subscription created successfully',
    type: SubscriptionMessageResponseDto,
  })
  @ApiResponse({ status: 409, description: 'User already has a subscription' })
  create(
    @CurrentUser() user: User,
    @Body() createSubscriptionDto: CreateSubscriptionDto,
  ) {
    return this.subscriptionsService.create(
      user.tenantId,
      createSubscriptionDto,
    );
  }

  @Get()
  @RequirePermissions('billing:read')
  // Every role: this is the endpoint the frontend's feature-flag store reads,
  // and an empty store hides the whole sidebar. SUPER_ADMIN is included because
  // RolesGuard has NO super-admin bypass — it compares user.role against the
  // list and nothing else, despite what access-control.decorator.ts claims.
  @Roles(...BILLING_READERS, UserRole.SUPER_ADMIN, UserRole.USER)
  @ApiOperation({ summary: 'Get current subscription' })
  @ApiResponse({
    status: 200,
    description: 'Current subscription details',
    type: SubscriptionResponseDto,
  })
  @ApiResponse({ status: 404, description: 'No subscription found' })
  findCurrent(@CurrentUser() user: User) {
    return this.subscriptionsService.findCurrent(user.id);
  }

  @Get('plans')
  @RequirePermissions('billing:read')
  @Roles(...BILLING_READERS, UserRole.SUPER_ADMIN, UserRole.USER)
  @ApiOperation({
    summary: 'Get all available subscription plans with pricing',
  })
  @ApiResponse({
    status: 200,
    description: 'List of subscription plans',
    type: PlansListResponseDto,
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
            storage: 10,
          },
          features: {
            analytics: true,
            automation: true,
            integrations: false,
            support: 'email',
            whiteLabel: false,
          },
        },
      ],
    },
  })
  getPlans() {
    return this.subscriptionsService.getPlans();
  }

  @Get('usage')
  @RequirePermissions('billing:read')
  @Roles(...BILLING_READERS, UserRole.SUPER_ADMIN, UserRole.USER)
  @ApiOperation({ summary: 'Get current usage statistics vs limits' })
  @ApiResponse({
    status: 200,
    description: 'Usage statistics',
    type: UsageStatisticsResponseDto,
    schema: {
      example: {
        current: {
          devices: 15,
          users: 3,
          apiCalls: 12500,
          storage: 4.2,
        },
        limits: {
          devices: 50,
          users: 5,
          apiCalls: 50000,
          dataRetention: 30,
          storage: 10,
        },
        percentage: {
          devices: 30,
          users: 60,
          apiCalls: 25,
          storage: 42,
        },
      },
    },
  })
  getUsage(@CurrentUser() user: User) {
    return this.subscriptionsService.getUsage(user.id);
  }

  @Post('upgrade')
  @RequirePermissions('billing:manage')
  @Roles(UserRole.SUPER_ADMIN, UserRole.TENANT_ADMIN)
  @ApiOperation({
    summary: 'Initiate subscription upgrade (redirects to payment)',
    description:
      'This endpoint validates the upgrade and returns payment requirement. To actually upgrade, user must complete payment via /payments/create endpoint.',
  })
  @ApiResponse({
    status: 200,
    description: 'Upgrade validated - payment required',
    type: UpgradeValidationResponseDto,
    schema: {
      example: {
        requiresPayment: true,
        message: 'Please complete payment to upgrade your subscription',
        plan: 'professional',
        billingPeriod: 'monthly',
      },
    },
  })
  @ApiResponse({
    status: 400,
    description: 'Cannot downgrade using this endpoint',
  })
  @ApiResponse({ status: 404, description: 'No subscription found' })
  upgrade(
    @CurrentUser() user: User,
    @Body() upgradeDto: UpgradeSubscriptionDto,
  ) {
    return this.subscriptionsService.upgrade(user.id, upgradeDto);
  }

  @Post('downgrade/schedule')
  @RequirePermissions('billing:manage')
  @Roles(UserRole.SUPER_ADMIN, UserRole.TENANT_ADMIN)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Schedule subscription downgrade',
    description:
      'Schedules a downgrade to take effect at the end of current billing period. No immediate change or refund.',
  })
  @ApiResponse({
    status: 200,
    description: 'Downgrade scheduled successfully',
    type: SubscriptionResponseDto,
    schema: {
      example: {
        id: 'uuid',
        plan: 'professional',
        status: 'active',
        nextBillingDate: '2025-01-18T00:00:00Z',
        metadata: {
          scheduledDowngrade: {
            plan: 'starter',
            effectiveDate: '2025-01-18T00:00:00Z',
          },
        },
      },
    },
  })
  @ApiResponse({
    status: 400,
    description: 'Invalid downgrade - target plan must be lower than current',
  })
  @ApiResponse({ status: 404, description: 'No subscription found' })
  scheduleDowngrade(
    @CurrentUser() user: User,
    @Body() downgradeDto: ScheduleDowngradeDto,
  ) {
    return this.subscriptionsService.scheduleDowngrade(
      user.id,
      downgradeDto.targetPlan,
    );
  }

  @Post('downgrade/cancel')
  @RequirePermissions('billing:manage')
  @Roles(UserRole.SUPER_ADMIN, UserRole.TENANT_ADMIN)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Cancel scheduled downgrade',
    description: 'Cancels a previously scheduled downgrade',
  })
  @ApiResponse({
    status: 200,
    description: 'Scheduled downgrade cancelled',
    type: SubscriptionResponseDto,
  })
  @ApiResponse({ status: 404, description: 'No scheduled downgrade found' })
  async cancelScheduledDowngrade(@CurrentUser() user: User) {
    return this.subscriptionsService.cancelScheduledDowngrade(user.id);
  }

  @Post('cancel')
  @RequirePermissions('billing:manage')
  @Roles(UserRole.SUPER_ADMIN, UserRole.TENANT_ADMIN)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Cancel subscription',
    description:
      'Cancels the subscription immediately. Access continues until end of billing period.',
  })
  @ApiResponse({
    status: 200,
    description: 'Subscription cancelled successfully',
    type: SubscriptionMessageResponseDto,
  })
  @ApiResponse({ status: 404, description: 'No subscription found' })
  @ApiResponse({ status: 409, description: 'Subscription already cancelled' })
  cancel(@CurrentUser() user: User) {
    return this.subscriptionsService.cancel(user.id);
  }

  // ───────────────────────────────────────────────────────────────────────────
  // LIFECYCLE
  // ───────────────────────────────────────────────────────────────────────────

  @Get('lifecycle')
  @RequirePermissions('billing:read')
  @Roles(...BILLING_READERS, UserRole.SUPER_ADMIN, UserRole.USER)
  @ApiOperation({
    summary: 'What happens to this subscription next',
    description: `
      One call for the billing screen: plan, status, auto-renew, the current
      period end, and **accessEndsAt** — the date to show as "your plan ends on
      X" once auto-renew is off or the subscription has been cancelled. Null
      while the plan keeps renewing.

      \`message\` is a single resolved sentence, safe to render verbatim.

      \`overQuota\` lists the usage keys currently above the plan ceiling. A
      tenant can legitimately be over it — a downgrade never deletes anything —
      and in that state every read and every operation on existing resources
      still works; only creating more is refused.
    `,
  })
  @ApiResponse({
    status: 200,
    description: 'Lifecycle state',
    schema: {
      example: {
        plan: 'professional',
        planName: 'Professional',
        status: 'active',
        autoRenew: false,
        currentPeriodEnd: '2026-11-11T00:00:00Z',
        accessEndsAt: '2026-11-11T00:00:00Z',
        willRenew: false,
        message:
          'Auto-renew is off — your Professional plan ends on 2026-11-11 and the account moves to Free.',
        trial: { used: true, active: false, endsAt: null, expired: false },
        pastDue: null,
        overQuota: [],
        canCreateResources: true,
      },
    },
  })
  getLifecycle(@CurrentUser() user: User) {
    return this.subscriptionsService.getLifecycle(user.id);
  }

  @Post('trial')
  @RequirePermissions('billing:manage')
  @Roles(UserRole.SUPER_ADMIN, UserRole.TENANT_ADMIN)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Start the free trial of a paid plan',
    description: `
      Moves the tenant onto the plan with \`status = trial\` until
      \`trialEndsAt\`. Nothing is charged and auto-renew is forced off — a trial
      converts by an explicit payment, never by a silent charge.

      **One trial per tenant, ever.** The record is kept independently of the
      subscription's status, so cancelling and re-subscribing does not earn a
      second one (409).

      At expiry the hourly sweep moves the tenant to FREE and keeps every
      resource created during the trial; see GET /subscriptions/lifecycle.
    `,
  })
  @ApiResponse({ status: 200, description: 'Trial started' })
  @ApiResponse({
    status: 400,
    description: 'The requested plan has no trial period',
  })
  @ApiResponse({
    status: 409,
    description:
      'Trial already used, or the account is not on the Free plan / is suspended',
  })
  startTrial(@CurrentUser() user: User, @Body() dto: StartTrialDto) {
    return this.subscriptionsService.startTrial(
      user.id,
      dto.plan,
      dto.billingPeriod,
    );
  }

  @Post('renew')
  @RequirePermissions('billing:manage')
  @Roles(UserRole.SUPER_ADMIN, UserRole.TENANT_ADMIN)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Renew the current plan for another period (returns payment requirement)',
    description: `
      Validates the renewal and returns what to pay, exactly like
      POST /subscriptions/upgrade. **The period is not extended here** — it is
      extended only by a confirmed payment, so complete the returned amount via
      POST /payments/create with the same plan.

      Renewal of the same plan is accepted by /payments/create as a RENEWAL
      (not an upgrade), and the extension is idempotent: the same payment
      delivered twice adds one period, not two.
    `,
  })
  @ApiResponse({
    status: 200,
    description: 'Renewal validated — payment required',
    schema: {
      example: {
        requiresPayment: true,
        message:
          'Please complete payment to extend your subscription for another period',
        plan: 'professional',
        billingPeriod: 'monthly',
        amount: 499,
        currentPeriodEnd: '2026-11-11T00:00:00Z',
      },
    },
  })
  @ApiResponse({
    status: 400,
    description:
      'Free plan does not expire, or the plan is quoted by sales (Enterprise)',
  })
  renew(@CurrentUser() user: User, @Body() dto: RenewSubscriptionDto) {
    return this.subscriptionsService.requestRenewal(user.id, dto.billingPeriod);
  }

  @Post('auto-renew')
  @RequirePermissions('billing:manage')
  @Roles(UserRole.SUPER_ADMIN, UserRole.TENANT_ADMIN)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Turn auto-renew on or off',
    description: `
      Off is not a cancellation: the plan runs to the end of the period already
      paid for, then the sweep moves the tenant to FREE. The response is the
      same shape as GET /subscriptions/lifecycle, so \`accessEndsAt\` and
      \`message\` are ready to show as "your plan ends on X".
    `,
  })
  @ApiResponse({ status: 200, description: 'Lifecycle state after the change' })
  @ApiResponse({
    status: 400,
    description: 'Nothing to renew on the Free plan',
  })
  @ApiResponse({
    status: 409,
    description: 'Subscription is cancelled — renew it to restart billing',
  })
  setAutoRenew(@CurrentUser() user: User, @Body() dto: ToggleAutoRenewDto) {
    return this.subscriptionsService.setAutoRenew(user.id, dto.enabled);
  }

  @Get('invoices')
  @RequirePermissions('billing:read')
  // Invoices are tenant-wide billing records, not per-user: the handler passes
  // user.tenantId straight through, so leaving this open let any CUSTOMER_USER
  // read the tenant's whole payment history.
  @Roles(UserRole.SUPER_ADMIN, UserRole.TENANT_ADMIN)
  @ApiOperation({
    summary: 'Get subscription invoices',
    description: 'Returns list of all invoices/receipts for this subscription',
  })
  @ApiResponse({
    status: 200,
    description: 'List of invoices',
    type: InvoicesListResponseDto,
  })
  getInvoices(
    @CurrentUser() user: User,
    @Query() paginationDto: PaginationDto,
  ) {
    return this.subscriptionsService.getInvoices(user.tenantId, paginationDto);
  }

  @Get('invoices/:paymentId/pdf')
  @RequirePermissions('billing:read')
  @Roles(UserRole.SUPER_ADMIN, UserRole.TENANT_ADMIN)
  @ApiOperation({ summary: 'Download invoice as PDF' })
  @ApiResponse({ status: 200, description: 'PDF file stream' })
  @ApiResponse({ status: 404, description: 'Invoice not found' })
  async downloadInvoicePdf(
    @CurrentUser() user: User,
    @Param('paymentId') paymentId: string,
    @Res() res: Response,
  ) {
    const { payment, invoiceNumber } =
      await this.subscriptionsService.getInvoiceForPdf(
        user.tenantId,
        paymentId,
      );

    const pdfBuffer = await this.invoicePdfService.generate(payment);

    res.set({
      'Content-Type': 'application/pdf',
      'Content-Disposition': `attachment; filename="${invoiceNumber}.pdf"`,
      'Content-Length': pdfBuffer.length,
    });

    res.end(pdfBuffer);
  }
}
