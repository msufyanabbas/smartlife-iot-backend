import { Processor, Process } from '@nestjs/bull';
import { Logger } from '@nestjs/common';
import type { Job } from 'bull';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Telemetry } from '../entities/telemetry.entity';
import { AlarmsService } from '../../alarms/alarms.service';

/**
 * Background processor for telemetry data
 * Handles:
 * - Data aggregation
 * - Alarm condition checking
 * - Data cleanup
 * - Analytics processing
 */
@Processor('telemetry')
export class TelemetryProcessor {
  private readonly logger = new Logger(TelemetryProcessor.name);

  constructor(
    @InjectRepository(Telemetry)
    private telemetryRepository: Repository<Telemetry>,
    private eventEmitter: EventEmitter2,
    private alarmsService: AlarmsService,
  ) {}

  /**
   * Process incoming telemetry data
   * Checks alarm conditions for each telemetry key
   */
  @Process('process-telemetry')
  async processTelemetry(
    job: Job<{
      deviceId: string;
      data: Record<string, any>;
      timestamp: Date;
    }>,
  ) {
    const { deviceId, data, timestamp } = job.data;

    this.logger.debug(
      `Processing telemetry for device ${deviceId}: ${JSON.stringify(data)}`,
    );

    try {
      // Check alarm conditions for each telemetry key
      for (const [key, value] of Object.entries(data)) {
        if (typeof value === 'number') {
          await this.alarmsService.checkAlarmConditions(deviceId, key, value);
        }
      }

      // Emit event for successful processing
      this.eventEmitter.emit('telemetry.processed', {
        deviceId,
        data,
        timestamp,
      });

      this.logger.debug(
        `Successfully processed telemetry for device ${deviceId}`,
      );
    } catch (error) {
      this.logger.error(
        `Failed to process telemetry for device ${deviceId}: ${error.message}`,
      );
      throw error; // Will trigger retry
    }
  }

  /**
   * Aggregate telemetry data
   * Runs periodically to create summaries
   */
  @Process('aggregate-telemetry')
  async aggregateTelemetry(
    job: Job<{
      deviceId: string;
      interval: 'hour' | 'day';
      timestamp: Date;
    }>,
  ) {
    const { deviceId, interval, timestamp } = job.data;

    this.logger.log(
      `Aggregating telemetry for device ${deviceId} at interval ${interval}`,
    );

    try {
      // Get telemetry for the interval
      const startTime = this.getIntervalStart(timestamp, interval);
      const endTime = this.getIntervalEnd(timestamp, interval);

      const telemetry = await this.telemetryRepository.find({
        where: {
          deviceId,
        },
        order: { timestamp: 'ASC' },
      });

      if (telemetry.length === 0) {
        this.logger.debug(`No telemetry data found for aggregation`);
        return;
      }

      // Aggregate data
      const aggregated = this.aggregateData(telemetry);

      // Emit event with aggregated data
      this.eventEmitter.emit('telemetry.aggregated', {
        deviceId,
        interval,
        startTime,
        endTime,
        aggregated,
      });

      this.logger.log(
        `Successfully aggregated telemetry for device ${deviceId}`,
      );
    } catch (error) {
      this.logger.error(
        `Failed to aggregate telemetry for device ${deviceId}: ${error.message}`,
      );
      throw error;
    }
  }

  /**
   * Clean up old telemetry data
   */
  @Process('cleanup-telemetry')
  async cleanupTelemetry(
    job: Job<{
      daysOld: number;
    }>,
  ) {
    const { daysOld } = job.data;

    this.logger.log(`Cleaning up telemetry older than ${daysOld} days`);

    try {
      const cutoffDate = new Date();
      cutoffDate.setDate(cutoffDate.getDate() - daysOld);

      const result = await this.telemetryRepository
        .createQueryBuilder()
        .delete()
        .from(Telemetry)
        .where('timestamp < :cutoffDate', { cutoffDate })
        .execute();

      const deletedCount = result.affected || 0;

      this.logger.log(`Deleted ${deletedCount} old telemetry records`);

      // Emit event
      this.eventEmitter.emit('telemetry.cleaned', {
        deletedCount,
        daysOld,
        cutoffDate,
      });

      return { deletedCount };
    } catch (error) {
      this.logger.error(`Failed to cleanup telemetry: ${error.message}`);
      throw error;
    }
  }

  /**
   * Calculate device statistics
   */
  @Process('calculate-statistics')
  async calculateStatistics(
    job: Job<{
      deviceId: string;
      period: 'daily' | 'weekly' | 'monthly';
    }>,
  ) {
    const { deviceId, period } = job.data;

    this.logger.log(`Calculating ${period} statistics for device ${deviceId}`);

    try {
      const { startDate, endDate } = this.getPeriodRange(period);

      // Get telemetry for the period
      const telemetry = await this.telemetryRepository.find({
        where: {
          deviceId,
        },
        order: { timestamp: 'ASC' },
      });

      if (telemetry.length === 0) {
        return null;
      }

      // Calculate statistics
      const statistics = this.calculateStats(telemetry);

      // Emit event
      this.eventEmitter.emit('telemetry.statistics', {
        deviceId,
        period,
        startDate,
        endDate,
        statistics,
      });

      return statistics;
    } catch (error) {
      this.logger.error(
        `Failed to calculate statistics for device ${deviceId}: ${error.message}`,
      );
      throw error;
    }
  }

  /**
   * Batch process multiple telemetry records
   */
  @Process('batch-process')
  async batchProcess(
    job: Job<{
      batch: Array<{
        deviceId: string;
        data: Record<string, any>;
        timestamp: Date;
      }>;
    }>,
  ) {
    const { batch } = job.data;

    this.logger.log(`Batch processing ${batch.length} telemetry records`);

    try {
      for (const record of batch) {
        await this.processTelemetry({
          data: record,
        } as Job);
      }

      this.logger.log(`Successfully batch processed ${batch.length} records`);
    } catch (error) {
      this.logger.error(`Failed to batch process telemetry: ${error.message}`);
      throw error;
    }
  }

  /**
   * Helper: Get interval start time
   */
  private getIntervalStart(timestamp: Date, interval: 'hour' | 'day'): Date {
    const date = new Date(timestamp);

    if (interval === 'hour') {
      date.setMinutes(0, 0, 0);
    } else if (interval === 'day') {
      date.setHours(0, 0, 0, 0);
    }

    return date;
  }

  /**
   * Helper: Get interval end time
   */
  private getIntervalEnd(timestamp: Date, interval: 'hour' | 'day'): Date {
    const date = this.getIntervalStart(timestamp, interval);

    if (interval === 'hour') {
      date.setHours(date.getHours() + 1);
    } else if (interval === 'day') {
      date.setDate(date.getDate() + 1);
    }

    return date;
  }

  /**
   * Helper: Aggregate data
   */
  private aggregateData(telemetry: Telemetry[]): Record<string, any> {
    const aggregated: Record<string, any> = {};
    const keys = new Set<string>();

    // Collect all keys
    telemetry.forEach((t) => {
      Object.keys(t.data).forEach((key) => keys.add(key));
    });

    // Calculate aggregations for each key
    keys.forEach((key) => {
      const values = telemetry
        .map((t) => t.data[key])
        .filter((v) => typeof v === 'number');

      if (values.length > 0) {
        aggregated[key] = {
          min: Math.min(...values),
          max: Math.max(...values),
          avg: values.reduce((a, b) => a + b, 0) / values.length,
          count: values.length,
        };
      }
    });

    return aggregated;
  }

  /**
   * Helper: Get period range
   */
  private getPeriodRange(period: 'daily' | 'weekly' | 'monthly'): {
    startDate: Date;
    endDate: Date;
  } {
    const endDate = new Date();
    const startDate = new Date();

    if (period === 'daily') {
      startDate.setDate(startDate.getDate() - 1);
    } else if (period === 'weekly') {
      startDate.setDate(startDate.getDate() - 7);
    } else if (period === 'monthly') {
      startDate.setMonth(startDate.getMonth() - 1);
    }

    return { startDate, endDate };
  }

  /**
   * Helper: Calculate statistics
   */
  private calculateStats(telemetry: Telemetry[]): Record<string, any> {
    return this.aggregateData(telemetry);
  }
}
