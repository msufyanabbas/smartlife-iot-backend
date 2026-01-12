// src/common/guards/subscription-limit.guard.ts
import {
  Injectable,
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Logger,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { SubscriptionsService } from '@modules/subscriptions/subscriptions.service';
import { TenantsService } from '@modules/tenants/tenants.service';
import { User, UserRole } from '@modules/users/entities/user.entity';

export enum ResourceType {
  DEVICE = 'devices',
  USER = 'users',
  CUSTOMER = 'customers',
  ASSET = 'assets',
  DASHBOARD = 'dashboards',
  RULE_CHAIN = 'ruleChains',
  API_CALL = 'apiCalls',
  STORAGE = 'storage',
}

export const SUBSCRIPTION_LIMIT_KEY = 'subscription_limit';

export interface SubscriptionLimitOptions {
  resource: ResourceType;
  operation: 'create' | 'check';
}

/**
 * Decorator to mark endpoints that require subscription limit checks
 * Usage: @RequireSubscriptionLimit({ resource: ResourceType.DEVICE, operation: 'create' })
 */
export const RequireSubscriptionLimit = (
  options: SubscriptionLimitOptions,
) => {
  return (target: any, propertyKey: string, descriptor: PropertyDescriptor) => {
    Reflect.defineMetadata(SUBSCRIPTION_LIMIT_KEY, options, descriptor.value);
    return descriptor;
  };
};

@Injectable()
export class SubscriptionLimitGuard implements CanActivate {
  private readonly logger = new Logger(SubscriptionLimitGuard.name);

  constructor(
    private readonly reflector: Reflector,
    private readonly subscriptionsService: SubscriptionsService,
    private readonly tenantsService: TenantsService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const handler = context.getHandler();
    const limitOptions = this.reflector.get<SubscriptionLimitOptions>(
      SUBSCRIPTION_LIMIT_KEY,
      handler,
    );

    if (!limitOptions) {
      // No limit check required
      return true;
    }

    const request = context.switchToHttp().getRequest();
    const user: User = request.user;

    if (!user) {
      throw new ForbiddenException('User not authenticated');
    }

    // Super admins bypass all limits
    if (user.role === UserRole.SUPER_ADMIN) {
      this.logger.debug(`Super admin ${user.email} bypasses subscription limits`);
      return true;
    }

    // Get tenant ID (all users have tenantId)
    const tenantId = user.tenantId;

    if (!tenantId) {
      throw new ForbiddenException('User must belong to a tenant');
    }

    // Get tenant and its admin
    const tenant = await this.tenantsService.findOne(tenantId);
    
    if (!tenant.tenantAdminId) {
      throw new ForbiddenException('Tenant has no admin configured');
    }

    // Check if tenant admin has active subscription
    const canPerform = await this.subscriptionsService.canPerformAction(
      tenant.tenantAdminId,
      this.mapResourceToSubscriptionField(limitOptions.resource),
    );

    if (!canPerform) {
      const subscription = await this.subscriptionsService.findCurrent(
        tenant.tenantAdminId,
      );

      const limitKey = this.mapResourceToSubscriptionField(limitOptions.resource);
      
      // Get actual tenant-wide usage
      const tenantUsage = await this.subscriptionsService.getTenantUsage(tenantId);
      const currentUsage = tenantUsage[limitKey] || 0;
      const limit = subscription.limits[limitKey];

      this.logger.warn(
        `Tenant ${tenantId} reached ${limitOptions.resource} limit: ${currentUsage}/${limit}`,
      );

      throw new ForbiddenException(
        `Your tenant has reached the ${limitOptions.resource} limit for the ${subscription.plan} plan (${currentUsage}/${limit}). Please ask your tenant admin to upgrade the subscription.`,
      );
    }

    this.logger.debug(
      `Tenant ${tenantId} can perform ${limitOptions.operation} on ${limitOptions.resource}`,
    );

    return true;
  }

  private mapResourceToSubscriptionField(
    resource: ResourceType,
  ): 'devices' | 'users' | 'apiCalls' | 'storage' {
    const mapping = {
      [ResourceType.DEVICE]: 'devices' as const,
      [ResourceType.USER]: 'users' as const,
      [ResourceType.CUSTOMER]: 'users' as const, // Customers count as users
      [ResourceType.ASSET]: 'devices' as const, // Assets count as devices
      [ResourceType.DASHBOARD]: 'devices' as const, // Or create separate limit
      [ResourceType.RULE_CHAIN]: 'devices' as const, // Or create separate limit
      [ResourceType.API_CALL]: 'apiCalls' as const,
      [ResourceType.STORAGE]: 'storage' as const,
    };

    return mapping[resource] || 'devices';
  }
}