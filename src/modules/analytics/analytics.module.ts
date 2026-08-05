// src/modules/analytics/analytics.module.ts
import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { AnalyticsController } from './analytics.controller';
import { AnalyticsService } from './analytics.service';

import { Analytics } from './entities/analytics.entity';
import { DashboardViewLog } from './entities/dashboard-view-log.entity';

import { Device } from '@modules/devices/entities/device.entity';
import { Telemetry } from '@modules/telemetry/entities/telemetry.entity';
import { Alarm } from '@modules/alarms/entities/alarm.entity';
import { Asset } from '@modules/assets/entities/asset.entity';
import { APILog } from '@modules/api-monitoring/entities/api-log.entity';
import { Attribute } from '@modules/attributes/entities/attribute.entity';
import { DeviceCommand } from '@modules/device-commands/entities/device-commands.entity';
import { User } from '@modules/users/entities/user.entity';
import { Tenant } from '@modules/tenants/entities/tenant.entity';
import { Dashboard } from '@modules/dashboards/entities/dashboard.entity';
import { Subscription } from '@modules/subscriptions/entities/subscription.entity';

@Module({
  imports: [
    // Repositories only — no sibling feature module is imported, so this module
    // can never participate in a dependency cycle. Same approach as
    // DashboardsService/FloorPlansService reading WidgetType and Subscription.
    TypeOrmModule.forFeature([
      Analytics,
      DashboardViewLog,
      Device,
      Telemetry,
      Alarm,
      Asset,
      APILog,
      Attribute,
      DeviceCommand,
      User,
      Tenant,
      Dashboard,
      Subscription,
    ]),
    // EventEmitterModule.forRoot() used to be called here as well. AppModule
    // already registers it, and a second forRoot() builds a second emitter —
    // exactly the duplicate-registration bug that was removed for
    // ScheduleModule. RedisModule and KafkaModule are @Global(), so
    // RedisService and KafkaService need no import either.
  ],
  controllers: [AnalyticsController],
  providers: [AnalyticsService],
  exports: [AnalyticsService],
})
export class AnalyticsModule {}
