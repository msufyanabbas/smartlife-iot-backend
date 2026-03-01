// src/lib/mqtt/mqtt.module.ts
import { Module, Global } from '@nestjs/common';
import { MQTTService } from './mqtt.service';
import { KafkaModule } from '../kafka/kafka.module';

@Global()
@Module({
  imports: [KafkaModule],  // MQTT needs Kafka to forward messages
  providers: [MQTTService],
  exports: [MQTTService],
})
export class MQTTModule {}