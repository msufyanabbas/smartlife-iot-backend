import { Module, Global } from '@nestjs/common';
import { RedisService } from './redis.service';

@Global()
@Module({
  providers: [
    {
      provide: RedisService,
      useFactory: async (): Promise<RedisService> => {
        const service = new RedisService();
        await service.connect();
        return service;
      },
    },
  ],
  exports: [RedisService],
})
export class RedisModule {}