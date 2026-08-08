// src/modules/schedules/schedule.module.ts
import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { SchedulesService } from './schedule.service';
import { SchedulesController } from './schedule.controller';
import { ScheduleExecutorService } from './schedule-executor.service';
import { ScheduleCronService } from './schedule-cron.service';

import { Schedule } from './entities/schedule.entity';
import { ScheduleExecution } from './entities/schedule-execution.entity';
import { Alarm, Device, Telemetry, User } from '@modules/index.entities';

import { DeviceCommandsModule } from '../device-commands/device-commands.module';
import { AttributesModule } from '../attributes/attributes.module';
import { RulesModule } from '../rules/rules.module';
import { NotificationsModule } from '../notifications/notifications.module';
import { AnalyticsModule } from '../analytics/analytics.module';

@Module({
  imports: [
    // Device / Telemetry / Alarm / User repositories are registered directly
    // rather than by importing DevicesModule, TelemetryModule etc. Those
    // modules pull in ProfilesModule and ProtocolsModule, and ProtocolsModule
    // imports AttributesModule — which this module also imports — closing a
    // cycle. Same idiom AttributesModule and AssetsModule already use.
    TypeOrmModule.forFeature([
      Schedule,
      ScheduleExecution,
      Device,
      Telemetry,
      Alarm,
      User,
    ]),

    // Behaviour is taken from the owning module's service in every case, so
    // the schedule executor never reimplements a downlink, an attribute
    // upsert, or a notification fan-out.
    DeviceCommandsModule, // DeviceCommandsService  → device_commands + Kafka
    AttributesModule, // AttributesService      → attribute upsert + MQTT push
    RulesModule, // RuleEngineService      → chain execution
    NotificationsModule, // NotificationsService   → channel dispatch
    AnalyticsModule, // AnalyticsService       → report payloads

    // EventEmitterModule.forRoot() used to be called here as well. AppModule
    // already registers it globally, and a second forRoot() builds a second
    // EventEmitter2 instance with its own subscriber loader — so events
    // emitted here would not necessarily reach listeners bound to the app's
    // emitter. AnalyticsModule carries the same note for the same reason.
    // ScheduleModule.forRoot() is likewise AppModule's job: each extra call
    // adds a ScheduleExplorer that re-registers every @Cron in the app.
  ],
  controllers: [SchedulesController],
  providers: [SchedulesService, ScheduleExecutorService, ScheduleCronService],
  exports: [SchedulesService, ScheduleExecutorService],
})
export class SchedulesModule {}
