// src/common/guards/feature-limit.guard.ts
import {
  Injectable,
  CanActivate,
  ExecutionContext,
  ForbiddenException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { FEATURE_KEY, IS_PUBLIC_KEY } from '@common/decorators/index.decorator';
import { Subscription } from '@modules/index.entities';
import { UserRole } from '@common/enums/index.enum';
import { SubscriptionFeatures } from '@common/interfaces/index.interface';

@Injectable()
export class FeatureLimitGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
  context.getHandler(),
  context.getClass(),
]);
if (isPublic) return true;
    // Read @RequireFeature() metadata
    const feature = this.reflector.get<keyof SubscriptionFeatures>(
      FEATURE_KEY,
      context.getHandler(),
    );

    // No @RequireFeature() on this route
    if (!feature) return true;

    const request = context.switchToHttp().getRequest();

    // Super admin bypasses feature checks
    if (request.user?.role === UserRole.SUPER_ADMIN) return true;

    // Read cached subscription (set by SubscriptionGuard)
    const subscription: Subscription = request.subscription;

    if (!subscription) {
      throw new ForbiddenException(
        'Subscription context not available. Check guard registration order.',
      );
    }

    // Check if feature is enabled
    if (!subscription.hasFeature(feature)) {
      throw new ForbiddenException(
        `The "${feature}" feature is not available in your current ` +
        `${subscription.plan} plan. Please upgrade your subscription to access this feature.`,
      );
    }

    return true;
  }
}