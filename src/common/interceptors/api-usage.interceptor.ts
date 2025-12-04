// src/common/interceptors/api-usage.interceptor.ts
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

@Injectable()
export class ApiUsageInterceptor implements NestInterceptor {
  constructor(private subscriptionsService: SubscriptionsService) {}

  async intercept(
    context: ExecutionContext,
    next: CallHandler,
  ): Promise<Observable<any>> {
    const request = context.switchToHttp().getRequest();
    const { user } = request;

    // Skip for unauthenticated requests
    if (!user) {
      return next.handle();
    }

    // Check if user can make API call
    const canMakeCall = await this.subscriptionsService.canPerformAction(
      user.id,
      'apiCalls',
    );

    if (!canMakeCall) {
      throw new ForbiddenException(
        'API call limit exceeded. Please upgrade your subscription.',
      );
    }

    return next.handle().pipe(
      tap(async () => {
        // Increment API call count after successful request
        await this.subscriptionsService.incrementUsage(user.id, 'apiCalls', 1);
      }),
    );
  }
}