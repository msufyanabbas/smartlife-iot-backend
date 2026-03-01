// src/common/interceptors/interceptors.module.ts
import { Global, Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { APP_INTERCEPTOR } from '@nestjs/core';
import { APILog } from '@modules/index.entities'; // + whatever else is needed

import {
    LoggingInterceptor,
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
        LoggingInterceptor,
        MetricsInterceptor,
        AuditInterceptor,
        NotificationInterceptor,
        UsageTrackingInterceptor,

        { provide: APP_INTERCEPTOR, useClass: LoggingInterceptor },
        { provide: APP_INTERCEPTOR, useClass: MetricsInterceptor },
        { provide: APP_INTERCEPTOR, useClass: AuditInterceptor },
        { provide: APP_INTERCEPTOR, useClass: NotificationInterceptor },
        { provide: APP_INTERCEPTOR, useClass: UsageTrackingInterceptor },
    ],
})
export class InterceptorsModule { }