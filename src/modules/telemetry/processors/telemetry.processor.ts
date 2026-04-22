import { Processor, Process } from '@nestjs/bull';
import { Logger } from '@nestjs/common';
import type { Job } from 'bull';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Telemetry } from '../entities/telemetry.entity';
import { AlarmsService } from '../../alarms/alarms.service';

// NOTE: This processor requires BullModule to be registered in TelemetryModule:
//   BullModule.registerQueue({ name: 'telemetry' })
// without it NestJS will throw at startup.

@Processor('telemetry')
export class TelemetryProcessor {
  private readonly logger = new Logger(TelemetryProcessor.name);

  constructor(
    @InjectRepository(Telemetry)
    private readonly telemetryRepository: Repository<Telemetry>,
    private readonly eventEmitter: EventEmitter2,
    private readonly alarmsService: AlarmsService,
  ) {}

  @Process('process-telemetry')
  async processTelemetry(
    job: Job<{ deviceId: string; data: Record<string, any>; timestamp: Date }>,
  ): Promise<void> {
    const { deviceId, data, timestamp } = job.data;
    this.logger.debug(`Processing telemetry for device ${deviceId}`);

    try {
      for (const [key, value] of Object.entries(data)) {
        if (typeof value === 'number') {
          await this.alarmsService.checkAlarmConditions(deviceId, key, value);
        }
      }

      this.eventEmitter.emit('telemetry.processed', { deviceId, data, timestamp });
    } catch (error) {
      this.logger.error(
        `Failed to process telemetry for device ${deviceId}: ${(error as Error).message}`,
      );
      throw error; // triggers Bull retry
    }
  }

  @Process('aggregate-telemetry')
  async aggregateTelemetry(
    job: Job<{ deviceId: string; interval: 'hour' | 'day'; timestamp: Date }>,
  ): Promise<void> {
    const { deviceId, interval, timestamp } = job.data;
    this.logger.log(`Aggregating telemetry for device ${deviceId} at interval ${interval}`);

    try {
      const startTime = this.getIntervalStart(timestamp, interval);
      const endTime = this.getIntervalEnd(timestamp, interval);

      const telemetry = await this.telemetryRepository.find({
        where: { deviceId },
        order: { timestamp: 'ASC' },
      });

      if (telemetry.length === 0) return;

      const aggregated = this.aggregateData(telemetry);

      this.eventEmitter.emit('telemetry.aggregated', {
        deviceId,
        interval,
        startTime,
        endTime,
        aggregated,
      });
    } catch (error) {
      this.logger.error(
        `Failed to aggregate telemetry for device ${deviceId}: ${(error as Error).message}`,
      );
      throw error;
    }
  }

  @Process('cleanup-telemetry')
  async cleanupTelemetry(job: Job<{ daysOld: number }>): Promise<{ deletedCount: number }> {
    const { daysOld } = job.data;
    this.logger.log(`Cleaning up telemetry older than ${daysOld} days`);

    const cutoffDate = new Date();
    cutoffDate.setDate(cutoffDate.getDate() - daysOld);

    const result = await this.telemetryRepository
      .createQueryBuilder()
      .delete()
      .from(Telemetry)
      .where('timestamp < :cutoffDate', { cutoffDate })
      .execute();

    const deletedCount = result.affected ?? 0;
    this.logger.log(`Deleted ${deletedCount} old telemetry records`);

    this.eventEmitter.emit('telemetry.cleaned', { deletedCount, daysOld, cutoffDate });
    return { deletedCount };
  }

  @Process('calculate-statistics')
  async calculateStatistics(
    job: Job<{ deviceId: string; period: 'daily' | 'weekly' | 'monthly' }>,
  ): Promise<any> {
    const { deviceId, period } = job.data;
    this.logger.log(`Calculating ${period} statistics for device ${deviceId}`);

    const { startDate, endDate } = this.getPeriodRange(period);

    const telemetry = await this.telemetryRepository.find({
      where: { deviceId },
      order: { timestamp: 'ASC' },
    });

    if (telemetry.length === 0) return null;

    const statistics = this.aggregateData(telemetry);

    this.eventEmitter.emit('telemetry.statistics', {
      deviceId,
      period,
      startDate,
      endDate,
      statistics,
    });

    return statistics;
  }

  // ── batchProcess removed ───────────────────────────────────────────────────
  // The original implementation called this.processTelemetry({ data: record } as Job)
  // which passes a fake Job object — all Job fields except .data are undefined,
  // causing Bull to throw. If you need batch processing, enqueue individual
  // 'process-telemetry' jobs for each record instead:
  //
  //   for (const record of batch) {
  //     await this.telemetryQueue.add('process-telemetry', record);
  //   }

  // ── Helpers ────────────────────────────────────────────────────────────────

  private getIntervalStart(timestamp: Date, interval: 'hour' | 'day'): Date {
    const date = new Date(timestamp);
    if (interval === 'hour') date.setMinutes(0, 0, 0);
    else date.setHours(0, 0, 0, 0);
    return date;
  }

  private getIntervalEnd(timestamp: Date, interval: 'hour' | 'day'): Date {
    const date = this.getIntervalStart(timestamp, interval);
    if (interval === 'hour') date.setHours(date.getHours() + 1);
    else date.setDate(date.getDate() + 1);
    return date;
  }

  private aggregateData(telemetry: Telemetry[]): Record<string, any> {
    const aggregated: Record<string, any> = {};
    const keys = new Set<string>();

    telemetry.forEach((t) => Object.keys(t.data).forEach((k) => keys.add(k)));

    keys.forEach((key) => {
      const values = telemetry
        .map((t) => t.data[key])
        .filter((v): v is number => typeof v === 'number');

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

  private getPeriodRange(period: 'daily' | 'weekly' | 'monthly'): {
    startDate: Date;
    endDate: Date;
  } {
    const endDate = new Date();
    const startDate = new Date();

    if (period === 'daily') startDate.setDate(startDate.getDate() - 1);
    else if (period === 'weekly') startDate.setDate(startDate.getDate() - 7);
    else startDate.setMonth(startDate.getMonth() - 1);

    return { startDate, endDate };
  }
}