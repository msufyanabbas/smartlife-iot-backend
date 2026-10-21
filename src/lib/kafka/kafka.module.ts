import { Module, Global } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { KafkaService } from './kafka.service';

/**
 * The factory is deliberately **synchronous over the network**.
 *
 * It used to be `async` and to `await service.initProducer()` and
 * `await service.createTopics()`. Either of those rejecting — which is what an
 * unreachable broker does — rejected the provider factory, and Nest responds
 * to a rejected factory by aborting the entire DI graph and exiting. The
 * process died before `app.listen()`, so there was no HTTP server, no
 * `/health`, and nothing in the logs that named Kafka as the cause. Local work
 * without the full Docker stack was impossible.
 *
 * `bootstrap()` starts the connect and returns. The retry loop inside the
 * service owns it from there, so the broker coming up ten minutes later needs
 * no restart.
 */
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
      useFactory: (configService: ConfigService): KafkaService => {
        const service = new KafkaService(configService);
        service.bootstrap();
        return service;
      },
    },
  ],
  exports: [KafkaService],
})
export class KafkaModule {}
