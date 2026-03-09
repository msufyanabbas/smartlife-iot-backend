// src/common/guards/guards.module.ts
// This module exists for one reason: PermissionGuard uses @InjectRepository()
// which requires the entity repositories to be available via TypeORM.
// Rather than importing those repositories directly into AppModule, we
// encapsulate all guard dependencies here and import just this one module.
//
import { Global, Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { TypeOrmModule } from '@nestjs/typeorm';
import { JwtModule } from '@nestjs/jwt';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { User, Customer, Subscription, Tenant } from '@modules/index.entities';

// Guards
import { JwtAuthGuard } from './jwt-auth.guard';
import { RolesGuard } from './roles.guard';
import { TenantIsolationGuard } from './tenant-isolation.guard';
import { SubscriptionGuard } from './subscription.guard';
import { FeatureLimitGuard } from './feature-limit.guard';
import { PermissionGuard } from './permission.guard';
import { SubscriptionLimitGuard } from './subscription-limit.guard';
import { CustomerAccessGuard } from './customer-access.guard';
import { WsJwtGuard } from './ws-jwt.guard';
import { CustomThrottlerGuard } from './throttle.guard';
import { SubscriptionsModule } from '@modules/subscriptions/subscriptions.module';

@Global()
@Module({
  imports: [
    // PermissionGuard needs User + Customer repositories
    // SubscriptionGuard needs SubscriptionsService which needs Subscription + Tenant
    TypeOrmModule.forFeature([User, Customer, Subscription, Tenant]),
    SubscriptionsModule,
    // FIX: use ConfigService properly via registerAsync + imports: [ConfigModule]
    JwtModule.registerAsync({
      imports: [ConfigModule],
      useFactory: (configService: ConfigService) => ({
        secret: configService.get<string>('JWT_SECRET'),
        signOptions: {
          expiresIn: configService.get<string>('JWT_EXPIRES_IN', '15m') as any,
        },
      }),
      inject: [ConfigService],
    }),
  ],
  providers: [
    // ── Guard instances ────────────────────────────────────────────────────
    // Registered as plain providers AND as APP_GUARD here so that NestJS
    // resolves their @InjectRepository() deps in THIS module's context,
    // where the TypeOrmModule.forFeature() repositories are available.
    JwtAuthGuard,
    RolesGuard,
    TenantIsolationGuard,
    SubscriptionGuard,
    FeatureLimitGuard,
    PermissionGuard,
    SubscriptionLimitGuard,
    CustomerAccessGuard,
    WsJwtGuard,
    CustomThrottlerGuard,

    // ── Global guard execution order ───────────────────────────────────────
    // Step 1 — Rate limiting (cheapest, no DB calls)
    { provide: APP_GUARD, useClass: CustomThrottlerGuard },
    // Step 2 — JWT authentication
    { provide: APP_GUARD, useClass: JwtAuthGuard },
    // Step 3 — Role check (pure enum comparison, no DB)
    { provide: APP_GUARD, useClass: RolesGuard },
    // Step 4 — Tenant isolation (reads from JWT payload, no DB)
    { provide: APP_GUARD, useClass: TenantIsolationGuard },
    { provide: APP_GUARD, useClass: CustomerAccessGuard },
    // Step 5 — Subscription load + health + plan gate (1 DB call, caches req.subscription)
    { provide: APP_GUARD, useClass: SubscriptionGuard },
    // Step 6 — Feature flag check (uses req.subscription cache, no DB)
    { provide: APP_GUARD, useClass: FeatureLimitGuard },
    // Step 7 — Fine-grained permission check (1 DB call for roles/permissions)
    { provide: APP_GUARD, useClass: PermissionGuard },
    // Step 8 — Subscription quota check (uses req.subscription cache, no DB)
    { provide: APP_GUARD, useClass: SubscriptionLimitGuard },
  ],
  exports: [
    // Export so guards can be used with @UseGuards() in feature modules
    JwtAuthGuard,
    RolesGuard,
    TenantIsolationGuard,
    SubscriptionGuard,
    FeatureLimitGuard,
    PermissionGuard,
    SubscriptionLimitGuard,
    CustomerAccessGuard,
    WsJwtGuard,
  ],
})
export class GuardsModule { }