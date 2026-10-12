// src/modules/subscriptions/dto/subscription-lifecycle.dto.ts
//
// The global ValidationPipe is {whitelist, forbidNonWhitelisted, transform}, so
// a property the frontend sends that is not declared here is a guaranteed 400.
// Everything these routes accept is declared.
import { IsBoolean, IsEnum, IsOptional } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';
import { SubscriptionPlan, BillingPeriod } from '@common/enums/index.enum';

export class StartTrialDto {
  @ApiProperty({
    type: String,
    enum: SubscriptionPlan,
    enumName: 'SubscriptionPlan',
    example: SubscriptionPlan.PROFESSIONAL,
    description:
      'Plan to trial. Must be a plan that defines a trial period (STARTER, PROFESSIONAL, ENTERPRISE) — FREE has none.',
  })
  @IsEnum(SubscriptionPlan)
  plan: SubscriptionPlan;

  @ApiProperty({
    type: String,
    enum: BillingPeriod,
    enumName: 'BillingPeriod',
    required: false,
    example: BillingPeriod.MONTHLY,
    description:
      'Billing period the trial converts to. Defaults to the current period. Nothing is charged during the trial.',
  })
  @IsOptional()
  @IsEnum(BillingPeriod)
  billingPeriod?: BillingPeriod;
}

export class RenewSubscriptionDto {
  @ApiProperty({
    type: String,
    enum: BillingPeriod,
    enumName: 'BillingPeriod',
    required: false,
    example: BillingPeriod.YEARLY,
    description:
      'Period to renew for. Defaults to the current billing period. Switching monthly → yearly here is allowed; the price quoted is the one for the period chosen.',
  })
  @IsOptional()
  @IsEnum(BillingPeriod)
  billingPeriod?: BillingPeriod;
}

export class ToggleAutoRenewDto {
  @ApiProperty({
    example: false,
    description:
      'false stops the plan renewing at the end of the current period; the response carries accessEndsAt, the date to show as "your plan ends on X".',
  })
  @IsBoolean()
  enabled: boolean;
}
