// src/modules/alarms/repositories/alarms.repository.ts
import { Injectable } from '@nestjs/common';
import { DataSource, Repository, Between } from 'typeorm';
import { Alarm } from '@modules/index.entities';
import { AlarmSeverity, AlarmStatus } from '@common/enums/index.enum';

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
    return await this.createQueryBuilder('alarm')
      .where('alarm.deviceId = :deviceId', { deviceId })
      .andWhere('alarm.isEnabled = :enabled', { enabled: true })
      .andWhere('alarm.status = :status', { status: AlarmStatus.ACTIVE })
      .andWhere("alarm.rule->>'telemetryKey' = :telemetryKey", { telemetryKey })
      .getMany();
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
   * Get alarm statistics for a tenant
   */
  async getTenantStatistics(tenantId: string): Promise<{
    total: number;
    active: number;
    critical: number;
    acknowledged: number;
  }> {
    const [total, active, critical, acknowledged] = await Promise.all([
      this.count({ where: { tenantId } }),
      this.count({ where: { tenantId, status: AlarmStatus.ACTIVE } }),
      this.count({
        where: {
          tenantId,
          status: AlarmStatus.ACTIVE,
          severity: AlarmSeverity.CRITICAL,
        },
      }),
      this.count({ where: { tenantId, status: AlarmStatus.ACKNOWLEDGED } }),
    ]);

    return { total, active, critical, acknowledged };
  }

  /**
   * Get alarm statistics for a customer
   */
  async getCustomerStatistics(
    tenantId: string,
    customerId: string,
  ): Promise<{
    total: number;
    active: number;
    critical: number;
    acknowledged: number;
  }> {
    const [total, active, critical, acknowledged] = await Promise.all([
      this.count({ where: { tenantId, customerId } }),
      this.count({ where: { tenantId, customerId, status: AlarmStatus.ACTIVE } }),
      this.count({
        where: {
          tenantId,
          customerId,
          status: AlarmStatus.ACTIVE,
          severity: AlarmSeverity.CRITICAL,
        },
      }),
      this.count({ where: { tenantId, customerId, status: AlarmStatus.ACKNOWLEDGED } }),
    ]);

    return { total, active, critical, acknowledged };
  }

  /**
   * Get alarm statistics for a device
   */
  async getDeviceStatistics(
    tenantId: string,
    deviceId: string,
  ): Promise<{
    total: number;
    active: number;
    critical: number;
    acknowledged: number;
  }> {
    const [total, active, critical, acknowledged] = await Promise.all([
      this.count({ where: { tenantId, deviceId } }),
      this.count({ where: { tenantId, deviceId, status: AlarmStatus.ACTIVE } }),
      this.count({
        where: {
          tenantId,
          deviceId,
          status: AlarmStatus.ACTIVE,
          severity: AlarmSeverity.CRITICAL,
        },
      }),
      this.count({ where: { tenantId, deviceId, status: AlarmStatus.ACKNOWLEDGED } }),
    ]);

    return { total, active, critical, acknowledged };
  }

  /**
   * Find alarms triggered in the last N days
   */
  async findRecentlyTriggered(
    tenantId: string,
    days: number = 7,
    customerId?: string,
  ): Promise<Alarm[]> {
    const startDate = new Date();
    startDate.setDate(startDate.getDate() - days);

    const whereCondition: any = {
      tenantId,
      triggeredAt: Between(startDate, new Date()),
    };

    if (customerId) {
      whereCondition.customerId = customerId;
    }

    return await this.find({
      where: whereCondition,
      relations: ['device'],
      order: { triggeredAt: 'DESC' },
      take: 50,
    });
  }

  /**
   * Find alarms that need to be cleared (condition no longer met)
   */
  async findClearableAlarms(deviceId: string): Promise<Alarm[]> {
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
  async getMostTriggered(
    tenantId: string,
    limit: number = 10,
    customerId?: string,
  ): Promise<Alarm[]> {
    const whereCondition: any = { tenantId };
    
    if (customerId) {
      whereCondition.customerId = customerId;
    }

    return await this.find({
      where: whereCondition,
      order: { triggerCount: 'DESC' },
      take: limit,
    });
  }

  /**
   * Count alarms by severity for a tenant
   */
  async countBySeverity(
    tenantId: string,
    customerId?: string,
  ): Promise<Record<AlarmSeverity, number>> {
    const query = this.createQueryBuilder('alarm')
      .select('alarm.severity', 'severity')
      .addSelect('COUNT(*)', 'count')
      .where('alarm.tenantId = :tenantId', { tenantId })
      .andWhere('alarm.status = :status', { status: AlarmStatus.ACTIVE })
      .groupBy('alarm.severity');

    if (customerId) {
      query.andWhere('alarm.customerId = :customerId', { customerId });
    }

    const counts = await query.getRawMany();

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

  /**
   * Find active alarms for tenant
   */
  async findActivealarms(
    tenantId: string,
    customerId?: string,
  ): Promise<Alarm[]> {
    const whereCondition: any = {
      tenantId,
      status: AlarmStatus.ACTIVE,
      isEnabled: true,
    };

    if (customerId) {
      whereCondition.customerId = customerId;
    }

    return await this.find({
      where: whereCondition,
      relations: ['device'],
      order: {
        severity: 'DESC', // CRITICAL first
        triggeredAt: 'DESC',
      },
    });
  }

  /**
   * Find unacknowledged critical alarms
   */
  async findUnacknowledgedCritical(
    tenantId: string,
    customerId?: string,
  ): Promise<Alarm[]> {
    const whereCondition: any = {
      tenantId,
      status: AlarmStatus.ACTIVE,
      severity: AlarmSeverity.CRITICAL,
      isEnabled: true,
    };

    if (customerId) {
      whereCondition.customerId = customerId;
    }

    return await this.find({
      where: whereCondition,
      relations: ['device'],
      order: { triggeredAt: 'DESC' },
    });
  }

  /**
   * Get alarms created by a specific user
   */
  async findByCreator(
    tenantId: string,
    creatorId: string,
  ): Promise<Alarm[]> {
    return await this.find({
      where: {
        tenantId,
        createdBy: creatorId,
      },
      order: { createdAt: 'DESC' },
    });
  }

  /**
   * Get alarms acknowledged by a specific user
   */
  async findByAcknowledger(
    tenantId: string,
    userId: string,
  ): Promise<Alarm[]> {
    return await this.find({
      where: {
        tenantId,
        acknowledgedBy: userId,
      },
      order: { acknowledgedAt: 'DESC' },
    });
  }

  /**
   * Get alarms resolved by a specific user
   */
  async findByResolver(
    tenantId: string,
    userId: string,
  ): Promise<Alarm[]> {
    return await this.find({
      where: {
        tenantId,
        resolvedBy: userId,
      },
      order: { resolvedAt: 'DESC' },
    });
  }

  /**
   * Count alarms by status for a tenant
   */
  async countByStatus(
    tenantId: string,
    customerId?: string,
  ): Promise<Record<AlarmStatus, number>> {
    const query = this.createQueryBuilder('alarm')
      .select('alarm.status', 'status')
      .addSelect('COUNT(*)', 'count')
      .where('alarm.tenantId = :tenantId', { tenantId })
      .groupBy('alarm.status');

    if (customerId) {
      query.andWhere('alarm.customerId = :customerId', { customerId });
    }

    const counts = await query.getRawMany();

    const result: any = {
      [AlarmStatus.ACTIVE]: 0,
      [AlarmStatus.ACKNOWLEDGED]: 0,
      [AlarmStatus.CLEARED]: 0,
      [AlarmStatus.RESOLVED]: 0,
    };

    counts.forEach((row) => {
      result[row.status] = parseInt(row.count);
    });

    return result;
  }

  /**
   * Find alarms that have been active for more than N hours
   */
  async findStaleAlarms(
    tenantId: string,
    hours: number = 24,
  ): Promise<Alarm[]> {
    const staleDate = new Date();
    staleDate.setHours(staleDate.getHours() - hours);

    return await this.createQueryBuilder('alarm')
      .where('alarm.tenantId = :tenantId', { tenantId })
      .andWhere('alarm.status = :status', { status: AlarmStatus.ACTIVE })
      .andWhere('alarm.triggeredAt < :staleDate', { staleDate })
      .getMany();
  }

  /**
   * Bulk acknowledge alarms
   */
  async bulkAcknowledge(
    alarmIds: string[],
    userId: string,
  ): Promise<void> {
    await this.createQueryBuilder()
      .update(Alarm)
      .set({
        status: AlarmStatus.ACKNOWLEDGED,
        acknowledgedAt: new Date(),
        acknowledgedBy: userId,
      })
      .where('id IN (:...alarmIds)', { alarmIds })
      .andWhere('status = :status', { status: AlarmStatus.ACTIVE })
      .execute();
  }

  /**
   * Bulk clear alarms
   */
  async bulkClear(alarmIds: string[]): Promise<void> {
    await this.createQueryBuilder()
      .update(Alarm)
      .set({
        status: AlarmStatus.CLEARED,
        clearedAt: new Date(),
      })
      .where('id IN (:...alarmIds)', { alarmIds })
      .andWhere('status IN (:...statuses)', {
        statuses: [AlarmStatus.ACTIVE, AlarmStatus.ACKNOWLEDGED],
      })
      .execute();
  }

  /**
   * Get alarm history for a device (last N alarms)
   */
  async getDeviceHistory(
    deviceId: string,
    limit: number = 20,
  ): Promise<Alarm[]> {
    return await this.find({
      where: { deviceId },
      order: { triggeredAt: 'DESC' },
      take: limit,
    });
  }
}