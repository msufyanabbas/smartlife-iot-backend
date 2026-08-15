// src/common/interceptors/interceptors.module.ts
import { Global, Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { APP_INTERCEPTOR } from '@nestjs/core';
import { APILog } from '@modules/index.entities'; // + whatever else is needed

import {
    ApiLoggingInterceptor,
    MetricsInterceptor,
    AuditInterceptor,
    UsageTrackingInterceptor,
} from './index.interceptor';
import { NotificationInterceptor } from './notification.interceptor';
import { AuditModule, MetricsModule, NotificationsModule } from '@/modules/index.module';

@Global()
@Module({
    imports: [
        TypeOrmModule.forFeature([
            APILog,
            // Audit entity if AuditInterceptor needs one
            // Add every entity your interceptors @InjectRepository()
        ]),
        MetricsModule,
        AuditModule,
        NotificationsModule

    ],
    providers: [
        // Writes one api_logs row per request that reaches a handler.
        // Requests rejected by a guard are covered by ApiLoggingMiddleware
        // (registered in AppModule) — interceptors never see those.
        { provide: APP_INTERCEPTOR, useClass: ApiLoggingInterceptor },
        { provide: APP_INTERCEPTOR, useClass: MetricsInterceptor },
        { provide: APP_INTERCEPTOR, useClass: AuditInterceptor },
        { provide: APP_INTERCEPTOR, useClass: NotificationInterceptor },
        { provide: APP_INTERCEPTOR, useClass: UsageTrackingInterceptor },
    ],
})
export class InterceptorsModule { }