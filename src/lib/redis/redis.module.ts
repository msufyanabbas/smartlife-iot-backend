import { Module, Global } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { RedisService } from './redis.service';

@Global()
@Module({
  imports: [ConfigModule],
  providers: [
    {
      provide: RedisService,
      inject: [ConfigService],
      useFactory: async (
        configService: ConfigService,
      ): Promise<RedisService> => {
        const service = new RedisService(configService);
        await service.connect();
        return service;
      },
    },
  ],
  exports: [RedisService],
})
export class RedisModule {}
