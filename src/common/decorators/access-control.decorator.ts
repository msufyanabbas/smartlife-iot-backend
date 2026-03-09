// src/common/decorators/access-control.decorator.ts
//
// COMPOSITION DECORATORS
// These combine multiple metadata decorators for cleaner controller code.
// 
// IMPORTANT: These do NOT call UseGuards() because all guards are already
// registered globally in AppModule. These decorators only SET METADATA that
// the global guards READ.
//
// Guard execution order (from app.module.ts):
//   1. CustomThrottlerGuard
//   2. JwtAuthGuard (checks @Public())
//   3. RolesGuard (checks @Roles())
//   4. TenantIsolationGuard
//   5. SubscriptionGuard (checks @RequireSubscription())
//   6. FeatureLimitGuard (checks @RequireFeature())
//   7. PermissionGuard (checks @RequirePermissions())
//   8. SubscriptionLimitGuard (checks @RequireSubscriptionLimit())
//
import { applyDecorators } from '@nestjs/common';
import { ApiOperation, ApiBearerAuth, ApiResponse } from '@nestjs/swagger';
import { Roles, RequirePermissions, RequireSubscription, RequireSubscriptionLimit, SubscriptionLimitOptions, RequireFeature } from './index.decorator';
import { SubscriptionFeatures } from '@common/interfaces/index.interface';
import { UserRole } from '@common/enums/index.enum';
import { SubscriptionPlan } from '@common/enums/index.enum';

// ─────────────────────────────────────────────────────────────────────────────
// @TenantAdminOnly()
// Shorthand for routes that only tenant admins can access.
// SUPER_ADMIN always passes RolesGuard regardless.
//
// @example
// @TenantAdminOnly()
// @Post('customers')
// createCustomer() { ... }
// ─────────────────────────────────────────────────────────────────────────────
export const TenantAdminOnly = () =>
  applyDecorators(Roles(UserRole.TENANT_ADMIN));

// ─────────────────────────────────────────────────────────────────────────────
// @CustomerAdminOnly()
// For routes that customer admins manage within their customer scope.
// ─────────────────────────────────────────────────────────────────────────────
export const CustomerAdminOnly = () =>
  applyDecorators(Roles(UserRole.CUSTOMER));

// ─────────────────────────────────────────────────────────────────────────────
// @TenantOrCustomerAdmin()
// Routes accessible by both tenant admins and customer admins.
// ─────────────────────────────────────────────────────────────────────────────
export const TenantOrCustomerAdmin = () =>
  applyDecorators(Roles(UserRole.TENANT_ADMIN, UserRole.CUSTOMER));

// ─────────────────────────────────────────────────────────────────────────────
// @ProtectedRoute()
// Full composition — role + plan + feature + permission in one decorator.
// Use this when a route has multiple requirements.
//
// @example
// @ProtectedRoute({
//   roles: [UserRole.TENANT_ADMIN],
//   plan: SubscriptionPlan.STARTER,
//   feature: 'floorPlans',
//   permissions: ['floor_plans:create'],
//   limit: { resource: 'floorPlans' },
// })
// @Post('floor-plans')
// createFloorPlan() { ... }
// ─────────────────────────────────────────────────────────────────────────────
export interface ProtectedRouteOptions {
  roles?: UserRole[];
  plan?: SubscriptionPlan;
  feature?: keyof SubscriptionFeatures;
  permissions?: string[];
  limit?: SubscriptionLimitOptions;
}

export const ProtectedRoute = (options: ProtectedRouteOptions) => {
  const decorators: (MethodDecorator | ClassDecorator)[] = [];

  if (options.roles?.length) {
    decorators.push(Roles(...options.roles));
  }
  if (options.plan) {
    decorators.push(RequireSubscription(options.plan));
  }
  if (options.feature) {
    decorators.push(RequireFeature(options.feature));
  }
  if (options.permissions?.length) {
    decorators.push(RequirePermissions(...options.permissions));
  }
  if (options.limit) {
    decorators.push(RequireSubscriptionLimit(options.limit));
  }

  return applyDecorators(...decorators);
};

// ─────────────────────────────────────────────────────────────────────────────
// @SwaggerAuth()
// Applies Swagger documentation decorators for authenticated endpoints.
// Use alongside functional decorators, not as a replacement.
//
// @example
// @SwaggerAuth('Create a new device', 'Device created successfully')
// @Post('devices')
// createDevice() { ... }
// ─────────────────────────────────────────────────────────────────────────────
export const SwaggerAuth = (summary: string, successDescription = 'Success') =>
  applyDecorators(
    ApiBearerAuth(),
    ApiOperation({ summary }),
    ApiResponse({ status: 200, description: successDescription }),
    ApiResponse({ status: 401, description: 'Unauthorized' }),
    ApiResponse({ status: 403, description: 'Forbidden' }),
  );