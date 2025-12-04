import { IsEnum, IsString, IsNumber, IsOptional, Min } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';
import { 
  SubscriptionPlan, 
  BillingPeriod 
} from '../../subscriptions/entities/subscription.entity';

export class CreatePaymentIntentDto {
  @ApiProperty({ 
    enum: SubscriptionPlan, 
    example: SubscriptionPlan.STARTER,
    description: 'Subscription plan to purchase'
  })
  @IsEnum(SubscriptionPlan)
  plan: SubscriptionPlan;

  @ApiProperty({ 
    enum: BillingPeriod, 
    example: BillingPeriod.MONTHLY,
    description: 'Billing period (monthly or yearly)'
  })
  @IsEnum(BillingPeriod)
  billingPeriod: BillingPeriod;
}

export class RefundPaymentDto {
  @ApiProperty({ description: 'Payment ID to refund' })
  @IsString()
  paymentId: string;

  @ApiProperty({ 
    required: false,
    description: 'Partial refund amount in SAR (leave empty for full refund)'
  })
  @IsOptional()
  @IsNumber()
  @Min(0)
  amount?: number;

  @ApiProperty({ 
    required: false,
    description: 'Reason for refund'
  })
  @IsOptional()
  @IsString()
  reason?: string;
}