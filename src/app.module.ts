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

@Module({
  imports: [
    ThrottlerModule.forRoot([{ ttl: 60000, limit: 100 }]),
    ConfigModule.forRoot({
      isGlobal: true,
      load: configModules,
      envFilePath: '.env',
      ignoreEnvFile: false,
      cache: true,
    }),
    TypeOrmModule.forRoot(AppDataSource.options),
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
          ttl: 60 * 60 * 1000,
        }),
      }),
    }),
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
    EventEmitterModule.forRoot(),
    ScheduleModule.forRoot(),
    MetricsModule,
    GuardsModule,         // ✅ registers all APP_GUARD tokens
    InterceptorsModule,   // ✅ registers all APP_INTERCEPTOR tokens — in imports, not providers
    ...featureModules,
  ],
  controllers: [AppController],
  providers: [],          // ✅ empty — guards and interceptors are owned by their modules
})
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer) {
    consumer.apply(RequestIdMiddleware).forRoutes('*');
  }
}