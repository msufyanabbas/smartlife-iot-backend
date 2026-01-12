// src/common/interceptors/audit.interceptor.ts
import {
  Injectable,
  NestInterceptor,
  ExecutionContext,
  CallHandler,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Observable } from 'rxjs';
import { tap, catchError } from 'rxjs/operators';
import { AuditService } from '@/modules/audit/audit.service';
import { AUDIT_KEY, AuditMetadata } from '@/common/decorators/audit.decorator';
import { AuditSeverity } from '@/modules/audit/entities/audit-log.entity';

@Injectable()
export class AuditInterceptor implements NestInterceptor {
  constructor(
    private readonly auditService: AuditService,
    private readonly reflector: Reflector,
  ) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<any> {
    const request = context.switchToHttp().getRequest();
    const user = request.user;
    
    // Get audit metadata from decorator
    const auditMetadata = this.reflector.get<AuditMetadata>(
      AUDIT_KEY,
      context.getHandler(),
    );

    // If no @Audit decorator, skip logging
    if (!auditMetadata) {
      return next.handle();
    }

    const startTime = Date.now();

    return next.handle().pipe(
      tap(async (response) => {
        // Log successful action
        try {
          const entityId = request.params?.id || response?.data?.id;
          const entityName = response?.data?.name || response?.data?.email || response?.data?.title;

          await this.auditService.logAction({
            userId: user?.id,
            userName: user?.name,
            userEmail: user?.email,
            tenantId: user?.tenantId || request.body?.tenantId,
            customerId: user?.customerId || request.body?.customerId,
            action: auditMetadata.action,
            entityType: auditMetadata.entityType,
            entityId: entityId,
            entityName: entityName,
            description: auditMetadata.description || `${auditMetadata.action} ${auditMetadata.entityType}`,
            metadata: {
              method: request.method,
              url: request.url,
              duration: Date.now() - startTime,
            },
            ipAddress: request.ip || request.connection?.remoteAddress,
            userAgent: request.headers['user-agent'],
            requestId: request.id,
            severity: auditMetadata.severity || AuditSeverity.INFO,
            success: true,
          });
        } catch (error) {
          console.error('Failed to log audit:', error);
        }
      }),
      catchError(async (error) => {
        // Log failed action
        try {
          await this.auditService.logAction({
            userId: user?.id,
            userName: user?.name,
            userEmail: user?.email,
            tenantId: user?.tenantId || request.body?.tenantId,
            customerId: user?.customerId || request.body?.customerId,
            action: auditMetadata.action,
            entityType: auditMetadata.entityType,
            entityId: request.params?.id,
            description: `Failed to ${auditMetadata.action} ${auditMetadata.entityType}`,
            metadata: {
              method: request.method,
              url: request.url,
              duration: Date.now() - startTime,
            },
            ipAddress: request.ip || request.connection?.remoteAddress,
            userAgent: request.headers['user-agent'],
            requestId: request.id,
            severity: AuditSeverity.ERROR,
            success: false,
            errorMessage: error.message,
          });
        } catch (auditError) {
          console.error('Failed to log audit error:', auditError);
        }
        
        throw error;
      }),
    );
  }
}