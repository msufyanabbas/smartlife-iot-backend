// src/modules/telemetry/telemetry.module.ts
import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { TelemetryController } from './telemetry.controller';
import { TelemetryService } from './telemetry.service';
import { TelemetryConsumer } from './telemetry.consumer';
import { Telemetry } from './entities/telemetry.entity';
import { KafkaModule } from '@/lib/kafka/kafka.module';
import { AutomationModule } from '@modules/automation/automation.module';  
import { WebsocketModule } from '@modules/index.module';

@Module({
  imports: [
    TypeOrmModule.forFeature([Telemetry]),
    KafkaModule,
    AutomationModule,  
    WebsocketModule
  ],
  controllers: [TelemetryController],
  providers: [
    TelemetryService,
    TelemetryConsumer,
  ],
  exports: [TelemetryService],
})
export class TelemetryModule {}