// src/common/decorators/access-control.decorator.ts
import { applyDecorators, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '@common/guards/jwt-auth.guard';
import { RolesGuard } from '@common/guards/roles.guard';
import { SubscriptionGuard } from '@common/guards/subscription.guard';
import { Roles } from './roles.decorator';
import { RequireSubscription } from './subscription.decorator';
import { UserRole } from '@modules/users/entities/user.entity';
import { SubscriptionPlan } from '@modules/subscriptions/entities/subscription.entity';

export function AccessControl(
  roles: UserRole[],
  plans?: SubscriptionPlan[],
) {
  const decorators = [
    UseGuards(JwtAuthGuard, RolesGuard, SubscriptionGuard),
    Roles(...roles),
  ];

  if (plans && plans.length > 0) {
    decorators.push(RequireSubscription(...plans));
  }

  return applyDecorators(...decorators);
}

// Usage:
// @AccessControl([UserRole.USER], [SubscriptionPlan.PROFESSIONAL])