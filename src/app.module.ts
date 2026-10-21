import { Module, ConfigModule, TypeOrmModule, CacheModule, BullModule, EventEmitterModule, ScheduleModule, ThrottlerModule, featureModules, MetricsModule } from '@modules/index.module';
import { ConfigService } from '@modules/index.service';
import { redisStore } from 'cache-manager-redis-yet';
import { configModules } from './config';
import { AppDataSource } from './database/data-source';
import { AppController } from './app.controller';
import { GuardsModule } from '@common/guards/guards.module';
import { InterceptorsModule } from './common/interceptors/interceptor.module';
import { Logger, MiddlewareConsumer, NestModule } from '@nestjs/common';
import { RequestIdMiddleware } from '@common/middleware/request-id.middleware';
import { ApiLoggingMiddleware } from '@common/middleware/api-logging.middleware';
import { APILog } from '@modules/api-monitoring/entities/api-log.entity';
import { validateEnv } from './config/env.validation';
import { envFilePaths } from './config/load-env';
import { envNumber, envString } from './config/env.utils';

const cacheLogger = new Logger('CacheModule');

/**
 * Build the Redis-backed HTTP cache store, or `undefined` if Redis cannot be
 * reached.
 *
 * Returning `undefined` rather than throwing is the whole point — see the
 * comment at the `CacheModule.registerAsync` call site.
 */
async function buildRedisCacheStore(
  configService: ConfigService,
): Promise<unknown | undefined> {
  try {
    return await redisStore({
      socket: {
        host: configService.get('REDIS_HOST'),
        port: envNumber(configService.get<string>('REDIS_PORT'), 6379),
        connectTimeout: envNumber(
          configService.get<string>('REDIS_CONNECT_TIMEOUT'),
          10000,
        ),
        // Without this, node-redis retries forever with its default backoff
        // and the factory never settles — the boot hangs instead of failing,
        // which is harder to diagnose than either outcome.
        reconnectStrategy: (retries: number) =>
          retries > 5 ? false : Math.min(retries * 200, 2000),
      },
      password: configService.get('REDIS_PASSWORD'),
      database: envNumber(configService.get<string>('REDIS_DB'), 0),
      // ── Namespaces, and why this one needed its own ────────────────────
      //
      // Three clients share this Redis deployment:
      //
      //   db 0, prefix `smartlife:`        RedisService (ioredis keyPrefix)
      //   db 0, prefix `smartlife:cache:`  this cache-manager store
      //   db 1, no prefix                  Bull (REDIS_QUEUE_DB)
      //
      // Bull is separated by database, which is what stops a cache flush from
      // dropping queued jobs. The other two share db 0, and until recently
      // they shared `smartlife:` as well — so a cache-manager entry for the
      // logical key `session:x` and the session RedisService writes at
      // `session:x` were the SAME physical key. Nothing collided only because
      // nothing injects CACHE_MANAGER today; the first route to add
      // `@UseInterceptors(CacheInterceptor)` on a path whose key happened to
      // match would have started overwriting live sessions with cached
      // response bodies.
      //
      // `:cache:` makes the two disjoint by construction rather than by
      // nobody having used one of them yet. RedisService's own prefix never
      // contains `cache:` — `RedisService.keys()` is the only thing that
      // enumerates, and it enumerates within its own prefix.
      keyPrefix:
        envString(
          configService.get<string>('REDIS_KEY_PREFIX'),
          'smartlife:',
        ) + 'cache:',
      // REDIS_TTL is in seconds (as documented in the env file); the cache
      // store wants milliseconds. Hardcoding an hour here meant REDIS_TTL had
      // no effect on the HTTP cache at all.
      ttl: envNumber(configService.get<string>('REDIS_TTL'), 3600) * 1000,
    });
  } catch (error) {
    cacheLogger.error(
      'Could not reach Redis for the HTTP response cache — falling back to ' +
        `the in-memory store: ${(error as Error).message}. The application is ` +
        'starting; the cache is now per-replica, so once CacheInterceptor is ' +
        'in use two replicas may serve different cached bodies. Fix Redis and ' +
        'restart to restore a shared cache.',
    );
    return undefined;
  }
}

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
      // ── Why the store is resolved defensively ───────────────────────────
      //
      // `store: await redisStore(...)` rejected the provider factory when
      // Redis was unreachable, and a rejected factory makes Nest abort the
      // whole DI graph before `app.listen()`. So a Redis that was down, or
      // simply not up yet, meant NO application: no HTTP server, no /health,
      // and a `connect ECONNREFUSED 127.0.0.1:6379` with nothing naming the
      // cache as the cause.
      //
      // That is the same shape that was fixed for Kafka (§11a) — and it was
      // worse here, because `CACHE_MANAGER` currently has **zero consumers**.
      // Nothing in the application injects it. The platform refused to start
      // over a cache no code reads.
      //
      // Falling back to the in-memory store keeps the HTTP cache local to the
      // replica, which is a real downgrade once `CacheInterceptor` is actually
      // used — so it is logged loudly rather than passed over. It is the right
      // trade either way: a per-replica cache serves requests, and a failed
      // boot serves none.
      useFactory: async (configService: ConfigService) => {
        const store = await buildRedisCacheStore(configService);
        return store ? { store } : {};
      },
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