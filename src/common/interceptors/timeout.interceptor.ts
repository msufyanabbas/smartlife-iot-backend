import {
  Injectable,
  NestInterceptor,
  ExecutionContext,
  CallHandler,
  RequestTimeoutException,
  Logger,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Observable, throwError, TimeoutError } from 'rxjs';
import { catchError, timeout } from 'rxjs/operators';

@Injectable()
export class TimeoutInterceptor implements NestInterceptor {
  private readonly logger = new Logger(TimeoutInterceptor.name);
  private readonly timeoutDuration: number;

  constructor(private configService: ConfigService) {
    this.timeoutDuration =
      this.configService.get<number>('REQUEST_TIMEOUT') || 30000; // Default 30 seconds
  }

  intercept(context: ExecutionContext, next: CallHandler): Observable<any> {
    const request = context.switchToHttp().getRequest();
    const { method, url } = request;

    return next.handle().pipe(
      timeout(this.timeoutDuration),
      catchError((error) => {
        if (error instanceof TimeoutError) {
          this.logger.error(
            `Request Timeout: ${method} ${url} - Exceeded ${this.timeoutDuration}ms`,
          );
          return throwError(
            () =>
              new RequestTimeoutException(
                `Request timeout - Operation took longer than ${this.timeoutDuration / 1000} seconds`,
              ),
          );
        }
        return throwError(() => error);
      }),
    );
  }
}
