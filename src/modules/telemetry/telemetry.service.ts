import {
  Injectable,
  NotFoundException,
  BadRequestException,
  ForbiddenException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import {
  Repository,
  Between,
  LessThanOrEqual,
  MoreThanOrEqual,
  In,
} from 'typeorm';
import { Telemetry } from './entities/telemetry.entity';
import { Device } from '../devices/entities/device.entity';
import { CreateTelemetryDto } from './dto/create-telemetry.dto';
import { QueryTelemetryDto } from './dto/telemetry-query.dto';
import { kafkaService } from '@/lib/kafka/kafka.service';
import { redisService } from '@/lib/redis/redis.service';

@Injectable()
export class TelemetryService {
  constructor(
    @InjectRepository(Telemetry)
    private telemetryRepository: Repository<Telemetry>,
    @InjectRepository(Device)
    private deviceRepository: Repository<Device>,
  ) {}

  /**
   * Create telemetry data for a device
   */
  async create(
    deviceKey: string,
    createTelemetryDto: CreateTelemetryDto,
  ): Promise<Telemetry> {
    // Find device
    const device = await this.deviceRepository.findOne({
      where: { deviceKey: deviceKey },
    });

    if (!device) {
      throw new NotFoundException(`Device with key ${deviceKey} not found`);
    }

    // Create telemetry record
    const telemetry = this.telemetryRepository.create({
      deviceId: device.id,
      deviceKey: device.deviceKey,
      timestamp: createTelemetryDto.timestamp
        ? new Date(createTelemetryDto.timestamp)
        : new Date(),
      data: createTelemetryDto.data,
      temperature: createTelemetryDto.temperature,
      humidity: createTelemetryDto.humidity,
      pressure: createTelemetryDto.pressure,
      latitude: createTelemetryDto.latitude,
      longitude: createTelemetryDto.longitude,
      batteryLevel: createTelemetryDto.batteryLevel,
      signalStrength: createTelemetryDto.signalStrength,
      metadata: createTelemetryDto.metadata,
      tenantId: device.tenantId,
    });

    // ============ KAFKA INTEGRATION ============
    // Publish to Kafka BEFORE saving to database
    // This allows async processing without blocking the response
    try {
      await kafkaService.sendMessage(
        'telemetry.device.raw',
        {
          deviceId: device.id,
          deviceKey: device.deviceKey,
          tenantId: device.tenantId,
          data: createTelemetryDto.data,
          temperature: createTelemetryDto.temperature,
          humidity: createTelemetryDto.humidity,
          pressure: createTelemetryDto.pressure,
          batteryLevel: createTelemetryDto.batteryLevel,
          receivedAt: Date.now(),
        },
        device.id, // Use deviceId as partition key for ordering
      );
    } catch (error) {
      console.error('Failed to publish to Kafka:', error);
      // Don't fail the request if Kafka is down
    }

    const saved = await this.telemetryRepository.save(telemetry);

    // ============ REDIS CACHING ============
    // Cache latest telemetry in Redis for fast access
    try {
      // 1. Store latest values
      await redisService.hmset(`device:${device.id}:telemetry:latest`, {
        temperature: createTelemetryDto.temperature?.toString() || '',
        humidity: createTelemetryDto.humidity?.toString() || '',
        pressure: createTelemetryDto.pressure?.toString() || '',
        batteryLevel: createTelemetryDto.batteryLevel?.toString() || '',
        timestamp: Date.now().toString(),
      });

      // 2. Add to recent readings list (keep last 100)
      await redisService.lpush(
        `telemetry:${device.id}:recent`,
        JSON.stringify({
          ...createTelemetryDto.data,
          temperature: createTelemetryDto.temperature,
          humidity: createTelemetryDto.humidity,
          timestamp: Date.now(),
        }),
      );
      await redisService.ltrim(`telemetry:${device.id}:recent`, 0, 99);
      await redisService.expire(`telemetry:${device.id}:recent`, 3600); // 1 hour

      // 3. Update device last seen
      await redisService.hset(
        `device:${device.id}:state`,
        'lastSeen',
        Date.now().toString(),
      );
    } catch (error) {
      console.error('Failed to cache in Redis:', error);
      // Don't fail the request if Redis is down
    }
    // ================================================

    // Update device activity
    await this.deviceRepository.update(
      { id: device.id },
      {
        lastActivityAt: new Date(),
        lastSeenAt: new Date(),
        messageCount: () => 'messageCount + 1',
      },
    );

    return saved;
  }

  /**
   * Create multiple telemetry records (batch insert)
   */
  async createBatch(
    deviceKey: string,
    telemetryData: CreateTelemetryDto[],
  ): Promise<Telemetry[]> {
    // Find device
    const device = await this.deviceRepository.findOne({
      where: { deviceKey },
    });

    if (!device) {
      throw new NotFoundException(`Device with key ${deviceKey} not found`);
    }

    // Create telemetry records
    const telemetryRecords = telemetryData.map((dto) =>
      this.telemetryRepository.create({
        deviceId: device.id,
        deviceKey: device.deviceKey,
        timestamp: dto.timestamp ? new Date(dto.timestamp) : new Date(),
        data: dto.data,
        temperature: dto.temperature,
        humidity: dto.humidity,
        pressure: dto.pressure,
        latitude: dto.latitude,
        longitude: dto.longitude,
        batteryLevel: dto.batteryLevel,
        signalStrength: dto.signalStrength,
        metadata: dto.metadata,
        tenantId: device.tenantId,
      }),
    );

    // ============ NEW: KAFKA BATCH INTEGRATION ============
    // Publish batch to Kafka
    try {
      const kafkaMessages = telemetryData.map((dto) => ({
        key: device.id,
        value: {
          deviceId: device.id,
          deviceKey: device.deviceKey,
          tenantId: device.tenantId,
          data: dto.data,
          temperature: dto.temperature,
          humidity: dto.humidity,
          receivedAt: Date.now(),
        },
      }));

      await kafkaService.sendBatch('telemetry.device.raw', kafkaMessages);
    } catch (error) {
      console.error('Failed to publish batch to Kafka:', error);
    }
    // ======================================================

    const saved = await this.telemetryRepository.save(telemetryRecords);

    // Update device activity
    await this.deviceRepository.update(
      { id: device.id },
      {
        lastActivityAt: new Date(),
        lastSeenAt: new Date(),
        messageCount: () => `messageCount + ${telemetryData.length}`,
      },
    );

    return saved;
  }

  /**
   * Query telemetry data for a device
   */
  async findByDevice(
    deviceId: string,
    userId: string,
    queryDto: QueryTelemetryDto,
  ): Promise<{ data: Telemetry[]; total: number }> {
    // Verify device ownership
    const device = await this.deviceRepository.findOne({
      where: { id: deviceId, userId },
    });

    if (!device) {
      throw new NotFoundException('Device not found or access denied');
    }

    const queryBuilder = this.telemetryRepository
      .createQueryBuilder('telemetry')
      .where('telemetry.deviceId = :deviceId', { deviceId });

    // Date range filter
    if (queryDto.startDate && queryDto.endDate) {
      queryBuilder.andWhere(
        'telemetry.timestamp BETWEEN :startDate AND :endDate',
        {
          startDate: new Date(queryDto.startDate),
          endDate: new Date(queryDto.endDate),
        },
      );
    } else if (queryDto.startDate) {
      queryBuilder.andWhere('telemetry.timestamp >= :startDate', {
        startDate: new Date(queryDto.startDate),
      });
    } else if (queryDto.endDate) {
      queryBuilder.andWhere('telemetry.timestamp <= :endDate', {
        endDate: new Date(queryDto.endDate),
      });
    }

    // Filter by specific data key
    if (queryDto.key) {
      queryBuilder.andWhere(`telemetry.data ? :key`, { key: queryDto.key });
    }

    // Get total count
    const total = await queryBuilder.getCount();

    // Sorting
    const order = queryDto.order === 'asc' ? 'ASC' : 'DESC';
    queryBuilder.orderBy('telemetry.timestamp', order);

    // Pagination
    queryBuilder.skip(queryDto.skip).take(queryDto.limit);

    const data = await queryBuilder.getMany();

    return { data, total };
  }

  /**
   * Get latest telemetry for a device
   */
  async getLatest(deviceId: string, userId: string): Promise<Telemetry> {
    // Verify device ownership
    const device = await this.deviceRepository.findOne({
      where: { id: deviceId, userId },
    });

    if (!device) {
      throw new NotFoundException('Device not found or access denied');
    }

    // ============ NEW: REDIS CACHE CHECK ============
    // Try to get from Redis first (much faster!)
    try {
      const cached = await redisService.hgetall(
        `device:${deviceId}:telemetry:latest`,
      );

      if (cached && Object.keys(cached).length > 0) {
        // Return cached data as Telemetry-like object
        return {
          deviceId,
          temperature: parseFloat(cached.temperature) || null,
          humidity: parseFloat(cached.humidity) || null,
          pressure: parseFloat(cached.pressure) || null,
          batteryLevel: parseFloat(cached.batteryLevel) || null,
          timestamp: new Date(parseInt(cached.timestamp)),
        } as any;
      }
    } catch (error) {
      console.error('Redis cache check failed:', error);
      // Fall through to database
    }

    const telemetry = await this.telemetryRepository.findOne({
      where: { deviceId },
      order: { timestamp: 'DESC' },
    });

    if (!telemetry) {
      throw new NotFoundException('No telemetry data found for this device');
    }

    // ============ NEW: CACHE THE RESULT ============
    // Cache the result for next time
    try {
      await redisService.hmset(`device:${deviceId}:telemetry:latest`, {
        temperature: telemetry.temperature?.toString() || '',
        humidity: telemetry.humidity?.toString() || '',
        pressure: telemetry.pressure?.toString() || '',
        batteryLevel: telemetry.batteryLevel?.toString() || '',
        timestamp: telemetry.timestamp.getTime().toString(),
      });
      await redisService.expire(`device:${deviceId}:telemetry:latest`, 300); // 5 min
    } catch (error) {
      console.error('Failed to cache result:', error);
    }

    return telemetry;
  }

  /**
   * Get telemetry statistics for a device
   */
  async getStatistics(
    deviceId: string,
    userId: string,
    startDate?: string,
    endDate?: string,
  ): Promise<any> {
    // Verify device ownership
    const device = await this.deviceRepository.findOne({
      where: { id: deviceId, userId },
    });

    if (!device) {
      throw new NotFoundException('Device not found or access denied');
    }

    const queryBuilder = this.telemetryRepository
      .createQueryBuilder('telemetry')
      .where('telemetry.deviceId = :deviceId', { deviceId });

    // Date range filter
    if (startDate && endDate) {
      queryBuilder.andWhere(
        'telemetry.timestamp BETWEEN :startDate AND :endDate',
        {
          startDate: new Date(startDate),
          endDate: new Date(endDate),
        },
      );
    }

    // Get statistics
    const stats = await queryBuilder
      .select('COUNT(*)', 'totalRecords')
      .addSelect('AVG(telemetry.temperature)', 'avgTemperature')
      .addSelect('MIN(telemetry.temperature)', 'minTemperature')
      .addSelect('MAX(telemetry.temperature)', 'maxTemperature')
      .addSelect('AVG(telemetry.humidity)', 'avgHumidity')
      .addSelect('MIN(telemetry.humidity)', 'minHumidity')
      .addSelect('MAX(telemetry.humidity)', 'maxHumidity')
      .addSelect('AVG(telemetry.pressure)', 'avgPressure')
      .addSelect('MIN(telemetry.pressure)', 'minPressure')
      .addSelect('MAX(telemetry.pressure)', 'maxPressure')
      .addSelect('AVG(telemetry.batteryLevel)', 'avgBatteryLevel')
      .addSelect('MIN(telemetry.batteryLevel)', 'minBatteryLevel')
      .addSelect('AVG(telemetry.signalStrength)', 'avgSignalStrength')
      .addSelect('MIN(telemetry.timestamp)', 'firstRecord')
      .addSelect('MAX(telemetry.timestamp)', 'lastRecord')
      .getRawOne();

    return {
      totalRecords: parseInt(stats.totalRecords) || 0,
      temperature: {
        avg: parseFloat(stats.avgTemperature) || null,
        min: parseFloat(stats.minTemperature) || null,
        max: parseFloat(stats.maxTemperature) || null,
      },
      humidity: {
        avg: parseFloat(stats.avgHumidity) || null,
        min: parseFloat(stats.minHumidity) || null,
        max: parseFloat(stats.maxHumidity) || null,
      },
      pressure: {
        avg: parseFloat(stats.avgPressure) || null,
        min: parseFloat(stats.minPressure) || null,
        max: parseFloat(stats.maxPressure) || null,
      },
      battery: {
        avg: parseFloat(stats.avgBatteryLevel) || null,
        min: parseFloat(stats.minBatteryLevel) || null,
      },
      signal: {
        avg: parseFloat(stats.avgSignalStrength) || null,
      },
      timeRange: {
        first: stats.firstRecord,
        last: stats.lastRecord,
      },
    };
  }

  /**
   * Get aggregated telemetry data (hourly, daily, monthly)
   */
  async getAggregated(
    deviceId: string,
    userId: string,
    interval: 'hour' | 'day' | 'month',
    startDate: string,
    endDate: string,
  ): Promise<any[]> {
    // Verify device ownership
    const device = await this.deviceRepository.findOne({
      where: { id: deviceId, userId },
    });

    if (!device) {
      throw new NotFoundException('Device not found or access denied');
    }

    // Determine date truncation based on interval
    let dateTrunc: string;
    switch (interval) {
      case 'hour':
        dateTrunc = 'hour';
        break;
      case 'day':
        dateTrunc = 'day';
        break;
      case 'month':
        dateTrunc = 'month';
        break;
      default:
        dateTrunc = 'hour';
    }

    // Build aggregation query
    const results = await this.telemetryRepository
      .createQueryBuilder('telemetry')
      .select(`DATE_TRUNC('${dateTrunc}', telemetry.timestamp)`, 'period')
      .addSelect('COUNT(*)', 'count')
      .addSelect('AVG(telemetry.temperature)', 'avgTemperature')
      .addSelect('MIN(telemetry.temperature)', 'minTemperature')
      .addSelect('MAX(telemetry.temperature)', 'maxTemperature')
      .addSelect('AVG(telemetry.humidity)', 'avgHumidity')
      .addSelect('MIN(telemetry.humidity)', 'minHumidity')
      .addSelect('MAX(telemetry.humidity)', 'maxHumidity')
      .addSelect('AVG(telemetry.pressure)', 'avgPressure')
      .addSelect('AVG(telemetry.batteryLevel)', 'avgBatteryLevel')
      .where('telemetry.deviceId = :deviceId', { deviceId })
      .andWhere('telemetry.timestamp BETWEEN :startDate AND :endDate', {
        startDate: new Date(startDate),
        endDate: new Date(endDate),
      })
      .groupBy('period')
      .orderBy('period', 'ASC')
      .getRawMany();

    return results.map((row) => ({
      period: row.period,
      count: parseInt(row.count),
      temperature: {
        avg: parseFloat(row.avgTemperature) || null,
        min: parseFloat(row.minTemperature) || null,
        max: parseFloat(row.maxTemperature) || null,
      },
      humidity: {
        avg: parseFloat(row.avgHumidity) || null,
        min: parseFloat(row.minHumidity) || null,
        max: parseFloat(row.maxHumidity) || null,
      },
      pressure: {
        avg: parseFloat(row.avgPressure) || null,
      },
      battery: {
        avg: parseFloat(row.avgBatteryLevel) || null,
      },
    }));
  }

  /**
   * Get time series data for a specific key
   */
  async getTimeSeries(
    deviceId: string,
    userId: string,
    key: string,
    startDate: string,
    endDate: string,
    limit: number = 1000,
  ): Promise<any[]> {
    // Verify device ownership
    const device = await this.deviceRepository.findOne({
      where: { id: deviceId, userId },
    });

    if (!device) {
      throw new NotFoundException('Device not found or access denied');
    }

    const results = await this.telemetryRepository
      .createQueryBuilder('telemetry')
      .select('telemetry.timestamp', 'timestamp')
      .addSelect(`telemetry.data->>'${key}'`, 'value')
      .where('telemetry.deviceId = :deviceId', { deviceId })
      .andWhere('telemetry.timestamp BETWEEN :startDate AND :endDate', {
        startDate: new Date(startDate),
        endDate: new Date(endDate),
      })
      .andWhere(`telemetry.data ? :key`, { key })
      .orderBy('telemetry.timestamp', 'ASC')
      .limit(limit)
      .getRawMany();

    return results.map((row) => ({
      timestamp: row.timestamp,
      value: parseFloat(row.value) || row.value,
    }));
  }

  /**
   * Delete old telemetry data (data retention)
   */
  async deleteOldData(daysToKeep: number = 90): Promise<number> {
    const cutoffDate = new Date();
    cutoffDate.setDate(cutoffDate.getDate() - daysToKeep);

    const result = await this.telemetryRepository
      .createQueryBuilder()
      .delete()
      .where('timestamp < :cutoffDate', { cutoffDate })
      .execute();

    return result.affected || 0;
  }

  /**
   * Delete telemetry data for a specific device
   */
  async deleteByDevice(deviceId: string, userId: string): Promise<number> {
    // Verify device ownership
    const device = await this.deviceRepository.findOne({
      where: { id: deviceId, userId },
    });

    if (!device) {
      throw new NotFoundException('Device not found or access denied');
    }

    const result = await this.telemetryRepository
      .createQueryBuilder()
      .delete()
      .where('deviceId = :deviceId', { deviceId })
      .execute();

    return result.affected || 0;
  }

  /**
   * Get telemetry count by device
   */
  async getCountByDevice(deviceId: string, userId: string): Promise<number> {
    // Verify device ownership
    const device = await this.deviceRepository.findOne({
      where: { id: deviceId, userId },
    });

    if (!device) {
      throw new NotFoundException('Device not found or access denied');
    }

    return await this.telemetryRepository.count({ where: { deviceId } });
  }

  /**
   * Export telemetry data as CSV
   */
  async exportToCSV(
    deviceId: string,
    userId: string,
    startDate?: string,
    endDate?: string,
  ): Promise<string> {
    const { data } = await this.findByDevice(deviceId, userId, {
      startDate,
      endDate,
      limit: 10000, // Max export limit
      skip: 0,
      order: 'asc',
    });

    if (data.length === 0) {
      return 'timestamp,data\n';
    }

    // Extract all unique keys from data objects
    const allKeys = new Set<string>();
    data.forEach((record) => {
      Object.keys(record.data || {}).forEach((key) => allKeys.add(key));
    });

    // Build CSV header
    const header = ['timestamp', 'deviceKey', ...Array.from(allKeys)].join(',');

    // Build CSV rows
    const rows = data.map((record) => {
      const values = [
        record.timestamp.toISOString(),
        record.deviceKey,
        ...Array.from(allKeys).map((key) => {
          const value = record.data?.[key];
          return value !== undefined ? value : '';
        }),
      ];
      return values.join(',');
    });

    return [header, ...rows].join('\n');
  }
}
