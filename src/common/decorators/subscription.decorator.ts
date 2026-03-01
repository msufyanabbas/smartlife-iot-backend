// src/common/decorators/subscription.decorator.ts
import { SetMetadata } from '@nestjs/common';
import { SubscriptionPlan } from '@common/enums/index.enum';
import { SubscriptionUsage } from '@common/interfaces/index.interface';

export const SUBSCRIPTION_KEY = 'subscription';
export const SUBSCRIPTION_LIMIT_KEY = 'subscription_limit';

/**
 * @RequireSubscription()
 * Requires a minimum subscription plan tier to access a route.
 * Read by SubscriptionGuard (global).
 *
 * Pass the MINIMUM plan(s) that can access this feature.
 * If multiple plans are passed, the lowest tier among them is used as the floor.
 * ENTERPRISE always satisfies any plan requirement.
 *
 * @example
 * // Only STARTER and above
 * @RequireSubscription(SubscriptionPlan.STARTER)
 * @Post('floor-plans')
 * createFloorPlan() { ... }
 *
 * // Only PROFESSIONAL and above
 * @RequireSubscription(SubscriptionPlan.PROFESSIONAL)
 * @Get('advanced-analytics')
 * getAnalytics() { ... }
 */
export const RequireSubscription = (...plans: SubscriptionPlan[]) =>
  SetMetadata(SUBSCRIPTION_KEY, plans);

// ─────────────────────────────────────────────────────────────────────────────
// Subscription Limit Decorator
// ─────────────────────────────────────────────────────────────────────────────

export interface SubscriptionLimitOptions {
  // Must match a key in SubscriptionUsage interface exactly
  resource: keyof SubscriptionUsage;
}

/**
 * @RequireSubscriptionLimit()
 * Checks whether the tenant has remaining quota for a resource before allowing
 * a write operation. Apply only to POST/create endpoints.
 * Read by SubscriptionLimitGuard (global).
 *
 * Reads from cached usage counters — no COUNT(*) queries.
 *
 * @example
 * @RequireSubscriptionLimit({ resource: 'devices' })
 * @Post('devices')
 * createDevice() { ... }
 *
 * @RequireSubscriptionLimit({ resource: 'customers' })
 * @Post('customers')
 * createCustomer() { ... }
 */
export const RequireSubscriptionLimit = (options: SubscriptionLimitOptions) =>
  SetMetadata(SUBSCRIPTION_LIMIT_KEY, options);