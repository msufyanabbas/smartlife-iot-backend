// src/database/seeds/schedule/schedule.seeder.ts
import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import {
  ScheduleActionType,
  ScheduleMaintenanceTask,
  ScheduleReportType,
  ScheduleTriggerType,
  UserRole,
} from '@common/enums/index.enum';
import { Schedule, User, Tenant } from '@modules/index.entities';
import { DEFAULT_SCHEDULE_TIMEZONE } from '@modules/schedules/entities/schedule.entity';
import { ISeeder } from '../seeder.interface';

@Injectable()
export class ScheduleSeeder implements ISeeder {
  private readonly logger = new Logger(ScheduleSeeder.name);

  constructor(
    @InjectRepository(Schedule)
    private readonly scheduleRepository: Repository<Schedule>,
    @InjectRepository(User)
    private readonly userRepository: Repository<User>,
    @InjectRepository(Tenant)
    private readonly tenantRepository: Repository<Tenant>,
  ) {}

  async seed(): Promise<void> {
    this.logger.log('🌱 Starting schedule seeding...');

    // Deterministic owner. The previous `find({ take: 10 })[0]` had no ORDER BY,
    // so Postgres was free to hand back a different user on every run — the
    // seeds then landed on an arbitrary account and, because schedules are
    // scoped by userId as well as tenantId, became invisible to the tenant
    // admin who went looking for them. Prefer the tenant's admin, oldest first.
    const owner =
      (await this.userRepository.findOne({
        where: { role: UserRole.TENANT_ADMIN },
        order: { createdAt: 'ASC' },
      })) ??
      (await this.userRepository.findOne({ order: { createdAt: 'ASC' } }));

    const tenants = await this.tenantRepository.find({ take: 1 });

    if (!owner || tenants.length === 0) {
      this.logger.warn(
        '⚠️  No users or tenants found. Please seed them first.',
      );
      return;
    }

    const tenantId = owner.tenantId || tenants[0].id;

    // Every seeded schedule ships DISABLED. Seeds run against real tenants,
    // and an armed DATA_MAINTENANCE schedule would soft-delete 90-day-old
    // telemetry the first time the cron fired — a destructive side effect
    // nobody asked for by running `npm run seed`. The tenant enables what it
    // wants, after using POST /schedules/:id/run to see what it does.
    const schedules: Array<Partial<Schedule>> = [
      {
        name: 'Daily Device Status Report',
        description: 'Send daily summary of device status at 8 AM Riyadh time',
        type: ScheduleTriggerType.CRON,
        cronExpression: '0 8 * * *',
        timezone: DEFAULT_SCHEDULE_TIMEZONE,
        enabled: false,
        actionType: ScheduleActionType.GENERATE_REPORT,
        actionConfig: {
          report: {
            reportType: ScheduleReportType.DEVICE_SUMMARY,
            timeRange: '24h',
            deliveryChannels: ['IN_APP'],
          },
        },
      },
      {
        name: 'Weekly Alarm Summary',
        description: 'Send weekly alarm summary every Monday at 9 AM',
        type: ScheduleTriggerType.CRON,
        cronExpression: '0 9 * * 1',
        timezone: DEFAULT_SCHEDULE_TIMEZONE,
        enabled: false,
        actionType: ScheduleActionType.GENERATE_REPORT,
        actionConfig: {
          report: {
            reportType: ScheduleReportType.ALARM_SUMMARY,
            timeRange: '7d',
            deliveryChannels: ['IN_APP'],
          },
        },
      },
      {
        name: 'Monthly Data Cleanup',
        description:
          'Archive telemetry older than 90 days on 1st of each month',
        type: ScheduleTriggerType.CRON,
        cronExpression: '0 1 1 * *',
        timezone: DEFAULT_SCHEDULE_TIMEZONE,
        enabled: false,
        actionType: ScheduleActionType.DATA_MAINTENANCE,
        actionConfig: {
          maintenance: {
            taskType: ScheduleMaintenanceTask.ARCHIVE_TELEMETRY,
            olderThanDays: 90,
          },
        },
      },
      {
        name: 'Hourly Stats Recalculation',
        description: 'Recalculate device message counts every hour',
        type: ScheduleTriggerType.CRON,
        cronExpression: '0 * * * *',
        timezone: DEFAULT_SCHEDULE_TIMEZONE,
        enabled: false,
        actionType: ScheduleActionType.DATA_MAINTENANCE,
        actionConfig: {
          maintenance: { taskType: ScheduleMaintenanceTask.RECALCULATE_STATS },
        },
      },
    ];

    let createdCount = 0;

    for (const data of schedules) {
      try {
        const existing = await this.scheduleRepository.findOne({
          where: { name: data.name, tenantId },
        });

        if (existing) {
          this.logger.log(`⏭️  Schedule already exists: ${data.name}`);
          continue;
        }

        const schedule = this.scheduleRepository.create({
          ...data,
          tenantId,
          userId: owner.id,
          createdBy: owner.id,
          runCount: 0,
          failCount: 0,
          // Left null on purpose. `nextRunAt` means "when the timer will next
          // fire", and a disabled schedule has no timer — `toggle()` fills it
          // in the moment an operator arms the schedule. Pre-computing a date
          // here would show a next run for something that is never going to
          // run, which is what the old seeder did.
          nextRunAt: null,
        });

        await this.scheduleRepository.save(schedule);

        this.logger.log(
          `✅ Created schedule: ${data.name?.padEnd(32)} | ` +
            `${data.actionType?.padEnd(18)} | ` +
            `Cron: ${data.cronExpression?.padEnd(12)} | ⏸️  DISABLED`,
        );
        createdCount++;
      } catch (error) {
        this.logger.error(
          `❌ Failed to seed schedule '${data.name}': ${(error as Error).message}`,
        );
      }
    }

    this.logger.log(
      `🎉 Schedule seeding complete! Created ${createdCount}/${schedules.length} schedules.`,
    );
    this.logger.log(
      '   All seeded schedules are DISABLED. Enable with POST /schedules/:id/toggle, ' +
        'or test one first with POST /schedules/:id/run.',
    );
  }
}
