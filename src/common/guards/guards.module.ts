// src/common/guards/guards.module.ts
// This module exists for one reason: PermissionGuard uses @InjectRepository()
// which requires the entity repositories to be available via TypeORM.
// Rather than importing those repositories directly into AppModule, we
// encapsulate all guard dependencies here and import just this one module.
//
import { Global, Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
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
import { SubscriptionsModule } from '@/modules/index.module';

@Global() // Makes exported providers available everywhere without re-importing
@Module({
  imports: [
    // PermissionGuard needs User + Customer repositories
    // SubscriptionGuard needs SubscriptionsService which needs Subscription + Tenant
    TypeOrmModule.forFeature([User, Customer, Subscription, Tenant]),
    SubscriptionsModule
  ],
  providers: [
    // All guards as plain providers (not APP_GUARD — that happens in AppModule)
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
  exports: [
    // Export all guards so they can be used with @UseGuards() in feature modules
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
export class GuardsModule {}