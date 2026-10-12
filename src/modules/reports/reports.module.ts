import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ReportTemplate } from './entities/report-template.entity';
import { ReportExecution } from './entities/report-execution.entity';
import { Device } from '@modules/devices/entities/device.entity';
import { Alarm } from '@modules/alarms/entities/alarm.entity';
import { User } from '@modules/users/entities/user.entity';
import { TelemetryModule } from '@modules/telemetry/telemetry.module';
import { AnalyticsModule } from '@modules/analytics/analytics.module';
import { AuditModule } from '@modules/audit/audit.module';
import { MailModule } from '@modules/mail/mail.module';
import { ReportsController } from './reports.controller';
import { ReportsService } from './reports.service';
import { ReportGeneratorService } from './report-generator.service';
import { ReportSchedulerService } from './report-scheduler.service';

/**
 * A report is a declarative query over services that already exist, so this
 * module imports them rather than reimplementing their queries:
 *
 * - `TelemetryModule` → `TelemetryService.getTimeSeries/getAggregated/getStatistics`
 * - `AnalyticsModule` → `AnalyticsService.getDeviceAnalytics`
 * - `AuditModule`     → `AuditService.findAll`, with its own role-based filtering
 * - `MailModule`      → scheduled delivery
 *
 * None of the four imports this module, so no cycle. `Device`, `Alarm` and
 * `User` are registered as repositories instead of importing their modules:
 * the only queries written here are the tenant-scoped entity SELECTs that
 * decide which rows a source runs over, and `DevicesModule` sits downstream of
 * `TelemetryModule` closely enough that importing it would risk a cycle. Same
 * approach `AnalyticsModule` and `FloorPlansModule` take.
 *
 * `ScheduleModule.forRoot()` is NOT called here — `AppModule` already
 * registers it, and a second `forRoot()` builds a second explorer that
 * re-registers every `@Cron` in the application, which is the duplicate
 * registration that was removed from `AnalyticsModule` and `SchedulesModule`.
 */
@Module({
  imports: [
    TypeOrmModule.forFeature([
      ReportTemplate,
      ReportExecution,
      Device,
      Alarm,
      User,
    ]),
    TelemetryModule,
    AnalyticsModule,
    AuditModule,
    MailModule,
  ],
  controllers: [ReportsController],
  providers: [ReportsService, ReportGeneratorService, ReportSchedulerService],
  exports: [ReportsService, ReportGeneratorService],
})
export class ReportsModule {}
