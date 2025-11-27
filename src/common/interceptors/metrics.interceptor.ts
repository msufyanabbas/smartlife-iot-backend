// src/common/interceptors/metrics.interceptor.ts
import {
  Injectable,
  NestInterceptor,
  ExecutionContext,
  CallHandler,
} from '@nestjs/common';
import { Observable } from 'rxjs';
import { tap } from 'rxjs/operators';
import { CustomMetricsService } from '@modules/metrics/custom-metrics.service';

@Injectable()
export class MetricsInterceptor implements NestInterceptor {
  constructor(private readonly metricsService: CustomMetricsService) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<any> {
    const request = context.switchToHttp().getRequest();
    const response = context.switchToHttp().getResponse();
    const startTime = Date.now();

    return next.handle().pipe(
      tap({
        next: () => {
          const duration = (Date.now() - startTime) / 1000; // Convert to seconds
          this.metricsService.trackHttpRequest(
            request.method,
            request.route?.path || request.path,
            response.statusCode,
            duration,
          );
        },
        error: (error) => {
          const duration = (Date.now() - startTime) / 1000;
          this.metricsService.trackHttpRequest(
            request.method,
            request.route?.path || request.path,
            error.status || 500,
            duration,
          );
        },
      }),
    );
  }
}