// src/common/guards/feature-limit.guard.ts
import {
  Injectable,
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  SetMetadata,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';

export const FEATURE_LIMIT_KEY = 'feature_limit';
export const CheckFeatureLimit = (feature: string) =>
  SetMetadata(FEATURE_LIMIT_KEY, feature);

@Injectable()
export class FeatureLimitGuard implements CanActivate {
  constructor(private reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const feature = this.reflector.get<string>(
      FEATURE_LIMIT_KEY,
      context.getHandler(),
    );

    if (!feature) {
      return true;
    }

    const { subscription } = context.switchToHttp().getRequest();

    if (!subscription) {
      throw new ForbiddenException('No subscription found');
    }

    // Check if the feature is enabled for this plan
    if (subscription.features && subscription.features[feature] === false) {
      throw new ForbiddenException(
        `This feature is not available in your current plan. Please upgrade.`,
      );
    }

    return true;
  }
}