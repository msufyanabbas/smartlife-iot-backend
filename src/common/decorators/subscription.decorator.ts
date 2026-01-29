// src/common/decorators/subscription.decorator.ts
import { SetMetadata } from '@nestjs/common';
import { SubscriptionPlan } from '@common/enums/index.enum';

export const SUBSCRIPTION_KEY = 'subscription';
export const RequireSubscription = (...plans: SubscriptionPlan[]) => 
  SetMetadata(SUBSCRIPTION_KEY, plans);

// Usage example: @RequireSubscription(SubscriptionPlan.STARTER, SubscriptionPlan.PROFESSIONAL)