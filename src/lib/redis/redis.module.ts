// src/lib/redis/redis.module.ts
import { Module, Global } from '@nestjs/common';
import { RedisService } from './redis.service';

@Global()
@Module({
  providers: [
    {
      provide: 'REDIS_SERVICE',
      useFactory: async () => {
        const service = new RedisService();
        await service.connect();
        return service;
      },
    },
    {
      provide: RedisService,
      useFactory: (redis: RedisService) => redis,
      inject: ['REDIS_SERVICE'],
    },
  ],
  exports: ['REDIS_SERVICE', RedisService],  
})
export class RedisModule {}