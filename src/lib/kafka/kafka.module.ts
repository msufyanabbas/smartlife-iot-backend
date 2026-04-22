import { Module, Global } from '@nestjs/common';
import { KafkaService } from './kafka.service';

@Global()
@Module({
  providers: [
    {
      provide: KafkaService,
      useFactory: async (): Promise<KafkaService> => {
        const service = new KafkaService();
        await service.initProducer();
        await service.createTopics();
        return service;
      },
    },
  ],
  exports: [KafkaService],
})
export class KafkaModule {}