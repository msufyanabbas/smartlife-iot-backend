import { forwardRef, Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { BullModule } from '@nestjs/bull';
import { TelemetryController } from './telemetry.controller';
import { TelemetryService } from './telemetry.service';
import { TelemetryConsumer } from './telemetry.consumer';
import { TelemetryProcessor } from './processors/telemetry.processor';
import { Telemetry } from './entities/telemetry.entity';
import { TelemetryRollup } from './entities/telemetry-rollup.entity';
import { TelemetryRollupService } from './telemetry-rollup.service';
import { TelemetryRetentionService } from './telemetry-retention.service';
import { TelemetryMaintenanceService } from './telemetry-maintenance.service';
import { Subscription } from '@modules/subscriptions/entities/subscription.entity';
import { KafkaModule } from '@/lib/kafka/kafka.module';
import { RedisModule } from '@/lib/redis/redis.module';
import { AutomationModule } from '@modules/automation/automation.module';
import { WebsocketModule } from '@modules/websocket/websocket.module';
import { AlarmsModule } from '@modules/alarms/alarms.module';
import { ProfilesModule } from '@modules/profiles/profiles.module';
import { IntegrationsModule } from '@modules/integrations/integrations.module';
import { Device } from '../index.entities';

@Module({
  imports: [
    // Subscription is registered here rather than by importing
    // SubscriptionsModule: TelemetryRetentionService only reads
    // `limits.dataRetentionDays`, and FloorPlansService already reads
    // subscription limits the same way to avoid a module cycle.
    TypeOrmModule.forFeature([
      Telemetry,
      TelemetryRollup,
      Device,
      Subscription,
    ]),
    KafkaModule,
    RedisModule,
    // exports AutomationService -> TelemetryService calls
    // evaluateTelemetryTriggers() on the HTTP ingestion path, which skips Kafka
    // and therefore never reaches AutomationConsumer.
    forwardRef(() => AutomationModule),
    WebsocketModule,
    AlarmsModule, // exports AlarmsService → needed by TelemetryProcessor
    ProfilesModule, // exports ProfileAlarmService → device-profile alarm rules
    // exports IntegrationDispatchService → outbound fan-out to external systems.
    // No forwardRef needed: IntegrationsModule imports only TypeOrmModule and
    // HttpModule, so there is no cycle back to TelemetryModule.
    IntegrationsModule,
    // The queue TelemetryProcessor consumes. It was already registered — what
    // was missing until TelemetryMaintenanceService was added is anything that
    // produces onto it.
    BullModule.registerQueue({ name: 'telemetry' }),
  ],
  controllers: [TelemetryController],
  providers: [
    TelemetryService,
    TelemetryConsumer,
    TelemetryProcessor,
    TelemetryRollupService,
    TelemetryRetentionService,
    // The @Cron producer. ScheduleModule.forRoot() in AppModule is what makes
    // its decorators live, exactly as for IntegrationEventsService.prune() and
    // DevicesService.checkOfflineDevices().
    TelemetryMaintenanceService,
  ],
  exports: [
    TelemetryService,
    TelemetryRollupService,
    TelemetryRetentionService,
  ],
})
export class TelemetryModule {}
