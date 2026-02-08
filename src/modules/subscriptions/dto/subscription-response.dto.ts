import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { SubscriptionPlan, BillingPeriod, SubscriptionStatus } from '@common/enums/index.enum';

// ==================== SUBSCRIPTION LIMITS DTO ====================

export class SubscriptionLimitsDto {
  @ApiProperty({ example: 50 })
  devices: number;

  @ApiProperty({ example: 5 })
  users: number;

  @ApiProperty({ example: 50000 })
  apiCalls: number;

  @ApiProperty({ example: 30, description: 'Data retention in days' })
  dataRetention: number;

  @ApiProperty({ example: 10, description: 'Storage in GB' })
  storage: number;

  @ApiPropertyOptional({ example: 100 })
  assets?: number;

  @ApiPropertyOptional({ example: 20 })
  dashboards?: number;

  @ApiPropertyOptional({ example: 10 })
  ruleChains?: number;
}

// ==================== SUBSCRIPTION FEATURES DTO ====================

export class SubscriptionFeaturesDto {
  @ApiProperty({ example: true })
  analytics: boolean;

  @ApiProperty({ example: true })
  automation: boolean;

  @ApiProperty({ example: false })
  integrations: boolean;

  @ApiProperty({ example: 'email', enum: ['none', 'email', 'priority', '24/7'] })
  support: string;

  @ApiProperty({ example: false })
  whiteLabel: boolean;

  @ApiPropertyOptional({ example: true })
  customDomains?: boolean;

  @ApiPropertyOptional({ example: false })
  advancedReporting?: boolean;

  @ApiPropertyOptional({ example: true })
  apiAccess?: boolean;
}

// ==================== SUBSCRIPTION METADATA DTO ====================

export class ScheduledDowngradeDto {
  @ApiProperty({ enum: SubscriptionPlan, example: SubscriptionPlan.STARTER })
  plan: SubscriptionPlan;

  @ApiProperty({ example: '2025-01-18T00:00:00Z' })
  effectiveDate: Date;
}

export class SubscriptionMetadataDto {
  @ApiPropertyOptional({ type: ScheduledDowngradeDto })
  scheduledDowngrade?: ScheduledDowngradeDto;

  @ApiPropertyOptional()
  additionalInfo?: Record<string, any>;
}

// ==================== SUBSCRIPTION RESPONSE DTO ====================

export class SubscriptionResponseDto {
  @ApiProperty({ example: 'subscription-id-123' })
  id: string;

  @ApiProperty({ example: 'user-id-123' })
  userId: string;

  @ApiProperty({ enum: SubscriptionPlan, example: SubscriptionPlan.PROFESSIONAL })
  plan: SubscriptionPlan;

  @ApiProperty({ enum: BillingPeriod, example: BillingPeriod.MONTHLY })
  billingPeriod: BillingPeriod;

  @ApiProperty({ enum: SubscriptionStatus, example: SubscriptionStatus.ACTIVE })
  status: SubscriptionStatus;

  @ApiProperty({ type: SubscriptionLimitsDto })
  limits: SubscriptionLimitsDto;

  @ApiProperty({ type: SubscriptionFeaturesDto })
  features: SubscriptionFeaturesDto;

  @ApiProperty({ example: '2024-12-18T00:00:00Z' })
  startDate: Date;

  @ApiPropertyOptional({ example: '2025-01-18T00:00:00Z' })
  nextBillingDate?: Date;

  @ApiPropertyOptional({ example: '2025-12-18T00:00:00Z' })
  endDate?: Date;

  @ApiPropertyOptional({ type: SubscriptionMetadataDto })
  metadata?: SubscriptionMetadataDto;

  @ApiProperty({ example: '2024-12-18T10:00:00Z' })
  createdAt: Date;

  @ApiProperty({ example: '2024-12-20T15:30:00Z' })
  updatedAt: Date;
}

// ==================== SUBSCRIPTION PLAN INFO DTO ====================

export class SubscriptionPlanInfoDto {
  @ApiProperty({ enum: SubscriptionPlan, example: SubscriptionPlan.STARTER })
  plan: SubscriptionPlan;

  @ApiProperty({ example: 'Starter' })
  name: string;

  @ApiPropertyOptional({ example: 'Perfect for small teams' })
  description?: string;

  @ApiProperty({ example: 49, description: 'Price in USD' })
  monthlyPrice: number;

  @ApiProperty({ example: 490, description: 'Price in USD' })
  yearlyPrice: number;

  @ApiProperty({ type: SubscriptionLimitsDto })
  limits: SubscriptionLimitsDto;

  @ApiProperty({ type: SubscriptionFeaturesDto })
  features: SubscriptionFeaturesDto;

  @ApiPropertyOptional({ example: true })
  isPopular?: boolean;

  @ApiPropertyOptional({ example: 17, description: 'Percentage saved on yearly billing' })
  yearlyDiscount?: number;
}

// ==================== PLANS LIST RESPONSE DTO ====================

export class PlansListResponseDto {
  @ApiProperty({ type: [SubscriptionPlanInfoDto] })
  plans: SubscriptionPlanInfoDto[];
}

// ==================== USAGE STATISTICS DTO ====================

export class CurrentUsageDto {
  @ApiProperty({ example: 15 })
  devices: number;

  @ApiProperty({ example: 3 })
  users: number;

  @ApiProperty({ example: 12500 })
  apiCalls: number;

  @ApiProperty({ example: 4.2, description: 'Storage used in GB' })
  storage: number;

  @ApiPropertyOptional({ example: 45 })
  assets?: number;

  @ApiPropertyOptional({ example: 8 })
  dashboards?: number;

  @ApiPropertyOptional({ example: 5 })
  ruleChains?: number;
}

export class UsagePercentageDto {
  @ApiProperty({ example: 30, description: 'Percentage of limit used' })
  devices: number;

  @ApiProperty({ example: 60 })
  users: number;

  @ApiProperty({ example: 25 })
  apiCalls: number;

  @ApiProperty({ example: 42 })
  storage: number;

  @ApiPropertyOptional({ example: 45 })
  assets?: number;

  @ApiPropertyOptional({ example: 40 })
  dashboards?: number;

  @ApiPropertyOptional({ example: 50 })
  ruleChains?: number;
}

export class UsageStatisticsResponseDto {
  @ApiProperty({ type: CurrentUsageDto })
  current: CurrentUsageDto;

  @ApiProperty({ type: SubscriptionLimitsDto })
  limits: SubscriptionLimitsDto;

  @ApiProperty({ type: UsagePercentageDto })
  percentage: UsagePercentageDto;

  @ApiProperty({ enum: SubscriptionPlan, example: SubscriptionPlan.PROFESSIONAL })
  currentPlan: SubscriptionPlan;

  @ApiPropertyOptional({ 
    type: [String],
    example: ['devices', 'users'],
    description: 'Resources that are approaching or exceeding limits'
  })
  warnings?: string[];
}

// ==================== UPGRADE VALIDATION RESPONSE DTO ====================

export class UpgradeValidationResponseDto {
  @ApiProperty({ example: true })
  requiresPayment: boolean;

  @ApiProperty({ example: 'Please complete payment to upgrade your subscription' })
  message: string;

  @ApiProperty({ enum: SubscriptionPlan, example: SubscriptionPlan.PROFESSIONAL })
  plan: SubscriptionPlan;

  @ApiProperty({ enum: BillingPeriod, example: BillingPeriod.MONTHLY })
  billingPeriod: BillingPeriod;

  @ApiPropertyOptional({ example: 99, description: 'Amount to be charged' })
  amount?: number;

  @ApiPropertyOptional({ example: 'USD' })
  currency?: string;

  @ApiPropertyOptional({ example: 'payment-intent-id' })
  paymentIntentId?: string;
}

// ==================== INVOICE DTO ====================

export class InvoiceDto {
  @ApiProperty({ example: 'invoice-id-123' })
  id: string;

  @ApiProperty({ example: 'INV-2024-001' })
  invoiceNumber: string;

  @ApiProperty({ example: '2024-12-18T00:00:00Z' })
  date: Date;

  @ApiProperty({ example: 99 })
  amount: number;

  @ApiProperty({ example: 'USD' })
  currency: string;

  @ApiProperty({ 
    example: 'paid', 
    enum: ['draft', 'open', 'paid', 'void', 'uncollectible'] 
  })
  status: string;

  @ApiProperty({ enum: SubscriptionPlan, example: SubscriptionPlan.PROFESSIONAL })
  plan: SubscriptionPlan;

  @ApiProperty({ enum: BillingPeriod, example: BillingPeriod.MONTHLY })
  billingPeriod: BillingPeriod;

  @ApiPropertyOptional({ example: 'https://invoice-url.com/invoice.pdf' })
  invoiceUrl?: string;

  @ApiPropertyOptional({ example: 'https://receipt-url.com/receipt.pdf' })
  receiptUrl?: string;

  @ApiProperty({ example: '2024-12-18T10:30:00Z' })
  createdAt: Date;
}

export class InvoicesListResponseDto {
  @ApiProperty({ type: [InvoiceDto] })
  invoices: InvoiceDto[];

  @ApiProperty({ example: 12 })
  total: number;
}

// ==================== MESSAGE RESPONSE DTO ====================

export class SubscriptionMessageResponseDto {
  @ApiProperty({ example: 'Operation completed successfully' })
  message: string;

  @ApiPropertyOptional({ type: SubscriptionResponseDto })
  data?: SubscriptionResponseDto;
}