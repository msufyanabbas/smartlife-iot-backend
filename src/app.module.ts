import {
  Module,
  ConfigModule,
  TypeOrmModule,
  CacheModule,
  BullModule,
  EventEmitterModule,
  ScheduleModule,
  ThrottlerModule,
  featureModules,
  MetricsModule
} from '@modules/index.module';
import { ConfigService } from '@modules/index.service';
import * as redisStore from 'cache-manager-redis-store';
import { configModules } from './config';
import { CustomThrottlerGuard } from '@common/guards/throttle.guard';
import { APP_GUARD, APP_INTERCEPTOR } from '@nestjs/core';
import { AppDataSource } from './database/data-source';
import { AppController } from './app.controller';
import { AuditInterceptor, MetricsInterceptor } from './common/interceptors/index.interceptor';
import { Audit } from './common/decorators/audit.decorator';
import { SubscriptionLimitGuard } from './common/guards/subscription-limit.guard';
import { UsageTrackingInterceptor } from './common/interceptors/usage-tracking.interceptor';

@Module({
  imports: [
    ThrottlerModule.forRoot([
      {
        ttl: 60000, // Time window in milliseconds (1 minute)
        limit: 100, // Max requests per window
      },
    ]),

    // Configuration
    ConfigModule.forRoot({
      isGlobal: true,
      load: configModules,
      envFilePath: '.env',
      ignoreEnvFile: false,
      cache: true,
    }),

    // Database (PostgreSQL)
    TypeOrmModule.forRoot(AppDataSource.options),

    // Cache (Redis)
    CacheModule.registerAsync({
      isGlobal: true,
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (configService: ConfigService) => ({
        store: redisStore,
        host: configService.get('REDIS_HOST'),
        port: configService.get('REDIS_PORT'),
        password: configService.get('REDIS_PASSWORD'),
        db: configService.get('REDIS_DB', 0),
        ttl: 60 * 60, // 1 hour default
      }),
    }),

    // Queue (Bull)
    BullModule.forRootAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (configService: ConfigService) => ({
        redis: {
          host: configService.get('REDIS_HOST'),
          port: configService.get('REDIS_PORT'),
          password: configService.get('REDIS_PASSWORD'),
        },
      }),
    }),

    // Event Emitter
    EventEmitterModule.forRoot(),

    // Scheduler
    ScheduleModule.forRoot(),

    // Metrics Module ← ADD THIS
    MetricsModule,

    // Feature Modules
    ...featureModules,
  ],
  controllers: [AppController],
  providers: [
    {
      provide: APP_GUARD,
      useClass: CustomThrottlerGuard,
    },
    {
      provide: APP_INTERCEPTOR,
      useClass: MetricsInterceptor
    },
    {
      provide: APP_INTERCEPTOR,
      useClass: AuditInterceptor,
    }, 
    // {
    //   provide: APP_GUARD,
    //   useClass: SubscriptionLimitGuard
    // },
    {
      provide: APP_INTERCEPTOR,
      useClass: UsageTrackingInterceptor
    }
  ],
})
export class AppModule {}