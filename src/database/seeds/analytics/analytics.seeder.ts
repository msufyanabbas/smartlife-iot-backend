import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, IsNull } from 'typeorm';
import {
  AnalyticsType,
  AnalyticsPeriod,
} from '@modules/analytics/entities/analytics.entity';
import {
  User,
  Device,
  Alarm,
  Tenant,
  Analytics,
} from '@modules/index.entities';
import { ISeeder } from '../seeder.interface';

@Injectable()
export class AnalyticsSeeder implements ISeeder {
  constructor(
    @InjectRepository(Analytics)
    private readonly analyticsRepository: Repository<Analytics>,
    @InjectRepository(User)
    private readonly userRepository: Repository<User>,
    @InjectRepository(Device)
    private readonly deviceRepository: Repository<Device>,
    @InjectRepository(Alarm)
    private readonly alarmRepository: Repository<Alarm>,
    @InjectRepository(Tenant)
    private readonly tenantRepository: Repository<Tenant>,
  ) {}

  async seed(): Promise<void> {
    // Fetch entities for referential integrity
    const users = await this.userRepository.find({ take: 10 });
    const devices = await this.deviceRepository.find({ take: 10 });
    const alarms = await this.alarmRepository.find({ take: 10 });
    const tenants = await this.tenantRepository.find({ take: 5 });

    if (users.length === 0) {
      console.log('⚠️  No users found. Please seed users first.');
      return;
    }

    if (tenants.length === 0) {
      console.log('⚠️  No tenants found. Please seed tenants first.');
      return;
    }

    // Helper functions
    const getRandomItem = <T>(array: T[]): T => {
      return array[Math.floor(Math.random() * array.length)];
    };

    const getDateDaysAgo = (days: number): Date => {
      const date = new Date();
      date.setDate(date.getDate() - days);
      return date;
    };

    const getDateHoursAgo = (hours: number): Date => {
      const date = new Date();
      date.setHours(date.getHours() - hours);
      return date;
    };

    const analytics = [
      // Device Usage Analytics - Daily
      {
        type: AnalyticsType.DEVICE_USAGE,
        period: AnalyticsPeriod.DAILY,
        entityId: devices[0]?.id,
        entityType: 'device',
        metrics: {
          uptime: 23.5,
          uptimePercentage: 97.9,
          downtime: 0.5,
          dataPointsReceived: 1440,
          averageInterval: 60,
          totalMessages: 1440,
          errorCount: 3,
          successRate: 99.79,
        },
        timestamp: getDateDaysAgo(0),
        tenantId: tenants[0]?.id,
      },
      {
        type: AnalyticsType.DEVICE_USAGE,
        period: AnalyticsPeriod.DAILY,
        entityId: devices[1]?.id,
        entityType: 'device',
        metrics: {
          uptime: 24,
          uptimePercentage: 100,
          downtime: 0,
          dataPointsReceived: 2880,
          averageInterval: 30,
          totalMessages: 2880,
          errorCount: 0,
          successRate: 100,
        },
        timestamp: getDateDaysAgo(0),
        tenantId: tenants[0]?.id,
      },
      {
        type: AnalyticsType.DEVICE_USAGE,
        period: AnalyticsPeriod.DAILY,
        entityId: devices[2]?.id,
        entityType: 'device',
        metrics: {
          uptime: 22.8,
          uptimePercentage: 95.0,
          downtime: 1.2,
          dataPointsReceived: 720,
          averageInterval: 120,
          totalMessages: 720,
          errorCount: 8,
          successRate: 98.89,
        },
        timestamp: getDateDaysAgo(0),
        tenantId: tenants[1]?.id || tenants[0]?.id,
      },
      // Device Usage Analytics - Weekly
      {
        type: AnalyticsType.DEVICE_USAGE,
        period: AnalyticsPeriod.WEEKLY,
        entityId: devices[0]?.id,
        entityType: 'device',
        metrics: {
          uptime: 165.2,
          uptimePercentage: 98.69,
          downtime: 2.8,
          dataPointsReceived: 10080,
          averageInterval: 60,
          totalMessages: 10080,
          errorCount: 15,
          successRate: 99.85,
          peakUsageDay: 'Monday',
          lowestUsageDay: 'Sunday',
        },
        timestamp: getDateDaysAgo(7),
        tenantId: tenants[0]?.id,
      },
      {
        type: AnalyticsType.DEVICE_USAGE,
        period: AnalyticsPeriod.WEEKLY,
        entityId: devices[3]?.id || devices[0]?.id,
        entityType: 'device',
        metrics: {
          uptime: 167.5,
          uptimePercentage: 99.7,
          downtime: 0.5,
          dataPointsReceived: 20160,
          averageInterval: 30,
          totalMessages: 20160,
          errorCount: 5,
          successRate: 99.98,
          peakUsageDay: 'Wednesday',
          lowestUsageDay: 'Saturday',
        },
        timestamp: getDateDaysAgo(7),
        tenantId: tenants[1]?.id || tenants[0]?.id,
      },
      // Device Usage Analytics - Monthly
      {
        type: AnalyticsType.DEVICE_USAGE,
        period: AnalyticsPeriod.MONTHLY,
        entityId: devices[2]?.id,
        entityType: 'device',
        metrics: {
          uptime: 714.5,
          uptimePercentage: 99.23,
          downtime: 5.5,
          dataPointsReceived: 43200,
          averageInterval: 60,
          totalMessages: 43200,
          errorCount: 45,
          successRate: 99.9,
          totalDataVolume: '2.5GB',
          averageDailyMessages: 1440,
        },
        timestamp: getDateDaysAgo(30),
        tenantId: getRandomItem(tenants).id,
      },
      // Telemetry Stats - Hourly
      {
        type: AnalyticsType.TELEMETRY_STATS,
        period: AnalyticsPeriod.HOURLY,
        entityId: devices[0]?.id,
        entityType: 'device',
        metrics: {
          temperature: {
            min: 20.5,
            max: 25.3,
            avg: 22.8,
            median: 22.5,
            stdDev: 1.2,
            sampleCount: 60,
          },
          humidity: {
            min: 45.2,
            max: 68.7,
            avg: 55.4,
            median: 54.8,
            stdDev: 5.3,
            sampleCount: 60,
          },
          pressure: {
            min: 1010.2,
            max: 1015.8,
            avg: 1013.2,
            median: 1013.0,
            stdDev: 1.5,
            sampleCount: 60,
          },
        },
        timestamp: getDateHoursAgo(1),
        tenantId: tenants[0]?.id,
      },
      {
        type: AnalyticsType.TELEMETRY_STATS,
        period: AnalyticsPeriod.HOURLY,
        entityId: devices[1]?.id,
        entityType: 'device',
        metrics: {
          temperature: {
            min: 18.8,
            max: 23.5,
            avg: 21.2,
            median: 21.0,
            stdDev: 1.0,
            sampleCount: 120,
          },
          battery: {
            min: 85.2,
            max: 87.5,
            avg: 86.5,
            median: 86.6,
            stdDev: 0.5,
            sampleCount: 120,
          },
        },
        timestamp: getDateHoursAgo(2),
        tenantId: tenants[1]?.id || tenants[0]?.id,
      },
      // Telemetry Stats - Daily
      {
        type: AnalyticsType.TELEMETRY_STATS,
        period: AnalyticsPeriod.DAILY,
        entityId: devices[1]?.id,
        entityType: 'device',
        metrics: {
          temperature: {
            min: 18.2,
            max: 28.9,
            avg: 23.5,
            median: 23.2,
            stdDev: 2.4,
            sampleCount: 1440,
            anomaliesDetected: 2,
          },
          co2: {
            min: 400,
            max: 1200,
            avg: 650,
            median: 620,
            stdDev: 150,
            sampleCount: 1440,
            thresholdExceeded: 5,
          },
          power: {
            min: 250,
            max: 850,
            avg: 480,
            median: 465,
            stdDev: 95,
            sampleCount: 1440,
            totalConsumption: '11.52kWh',
          },
        },
        timestamp: getDateDaysAgo(0),
        tenantId: getRandomItem(tenants).id,
      },
      // Telemetry Stats - Weekly
      {
        type: AnalyticsType.TELEMETRY_STATS,
        period: AnalyticsPeriod.WEEKLY,
        entityId: devices[2]?.id,
        entityType: 'device',
        metrics: {
          vibration: {
            min: 0.1,
            max: 95.5,
            avg: 35.2,
            median: 32.8,
            stdDev: 18.5,
            sampleCount: 10080,
            anomaliesDetected: 12,
            peakTimestamp: '2025-11-04T15:30:00Z',
          },
          signalStrength: {
            min: -85,
            max: -45,
            avg: -62,
            median: -60,
            stdDev: 8.5,
            sampleCount: 10080,
            disconnections: 3,
          },
        },
        timestamp: getDateDaysAgo(7),
        tenantId: tenants[0]?.id,
      },
      // Alarm Frequency - Daily (system-wide, no entityId)
      {
        type: AnalyticsType.ALARM_FREQUENCY,
        period: AnalyticsPeriod.DAILY,
        entityType: 'system',
        metrics: {
          totalAlarms: 45,
          activeAlarms: 12,
          acknowledgedAlarms: 15,
          clearedAlarms: 10,
          resolvedAlarms: 8,
          bySeverity: {
            info: 8,
            warning: 18,
            error: 12,
            critical: 7,
          },
          byDevice: devices.slice(0, 3).reduce(
            (acc, device) => {
              if (device?.id)
                acc[device.id] = Math.floor(Math.random() * 10) + 1;
              return acc;
            },
            {} as Record<string, number>,
          ),
          meanTimeToAcknowledge: 180,
          meanTimeToResolve: 1200,
        },
        timestamp: getDateDaysAgo(0),
        tenantId: tenants[0]?.id,
      },
      {
        type: AnalyticsType.ALARM_FREQUENCY,
        period: AnalyticsPeriod.DAILY,
        entityType: 'system',
        metrics: {
          totalAlarms: 32,
          activeAlarms: 8,
          acknowledgedAlarms: 12,
          clearedAlarms: 7,
          resolvedAlarms: 5,
          bySeverity: {
            info: 5,
            warning: 15,
            error: 8,
            critical: 4,
          },
          byDevice: devices.slice(3, 6).reduce(
            (acc, device) => {
              if (device?.id)
                acc[device.id] = Math.floor(Math.random() * 8) + 1;
              return acc;
            },
            {} as Record<string, number>,
          ),
          meanTimeToAcknowledge: 240,
          meanTimeToResolve: 1500,
        },
        timestamp: getDateDaysAgo(0),
        tenantId: tenants[1]?.id || tenants[0]?.id,
      },
      // Alarm Frequency - Weekly
      {
        type: AnalyticsType.ALARM_FREQUENCY,
        period: AnalyticsPeriod.WEEKLY,
        entityType: 'system',
        metrics: {
          totalAlarms: 285,
          activeAlarms: 15,
          acknowledgedAlarms: 95,
          clearedAlarms: 120,
          resolvedAlarms: 55,
          bySeverity: {
            info: 65,
            warning: 125,
            error: 70,
            critical: 25,
          },
          trendDirection: 'increasing',
          weekOverWeekChange: 12.5,
          peakDay: 'Tuesday',
          peakHour: 14,
        },
        timestamp: getDateDaysAgo(7),
        tenantId: getRandomItem(tenants).id,
      },
      // User Activity - Daily
      {
        type: AnalyticsType.USER_ACTIVITY,
        period: AnalyticsPeriod.DAILY,
        entityId: users[0]?.id,
        entityType: 'user',
        metrics: {
          logins: 3,
          sessionDuration: 7200,
          pagesViewed: 45,
          devicesAccessed: 8,
          alarmsAcknowledged: 5,
          alarmsResolved: 2,
          configChanges: 3,
          reportsGenerated: 1,
        },
        timestamp: getDateDaysAgo(0),
        tenantId: getRandomItem(tenants).id,
      },
      {
        type: AnalyticsType.USER_ACTIVITY,
        period: AnalyticsPeriod.DAILY,
        entityId: users[1]?.id || users[0]?.id,
        entityType: 'user',
        metrics: {
          logins: 5,
          sessionDuration: 10800,
          pagesViewed: 78,
          devicesAccessed: 12,
          alarmsAcknowledged: 8,
          alarmsResolved: 6,
          configChanges: 7,
          reportsGenerated: 3,
        },
        timestamp: getDateDaysAgo(0),
        tenantId: getRandomItem(tenants).id,
      },
      // User Activity - Weekly
      {
        type: AnalyticsType.USER_ACTIVITY,
        period: AnalyticsPeriod.WEEKLY,
        entityId: users[2]?.id || users[0]?.id,
        entityType: 'user',
        metrics: {
          logins: 18,
          totalSessionDuration: 43200,
          averageSessionDuration: 2400,
          pagesViewed: 285,
          devicesAccessed: 15,
          alarmsAcknowledged: 25,
          alarmsResolved: 18,
          configChanges: 12,
          reportsGenerated: 5,
          mostActiveDay: 'Monday',
          peakActivityHour: 10,
        },
        timestamp: getDateDaysAgo(7),
        tenantId: getRandomItem(tenants).id,
      },
      // User Activity - Monthly (Aggregate, no entityId)
      {
        type: AnalyticsType.USER_ACTIVITY,
        period: AnalyticsPeriod.MONTHLY,
        entityType: 'users',
        metrics: {
          totalUsers: users.length,
          activeUsers: Math.floor(users.length * 0.85),
          totalLogins: 450,
          averageLoginsPerUser: Math.floor(450 / users.length),
          totalSessionDuration: 540000,
          averageSessionDuration: 3600,
          totalAlarmsAcknowledged: 285,
          totalAlarmsResolved: 180,
          topUsers: users.slice(0, 3).map((u) => ({
            userId: u?.id,
            userName: u?.name,
            activityScore: Math.floor(Math.random() * 100) + 50,
          })),
        },
        timestamp: getDateDaysAgo(30),
        tenantId: getRandomItem(tenants).id,
      },
      // System Performance - Hourly (no tenantId - system-wide)
      {
        type: AnalyticsType.SYSTEM_PERFORMANCE,
        period: AnalyticsPeriod.HOURLY,
        entityType: 'system',
        metrics: {
          cpuUsage: {
            min: 15.2,
            max: 45.8,
            avg: 28.5,
          },
          memoryUsage: {
            min: 52.3,
            max: 68.9,
            avg: 61.2,
          },
          diskUsage: 45.5,
          networkIn: '125MB',
          networkOut: '98MB',
          apiRequests: 15420,
          apiLatency: {
            min: 12,
            max: 850,
            avg: 95,
            p95: 250,
            p99: 450,
          },
          databaseQueries: 8540,
          databaseLatency: {
            min: 5,
            max: 320,
            avg: 35,
          },
          errorRate: 0.15,
        },
        timestamp: getDateHoursAgo(1),
      },
      // System Performance - Daily
      {
        type: AnalyticsType.SYSTEM_PERFORMANCE,
        period: AnalyticsPeriod.DAILY,
        entityType: 'system',
        metrics: {
          cpuUsage: {
            min: 12.5,
            max: 78.3,
            avg: 32.8,
          },
          memoryUsage: {
            min: 48.2,
            max: 75.5,
            avg: 63.5,
          },
          diskUsage: 45.8,
          networkIn: '2.8GB',
          networkOut: '2.2GB',
          apiRequests: 385200,
          apiLatency: {
            min: 8,
            max: 1250,
            avg: 105,
            p95: 280,
            p99: 520,
          },
          databaseQueries: 215800,
          databaseLatency: {
            min: 3,
            max: 450,
            avg: 38,
          },
          errorRate: 0.12,
          peakHour: 14,
          slowestEndpoints: [
            { endpoint: '/api/telemetry/query', avgLatency: 450 },
            { endpoint: '/api/analytics/generate', avgLatency: 380 },
          ],
        },
        timestamp: getDateDaysAgo(0),
      },
      // System Performance - Weekly
      {
        type: AnalyticsType.SYSTEM_PERFORMANCE,
        period: AnalyticsPeriod.WEEKLY,
        entityType: 'system',
        metrics: {
          cpuUsage: {
            min: 10.2,
            max: 82.5,
            avg: 35.2,
          },
          memoryUsage: {
            min: 45.8,
            max: 78.9,
            avg: 64.8,
          },
          diskUsage: 46.2,
          diskGrowth: '1.5GB',
          networkIn: '18.5GB',
          networkOut: '14.8GB',
          apiRequests: 2685000,
          apiLatency: {
            min: 5,
            max: 1580,
            avg: 108,
            p95: 295,
            p99: 550,
          },
          databaseQueries: 1548000,
          databaseLatency: {
            min: 2,
            max: 580,
            avg: 42,
          },
          errorRate: 0.14,
          uptime: 99.95,
          incidents: 2,
          peakDay: 'Wednesday',
        },
        timestamp: getDateDaysAgo(7),
      },
      // Tenant-specific Performance
      {
        type: AnalyticsType.SYSTEM_PERFORMANCE,
        period: AnalyticsPeriod.DAILY,
        entityId: tenants[0]?.id,
        entityType: 'tenant',
        metrics: {
          devicesCount: devices.filter((d) => d?.tenantId === tenants[0]?.id)
            .length,
          activeDevices: Math.floor(
            devices.filter((d) => d?.tenantId === tenants[0]?.id).length * 0.9,
          ),
          totalDataPoints: 45000,
          storageUsed: '850MB',
          apiCalls: 12500,
          bandwidthUsed: '1.2GB',
          alarmsTriggered: 25,
          activeUsers: users.filter((u) => u?.tenantId === tenants[0]?.id)
            .length,
        },
        timestamp: getDateDaysAgo(0),
        tenantId: tenants[0]?.id,
      },
      {
        type: AnalyticsType.SYSTEM_PERFORMANCE,
        period: AnalyticsPeriod.DAILY,
        entityId: tenants[1]?.id || tenants[0]?.id,
        entityType: 'tenant',
        metrics: {
          devicesCount: devices.filter(
            (d) => d?.tenantId === (tenants[1]?.id || tenants[0]?.id),
          ).length,
          activeDevices: Math.floor(
            devices.filter(
              (d) => d?.tenantId === (tenants[1]?.id || tenants[0]?.id),
            ).length * 0.85,
          ),
          totalDataPoints: 38000,
          storageUsed: '720MB',
          apiCalls: 10200,
          bandwidthUsed: '980MB',
          alarmsTriggered: 18,
          activeUsers: users.filter(
            (u) => u?.tenantId === (tenants[1]?.id || tenants[0]?.id),
          ).length,
        },
        timestamp: getDateDaysAgo(0),
        tenantId: tenants[1]?.id || tenants[0]?.id,
      },
    ];

    for (const analyticsData of analytics) {
      // Build where clause conditionally
      const whereClause: any = {
        type: analyticsData.type,
        period: analyticsData.period,
        timestamp: analyticsData.timestamp,
      };

      // Only add entityId to where clause if it exists
      if ('entityId' in analyticsData && analyticsData.entityId) {
        whereClause.entityId = analyticsData.entityId;
      } else {
        whereClause.entityId = IsNull();
      }

      const existing = await this.analyticsRepository.findOne({
        where: whereClause,
      });

      if (!existing) {
        const analytic = this.analyticsRepository.create(analyticsData as any);
        await this.analyticsRepository.save(analytic);
        console.log(
          `✅ Created analytics: ${analyticsData.type} (${analyticsData.period}) - ${analyticsData.entityType || 'system'}`,
        );
      } else {
        console.log(
          `⏭️  Analytics already exists: ${analyticsData.type} (${analyticsData.period}) at ${analyticsData.timestamp}`,
        );
      }
    }

    console.log('🎉 Analytics seeding completed!');
  }
}
