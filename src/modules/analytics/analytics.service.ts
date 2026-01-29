import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, Between } from 'typeorm';
import { Cron, CronExpression } from '@nestjs/schedule';
import {
  AnalyticsType,
  AnalyticsPeriod,
} from './entities/analytics.entity';
import {
  CreateAnalyticsDto,
  QueryAnalyticsDto,
  DeviceAnalyticsDto,
} from './dto/analytics.dto';
import { Device, DeviceStatus } from '../devices/entities/device.entity';
import { Telemetry } from '../telemetry/entities/telemetry.entity';
import { Alarm, User, Analytics } from '@modules/index.entities';
import { AlarmStatus } from '@common/enums/index.enum';

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
  ) {}

  /**
   * Create analytics record
   */
  async create(createAnalyticsDto: CreateAnalyticsDto): Promise<Analytics> {
    const analytics = this.analyticsRepository.create({
      ...createAnalyticsDto,
      timestamp: new Date(createAnalyticsDto.timestamp),
    });
    return await this.analyticsRepository.save(analytics);
  }

  /**
   * Query analytics with filters
   */
  async findAll(queryDto: QueryAnalyticsDto): Promise<{
    data: Analytics[];
    total: number;
    page: number;
    limit: number;
  }> {
    const page = queryDto.page || 1;
    const limit = queryDto.limit || 50;
    const skip = (page - 1) * limit;

    const queryBuilder =
      this.analyticsRepository.createQueryBuilder('analytics');

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

    return { data, total, page, limit };
  }

  /**
   * Get device analytics
   */
  async getDeviceAnalytics(dto: DeviceAnalyticsDto): Promise<any> {
    const period = dto.period || AnalyticsPeriod.DAILY;
    const endDate = dto.endDate ? new Date(dto.endDate) : new Date();
    const startDate = dto.startDate
      ? new Date(dto.startDate)
      : this.getDefaultStartDate(period);

    const query: any = {
      type: AnalyticsType.DEVICE_USAGE,
      period,
      timestamp: Between(startDate, endDate),
    };

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
  async getTelemetryStats(startDate?: Date, endDate?: Date): Promise<any> {
    const start = startDate || this.getDefaultStartDate(AnalyticsPeriod.DAILY);
    const end = endDate || new Date();

    const stats = await this.telemetryRepository
      .createQueryBuilder('telemetry')
      .select('telemetry.deviceId', 'deviceId')
      .addSelect('COUNT(*)', 'count')
      .addSelect('MIN(telemetry.timestamp)', 'firstRecord')
      .addSelect('MAX(telemetry.timestamp)', 'lastRecord')
      .where('telemetry.timestamp BETWEEN :start AND :end', { start, end })
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
  async getAlarmAnalytics(startDate?: Date, endDate?: Date): Promise<any> {
    const start = startDate || this.getDefaultStartDate(AnalyticsPeriod.WEEKLY);
    const end = endDate || new Date();

    const alarmStats = await this.alarmRepository
      .createQueryBuilder('alarm')
      .select('alarm.severity', 'severity')
      .addSelect('COUNT(*)', 'count')
      .where('alarm.triggeredAt BETWEEN :start AND :end', { start, end })
      .groupBy('alarm.severity')
      .getRawMany();

    const deviceAlarms = await this.alarmRepository
      .createQueryBuilder('alarm')
      .select('alarm.deviceId', 'deviceId')
      .addSelect('COUNT(*)', 'count')
      .where('alarm.triggeredAt BETWEEN :start AND :end', { start, end })
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
  async getUserActivity(startDate?: Date, endDate?: Date): Promise<any> {
    const start = startDate || this.getDefaultStartDate(AnalyticsPeriod.DAILY);
    const end = endDate || new Date();

    const activeUsers = await this.userRepository
      .createQueryBuilder('user')
      .where('user.lastLoginAt BETWEEN :start AND :end', { start, end })
      .getCount();

    const totalUsers = await this.userRepository.count();

    const usersByRole = await this.userRepository
      .createQueryBuilder('user')
      .select('user.role', 'role')
      .addSelect('COUNT(*)', 'count')
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
  async getSystemOverview(): Promise<any> {
    const [
      totalDevices,
      onlineDevices,
      totalUsers,
      activeAlarms,
      todayTelemetry,
    ] = await Promise.all([
      this.deviceRepository.count(),
      this.deviceRepository.count({ where: { status: DeviceStatus.ACTIVE } }),
      this.userRepository.count(),
      this.alarmRepository.count({ where: { status: AlarmStatus.ACTIVE } }),
      this.getTodayTelemetryCount(),
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
   * Generate daily analytics (run via cron)
   */
  @Cron(CronExpression.EVERY_DAY_AT_MIDNIGHT)
  async generateDailyAnalytics(): Promise<void> {
    const yesterday = new Date();
    yesterday.setDate(yesterday.getDate() - 1);
    yesterday.setHours(0, 0, 0, 0);

    const today = new Date();
    today.setHours(0, 0, 0, 0);

    // Device usage analytics
    await this.generateDeviceUsageAnalytics(yesterday, today);

    // Telemetry statistics
    await this.generateTelemetryAnalytics(yesterday, today);

    // Alarm frequency
    await this.generateAlarmAnalytics(yesterday, today);

    // User activity
    await this.generateUserActivityAnalytics(yesterday, today);
  }

  /**
   * Private: Generate device usage analytics
   */
  private async generateDeviceUsageAnalytics(
    startDate: Date,
    endDate: Date,
  ): Promise<void> {
    const devices = await this.deviceRepository.find();

    for (const device of devices) {
      const telemetryCount = await this.telemetryRepository.count({
        where: {
          deviceId: device.id,
          timestamp: Between(startDate, endDate),
        },
      });

      await this.create({
        type: AnalyticsType.DEVICE_USAGE,
        period: AnalyticsPeriod.DAILY,
        entityId: device.id,
        entityType: 'device',
        metrics: {
          telemetryCount,
          status: device.status,
          uptime: this.calculateUptime(device),
        },
        timestamp: startDate.toISOString(),
      });
    }
  }

  /**
   * Private: Generate telemetry analytics
   */
  private async generateTelemetryAnalytics(
    startDate: Date,
    endDate: Date,
  ): Promise<void> {
    const stats = await this.getTelemetryStats(startDate, endDate);

    await this.create({
      type: AnalyticsType.TELEMETRY_STATS,
      period: AnalyticsPeriod.DAILY,
      metrics: {
        totalRecords: stats.totalRecords,
        deviceCount: stats.devices.length,
      },
      timestamp: startDate.toISOString(),
    });
  }

  /**
   * Private: Generate alarm analytics
   */
  private async generateAlarmAnalytics(
    startDate: Date,
    endDate: Date,
  ): Promise<void> {
    const stats = await this.getAlarmAnalytics(startDate, endDate);

    await this.create({
      type: AnalyticsType.ALARM_FREQUENCY,
      period: AnalyticsPeriod.DAILY,
      metrics: {
        totalAlarms: stats.totalAlarms,
        bySeverity: stats.bySeverity,
        topDevices: stats.topDevices,
      },
      timestamp: startDate.toISOString(),
    });
  }

  /**
   * Private: Generate user activity analytics
   */
  private async generateUserActivityAnalytics(
    startDate: Date,
    endDate: Date,
  ): Promise<void> {
    const stats = await this.getUserActivity(startDate, endDate);

    await this.create({
      type: AnalyticsType.USER_ACTIVITY,
      period: AnalyticsPeriod.DAILY,
      metrics: {
        totalUsers: stats.totalUsers,
        activeUsers: stats.activeUsers,
        byRole: stats.byRole,
      },
      timestamp: startDate.toISOString(),
    });
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
  private async getTodayTelemetryCount(): Promise<number> {
    const today = new Date();
    today.setHours(0, 0, 0, 0);

    return await this.telemetryRepository.count({
      where: {
        timestamp: Between(today, new Date()),
      },
    });
  }

  /**
   * Helper: Calculate device uptime
   */
  private calculateUptime(device: any): number {
    // Simplified uptime calculation
    // In production, you'd track connection/disconnection events
    return device.status === 'online' ? 100 : 0;
  }

  /**
   * Delete old analytics
   */
  async deleteOld(daysOld: number): Promise<number> {
    const cutoffDate = new Date();
    cutoffDate.setDate(cutoffDate.getDate() - daysOld);

    const result = await this.analyticsRepository
      .createQueryBuilder()
      .delete()
      .where('timestamp < :cutoffDate', { cutoffDate })
      .execute();

    return result.affected || 0;
  }
}
