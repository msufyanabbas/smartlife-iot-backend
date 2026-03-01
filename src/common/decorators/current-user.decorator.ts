// src/common/decorators/current-user.decorator.ts
import { createParamDecorator, ExecutionContext } from '@nestjs/common';
import { User } from '@modules/index.entities';

// Augment Express Request type
declare global {
  namespace Express {
    interface Request {
      user?: User;
      tenantFilter?: { tenantId: string };
      customerFilter?: { tenantId: string; customerId?: string };
      subscription?: import('@modules/subscriptions/entities/subscription.entity').Subscription;
      effectivePermissions?: Set<string>;
    }
  }
}

/**
 * @CurrentUser()
 * Extract authenticated user or specific properties
 * 
 * @example
 * // Get full user object
 * @CurrentUser() user: User
 * 
 * // Get specific property
 * @CurrentUser('id') userId: string
 * @CurrentUser('tenantId') tenantId: string
 * @CurrentUser('role') role: UserRole
 */
export const CurrentUser = createParamDecorator(
  (data: keyof User | undefined, ctx: ExecutionContext): User | any => {
    const request = ctx.switchToHttp().getRequest();
    const user: User = request.user;

    if (!user) return undefined;

    // If property specified, return that property
    if (data) {
      return user[data];
    }

    // Otherwise return full user object
    return user;
  },
);

/**
 * @ResolvedTenantId()
 * Shorthand for @CurrentUser('tenantId')
 */
export const ResolvedTenantId = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): string | undefined => {
    return ctx.switchToHttp().getRequest().user?.tenantId;
  },
);

/**
 * @ResolvedCustomerId()
 * Shorthand for @CurrentUser('customerId')
 */
export const ResolvedCustomerId = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): string | undefined => {
    return ctx.switchToHttp().getRequest().user?.customerId;
  },
);