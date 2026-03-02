// src/common/guards/subscription-limit.guard.ts
import {
  Injectable,
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Logger,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { IS_PUBLIC_KEY, SUBSCRIPTION_LIMIT_KEY } from '@common/decorators/index.decorator';
import { User, Subscription } from '@modules/index.entities';
import { UserRole } from '@common/enums/index.enum';
import { SubscriptionUsage } from '@common/interfaces/index.interface';

// ─────────────────────────────────────────────────────────────────────────────
// ResourceType
//
// Must stay in sync with keyof SubscriptionUsage in subscription.entity.ts.
// When you add a new resource type, add it here and in SubscriptionUsage.
// ─────────────────────────────────────────────────────────────────────────────
export enum ResourceType {
  DEVICE       = 'devices',
  USER         = 'users',
  CUSTOMER     = 'customers',
  DASHBOARD    = 'dashboards',
  ASSET        = 'assets',
  FLOOR_PLAN   = 'floorPlans',
  AUTOMATION   = 'automations',
  API_CALL     = 'apiCalls',
  STORAGE      = 'storageGB',          // matches SubscriptionUsage key exactly
  SMS          = 'smsNotifications',
}

export interface SubscriptionLimitOptions {
  resource: ResourceType;
}

const RESOURCE_DISPLAY_NAMES: Record<ResourceType, string> = {
  [ResourceType.DEVICE]:    'Device',
  [ResourceType.USER]:      'User',
  [ResourceType.CUSTOMER]:  'Customer',
  [ResourceType.DASHBOARD]: 'Dashboard',
  [ResourceType.ASSET]:     'Asset',
  [ResourceType.FLOOR_PLAN]:'Floor Plan',
  [ResourceType.AUTOMATION]:'Automation',
  [ResourceType.API_CALL]:  'API Call',
  [ResourceType.STORAGE]:   'Storage',
  [ResourceType.SMS]:       'SMS Notification',
};

@Injectable()
export class SubscriptionLimitGuard implements CanActivate {
  private readonly logger = new Logger(SubscriptionLimitGuard.name);

  constructor(private readonly reflector: Reflector) {}
  // ↑ No SubscriptionsService needed — reads from req.subscription cache set by SubscriptionGuard

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
  context.getHandler(),
  context.getClass(),
]);
if (isPublic) return true;
    const options = this.reflector.get<SubscriptionLimitOptions>(
      SUBSCRIPTION_LIMIT_KEY,
      context.getHandler(),
    );

    // No @RequireSubscriptionLimit() on this route
    if (!options) return true;

    const request = context.switchToHttp().getRequest();
    const user: User = request.user;

    if (!user) throw new ForbiddenException('User not authenticated');

    // Super admin has no limits
    if (user.role === UserRole.SUPER_ADMIN) return true;

    // ── Read cached subscription (set by SubscriptionGuard) ─────────────────
    // SubscriptionGuard must run before this guard in the APP_GUARD array.
    const subscription: Subscription = request.subscription;

    if (!subscription) {
      // Misconfigured guard order — SubscriptionGuard did not run first
      this.logger.error(
        'SubscriptionLimitGuard ran before SubscriptionGuard — check APP_GUARD registration order',
      );
      throw new ForbiddenException('Subscription context not available');
    }

    const resource = options.resource as keyof SubscriptionUsage;

    // ── Check tenant-level limit using entity helper ───────────────────────
    if (subscription.isLimitReached(resource)) {
      const remaining = subscription.getRemainingCapacity(resource);
      const limitValue = subscription.getLimitValue(resource);
      const currentUsage = subscription.usage[resource] ?? 0;
      const displayName = RESOURCE_DISPLAY_NAMES[options.resource];

      this.logger.warn(
        `Tenant ${user.tenantId} reached ${resource} limit: ${currentUsage}/${limitValue}`,
      );

      const upgradeHint = user.role === UserRole.TENANT_ADMIN
        ? 'Please upgrade your subscription to increase this limit.'
        : 'Please contact your administrator to upgrade the subscription.';

      throw new ForbiddenException(
        `Your tenant has reached the ${displayName} limit for the ` +
        `${subscription.plan} plan (${currentUsage}/${limitValue === -1 ? 'Unlimited' : limitValue}). ` +
        upgradeHint,
      );
    }

    this.logger.debug(
      `Tenant ${user.tenantId}: ${resource} OK ` +
      `(${subscription.usage[resource]}/${subscription.getLimitValue(resource)})`,
    );

    return true;
  }
}