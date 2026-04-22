import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { BullModule } from '@nestjs/bull';
import { TelemetryController } from './telemetry.controller';
import { TelemetryService } from './telemetry.service';
import { TelemetryConsumer } from './telemetry.consumer';
import { TelemetryProcessor } from './processors/telemetry.processor';
import { Telemetry } from './entities/telemetry.entity';
import { KafkaModule } from '@/lib/kafka/kafka.module';
import { RedisModule } from '@/lib/redis/redis.module';
import { AutomationModule } from '@modules/automation/automation.module';
import { WebsocketModule } from '@modules/websocket/websocket.module';
import { AlarmsModule } from '@modules/alarms/alarms.module';
import { Device } from '../index.entities';

@Module({
  imports: [
    TypeOrmModule.forFeature([Telemetry, Device]),
    KafkaModule,
    RedisModule,
    AutomationModule,  // must export AutomationProcessor
    WebsocketModule,
    AlarmsModule,      // exports AlarmsService → needed by TelemetryProcessor
    BullModule.registerQueue({ name: 'telemetry' }),
  ],
  controllers: [TelemetryController],
  providers: [
    TelemetryService,
    TelemetryConsumer,
    TelemetryProcessor,
  ],
  exports: [TelemetryService],
})
export class TelemetryModule {}