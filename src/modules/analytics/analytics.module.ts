// src/modules/analytics/analytics.module.ts
import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ScheduleModule } from '@nestjs/schedule';
import { EventEmitterModule } from '@nestjs/event-emitter';

import { AnalyticsController } from './analytics.controller';
import { AnalyticsService }    from './analytics.service';

import { Analytics }           from './entities/analytics.entity';
import { DashboardViewLog }    from './entities/dashboard-view-log.entity';

import { Device }              from '@modules/devices/entities/device.entity';
import { Telemetry }           from '@modules/telemetry/entities/telemetry.entity';
import { Alarm }               from '@modules/alarms/entities/alarm.entity';
import { User }                from '@modules/users/entities/user.entity';
import { Tenant }              from '@modules/tenants/entities/tenant.entity';
import { Dashboard }           from '@modules/dashboards/entities/dashboard.entity';
import { EdgeMetricsSnapshot } from '@modules/edge/entities/edge-metrics-snapshot.entity';

@Module({
  imports: [
    TypeOrmModule.forFeature([
      Analytics,
      DashboardViewLog,
      Device,
      Telemetry,
      Alarm,
      User,
      Tenant,
      Dashboard,
      EdgeMetricsSnapshot,
    ]),
    ScheduleModule.forRoot(),
    EventEmitterModule.forRoot(),
  ],
  controllers: [AnalyticsController],
  providers:   [AnalyticsService],
  exports:     [AnalyticsService],
})
export class AnalyticsModule {}