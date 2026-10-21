import { Module, Global } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { RedisService } from './redis.service';
import { PermissionCacheService } from './permission-cache.service';
import { SubscriptionCacheService } from './subscription-cache.service';

/**
 * The factory is synchronous over the network, for the reason spelled out on
 * `RedisService.connect()`: it previously awaited the connect, and with
 * `lazyConnect: true` that is the call that opens the socket — so a Redis that
 * was down at boot took the whole process down with it.
 *
 * `PermissionCacheService` lives here rather than in `GuardsModule` because
 * both the guard that reads it and the services that invalidate it
 * (`UsersService`, `RolesService`) need the same instance, and those are in
 * unrelated modules. This module is `@Global`, so they get it by injection
 * without importing anything — and without `GuardsModule` having to be
 * imported by every module that can change a permission.
 */
@Global()
@Module({
  imports: [ConfigModule],
  providers: [
    {
      provide: RedisService,
      inject: [ConfigService],
      useFactory: (configService: ConfigService): RedisService => {
        const service = new RedisService(configService);
        service.connect();
        return service;
      },
    },
    PermissionCacheService,
    SubscriptionCacheService,
  ],
  exports: [RedisService, PermissionCacheService, SubscriptionCacheService],
})
export class RedisModule {}
