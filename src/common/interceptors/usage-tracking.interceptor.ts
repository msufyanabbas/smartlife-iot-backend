// src/common/interceptors/usage-tracking.interceptor.ts
import {
  Injectable,
  NestInterceptor,
  ExecutionContext,
  CallHandler,
  ForbiddenException,
} from '@nestjs/common';
import { Observable } from 'rxjs';
import { tap } from 'rxjs/operators';
import { SubscriptionsService } from '@modules/subscriptions/subscriptions.service';

export interface UsageTrackingOptions {
  resource: 'devices' | 'users' | 'apiCalls' | 'storage';
  incrementBy?: number;
}

@Injectable()
export class UsageTrackingInterceptor implements NestInterceptor {
  constructor(private subscriptionsService: SubscriptionsService) {}

  async intercept(
    context: ExecutionContext,
    next: CallHandler,
  ): Promise<Observable<any>> {
    const request = context.switchToHttp().getRequest();
    const { user, subscription } = request;

    if (!subscription) {
      return next.handle();
    }

    // Get metadata from decorator
    const metadata = Reflect.getMetadata(
      'usage_tracking',
      context.getHandler(),
    ) as UsageTrackingOptions;

    if (!metadata) {
      return next.handle();
    }

    const { resource, incrementBy = 1 } = metadata;

    // Check if limit is exceeded
    const currentUsage = subscription.usage[resource] || 0;
    const limit = subscription.limits[resource];

    if (limit !== -1 && currentUsage >= limit) {
      throw new ForbiddenException(
        `You have reached the ${resource} limit for your plan. Please upgrade.`,
      );
    }

    return next.handle().pipe(
      tap(async () => {
        // Increment usage after successful operation
        await this.subscriptionsService.incrementUsage(
          user.id,
          resource,
          incrementBy,
        );
      }),
    );
  }
}

// Decorator to track usage
export const TrackUsage = (options: UsageTrackingOptions) => {
  return (target: any, propertyKey: string, descriptor: PropertyDescriptor) => {
    Reflect.defineMetadata('usage_tracking', options, descriptor.value);
    return descriptor;
  };
};