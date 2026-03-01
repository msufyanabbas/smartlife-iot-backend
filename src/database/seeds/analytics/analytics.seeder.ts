// src/database/seeders/analytics.seeder.ts
import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, IsNull } from 'typeorm';  // ← Add IsNull import
import { AnalyticsType, AnalyticsPeriod } from '@common/enums/index.enum';
import { Analytics, User, Device, Tenant } from '@modules/index.entities';
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
    @InjectRepository(Tenant)
    private readonly tenantRepository: Repository<Tenant>,
  ) {}

  async seed(): Promise<void> {
    console.log('📊 Seeding analytics...');

    // Get first tenant
    const tenant = await this.tenantRepository.findOne({
      where: {},
      order: { createdAt: 'ASC' },
    });

    if (!tenant) {
      console.log('⚠️  No tenants found. Please seed tenants first.');
      return;
    }

    // Get users and devices from this tenant
    const users = await this.userRepository.find({
      where: { tenantId: tenant.id },
      take: 3,
    });

    const devices = await this.deviceRepository.find({
      where: { tenantId: tenant.id },
      take: 3,
      relations: ['customer'],
    });

    if (devices.length === 0) {
      console.log('⚠️  No devices found. Please seed devices first.');
      return;
    }

    // Helper functions
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

    const analyticsData = [
      // 1. Device Usage Analytics - Daily
      {
        tenantId: tenant.id,
        customerId: devices[0]?.customerId,
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
        metadata: {
          calculatedAt: new Date(),
          dataPoints: 1440,
          sources: ['telemetry'],
          aggregations: ['avg', 'sum', 'count'],
        },
      },

      // 2. Telemetry Stats - Hourly
      {
        tenantId: tenant.id,
        customerId: devices[1]?.customerId || devices[0]?.customerId,
        type: AnalyticsType.TELEMETRY_STATS,
        period: AnalyticsPeriod.HOURLY,
        entityId: devices[1]?.id || devices[0]?.id,
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
        metadata: {
          calculatedAt: new Date(),
          dataPoints: 60,
          sources: ['telemetry'],
          aggregations: ['min', 'max', 'avg', 'median', 'stdDev'],
        },
      },

      // 3. Alarm Frequency - Daily (system-wide for this tenant, no entityId)
      {
        tenantId: tenant.id,
        customerId: undefined,  // ← System-wide, no customer
        type: AnalyticsType.ALARM_FREQUENCY,
        period: AnalyticsPeriod.DAILY,
        entityId: undefined,  // ← No specific entity
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
              if (device?.id) acc[device.id] = Math.floor(Math.random() * 10) + 1;
              return acc;
            },
            {} as Record<string, number>,
          ),
          meanTimeToAcknowledge: 180,
          meanTimeToResolve: 1200,
        },
        timestamp: getDateDaysAgo(0),
        metadata: {
          calculatedAt: new Date(),
          dataPoints: 45,
          sources: ['alarms'],
          aggregations: ['count', 'avg', 'group_by'],
        },
      },

      // 4. User Activity - Daily
      {
        tenantId: tenant.id,
        customerId: undefined,
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
          mostVisitedPages: ['/dashboards', '/devices', '/alarms'],
        },
        timestamp: getDateDaysAgo(0),
        metadata: {
          calculatedAt: new Date(),
          dataPoints: 3,
          sources: ['audit_logs', 'sessions'],
          aggregations: ['count', 'sum'],
        },
      },

      // 5. System Performance - Daily (tenant-specific)
      {
        tenantId: tenant.id,
        customerId: undefined,
        type: AnalyticsType.SYSTEM_PERFORMANCE,
        period: AnalyticsPeriod.DAILY,
        entityId: undefined,  // ← System-wide
        entityType: 'tenant',
        metrics: {
          devicesCount: devices.length,
          activeDevices: Math.floor(devices.length * 0.9),
          totalDataPoints: 45000,
          storageUsed: '850MB',
          apiCalls: 12500,
          bandwidthUsed: '1.2GB',
          alarmsTriggered: 25,
          activeUsers: users.length,
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
          apiLatency: {
            min: 12,
            max: 850,
            avg: 95,
            p95: 250,
            p99: 450,
          },
        },
        timestamp: getDateDaysAgo(0),
        metadata: {
          calculatedAt: new Date(),
          dataPoints: 12500,
          sources: ['metrics', 'telemetry', 'api_logs'],
          aggregations: ['avg', 'min', 'max', 'count', 'percentile'],
        },
      },
    ];

    for (const data of analyticsData) {
      // ═══════════════════════════════════════════════════════════════════════
      // BUILD WHERE CLAUSE (Handle nullable entityId properly)
      // ═══════════════════════════════════════════════════════════════════════
      
      const whereClause: any = {
        tenantId: data.tenantId,
        type: data.type,
        period: data.period,
        timestamp: data.timestamp,
      };

      // Handle nullable entityId with IsNull()
      if (data.entityId) {
        whereClause.entityId = data.entityId;
      } else {
        whereClause.entityId = IsNull();  // ← Use IsNull() for null values
      }

      const existing = await this.analyticsRepository.findOne({
        where: whereClause,
      });

      if (!existing) {
        const analytic = this.analyticsRepository.create(data as any);
        await this.analyticsRepository.save(analytic);
        console.log(
          `✅ Created analytics: ${data.type} (${data.period}) - ${data.entityType || 'system'}`,
        );
      } else {
        console.log(
          `⏭️  Analytics already exists: ${data.type} (${data.period})`,
        );
      }
    }

    console.log('🎉 Analytics seeding completed! (5 records created)');
  }
}