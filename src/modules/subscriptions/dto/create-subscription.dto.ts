import { IsEnum, IsOptional } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';
import { SubscriptionPlan, BillingPeriod} from '@common/enums/index.enum';

export class CreateSubscriptionDto {
  @ApiProperty({ 
    enum: SubscriptionPlan, 
    example: SubscriptionPlan.FREE,
    description: 'Subscription plan - only FREE can be created directly'
  })
  @IsEnum(SubscriptionPlan)
  plan: SubscriptionPlan;

  @ApiProperty({ 
    enum: BillingPeriod, 
    example: BillingPeriod.MONTHLY,
    description: 'Billing period'
  })
  @IsOptional()
  @IsEnum(BillingPeriod)
  billingPeriod?: BillingPeriod;
}

export class UpgradeSubscriptionDto {
  @ApiProperty({ 
    enum: SubscriptionPlan,
    example: SubscriptionPlan.PROFESSIONAL,
    description: 'Target plan (must be higher than current plan)'
  })
  @IsEnum(SubscriptionPlan)
  plan: SubscriptionPlan;

  @ApiProperty({ 
    enum: BillingPeriod, 
    required: false,
    example: BillingPeriod.YEARLY,
    description: 'Billing period (defaults to current period if not specified)'
  })
  @IsOptional()
  @IsEnum(BillingPeriod)
  billingPeriod?: BillingPeriod;
}

export class ScheduleDowngradeDto {
  @ApiProperty({ 
    enum: SubscriptionPlan,
    example: SubscriptionPlan.STARTER,
    description: 'Target plan to downgrade to (must be lower than current plan)'
  })
  @IsEnum(SubscriptionPlan)
  targetPlan: SubscriptionPlan;
}