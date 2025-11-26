import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { ScheduleType } from '@modules/schedules/entities/schedule.entity';
import { Schedule, User } from '@modules/index.entities';
import { ISeeder } from '../seeder.interface';

@Injectable()
export class ScheduleSeeder implements ISeeder {
  constructor(
    @InjectRepository(Schedule)
    private readonly scheduleRepository: Repository<Schedule>,
    @InjectRepository(User)
    private readonly userRepository: Repository<User>,
  ) {}

  async seed(): Promise<void> {
    // Fetch all users first
    const users = await this.userRepository.find({ take: 10 });

    if (users.length === 0) {
      console.log('⚠️  No users found. Please seed users first.');
      return;
    }

    // Helper function to get random item from array
    const getRandomItem = <T>(array: T[]): T => {
      return array[Math.floor(Math.random() * array.length)];
    };

    // Helper function to calculate next run based on cron
    const calculateNextRun = (hoursFromNow: number): Date => {
      const date = new Date();
      date.setHours(date.getHours() + hoursFromNow);
      return date;
    };

    // Helper function to generate last run
    const generateLastRun = (hoursAgo: number): Date => {
      const date = new Date();
      date.setHours(date.getHours() - hoursAgo);
      return date;
    };

    const schedules = [
      {
        name: 'Daily Device Performance Report',
        description:
          'Automated daily report showing device performance metrics and uptime',
        type: ScheduleType.REPORT,
        schedule: '0 8 * * *', // Every day at 8 AM
        enabled: true,
        configuration: {
          reportType: 'device_performance',
          recipients: [users[0].email, 'reports@example.com'],
          format: 'pdf',
        },
        lastRun: generateLastRun(24),
        nextRun: calculateNextRun(0),
        executionCount: 45,
        userId: users[0].id,
        tenantId: users[0].tenantId,
      },
      {
        name: 'Weekly Analytics Summary',
        description: 'Weekly summary of system analytics and key metrics',
        type: ScheduleType.REPORT,
        schedule: '0 9 * * 1', // Every Monday at 9 AM
        enabled: true,
        configuration: {
          reportType: 'weekly_analytics',
          recipients: [users[0].email, users[1]?.email || users[0].email],
          format: 'pdf',
        },
        lastRun: generateLastRun(168), // 7 days ago
        nextRun: calculateNextRun(24),
        executionCount: 12,
        userId: users[0].id,
        tenantId: users[0].tenantId,
      },
      {
        name: 'Nightly Database Backup',
        description: 'Automated nightly backup of all system data',
        type: ScheduleType.BACKUP,
        schedule: '0 2 * * *', // Every day at 2 AM
        enabled: true,
        configuration: {
          retention: 30, // Keep backups for 30 days
        },
        lastRun: generateLastRun(24),
        nextRun: calculateNextRun(2),
        executionCount: 120,
        userId: users[0].id,
        tenantId: users[0].tenantId,
      },
      {
        name: 'Weekly Backup',
        description: 'Weekly full system backup for disaster recovery',
        type: ScheduleType.BACKUP,
        schedule: '0 3 * * 0', // Every Sunday at 3 AM
        enabled: true,
        configuration: {
          retention: 90, // Keep backups for 90 days
        },
        lastRun: generateLastRun(168),
        nextRun: calculateNextRun(48),
        executionCount: 18,
        userId: users[1]?.id || users[0].id,
        tenantId: users[1]?.tenantId || users[0].tenantId,
      },
      {
        name: 'Old Telemetry Data Cleanup',
        description: 'Remove telemetry data older than retention period',
        type: ScheduleType.CLEANUP,
        schedule: '0 4 * * *', // Every day at 4 AM
        enabled: true,
        configuration: {
          retention: 90, // Keep data for 90 days
        },
        lastRun: generateLastRun(24),
        nextRun: calculateNextRun(4),
        executionCount: 90,
        userId: users[0].id,
        tenantId: users[0].tenantId,
      },
      {
        name: 'Temp Files Cleanup',
        description: 'Clean up temporary files and cache',
        type: ScheduleType.CLEANUP,
        schedule: '0 */6 * * *', // Every 6 hours
        enabled: true,
        configuration: {
          retention: 1, // Keep files for 1 day
        },
        lastRun: generateLastRun(6),
        nextRun: calculateNextRun(0),
        executionCount: 240,
        userId: users[0].id,
        tenantId: users[0].tenantId,
      },
      {
        name: 'Monthly Data Export',
        description: 'Export all device data for archival purposes',
        type: ScheduleType.EXPORT,
        schedule: '0 1 1 * *', // 1st of every month at 1 AM
        enabled: true,
        configuration: {
          format: 'csv',
          recipients: [users[0].email],
        },
        lastRun: generateLastRun(720), // 30 days ago
        nextRun: calculateNextRun(24),
        executionCount: 10,
        userId: users[1]?.id || users[0].id,
        tenantId: users[1]?.tenantId || users[0].tenantId,
      },
      {
        name: 'Alarm History Export',
        description: 'Export alarm history for compliance reporting',
        type: ScheduleType.EXPORT,
        schedule: '0 10 * * 5', // Every Friday at 10 AM
        enabled: true,
        configuration: {
          format: 'xlsx',
          recipients: [users[0].email, 'compliance@example.com'],
        },
        lastRun: generateLastRun(168),
        nextRun: calculateNextRun(72),
        executionCount: 25,
        userId: users[2]?.id || users[0].id,
        tenantId: users[2]?.tenantId || users[0].tenantId,
      },
      {
        name: 'Hourly System Health Report',
        description: 'Frequent health check report for critical systems',
        type: ScheduleType.REPORT,
        schedule: '0 * * * *', // Every hour
        enabled: true,
        configuration: {
          reportType: 'system_health',
          recipients: ['ops@example.com'],
          format: 'json',
        },
        lastRun: generateLastRun(1),
        nextRun: calculateNextRun(0),
        executionCount: 720,
        userId: getRandomItem(users).id,
        tenantId: getRandomItem(users).tenantId,
      },
      {
        name: 'Monthly Energy Consumption Report',
        description: 'Detailed monthly energy consumption and cost analysis',
        type: ScheduleType.REPORT,
        schedule: '0 9 1 * *', // 1st of every month at 9 AM
        enabled: true,
        configuration: {
          reportType: 'energy_consumption',
          recipients: [getRandomItem(users).email, 'energy@example.com'],
          format: 'pdf',
        },
        lastRun: generateLastRun(720),
        nextRun: calculateNextRun(48),
        executionCount: 6,
        userId: getRandomItem(users).id,
        tenantId: getRandomItem(users).tenantId,
      },
      {
        name: 'Device Firmware Update Check',
        description: 'Check for available firmware updates for all devices',
        type: ScheduleType.REPORT,
        schedule: '0 6 * * 1', // Every Monday at 6 AM
        enabled: false,
        configuration: {
          reportType: 'firmware_updates',
          recipients: [getRandomItem(users).email],
          format: 'html',
        },
        nextRun: calculateNextRun(168),
        executionCount: 0,
        userId: getRandomItem(users).id,
        tenantId: getRandomItem(users).tenantId,
      },
      {
        name: 'Audit Log Export',
        description: 'Export system audit logs for security review',
        type: ScheduleType.EXPORT,
        schedule: '0 23 * * *', // Every day at 11 PM
        enabled: true,
        configuration: {
          format: 'json',
          recipients: ['security@example.com'],
        },
        lastRun: generateLastRun(24),
        nextRun: calculateNextRun(23),
        executionCount: 60,
        userId: getRandomItem(users).id,
        tenantId: getRandomItem(users).tenantId,
      },
      {
        name: 'Inactive User Cleanup',
        description: 'Remove users who have been inactive for over 1 year',
        type: ScheduleType.CLEANUP,
        schedule: '0 3 1 * *', // 1st of every month at 3 AM
        enabled: false,
        configuration: {
          retention: 365, // 1 year
        },
        nextRun: calculateNextRun(720),
        executionCount: 0,
        userId: getRandomItem(users).id,
        tenantId: getRandomItem(users).tenantId,
      },
      {
        name: 'Error Log Cleanup',
        description: 'Archive and remove old error logs',
        type: ScheduleType.CLEANUP,
        schedule: '0 5 * * 0', // Every Sunday at 5 AM
        enabled: true,
        configuration: {
          retention: 30,
        },
        lastRun: generateLastRun(168),
        nextRun: calculateNextRun(72),
        executionCount: 20,
        userId: getRandomItem(users).id,
        tenantId: getRandomItem(users).tenantId,
      },
      {
        name: 'Quarterly Compliance Report',
        description: 'Comprehensive quarterly compliance and audit report',
        type: ScheduleType.REPORT,
        schedule: '0 10 1 */3 *', // 1st of every quarter at 10 AM
        enabled: true,
        configuration: {
          reportType: 'compliance',
          recipients: [
            getRandomItem(users).email,
            'compliance@example.com',
            'audit@example.com',
          ],
          format: 'pdf',
        },
        lastRun: generateLastRun(2160), // 90 days ago
        nextRun: calculateNextRun(720),
        executionCount: 4,
        userId: getRandomItem(users).id,
        tenantId: getRandomItem(users).tenantId,
      },
      {
        name: 'Device Metrics Export',
        description: 'Export device performance metrics for analysis',
        type: ScheduleType.EXPORT,
        schedule: '0 0 * * 0', // Every Sunday at midnight
        enabled: true,
        configuration: {
          format: 'csv',
          recipients: [getRandomItem(users).email],
        },
        lastRun: generateLastRun(168),
        nextRun: calculateNextRun(48),
        executionCount: 30,
        userId: getRandomItem(users).id,
        tenantId: getRandomItem(users).tenantId,
      },
      {
        name: 'Session Cleanup',
        description: 'Remove expired user sessions and tokens',
        type: ScheduleType.CLEANUP,
        schedule: '*/30 * * * *', // Every 30 minutes
        enabled: true,
        configuration: {
          retention: 0,
        },
        lastRun: generateLastRun(0.5),
        nextRun: calculateNextRun(0),
        executionCount: 1440,
        userId: getRandomItem(users).id,
        tenantId: getRandomItem(users).tenantId,
      },
      {
        name: 'Notification Log Cleanup',
        description: 'Clean up old notification logs',
        type: ScheduleType.CLEANUP,
        schedule: '0 4 * * 1', // Every Monday at 4 AM
        enabled: true,
        configuration: {
          retention: 60,
        },
        lastRun: generateLastRun(168),
        nextRun: calculateNextRun(24),
        executionCount: 15,
        userId: getRandomItem(users).id,
        tenantId: getRandomItem(users).tenantId,
      },
      {
        name: 'SLA Performance Report',
        description: 'Weekly SLA compliance and performance metrics report',
        type: ScheduleType.REPORT,
        schedule: '0 8 * * 1', // Every Monday at 8 AM
        enabled: true,
        configuration: {
          reportType: 'sla_performance',
          recipients: [getRandomItem(users).email, 'management@example.com'],
          format: 'pdf',
        },
        lastRun: generateLastRun(168),
        nextRun: calculateNextRun(24),
        executionCount: 20,
        userId: getRandomItem(users).id,
        tenantId: getRandomItem(users).tenantId,
      },
      {
        name: 'Custom Dashboard Export',
        description: 'Export custom dashboard data and visualizations',
        type: ScheduleType.EXPORT,
        schedule: '0 7 * * *', // Every day at 7 AM
        enabled: false,
        configuration: {
          format: 'pdf',
          recipients: [getRandomItem(users).email],
        },
        nextRun: calculateNextRun(7),
        executionCount: 0,
        userId: getRandomItem(users).id,
        tenantId: getRandomItem(users).tenantId,
      },
    ];

    for (const scheduleData of schedules) {
      const existing = await this.scheduleRepository.findOne({
        where: { name: scheduleData.name, userId: scheduleData.userId },
      });

      if (!existing) {
        const schedule = this.scheduleRepository.create(scheduleData);
        await this.scheduleRepository.save(schedule);
        console.log(
          `✅ Created schedule: ${scheduleData.name} (${scheduleData.type} - ${scheduleData.enabled ? 'enabled' : 'disabled'})`,
        );
      } else {
        console.log(`⏭️  Schedule already exists: ${scheduleData.name}`);
      }
    }

    console.log('🎉 Schedule seeding completed!');
  }
}
