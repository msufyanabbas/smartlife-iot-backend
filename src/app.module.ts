import { Module, ConfigModule, TypeOrmModule, CacheModule, BullModule, EventEmitterModule, ScheduleModule, ThrottlerModule, featureModules, MetricsModule } from '@modules/index.module';
import { ConfigService } from '@modules/index.service';
import { redisStore } from 'cache-manager-redis-yet';
import { configModules } from './config';
import { AppDataSource } from './database/data-source';
import { AppController } from './app.controller';
import { GuardsModule } from '@common/guards/guards.module';
import { InterceptorsModule } from './common/interceptors/interceptor.module';
import { MiddlewareConsumer, NestModule } from '@nestjs/common';
import { RequestIdMiddleware } from '@common/middleware/request-id.middleware';
import { ApiLoggingMiddleware } from '@common/middleware/api-logging.middleware';
import { APILog } from '@modules/api-monitoring/entities/api-log.entity';
import { validateEnv } from './config/env.validation';
import { envFilePaths } from './config/load-env';
import { envNumber, envString } from './config/env.utils';

@Module({
  imports: [
    // ConfigModule first: every module below reads from it, and `validate`
    // runs here — a bad environment now fails at boot with the offending
    // variables named, instead of surfacing as a connection error later.
    ConfigModule.forRoot({
      isGlobal: true,
      load: configModules,
      // Was pinned to '.env', which contradicted data-source.ts (it loaded
      // `.env.${NODE_ENV}`). A production deploy could therefore have TypeORM
      // reading .env.production while ConfigService read .env. Both now use the
      // same resolution order.
      envFilePath: envFilePaths(),
      ignoreEnvFile: false,
      cache: true,
      validate: validateEnv,
    }),

    // THROTTLE_TTL and THROTTLE_LIMIT were declared in the env and parsed by
    // app.config.ts, but forRoot took literals — so the rate limit was fixed at
    // 100 requests/60s no matter what was configured.
    //
    // Note the unit: @nestjs/throttler v5+ expects ttl in milliseconds, while
    // .env.production.example carried `THROTTLE_TTL=60` (seconds). Values below
    // 1000 are treated as seconds and converted, so both spellings work.
    ThrottlerModule.forRootAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (configService: ConfigService) => {
        const rawTtl = envNumber(configService.get<string>('THROTTLE_TTL'), 60000);
        const ttl = rawTtl < 1000 ? rawTtl * 1000 : rawTtl;

        return [
          {
            ttl,
            limit: envNumber(configService.get<string>('THROTTLE_LIMIT'), 100),
          },
        ];
      },
    }),
    TypeOrmModule.forRoot(AppDataSource.options),
    // ApiLoggingMiddleware injects this repository. Middleware is resolved from
    // the module that declares it, so forFeature must live here — not only in
    // ApiMonitoringModule.
    TypeOrmModule.forFeature([APILog]),
    CacheModule.registerAsync({
      isGlobal: true,
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: async (configService: ConfigService) => ({
        store: await redisStore({
          socket: {
            host: configService.get('REDIS_HOST'),
            port: envNumber(configService.get<string>('REDIS_PORT'), 6379),
            connectTimeout: envNumber(
              configService.get<string>('REDIS_CONNECT_TIMEOUT'),
              10000,
            ),
          },
          password: configService.get('REDIS_PASSWORD'),
          database: envNumber(configService.get<string>('REDIS_DB'), 0),
          // Namespacing cache entries keeps them from colliding with the keys
          // RedisService writes into the same database.
          keyPrefix: envString(
            configService.get<string>('REDIS_KEY_PREFIX'),
            'smartlife:',
          ),
          // REDIS_TTL is in seconds (as documented in the env file); the cache
          // store wants milliseconds. Hardcoding an hour here meant REDIS_TTL
          // had no effect on the HTTP cache at all.
          ttl: envNumber(configService.get<string>('REDIS_TTL'), 3600) * 1000,
        }),
      }),
    }),
    BullModule.forRootAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (configService: ConfigService) => ({
        redis: {
          host: configService.get('REDIS_HOST'),
          port: envNumber(configService.get<string>('REDIS_PORT'), 6379),
          password: configService.get('REDIS_PASSWORD'),
          // Bull needs its own logical database or its queue keys mix with
          // application cache keys and a cache flush drops queued jobs.
          db: envNumber(configService.get<string>('REDIS_QUEUE_DB'), 1),
        },
      }),
    }),
    EventEmitterModule.forRoot(),
    ScheduleModule.forRoot(),
    MetricsModule,
    GuardsModule,         // ✅ registers all APP_GUARD tokens
    InterceptorsModule,   // ✅ registers all APP_INTERCEPTOR tokens — in imports, not providers
    ...featureModules,
  ],
  controllers: [AppController],
  providers: [ApiLoggingMiddleware], // guards/interceptors stay owned by their
                                     // modules; middleware must be a provider
                                     // of the module that applies it
})
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer) {
    // Order matters: RequestIdMiddleware first so req.id exists by the time
    // ApiLoggingMiddleware stamps a row with it.
    consumer.apply(RequestIdMiddleware, ApiLoggingMiddleware).forRoutes('*');
  }
}