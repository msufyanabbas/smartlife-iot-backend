// src/modules/analytics/services/analytics.service.ts
import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, Between } from 'typeorm';
import { Cron, CronExpression } from '@nestjs/schedule';
import { AnalyticsType, AnalyticsPeriod } from '@common/enums/index.enum';
import {
  CreateAnalyticsDto,
  QueryAnalyticsDto,
  DeviceAnalyticsDto,
} from './dto/analytics.dto';
import { Device, Telemetry, Alarm, User, Analytics, Tenant } from '@modules/index.entities';
import { DeviceStatus, AlarmStatus } from '@common/enums/index.enum';

@Injectable()
export class AnalyticsService {
  constructor(
    @InjectRepository(Analytics)
    private analyticsRepository: Repository<Analytics>,
    @InjectRepository(Device)
    private deviceRepository: Repository<Device>,
    @InjectRepository(Telemetry)
    private telemetryRepository: Repository<Telemetry>,
    @InjectRepository(Alarm)
    private alarmRepository: Repository<Alarm>,
    @InjectRepository(User)
    private userRepository: Repository<User>,
    @InjectRepository(Tenant)
    private tenantRepository: Repository<Tenant>,
  ) {}

  /**
   * Create analytics record
   */
  async create(
    tenantId: string | undefined,
    customerId: string | undefined,
    createAnalyticsDto: CreateAnalyticsDto,
  ): Promise<Analytics> {
    const analytics = this.analyticsRepository.create({
      ...createAnalyticsDto,
      tenantId,
      customerId,
      timestamp: new Date(createAnalyticsDto.timestamp),
    });
    return await this.analyticsRepository.save(analytics);
  }

  /**
   * Query analytics with filters
   */
  async findAll(
    tenantId: string | undefined,
    queryDto: QueryAnalyticsDto,
    customerId?: string,
  ): Promise<{
    data: Analytics[];
    total: number;
    page: number;
    limit: number;
    totalPages: number;
  }> {
    const page = queryDto.page || 1;
    const limit = queryDto.limit || 50;
    const skip = (page - 1) * limit;

    const queryBuilder = this.analyticsRepository
      .createQueryBuilder('analytics')
      .where('analytics.tenantId = :tenantId', { tenantId });

    // Filter by customer if provided
    if (customerId) {
      queryBuilder.andWhere('analytics.customerId = :customerId', { customerId });
    }

    if (queryDto.type) {
      queryBuilder.andWhere('analytics.type = :type', { type: queryDto.type });
    }

    if (queryDto.period) {
      queryBuilder.andWhere('analytics.period = :period', {
        period: queryDto.period,
      });
    }

    if (queryDto.entityId) {
      queryBuilder.andWhere('analytics.entityId = :entityId', {
        entityId: queryDto.entityId,
      });
    }

    if (queryDto.entityType) {
      queryBuilder.andWhere('analytics.entityType = :entityType', {
        entityType: queryDto.entityType,
      });
    }

    if (queryDto.startDate && queryDto.endDate) {
      queryBuilder.andWhere('analytics.timestamp BETWEEN :start AND :end', {
        start: new Date(queryDto.startDate),
        end: new Date(queryDto.endDate),
      });
    }

    const total = await queryBuilder.getCount();
    const data = await queryBuilder
      .orderBy('analytics.timestamp', 'DESC')
      .skip(skip)
      .take(limit)
      .getMany();

    return {
      data,
      total,
      page,
      limit,
      totalPages: Math.ceil(total / limit),
    };
  }

  /**
   * Get device analytics
   */
  async getDeviceAnalytics(
    tenantId: string | undefined,
    dto: DeviceAnalyticsDto,
    customerId?: string,
  ): Promise<any> {
    const period = dto.period || AnalyticsPeriod.DAILY;
    const endDate = dto.endDate ? new Date(dto.endDate) : new Date();
    const startDate = dto.startDate
      ? new Date(dto.startDate)
      : this.getDefaultStartDate(period);

    const query: any = {
      tenantId,
      type: AnalyticsType.DEVICE_USAGE,
      period,
      timestamp: Between(startDate, endDate),
    };

    if (customerId) {
      query.customerId = customerId;
    }

    if (dto.deviceId) {
      query.entityId = dto.deviceId;
    }

    const analytics = await this.analyticsRepository.find({
      where: query,
      order: { timestamp: 'ASC' },
    });

    return {
      period,
      startDate,
      endDate,
      data: analytics.map((a) => ({
        timestamp: a.timestamp,
        metrics: a.metrics,
        deviceId: a.entityId,
      })),
    };
  }

  /**
   * Get telemetry statistics
   */
  async getTelemetryStats(
    tenantId: string | undefined,
    startDate?: Date,
    endDate?: Date,
    customerId?: string,
  ): Promise<any> {
    const start = startDate || this.getDefaultStartDate(AnalyticsPeriod.DAILY);
    const end = endDate || new Date();

    const queryBuilder = this.telemetryRepository
      .createQueryBuilder('telemetry')
      .select('telemetry.deviceId', 'deviceId')
      .addSelect('COUNT(*)', 'count')
      .addSelect('MIN(telemetry.timestamp)', 'firstRecord')
      .addSelect('MAX(telemetry.timestamp)', 'lastRecord')
      .innerJoin('telemetry.device', 'device')
      .where('device.tenantId = :tenantId', { tenantId })
      .andWhere('telemetry.timestamp BETWEEN :start AND :end', { start, end });

    if (customerId) {
      queryBuilder.andWhere('device.customerId = :customerId', { customerId });
    }

    const stats = await queryBuilder
      .groupBy('telemetry.deviceId')
      .getRawMany();

    return {
      startDate: start,
      endDate: end,
      devices: stats.map((s) => ({
        deviceId: s.deviceId,
        recordCount: parseInt(s.count),
        firstRecord: s.firstRecord,
        lastRecord: s.lastRecord,
      })),
      totalRecords: stats.reduce((sum, s) => sum + parseInt(s.count), 0),
    };
  }

  /**
   * Get alarm analytics
   */
  async getAlarmAnalytics(
    tenantId: string | undefined,
    startDate?: Date,
    endDate?: Date,
    customerId?: string,
  ): Promise<any> {
    const start = startDate || this.getDefaultStartDate(AnalyticsPeriod.WEEKLY);
    const end = endDate || new Date();

    const whereCondition: any = {
      tenantId,
      triggeredAt: Between(start, end),
    };

    if (customerId) {
      whereCondition.customerId = customerId;
    }

    const alarmStats = await this.alarmRepository
      .createQueryBuilder('alarm')
      .select('alarm.severity', 'severity')
      .addSelect('COUNT(*)', 'count')
      .where('alarm.tenantId = :tenantId', { tenantId })
      .andWhere('alarm.triggeredAt BETWEEN :start AND :end', { start, end })
      .groupBy('alarm.severity')
      .getRawMany();

    const queryBuilder = this.alarmRepository
      .createQueryBuilder('alarm')
      .select('alarm.deviceId', 'deviceId')
      .addSelect('COUNT(*)', 'count')
      .where('alarm.tenantId = :tenantId', { tenantId })
      .andWhere('alarm.triggeredAt BETWEEN :start AND :end', { start, end });

    if (customerId) {
      queryBuilder.andWhere('alarm.customerId = :customerId', { customerId });
    }

    const deviceAlarms = await queryBuilder
      .groupBy('alarm.deviceId')
      .orderBy('count', 'DESC')
      .limit(10)
      .getRawMany();

    return {
      startDate: start,
      endDate: end,
      bySeverity: alarmStats.reduce((acc, stat) => {
        acc[stat.severity] = parseInt(stat.count);
        return acc;
      }, {}),
      topDevices: deviceAlarms.map((d) => ({
        deviceId: d.deviceId,
        alarmCount: parseInt(d.count),
      })),
      totalAlarms: alarmStats.reduce((sum, s) => sum + parseInt(s.count), 0),
    };
  }

  /**
   * Get user activity analytics
   */
  async getUserActivity(
    tenantId: string | undefined,
    startDate?: Date,
    endDate?: Date,
  ): Promise<any> {
    const start = startDate || this.getDefaultStartDate(AnalyticsPeriod.DAILY);
    const end = endDate || new Date();

    const activeUsers = await this.userRepository
      .createQueryBuilder('user')
      .where('user.tenantId = :tenantId', { tenantId })
      .andWhere('user.lastLoginAt BETWEEN :start AND :end', { start, end })
      .getCount();

    const totalUsers = await this.userRepository.count({
      where: { tenantId },
    });

    const usersByRole = await this.userRepository
      .createQueryBuilder('user')
      .select('user.role', 'role')
      .addSelect('COUNT(*)', 'count')
      .where('user.tenantId = :tenantId', { tenantId })
      .groupBy('user.role')
      .getRawMany();

    return {
      startDate: start,
      endDate: end,
      totalUsers,
      activeUsers,
      byRole: usersByRole.reduce((acc, stat) => {
        acc[stat.role] = parseInt(stat.count);
        return acc;
      }, {}),
    };
  }

  /**
   * Get system overview
   */
  async getSystemOverview(
    tenantId: string | undefined,
    customerId?: string,
  ): Promise<any> {
    const whereCondition: any = { tenantId };
    
    if (customerId) {
      whereCondition.customerId = customerId;
    }

    const [
      totalDevices,
      onlineDevices,
      totalUsers,
      activeAlarms,
      todayTelemetry,
    ] = await Promise.all([
      this.deviceRepository.count({ where: whereCondition }),
      this.deviceRepository.count({
        where: { ...whereCondition, status: DeviceStatus.ACTIVE },
      }),
      this.userRepository.count({ where: { tenantId } }),
      this.alarmRepository.count({
        where: { ...whereCondition, status: AlarmStatus.ACTIVE },
      }),
      this.getTodayTelemetryCount(tenantId, customerId),
    ]);

    return {
      devices: {
        total: totalDevices,
        online: onlineDevices,
        offline: totalDevices - onlineDevices,
      },
      users: {
        total: totalUsers,
      },
      alarms: {
        active: activeAlarms,
      },
      telemetry: {
        today: todayTelemetry,
      },
      timestamp: new Date(),
    };
  }

  /**
   * Generate daily analytics (run via cron for all tenants)
   */
  @Cron(CronExpression.EVERY_DAY_AT_MIDNIGHT)
  async generateDailyAnalytics(): Promise<void> {
    const yesterday = new Date();
    yesterday.setDate(yesterday.getDate() - 1);
    yesterday.setHours(0, 0, 0, 0);

    const today = new Date();
    today.setHours(0, 0, 0, 0);

    // Get all tenants
    const tenants = await this.tenantRepository.find();

    for (const tenant of tenants) {
      try {
        // Device usage analytics
        await this.generateDeviceUsageAnalytics(tenant.id, yesterday, today);

        // Telemetry statistics
        await this.generateTelemetryAnalytics(tenant.id, yesterday, today);

        // Alarm frequency
        await this.generateAlarmAnalytics(tenant.id, yesterday, today);

        // User activity
        await this.generateUserActivityAnalytics(tenant.id, yesterday, today);

        console.log(`✅ Generated daily analytics for tenant: ${tenant.id}`);
      } catch (error) {
        console.error(`❌ Error generating analytics for tenant ${tenant.id}:`, error);
      }
    }
  }

  /**
   * Private: Generate device usage analytics
   */
  private async generateDeviceUsageAnalytics(
    tenantId: string,
    startDate: Date,
    endDate: Date,
  ): Promise<void> {
    const devices = await this.deviceRepository.find({
      where: { tenantId },
    });

    for (const device of devices) {
      const telemetryCount = await this.telemetryRepository.count({
        where: {
          deviceId: device.id,
          timestamp: Between(startDate, endDate),
        },
      });

      await this.analyticsRepository.save(
        this.analyticsRepository.create({
          tenantId,
          customerId: device.customerId,
          type: AnalyticsType.DEVICE_USAGE,
          period: AnalyticsPeriod.DAILY,
          entityId: device.id,
          entityType: 'device',
          metrics: {
            telemetryCount,
            status: device.status,
            uptime: this.calculateUptime(device),
          },
          timestamp: startDate,
        }),
      );
    }
  }

  /**
   * Private: Generate telemetry analytics
   */
  private async generateTelemetryAnalytics(
    tenantId: string,
    startDate: Date,
    endDate: Date,
  ): Promise<void> {
    const stats = await this.getTelemetryStats(tenantId, startDate, endDate);

    await this.analyticsRepository.save(
      this.analyticsRepository.create({
        tenantId,
        type: AnalyticsType.TELEMETRY_STATS,
        period: AnalyticsPeriod.DAILY,
        metrics: {
          totalRecords: stats.totalRecords,
          deviceCount: stats.devices.length,
        },
        timestamp: startDate,
      }),
    );
  }

  /**
   * Private: Generate alarm analytics
   */
  private async generateAlarmAnalytics(
    tenantId: string,
    startDate: Date,
    endDate: Date,
  ): Promise<void> {
    const stats = await this.getAlarmAnalytics(tenantId, startDate, endDate);

    await this.analyticsRepository.save(
      this.analyticsRepository.create({
        tenantId,
        type: AnalyticsType.ALARM_FREQUENCY,
        period: AnalyticsPeriod.DAILY,
        metrics: {
          totalAlarms: stats.totalAlarms,
          bySeverity: stats.bySeverity,
          topDevices: stats.topDevices,
        },
        timestamp: startDate,
      }),
    );
  }

  /**
   * Private: Generate user activity analytics
   */
  private async generateUserActivityAnalytics(
    tenantId: string,
    startDate: Date,
    endDate: Date,
  ): Promise<void> {
    const stats = await this.getUserActivity(tenantId, startDate, endDate);

    await this.analyticsRepository.save(
      this.analyticsRepository.create({
        tenantId,
        type: AnalyticsType.USER_ACTIVITY,
        period: AnalyticsPeriod.DAILY,
        metrics: {
          totalUsers: stats.totalUsers,
          activeUsers: stats.activeUsers,
          byRole: stats.byRole,
        },
        timestamp: startDate,
      }),
    );
  }

  /**
   * Helper: Get default start date based on period
   */
  private getDefaultStartDate(period: AnalyticsPeriod): Date {
    const date = new Date();

    switch (period) {
      case AnalyticsPeriod.HOURLY:
        date.setHours(date.getHours() - 24);
        break;
      case AnalyticsPeriod.DAILY:
        date.setDate(date.getDate() - 30);
        break;
      case AnalyticsPeriod.WEEKLY:
        date.setDate(date.getDate() - 90);
        break;
      case AnalyticsPeriod.MONTHLY:
        date.setMonth(date.getMonth() - 12);
        break;
    }

    return date;
  }

  /**
   * Helper: Get today's telemetry count
   */
  private async getTodayTelemetryCount(
    tenantId: string | undefined,
    customerId?: string,
  ): Promise<number> {
    const today = new Date();
    today.setHours(0, 0, 0, 0);

    const queryBuilder = this.telemetryRepository
      .createQueryBuilder('telemetry')
      .innerJoin('telemetry.device', 'device')
      .where('device.tenantId = :tenantId', { tenantId })
      .andWhere('telemetry.timestamp BETWEEN :start AND :end', {
        start: today,
        end: new Date(),
      });

    if (customerId) {
      queryBuilder.andWhere('device.customerId = :customerId', { customerId });
    }

    return await queryBuilder.getCount();
  }

  /**
   * Helper: Calculate device uptime
   */
  private calculateUptime(device: any): number {
    // Simplified uptime calculation
    // In production, you'd track connection/disconnection events
    return device.status === DeviceStatus.ACTIVE ? 100 : 0;
  }

  /**
   * Delete old analytics
   */
  async deleteOld(tenantId: string | undefined, daysOld: number): Promise<number> {
    const cutoffDate = new Date();
    cutoffDate.setDate(cutoffDate.getDate() - daysOld);

    const result = await this.analyticsRepository
      .createQueryBuilder()
      .delete()
      .where('tenantId = :tenantId', { tenantId })
      .andWhere('timestamp < :cutoffDate', { cutoffDate })
      .execute();

    return result.affected || 0;
  }
}