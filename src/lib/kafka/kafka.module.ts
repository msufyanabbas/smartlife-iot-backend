import { Module, Global } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { KafkaService } from './kafka.service';

@Global()
@Module({
  imports: [ConfigModule],
  providers: [
    {
      provide: KafkaService,
      // ConfigService is injected rather than the service reading process.env
      // itself, so the 'kafka' namespace (and its validation) is the single
      // source of truth for broker settings.
      inject: [ConfigService],
      useFactory: async (
        configService: ConfigService,
      ): Promise<KafkaService> => {
        const service = new KafkaService(configService);
        await service.initProducer();
        await service.createTopics();
        return service;
      },
    },
  ],
  exports: [KafkaService],
})
export class KafkaModule {}
