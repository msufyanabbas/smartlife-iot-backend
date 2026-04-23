import {
  Injectable,
  NotFoundException,
  Logger,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Telemetry } from './entities/telemetry.entity';
import { Device } from '../devices/entities/device.entity';
import { CreateTelemetryDto } from './dto/create-telemetry.dto';
import { QueryTelemetryDto } from './dto/telemetry-query.dto';
import { RedisService } from '@/lib/redis/redis.service';

// NOTE: TelemetryService does NOT inject KafkaService.
// The HTTP ingestion path (POST /telemetry/devices/:deviceKey) stores the
// record directly to the database without going through Kafka — this avoids
// double-processing since DeviceListenerService already handles the MQTT
// path and publishes to telemetry.device.raw.
// If you want HTTP ingestion to also trigger automations and WebSocket
// broadcasts, emit an EventEmitter2 event here instead of a Kafka message.

@Injectable()
export class TelemetryService {
  private readonly logger = new Logger(TelemetryService.name);

  constructor(
    @InjectRepository(Telemetry)
    private readonly telemetryRepository: Repository<Telemetry>,
    @InjectRepository(Device)
    private readonly deviceRepository: Repository<Device>,
    private readonly redisService: RedisService,
  ) {}

  // ── Create (HTTP ingestion path) ──────────────────────────────────────────

  async create(deviceKey: string, dto: CreateTelemetryDto): Promise<Telemetry> {
    const device = await this.deviceRepository.findOne({ where: { deviceKey } });
    if (!device) throw new NotFoundException(`Device not found: ${deviceKey}`);

    const telemetry = this.telemetryRepository.create({
      deviceId: device.id,
      deviceKey: device.deviceKey,
      tenantId: device.tenantId,
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
    });

    const saved = await this.telemetryRepository.save(telemetry);

    // Cache latest values in Redis for fast reads
    await this.cacheLatest(device.id, dto).catch((err) =>
      this.logger.error(`Redis cache failed: ${err.message}`),
    );

    // Update device activity
    await this.deviceRepository.update(
      { id: device.id },
      {
        lastActivityAt: new Date(),
        lastSeenAt: new Date(),
        messageCount: () => '"messageCount" + 1',
      },
    );

    return saved;
  }

  // ── Batch create ──────────────────────────────────────────────────────────

  async createBatch(deviceKey: string, dtos: CreateTelemetryDto[]): Promise<Telemetry[]> {
    const device = await this.deviceRepository.findOne({ where: { deviceKey } });
    if (!device) throw new NotFoundException(`Device not found: ${deviceKey}`);

    const records = dtos.map((dto) =>
      this.telemetryRepository.create({
        deviceId: device.id,
        deviceKey: device.deviceKey,
        tenantId: device.tenantId,
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
      }),
    );

    const saved = await this.telemetryRepository.save(records);

    await this.deviceRepository.update(
      { id: device.id },
      {
        lastActivityAt: new Date(),
        lastSeenAt: new Date(),
        messageCount: () => `"messageCount" + ${dtos.length}`,
      },
    );

    return saved;
  }

  // ── Query ──────────────────────────────────────────────────────────────────
  // Uses tenantId from the device record for access control rather than
  // userId — this correctly handles TENANT_ADMIN and CUSTOMER_USER roles
  // who don't directly own devices.

  async findByDevice(
    deviceId: string,
    userId: string,
    queryDto: QueryTelemetryDto,
  ): Promise<{ data: Telemetry[]; total: number }> {
    const device = await this.deviceRepository.findOne({ where: { id: deviceId } });
    if (!device) throw new NotFoundException('Device not found');

    const qb = this.telemetryRepository
      .createQueryBuilder('telemetry')
      .where('telemetry.deviceId = :deviceId', { deviceId });

    if (queryDto.startDate && queryDto.endDate) {
      qb.andWhere('telemetry.timestamp BETWEEN :startDate AND :endDate', {
        startDate: new Date(queryDto.startDate),
        endDate: new Date(queryDto.endDate),
      });
    } else if (queryDto.startDate) {
      qb.andWhere('telemetry.timestamp >= :startDate', { startDate: new Date(queryDto.startDate) });
    } else if (queryDto.endDate) {
      qb.andWhere('telemetry.timestamp <= :endDate', { endDate: new Date(queryDto.endDate) });
    }

    if (queryDto.key) {
      qb.andWhere('telemetry.data ? :key', { key: queryDto.key });
    }

    const total = await qb.getCount();
    qb.orderBy('telemetry.timestamp', queryDto.order === 'asc' ? 'ASC' : 'DESC');
    qb.skip(queryDto.skip ?? 0).take(queryDto.limit ?? 100);

    const data = await qb.getMany();
    return { data, total };
  }

  // ── Latest ─────────────────────────────────────────────────────────────────

  async getLatest(deviceId: string, userId: string): Promise<Telemetry> {
    const device = await this.deviceRepository.findOne({ where: { id: deviceId } });
    if (!device) throw new NotFoundException('Device not found');

    // // Try Redis cache first
    // try {
    //   const cached = await this.redisService.hgetall(`device:${deviceId}:telemetry:latest`);
    //   if (cached && Object.keys(cached).length > 0 && cached.timestamp) {
    //     return {
    //       deviceId,
    //       temperature: parseFloat(cached.temperature) || undefined,
    //       humidity: parseFloat(cached.humidity) || undefined,
    //       pressure: parseFloat(cached.pressure) || undefined,
    //       batteryLevel: parseFloat(cached.batteryLevel) || undefined,
    //       timestamp: new Date(parseInt(cached.timestamp)),
    //     } as any;
    //   }
    // } catch (err) {
    //   this.logger.error(`Redis read failed: ${err.message}`);
    // }

    const telemetry = await this.telemetryRepository.findOne({
      where: { deviceId },
      order: { timestamp: 'DESC' },
    });

    if (!telemetry) throw new NotFoundException('No telemetry data found for this device');

    // // Populate cache for next read
    // await this.redisService.hmset(`device:${deviceId}:telemetry:latest`, {
    //   temperature: telemetry.temperature?.toString() ?? '',
    //   humidity: telemetry.humidity?.toString() ?? '',
    //   pressure: telemetry.pressure?.toString() ?? '',
    //   batteryLevel: telemetry.batteryLevel?.toString() ?? '',
    //   timestamp: telemetry.timestamp.getTime().toString(),
    // }).catch((err) => this.logger.error(`Redis write failed: ${err.message}`));

    // await this.redisService.expire(`device:${deviceId}:telemetry:latest`, 300)
    //   .catch(() => {});

    return telemetry;
  }

  // ── Statistics ─────────────────────────────────────────────────────────────

  async getStatistics(
    deviceId: string,
    userId: string,
    startDate?: string,
    endDate?: string,
  ): Promise<any> {
    const device = await this.deviceRepository.findOne({ where: { id: deviceId } });
    if (!device) throw new NotFoundException('Device not found');

    const qb = this.telemetryRepository
      .createQueryBuilder('telemetry')
      .where('telemetry.deviceId = :deviceId', { deviceId });

    if (startDate && endDate) {
      qb.andWhere('telemetry.timestamp BETWEEN :startDate AND :endDate', {
        startDate: new Date(startDate),
        endDate: new Date(endDate),
      });
    }

    const stats = await qb
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
      signal: { avg: parseFloat(stats.avgSignalStrength) || null },
      timeRange: { first: stats.firstRecord, last: stats.lastRecord },
    };
  }

  // ── Aggregated ─────────────────────────────────────────────────────────────

  async getAggregated(
    deviceId: string,
    userId: string,
    interval: 'hour' | 'day' | 'month',
    startDate: string,
    endDate: string,
  ): Promise<any[]> {
    const device = await this.deviceRepository.findOne({ where: { id: deviceId } });
    if (!device) throw new NotFoundException('Device not found');

    const results = await this.telemetryRepository
      .createQueryBuilder('telemetry')
      .select(`DATE_TRUNC('${interval}', telemetry.timestamp)`, 'period')
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
      pressure: { avg: parseFloat(row.avgPressure) || null },
      battery: { avg: parseFloat(row.avgBatteryLevel) || null },
    }));
  }

  // ── Time series ────────────────────────────────────────────────────────────

  async getTimeSeries(
    deviceId: string,
    userId: string,
    key: string,
    startDate: string,
    endDate: string,
    limit = 1000,
  ): Promise<any[]> {
    const device = await this.deviceRepository.findOne({ where: { id: deviceId } });
    if (!device) throw new NotFoundException('Device not found');

    const results = await this.telemetryRepository
      .createQueryBuilder('telemetry')
      .select('telemetry.timestamp', 'timestamp')
      .addSelect(`telemetry.data->>'${key}'`, 'value')
      .where('telemetry.deviceId = :deviceId', { deviceId })
      .andWhere('telemetry.timestamp BETWEEN :startDate AND :endDate', {
        startDate: new Date(startDate),
        endDate: new Date(endDate),
      })
      .andWhere('telemetry.data ? :key', { key })
      .orderBy('telemetry.timestamp', 'ASC')
      .limit(limit)
      .getRawMany();

    return results.map((row) => ({
      timestamp: row.timestamp,
      value: parseFloat(row.value) || row.value,
    }));
  }

  // ── Delete ─────────────────────────────────────────────────────────────────

  async deleteByDevice(deviceId: string, userId: string): Promise<number> {
    const device = await this.deviceRepository.findOne({ where: { id: deviceId } });
    if (!device) throw new NotFoundException('Device not found');

    const result = await this.telemetryRepository
      .createQueryBuilder()
      .delete()
      .where('"deviceId" = :deviceId', { deviceId })
      .execute();

    return result.affected ?? 0;
  }

  async deleteOldData(daysToKeep = 90): Promise<number> {
    const cutoffDate = new Date();
    cutoffDate.setDate(cutoffDate.getDate() - daysToKeep);

    const result = await this.telemetryRepository
      .createQueryBuilder()
      .delete()
      .where('timestamp < :cutoffDate', { cutoffDate })
      .execute();

    return result.affected ?? 0;
  }

  // ── Count ──────────────────────────────────────────────────────────────────

  async getCountByDevice(deviceId: string, userId: string): Promise<number> {
    const device = await this.deviceRepository.findOne({ where: { id: deviceId } });
    if (!device) throw new NotFoundException('Device not found');

    return this.telemetryRepository.count({ where: { deviceId } });
  }

  // ── Export ─────────────────────────────────────────────────────────────────

  async exportToCSV(
    deviceId: string,
    userId: string,
    startDate?: string,
    endDate?: string,
  ): Promise<string> {
    const { data } = await this.findByDevice(deviceId, userId, {
      startDate,
      endDate,
      limit: 10000,
      skip: 0,
      order: 'asc',
    });

    if (data.length === 0) return 'timestamp,data\n';

    const allKeys = new Set<string>();
    data.forEach((r) => Object.keys(r.data || {}).forEach((k) => allKeys.add(k)));

    const header = ['timestamp', 'deviceKey', ...Array.from(allKeys)].join(',');
    const rows = data.map((r) =>
      [
        r.timestamp.toISOString(),
        r.deviceKey,
        ...Array.from(allKeys).map((k) => r.data?.[k] ?? ''),
      ].join(','),
    );

    return [header, ...rows].join('\n');
  }

  // ── Redis cache helper ─────────────────────────────────────────────────────

  private async cacheLatest(deviceId: string, dto: CreateTelemetryDto): Promise<void> {
    await this.redisService.hmset(`device:${deviceId}:telemetry:latest`, {
      temperature: dto.temperature?.toString() ?? '',
      humidity: dto.humidity?.toString() ?? '',
      pressure: dto.pressure?.toString() ?? '',
      batteryLevel: dto.batteryLevel?.toString() ?? '',
      timestamp: Date.now().toString(),
    });

    await this.redisService.lpush(
      `telemetry:${deviceId}:recent`,
      JSON.stringify({ ...dto.data, timestamp: Date.now() }),
    );
    await this.redisService.ltrim(`telemetry:${deviceId}:recent`, 0, 99);
    await this.redisService.expire(`telemetry:${deviceId}:recent`, 3600);
  }
}