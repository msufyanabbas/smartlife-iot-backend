import { Injectable } from '@nestjs/common';
import { DataSource, Repository, Between } from 'typeorm';
import { Alarm, AlarmStatus, AlarmSeverity } from '../entities/alarm.entity';

/**
 * Custom repository for complex alarm queries
 * This extends TypeORM Repository with custom methods
 */
@Injectable()
export class AlarmsRepository extends Repository<Alarm> {
  constructor(private dataSource: DataSource) {
    super(Alarm, dataSource.createEntityManager());
  }

  /**
   * Find active alarms for a device with a specific telemetry key
   */
  async findActiveByDeviceAndKey(
    deviceId: string,
    telemetryKey: string,
  ): Promise<Alarm[]> {
    return await this.find({
      where: {
        deviceId,
        isEnabled: true,
        status: AlarmStatus.ACTIVE,
      },
    });
  }

  /**
   * Find all alarms that should be monitoring a specific telemetry key
   */
  async findByTelemetryKey(
    deviceId: string,
    telemetryKey: string,
  ): Promise<Alarm[]> {
    return await this.createQueryBuilder('alarm')
      .where('alarm.deviceId = :deviceId', { deviceId })
      .andWhere('alarm.isEnabled = :enabled', { enabled: true })
      .andWhere("alarm.rule->>'telemetryKey' = :telemetryKey", { telemetryKey })
      .getMany();
  }

  /**
   * Get alarm statistics for a user
   */
  async getUserStatistics(userId: string): Promise<{
    total: number;
    active: number;
    critical: number;
    acknowledged: number;
  }> {
    const [total, active, critical, acknowledged] = await Promise.all([
      this.count({ where: { userId } }),
      this.count({ where: { userId, status: AlarmStatus.ACTIVE } }),
      this.count({
        where: {
          userId,
          status: AlarmStatus.ACTIVE,
          severity: AlarmSeverity.CRITICAL,
        },
      }),
      this.count({ where: { userId, status: AlarmStatus.ACKNOWLEDGED } }),
    ]);

    return { total, active, critical, acknowledged };
  }

  /**
   * Find alarms triggered in the last N days
   */
  async findRecentlyTriggered(
    userId: string,
    days: number = 7,
  ): Promise<Alarm[]> {
    const startDate = new Date();
    startDate.setDate(startDate.getDate() - days);

    return await this.find({
      where: {
        userId,
        triggeredAt: Between(startDate, new Date()),
      },
      relations: ['device'],
      order: { triggeredAt: 'DESC' },
      take: 50,
    });
  }

  /**
   * Find alarms that need to be cleared (condition no longer met)
   */
  async findClearablealarms(deviceId: string): Promise<Alarm[]> {
    return await this.find({
      where: {
        deviceId,
        status: AlarmStatus.ACTIVE,
        autoClear: true,
      },
    });
  }

  /**
   * Get most frequently triggered alarms
   */
  async getMostTriggered(userId: string, limit: number = 10): Promise<Alarm[]> {
    return await this.find({
      where: { userId },
      order: { triggerCount: 'DESC' },
      take: limit,
    });
  }

  /**
   * Count alarms by severity
   */
  async countBySeverity(
    userId: string,
  ): Promise<Record<AlarmSeverity, number>> {
    const counts = await this.createQueryBuilder('alarm')
      .select('alarm.severity', 'severity')
      .addSelect('COUNT(*)', 'count')
      .where('alarm.userId = :userId', { userId })
      .andWhere('alarm.status = :status', { status: AlarmStatus.ACTIVE })
      .groupBy('alarm.severity')
      .getRawMany();

    const result: any = {
      [AlarmSeverity.INFO]: 0,
      [AlarmSeverity.WARNING]: 0,
      [AlarmSeverity.ERROR]: 0,
      [AlarmSeverity.CRITICAL]: 0,
    };

    counts.forEach((row) => {
      result[row.severity] = parseInt(row.count);
    });

    return result;
  }
}
