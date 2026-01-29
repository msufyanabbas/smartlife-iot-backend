// src/common/guards/subscription-limit.guard.ts
import {
  Injectable,
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Logger,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { SubscriptionsService } from '@modules/index.service';
import { User } from '@modules/index.entities';
import { UserRole } from '@common/enums/index.enum';

export enum ResourceType {
  DEVICE = 'devices',
  USER = 'users',
  CUSTOMER = 'customers',
  API_CALL = 'apiCalls',
  STORAGE = 'storage',
  SMS_NOTIFICATION = 'smsNotifications',
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
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const handler = context.getHandler();
    const limitOptions = this.reflector.get<SubscriptionLimitOptions>(
      SUBSCRIPTION_LIMIT_KEY,
      handler,
    );

    // No limit check required
    if (!limitOptions) {
      return true;
    }

    const request = context.switchToHttp().getRequest();
    const user: User = request.user;

    if (!user) {
      throw new ForbiddenException('User not authenticated');
    }

    // Super admins bypass all limits
    if (user.role === UserRole.SUPER_ADMIN) {
      this.logger.debug(
        `Super admin ${user.email} bypasses subscription limits`,
      );
      return true;
    }

    // All users must belong to a tenant
    const tenantId = user.tenantId;

    if (!tenantId) {
      throw new ForbiddenException('User must belong to a tenant');
    }

    try {
      // Check tenant-wide limits
      const canPerform = await this.subscriptionsService.canTenantPerformAction(
        tenantId,
        this.mapResourceToSubscriptionField(limitOptions.resource),
      );

      if (!canPerform) {
        // Get current usage and limits for error message
        const subscription = await this.subscriptionsService.findCurrent(
          user.id,
        );
        const tenantUsage =
          await this.subscriptionsService.getTenantUsage(tenantId);

        const resourceKey = this.mapResourceToSubscriptionField(
          limitOptions.resource,
        );
        const currentUsage = tenantUsage[resourceKey] || 0;
        const limit = this.getLimit(subscription.limits, limitOptions.resource);

        this.logger.warn(
          `Tenant ${tenantId} reached ${limitOptions.resource} limit: ${currentUsage}/${limit}`,
        );

        throw new ForbiddenException(
          this.generateLimitMessage(
            limitOptions.resource,
            currentUsage,
            limit,
            subscription.plan,
            user.role === UserRole.TENANT_ADMIN,
          ),
        );
      }

      this.logger.debug(
        `Tenant ${tenantId} can perform ${limitOptions.operation} on ${limitOptions.resource}`,
      );

      return true;
    } catch (error) {
      if (error instanceof ForbiddenException) {
        throw error;
      }
      this.logger.error(
        `Error checking subscription limit for tenant ${tenantId}:`,
        error,
      );
      throw new ForbiddenException(
        'Unable to verify subscription limits. Please try again.',
      );
    }
  }

  /**
   * Map ResourceType to subscription field name
   */
  private mapResourceToSubscriptionField(
    resource: ResourceType,
  ): 'devices' | 'users' | 'customers' | 'apiCalls' | 'storage' | 'smsNotifications' {
    const mapping = {
      [ResourceType.DEVICE]: 'devices' as const,
      [ResourceType.USER]: 'users' as const,
      [ResourceType.CUSTOMER]: 'customers' as const,
      [ResourceType.API_CALL]: 'apiCalls' as const,
      [ResourceType.STORAGE]: 'storage' as const,
      [ResourceType.SMS_NOTIFICATION]: 'smsNotifications' as const,
    };

    return mapping[resource];
  }

  /**
   * Get limit value from subscription limits
   */
  private getLimit(limits: any, resource: ResourceType): number {
    switch (resource) {
      case ResourceType.DEVICE:
        return limits.devices;
      case ResourceType.USER:
        return limits.users;
      case ResourceType.CUSTOMER:
        return limits.customers;
      case ResourceType.API_CALL:
        return limits.apiCallsPerMonth;
      case ResourceType.STORAGE:
        return limits.storageGB;
      case ResourceType.SMS_NOTIFICATION:
        return limits.smsNotificationsPerMonth;
      default:
        return 0;
    }
  }

  /**
   * Generate user-friendly limit reached message
   */
  private generateLimitMessage(
    resource: ResourceType,
    currentUsage: number,
    limit: number,
    planName: string,
    isTenantAdmin: boolean,
  ): string {
    const resourceName = this.getResourceDisplayName(resource);
    const limitText = limit === -1 ? 'Unlimited' : limit.toString();

    const baseMessage = `Your tenant has reached the ${resourceName.toLowerCase()} limit for the ${planName} plan (${currentUsage}/${limitText}).`;

    if (isTenantAdmin) {
      return `${baseMessage} Please upgrade your subscription to increase this limit.`;
    } else {
      return `${baseMessage} Please contact your tenant administrator to upgrade the subscription.`;
    }
  }

  /**
   * Get display name for resource
   */
  private getResourceDisplayName(resource: ResourceType): string {
    const names = {
      [ResourceType.DEVICE]: 'Device',
      [ResourceType.USER]: 'User',
      [ResourceType.CUSTOMER]: 'Customer',
      [ResourceType.API_CALL]: 'API Call',
      [ResourceType.STORAGE]: 'Storage',
      [ResourceType.SMS_NOTIFICATION]: 'SMS Notification',
    };

    return names[resource];
  }
}