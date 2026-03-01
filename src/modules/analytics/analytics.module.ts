import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ScheduleModule } from '@nestjs/schedule';
import { AnalyticsController } from './analytics.controller';
import { AnalyticsService } from './analytics.service';
import { Analytics } from './entities/analytics.entity';
import { Device } from '../devices/entities/device.entity';
import { Telemetry } from '../telemetry/entities/telemetry.entity';
import { Alarm } from '../alarms/entities/alarm.entity';
import { User } from '../users/entities/user.entity';
import { Tenant } from '../index.entities';

@Module({
  imports: [
    TypeOrmModule.forFeature([Analytics, Device, Telemetry, Alarm, User, Tenant]),
    ScheduleModule.forRoot(),
  ],
  controllers: [AnalyticsController],
  providers: [AnalyticsService],
  exports: [AnalyticsService],
})
export class AnalyticsModule { }
