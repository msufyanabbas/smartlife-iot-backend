// src/modules/automations/automation.module.ts
import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AutomationController } from './automation.controller';
import { AutomationService } from './automation.service';
import { AutomationProcessor } from './automation.processor';
import { AutomationConsumer } from './automation.consumer';
import { Automation, Device, Telemetry } from '@modules/index.entities';
import { KafkaModule } from '@/lib/kafka/kafka.module';

@Module({
  imports: [
    TypeOrmModule.forFeature([Automation, Device, Telemetry]),
    KafkaModule,  // ← Import Kafka
  ],
  controllers: [AutomationController],
  providers: [
    AutomationService,
    AutomationProcessor,   // ← Add Processor
    AutomationConsumer,    // ← Add Consumer
  ],
  exports: [AutomationService, AutomationProcessor],
})
export class AutomationModule {}