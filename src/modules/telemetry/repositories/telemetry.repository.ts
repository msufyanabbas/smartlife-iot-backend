import { Injectable } from '@nestjs/common';
import { DataSource, Repository, Between, MoreThan, LessThan } from 'typeorm';
import { Telemetry } from '../entities/telemetry.entity';

/**
 * Custom repository for complex telemetry queries
 */
@Injectable()
export class TelemetryRepository extends Repository<Telemetry> {
  constructor(private dataSource: DataSource) {
    super(Telemetry, dataSource.createEntityManager());
  }

  /**
   * Get latest telemetry for device
   */
  async getLatest(deviceId: string): Promise<Record<string, any>> {
    const result = await this.createQueryBuilder('telemetry')
      .select('telemetry.data')
      .where('telemetry.deviceId = :deviceId', { deviceId })
      .orderBy('telemetry.timestamp', 'DESC')
      .limit(1)
      .getOne();

    return result?.data || {};
  }

  /**
   * Get telemetry aggregated by time interval
   */
  async getAggregated(
    deviceId: string,
    key: string,
    aggregation: 'avg' | 'sum' | 'min' | 'max' | 'count',
    interval: 'minute' | 'hour' | 'day' | 'week' | 'month',
    startDate: Date,
    endDate: Date,
  ): Promise<Array<{ timestamp: Date; value: number }>> {
    const intervalMap = {
      minute: '1 minute',
      hour: '1 hour',
      day: '1 day',
      week: '1 week',
      month: '1 month',
    };

    const aggMap = {
      avg: 'AVG',
      sum: 'SUM',
      min: 'MIN',
      max: 'MAX',
      count: 'COUNT',
    };

    const query = `
      SELECT 
        date_trunc($1, timestamp) as timestamp,
        ${aggMap[aggregation]}((data->>$2)::numeric) as value
      FROM telemetry
      WHERE "deviceId" = $3
        AND timestamp BETWEEN $4 AND $5
        AND data ? $2
      GROUP BY date_trunc($1, timestamp)
      ORDER BY timestamp ASC
    `;

    const results = await this.query(query, [
      interval,
      key,
      deviceId,
      startDate,
      endDate,
    ]);

    return results.map((row) => ({
      timestamp: row.timestamp,
      value: parseFloat(row.value) || 0,
    }));
  }

  /**
   * Get telemetry keys for a device
   */
  async getKeys(deviceId: string): Promise<string[]> {
    const result = await this.createQueryBuilder('telemetry')
      .select('DISTINCT jsonb_object_keys(data)', 'key')
      .where('telemetry.deviceId = :deviceId', { deviceId })
      .getRawMany();

    return result.map((row) => row.key);
  }

  /**
   * Delete old telemetry data
   */
  async deleteOld(daysOld: number): Promise<number> {
    const cutoffDate = new Date();
    cutoffDate.setDate(cutoffDate.getDate() - daysOld);

    const result = await this.createQueryBuilder()
      .delete()
      .from(Telemetry)
      .where('timestamp < :cutoffDate', { cutoffDate })
      .execute();

    return result.affected || 0;
  }

  /**
   * Get telemetry statistics
   */
  async getStatistics(
    deviceId: string,
    key: string,
    hours: number = 24,
  ): Promise<{
    min: number;
    max: number;
    avg: number;
    count: number;
  }> {
    const startDate = new Date();
    startDate.setHours(startDate.getHours() - hours);

    const result = await this.createQueryBuilder('telemetry')
      .select(
        `
        MIN((data->>:key)::numeric) as min,
        MAX((data->>:key)::numeric) as max,
        AVG((data->>:key)::numeric) as avg,
        COUNT(*) as count
      `,
      )
      .where('telemetry.deviceId = :deviceId', { deviceId })
      .andWhere('telemetry.timestamp >= :startDate', { startDate })
      .andWhere('data ? :key')
      .setParameter('key', key)
      .getRawOne();

    return {
      min: parseFloat(result.min) || 0,
      max: parseFloat(result.max) || 0,
      avg: parseFloat(result.avg) || 0,
      count: parseInt(result.count) || 0,
    };
  }

  /**
   * Batch insert telemetry data
   */
  async batchInsert(telemetryData: Partial<Telemetry>[]): Promise<void> {
    if (telemetryData.length === 0) return;

    await this.createQueryBuilder()
      .insert()
      .into(Telemetry)
      .values(telemetryData)
      .execute();
  }

  /**
   * Get telemetry trend (increasing/decreasing)
   */
  async getTrend(
    deviceId: string,
    key: string,
    hours: number = 1,
  ): Promise<'increasing' | 'decreasing' | 'stable'> {
    const endDate = new Date();
    const startDate = new Date();
    startDate.setHours(startDate.getHours() - hours);

    const result = await this.createQueryBuilder('telemetry')
      .select(
        `
        AVG(CASE WHEN timestamp >= :midpoint THEN (data->>:key)::numeric END) as recent_avg,
        AVG(CASE WHEN timestamp < :midpoint THEN (data->>:key)::numeric END) as past_avg
      `,
      )
      .where('telemetry.deviceId = :deviceId', { deviceId })
      .andWhere('telemetry.timestamp BETWEEN :startDate AND :endDate', {
        startDate,
        endDate,
      })
      .andWhere('data ? :key')
      .setParameter('key', key)
      .setParameter(
        'midpoint',
        new Date((startDate.getTime() + endDate.getTime()) / 2),
      )
      .getRawOne();

    const recentAvg = parseFloat(result.recent_avg) || 0;
    const pastAvg = parseFloat(result.past_avg) || 0;
    const threshold = 0.05; // 5% change threshold

    if (recentAvg > pastAvg * (1 + threshold)) return 'increasing';
    if (recentAvg < pastAvg * (1 - threshold)) return 'decreasing';
    return 'stable';
  }
}
