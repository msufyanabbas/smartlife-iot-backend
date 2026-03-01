// src/lib/kafka/kafka.module.ts
import { Module, Global } from '@nestjs/common';
import { KafkaService } from './kafka.service';

@Global()
@Module({
  providers: [
    {
      provide: 'KAFKA_SERVICE',
      useFactory: async () => {
        const service = new KafkaService();
        await service.initProducer();
        await service.createTopics();
        return service;
      },
    },
    {
      provide: KafkaService,
      useFactory: (kafka: KafkaService) => kafka,
      inject: ['KAFKA_SERVICE'],
    },
  ],
  exports: ['KAFKA_SERVICE', KafkaService],  
})
export class KafkaModule {}