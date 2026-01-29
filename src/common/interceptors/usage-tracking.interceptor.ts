// src/common/interceptors/usage-tracking.interceptor.ts
import {
  Injectable,
  NestInterceptor,
  ExecutionContext,
  CallHandler,
  Logger,
} from '@nestjs/common';
import { Observable } from 'rxjs';
import { tap } from 'rxjs/operators';
import { SubscriptionsService } from '@modules/subscriptions/subscriptions.service';
import { User } from '@modules/users/entities/user.entity';

/**
 * Interceptor to track API calls usage
 * Apply this globally or to specific controllers
 */
@Injectable()
export class UsageTrackingInterceptor implements NestInterceptor {
  private readonly logger = new Logger(UsageTrackingInterceptor.name);

  constructor(private readonly subscriptionsService: SubscriptionsService) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<any> {
    const request = context.switchToHttp().getRequest();
    const user: User = request.user;

    // Only track for authenticated requests
    if (!user || !user.tenantId) {
      return next.handle();
    }

    const startTime = Date.now();

    return next.handle().pipe(
      tap({
        next: async () => {
          const duration = Date.now() - startTime;
          
          try {
            // Increment API call count for tenant
            await this.subscriptionsService.incrementTenantUsage(
              user.tenantId as any,
              'apiCalls',
              1,
            );

            this.logger.debug(
              `API call tracked for tenant ${user.tenantId} - Duration: ${duration}ms`,
            );
          } catch (error) {
            this.logger.error(
              `Failed to track API usage for tenant ${user.tenantId}:`,
              error,
            );
          }
        },
        error: (error) => {
          // Still track failed requests
          this.subscriptionsService
            .incrementTenantUsage(user.tenantId as any, 'apiCalls', 1)
            .catch((err) =>
              this.logger.error('Failed to track failed API call:', err),
            );
        },
      }),
    );
  }
}