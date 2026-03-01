// src/common/interceptors/logging.interceptor.ts
import { Injectable, NestInterceptor, ExecutionContext, CallHandler } from '@nestjs/common';
import { Observable } from 'rxjs';
import { tap } from 'rxjs/operators';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { APILog } from '@modules/index.entities';

@Injectable()
export class LoggingInterceptor implements NestInterceptor {
  constructor(
    @InjectRepository(APILog)
    private apiLogRepo: Repository<APILog>,
  ) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<any> {
    const request = context.switchToHttp().getRequest();
    const { method, url, user, ip, headers, id: requestId } = request;
    const startTime = Date.now();

    return next.handle().pipe(
      tap({
        next: (response) => {
          const responseTime = Date.now() - startTime;
          
          // Log successful request
          this.createLog({
            requestId,
            tenantId: user?.tenantId,
            customerId: user?.customerId,
            userId: user?.id,
            method,
            endpoint: url,
            statusCode: 200,
            responseTime,
            ip,
            userAgent: headers['user-agent'],
          });
        },
        error: (error) => {
          const responseTime = Date.now() - startTime;
          
          // Log failed request
          this.createLog({
            requestId,
            tenantId: user?.tenantId,
            customerId: user?.customerId,
            userId: user?.id,
            method,
            endpoint: url,
            statusCode: error.status || 500,
            responseTime,
            ip,
            userAgent: headers['user-agent'],
            errorMessage: error.message,
            errorStack: error.stack,
          });
        },
      }),
    );
  }

  private async createLog(data: Partial<APILog>) {
    try {
      await this.apiLogRepo.save(this.apiLogRepo.create(data));
    } catch (error) {
      // Don't let logging errors crash the request
      console.error('Failed to create API log:', error);
    }
  }
}