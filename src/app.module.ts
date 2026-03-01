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
import { redisStore } from 'cache-manager-redis-yet';
import { configModules } from './config';
import { APP_GUARD, APP_INTERCEPTOR } from '@nestjs/core';
import { AppDataSource } from './database/data-source';
import { AppController } from './app.controller';
import { AuditInterceptor, MetricsInterceptor } from './common/interceptors/index.interceptor';
import { UsageTrackingInterceptor } from './common/interceptors/index.interceptor';
// Guards — imported from the barrel, not directly from individual files
import {
  CustomThrottlerGuard,
  JwtAuthGuard,
  RolesGuard,
  TenantIsolationGuard,
  SubscriptionGuard,
  FeatureLimitGuard,
  PermissionGuard,
  SubscriptionLimitGuard,
} from '@common/guards/index.guards';
// GuardsModule provides repository dependencies for guards that need them
import { GuardsModule } from '@common/guards/guards.module';
import { NotificationInterceptor } from './common/interceptors/notification.interceptor';
import { MiddlewareConsumer, NestModule } from '@nestjs/common';
import { RequestIdMiddleware } from '@common/middleware/request-id.middleware';

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
  useFactory: async (configService: ConfigService) => ({
    store: await redisStore({
      socket: {
        host: configService.get('REDIS_HOST'),
        port: configService.get('REDIS_PORT'),
      },
      password: configService.get('REDIS_PASSWORD'),
      database: configService.get('REDIS_DB', 0),
      ttl: 60 * 60 * 1000, // milliseconds (1 hour)
    }),
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

    // ── Guards Module ──────────────────────────────────────────────────────
    // Provides repository dependencies required by PermissionGuard and
    // SubscriptionGuard. Must be imported before APP_GUARD providers resolve.
    GuardsModule,

    // Feature Modules
    ...featureModules,
  ],
  controllers: [AppController],
  providers: [
    // ══════════════════════════════════════════════════════════════════════
    // GLOBAL GUARDS — registered in execution order (top = first to run)
    //
    // Every HTTP request passes through ALL of these in order.
    // If any guard returns false or throws, the request is rejected
    // and no subsequent guards or handlers run.
    //
    // Routes decorated with @Public() skip JwtAuthGuard (and therefore
    // all subsequent guards, since user will be undefined).
    // ══════════════════════════════════════════════════════════════════════

    // Step 1 — Rate limiting
    // Cheapest check first. Uses user.id if authenticated, IP if not.
    // No DB calls.
    {
      provide: APP_GUARD,
      useClass: CustomThrottlerGuard,
    },

    // Step 2 — JWT authentication
    // Validates Bearer token, populates req.user from JWT payload.
    // Routes with @Public() bypass this entirely.
    {
      provide: APP_GUARD,
      useClass: JwtAuthGuard,
    },

    // Step 3 — Role check
    // Reads @Roles() decorator, checks user.role enum.
    // No DB calls — pure enum comparison on req.user.role.
    {
      provide: APP_GUARD,
      useClass: RolesGuard,
    },

    // Step 4 — Tenant isolation
    // Sets req.tenantFilter = { tenantId: user.tenantId }.
    // Rejects requests where URL tenantId doesn't match user's tenant.
    // No DB calls — reads from req.user.tenantId (JWT payload).
    {
      provide: APP_GUARD,
      useClass: TenantIsolationGuard,
    },

    // Step 5 — Subscription load + health + plan gate
    // One DB call: loads subscription by tenantId, caches as req.subscription.
    // ALWAYS runs even without @RequireSubscription() so that downstream
    // guards (FeatureLimitGuard, SubscriptionLimitGuard) have the cache.
    // Also checks: subscription is active, trial not expired, plan level.
    {
      provide: APP_GUARD,
      useClass: SubscriptionGuard,
    },

    // Step 6 — Feature flag check
    // Reads @RequireFeature('floorPlans'), checks req.subscription.features.
    // Zero DB calls — uses req.subscription cached in Step 5.
    {
      provide: APP_GUARD,
      useClass: FeatureLimitGuard,
    },

    // Step 7 — Fine-grained permission check
    // Reads @RequirePermissions('devices:create').
    // One DB call: loads user roles + permissions + direct permissions.
    // Intersects with customer.grantedPermissions for customer-scoped users.
    // Bypasses SUPER_ADMIN and TENANT_ADMIN (they have full access by role).
    {
      provide: APP_GUARD,
      useClass: PermissionGuard,
    },

    // Step 8 — Subscription quota check
    // Reads @RequireSubscriptionLimit({ resource: ResourceType.DEVICE }).
    // Zero DB calls — uses req.subscription cached in Step 5.
    // Checks usage counters against plan limits.
    {
      provide: APP_GUARD,
      useClass: SubscriptionLimitGuard,
    },

    // ══════════════════════════════════════════════════════════════════════
    // GLOBAL INTERCEPTORS
    // Run after guards, wrap the handler execution.
    // ══════════════════════════════════════════════════════════════════════
    {
      provide: APP_INTERCEPTOR,
      useClass: MetricsInterceptor
    },
    {
      provide: APP_INTERCEPTOR,
      useClass: AuditInterceptor,
    }, 
    {
      provide: APP_INTERCEPTOR,
      useClass: NotificationInterceptor
    },
    {
      provide: APP_INTERCEPTOR,
      useClass: UsageTrackingInterceptor
    }
  ],
})
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer) {
    consumer.apply(RequestIdMiddleware).forRoutes('*');
  }
}