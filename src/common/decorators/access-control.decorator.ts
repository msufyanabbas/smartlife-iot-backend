// src/common/decorators/access-control.decorator.ts
import { applyDecorators, UseGuards } from '@nestjs/common';
import { JwtAuthGuard, RolesGuard, SubscriptionGuard } from '@common/guards/index.guards';
import { Roles, RequireSubscription } from '@common/decorators/index.decorator';
import { UserRole } from '@common/enums/index.enum';
import { SubscriptionPlan } from '@common/enums/index.enum';

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