// src/database/seeds/schedule/schedule.seeder.ts
import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { ScheduleType } from '@common/enums/index.enum';
import { Schedule, User, Tenant } from '@modules/index.entities';
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
  ) { }

  async seed(): Promise<void> {
    this.logger.log('🌱 Starting schedule seeding...');

    // Check if schedules already exist
    const existingSchedules = await this.scheduleRepository.count();
    if (existingSchedules > 0) {
      this.logger.log(`⏭️  Schedules already seeded (${existingSchedules} records). Skipping...`);
      return;
    }

    // Fetch users and tenants
    const users = await this.userRepository.find({ take: 10 });
    const tenants = await this.tenantRepository.find({ take: 5 });

    if (users.length === 0 || tenants.length === 0) {
      this.logger.warn('⚠️  No users or tenants found. Please seed them first.');
      return;
    }

    // Helper functions
    const calculateNextRun = (hoursFromNow: number): Date => {
      const date = new Date();
      date.setHours(date.getHours() + hoursFromNow);
      return date;
    };

    const generateLastRun = (hoursAgo: number): Date => {
      const date = new Date();
      date.setHours(date.getHours() - hoursAgo);
      return date;
    };

    const schedules: Partial<Schedule>[] = [
      // ════════════════════════════════════════════════════════════════
      // 1. DAILY DEVICE PERFORMANCE REPORT
      // ════════════════════════════════════════════════════════════════
      {
        tenantId: users[0].tenantId || tenants[0].id,
        userId: users[0].id,
        name: 'Daily Device Performance Report',
        description: 'Automated daily report showing device performance metrics and uptime',
        type: ScheduleType.REPORT,
        schedule: '0 8 * * *', // Every day at 8 AM
        enabled: true,
        configuration: {
          reportType: 'device_performance',
          recipients: [users[0].email, 'reports@smartlife.sa'],
          format: 'pdf',
          includeCharts: true,
          includeDeviceList: true,
        },
        lastRun: generateLastRun(24),
        nextRun: calculateNextRun(0),
        executionCount: 45,
        failureCount: 2,
      },

      // ════════════════════════════════════════════════════════════════
      // 2. NIGHTLY DATABASE BACKUP
      // ════════════════════════════════════════════════════════════════
      {
        tenantId: users[0].tenantId || tenants[0].id,
        userId: users[0].id,
        name: 'Nightly Database Backup',
        description: 'Automated nightly backup of all system data',
        type: ScheduleType.BACKUP,
        schedule: '0 2 * * *', // Every day at 2 AM
        enabled: true,
        configuration: {
          retention: 30, // Keep backups for 30 days
          compression: true,
          incremental: false,
          destinations: ['local', 's3'],
        },
        lastRun: generateLastRun(24),
        nextRun: calculateNextRun(2),
        executionCount: 120,
        failureCount: 0,
      },

      // ════════════════════════════════════════════════════════════════
      // 3. OLD TELEMETRY DATA CLEANUP
      // ════════════════════════════════════════════════════════════════
      {
        tenantId: users[1]?.tenantId || users[0].tenantId || tenants[0].id,
        userId: users[1]?.id || users[0].id,
        name: 'Old Telemetry Data Cleanup',
        description: 'Remove telemetry data older than retention period',
        type: ScheduleType.CLEANUP,
        schedule: '0 4 * * *', // Every day at 4 AM
        enabled: true,
        configuration: {
          retention: 90, // Keep data for 90 days
          batchSize: 1000,
          archiveBeforeDelete: true,
        },
        lastRun: generateLastRun(24),
        nextRun: calculateNextRun(4),
        executionCount: 90,
        failureCount: 1,
        lastError: undefined,
      },

      // ════════════════════════════════════════════════════════════════
      // 4. MONTHLY DATA EXPORT
      // ════════════════════════════════════════════════════════════════
      {
        tenantId: users[1]?.tenantId || users[0].tenantId || tenants[0].id,
        userId: users[1]?.id || users[0].id,
        name: 'Monthly Data Export',
        description: 'Export all device data for archival purposes',
        type: ScheduleType.EXPORT,
        schedule: '0 1 1 * *', // 1st of every month at 1 AM
        enabled: true,
        configuration: {
          format: 'csv',
          recipients: [users[0].email, users[1]?.email || users[0].email],
          includeDevices: true,
          includeAlarms: true,
          includeTelemetry: true,
          compression: 'zip',
        },
        lastRun: generateLastRun(720), // 30 days ago
        nextRun: calculateNextRun(24),
        executionCount: 10,
        failureCount: 0,
      },

      // ════════════════════════════════════════════════════════════════
      // 5. WEEKLY ANALYTICS SUMMARY (DISABLED)
      // ════════════════════════════════════════════════════════════════
      {
        tenantId: users[2]?.tenantId || users[0].tenantId || tenants[0].id,
        userId: users[2]?.id || users[0].id,
        name: 'Weekly Analytics Summary',
        description: 'Weekly summary of system analytics and key metrics',
        type: ScheduleType.REPORT,
        schedule: '0 9 * * 1', // Every Monday at 9 AM
        enabled: false, // Disabled for testing
        configuration: {
          reportType: 'weekly_analytics',
          recipients: [users[0].email],
          format: 'pdf',
          includeTrends: true,
          includeComparisons: true,
          comparisonPeriod: 'previous_week',
        },
        lastRun: undefined, // Never run (disabled)
        nextRun: calculateNextRun(168), // Next Monday
        executionCount: 0,
        failureCount: 0,
      },
    ];

    // ════════════════════════════════════════════════════════════════
    // SAVE ALL SCHEDULES
    // ════════════════════════════════════════════════════════════════
    let createdCount = 0;

    for (const scheduleData of schedules) {
      try {
        // Check if schedule already exists
        const existing = await this.scheduleRepository.findOne({
          where: {
            name: scheduleData.name,
            tenantId: scheduleData.tenantId,
          },
        });

        if (existing) {
          this.logger.log(`⏭️  Schedule already exists: ${scheduleData.name}`);
          continue;
        }

        const schedule = this.scheduleRepository.create(scheduleData);
        await this.scheduleRepository.save(schedule);

        const statusTag = schedule.enabled ? '✅ ENABLED' : '⏸️  DISABLED';
        const overdueTag = schedule.isOverdue() ? '⏰ OVERDUE' : '';

        this.logger.log(
          `✅ Created schedule: ${scheduleData.name?.padEnd(35)} | ` +
          `Type: ${scheduleData.type?.padEnd(8)} | ` +
          `Cron: ${scheduleData.schedule?.padEnd(15)} | ` +
          `${statusTag} ${overdueTag}`,
        );
        createdCount++;
      } catch (error) {
        this.logger.error(
          `❌ Failed to seed schedule '${scheduleData.name}': ${error.message}`,
        );
      }
    }

    this.logger.log(
      `🎉 Schedule seeding complete! Created ${createdCount}/${schedules.length} schedules.`,
    );

    // ════════════════════════════════════════════════════════════════
    // SUMMARY STATISTICS
    // ════════════════════════════════════════════════════════════════
    const summary = {
      byType: {
        report: schedules.filter(s => s.type === ScheduleType.REPORT).length,
        backup: schedules.filter(s => s.type === ScheduleType.BACKUP).length,
        cleanup: schedules.filter(s => s.type === ScheduleType.CLEANUP).length,
        export: schedules.filter(s => s.type === ScheduleType.EXPORT).length,
      },
      enabled: schedules.filter(s => s.enabled).length,
      disabled: schedules.filter(s => !s.enabled).length,
      withLastRun: schedules.filter(s => s.lastRun).length,
      totalExecutions: schedules.reduce((sum, s) => sum + (s.executionCount || 0), 0),
      totalFailures: schedules.reduce((sum, s) => sum + (s.failureCount || 0), 0),
    };

    this.logger.log('\n📊 Schedule Seeding Summary:');
    this.logger.log(
      `   Types: ${summary.byType.report} reports, ${summary.byType.backup} backups, ` +
      `${summary.byType.cleanup} cleanups, ${summary.byType.export} exports`,
    );
    this.logger.log(`   Status: ${summary.enabled} enabled, ${summary.disabled} disabled`);
    this.logger.log(
      `   Executions: ${summary.totalExecutions} total (${summary.totalFailures} failures)`,
    );
    this.logger.log(`   History: ${summary.withLastRun} schedules have run before`);
  }
}