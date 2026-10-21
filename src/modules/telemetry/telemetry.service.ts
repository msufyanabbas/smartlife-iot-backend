import {
  Injectable,
  NotFoundException,
  Logger,
  Inject,
  forwardRef,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Telemetry } from './entities/telemetry.entity';
import { Device } from '../devices/entities/device.entity';
import { CreateTelemetryDto } from './dto/create-telemetry.dto';
import { QueryTelemetryDto } from './dto/telemetry-query.dto';
import { RedisService } from '@/lib/redis/redis.service';
import { DeviceStatus, UserRole } from '@common/enums/index.enum';
import { ProfileAlarmService } from '@modules/profiles/profile-alarm.service';
import { IntegrationDispatchService } from '@modules/integrations/integration-dispatch.service';
import { AutomationService } from '@modules/automation/automation.service';
import { TelemetryRollupService } from './telemetry-rollup.service';
import { TelemetryRetentionService } from './telemetry-retention.service';
import { TelemetryLatestCacheService } from './telemetry-latest-cache.service';

/** Role and scope of the caller, for the device access check below. */
interface CallerScope {
  role: UserRole;
  tenantId: string | null;
  customerId: string | null;
}
import type { TelemetryRollupGranularity } from './entities/telemetry-rollup.entity';

// NOTE: TelemetryService does NOT inject KafkaService.
// The HTTP ingestion path (POST /telemetry/devices/:deviceKey) stores the
// record directly to the database without going through Kafka — this avoids
// double-processing since DeviceListenerService already handles the MQTT
// path and publishes to telemetry.device.raw.
// If you want HTTP ingestion to also trigger automations and WebSocket
// broadcasts, emit an EventEmitter2 event here instead of a Kafka message.
//
// Because this path skips Kafka it also skips TelemetryConsumer, which is
// where device-profile alarm rules are evaluated and where outbound
// integrations are dispatched. Both are therefore invoked directly below —
// without them, a device ingesting over HTTP would never fire its profile's
// alarm rules and never reach an external integration. Automations are
// likewise invoked directly (evaluateTelemetryTriggers) - the Kafka path
// reaches them through AutomationConsumer instead, so the two never both
// fire for the same frame. The WebSocket broadcast and the rule-engine
// forward remain Kafka-only.

@Injectable()
export class TelemetryService {
  private readonly logger = new Logger(TelemetryService.name);

  constructor(
    @InjectRepository(Telemetry)
    private readonly telemetryRepository: Repository<Telemetry>,
    @InjectRepository(Device)
    private readonly deviceRepository: Repository<Device>,
    // Retained but no longer used by this class: the latest-reading cache
    // moved to TelemetryLatestCacheService (it has to be shared with
    // TelemetryConsumer, the other writer). Kept because this module's cron
    // service needs a distributed lock and will take it from here.
    private readonly redisService: RedisService,
    // Sole owner of the `telemetry:latest:*` key — see that class for why the
    // cache cannot live in this service.
    private readonly latestCache: TelemetryLatestCacheService,
    // Provided by ProfilesModule, already imported by TelemetryModule.
    private readonly profileAlarmService: ProfileAlarmService,
    // Provided by IntegrationsModule, already imported by TelemetryModule.
    // No forwardRef: IntegrationsModule imports only TypeOrmModule and
    // HttpModule, so there is no cycle back to TelemetryModule.
    private readonly integrationDispatchService: IntegrationDispatchService,
    // forwardRef: AutomationModule imports nothing from TelemetryModule today,
    // but TelemetryModule -> AutomationModule -> AttributesModule -> Telemetry
    // repository is close enough to a cycle to be worth guarding.
    @Inject(forwardRef(() => AutomationService))
    private readonly automationService: InstanceType<typeof AutomationService>,
    // Both are providers of TelemetryModule itself and depend on nothing from
    // TelemetryService, so no forwardRef is needed in either direction.
    private readonly rollupService: TelemetryRollupService,
    private readonly retentionService: TelemetryRetentionService,
  ) {}

  /**
   * Device columns to touch after an inbound message.
   *
   * A device sending data is by definition reachable, so INACTIVE (never seen)
   * and OFFLINE (went quiet) both return to ACTIVE. Any other status —
   * MAINTENANCE, ERROR — is operator-set and left alone.
   *
   * DeviceStatus has no 'online' member; ACTIVE is the reachable state and
   * checkOfflineDevices() is what moves it back to OFFLINE after 5 minutes
   * of silence.
   */
  private activityPatch(device: Device, messageCount: number) {
    const revived =
      device.status === DeviceStatus.INACTIVE ||
      device.status === DeviceStatus.OFFLINE;

    return {
      lastActivityAt: new Date(),
      lastSeenAt: new Date(),
      messageCount: () => `"messageCount" + ${messageCount}`,
      status: revived ? DeviceStatus.ACTIVE : device.status,
      ...(revived && !device.activatedAt ? { activatedAt: new Date() } : {}),
    };
  }

  /**
   * Evaluate the device profile's alarm rules for an HTTP-ingested reading.
   *
   * Never throws: an alarm-rule problem must not fail the ingestion request
   * and cause the device to retry a reading that was already stored.
   */
  private async evaluateProfileAlarms(
    deviceId: string,
    data: Record<string, any> | undefined,
  ): Promise<void> {
    try {
      await this.profileAlarmService.evaluateProfileAlarmRules(
        deviceId,
        data ?? {},
      );
    } catch (err) {
      this.logger.error(
        `Device profile alarm check failed for ${deviceId}: ${(err as Error).message}`,
      );
    }
  }

  /**
   * Fan the reading out to the tenant's external integrations.
   *
   * Mirrors step 3b of TelemetryConsumer.handleMessage(), which is the Kafka
   * path's equivalent. Deferred with setImmediate() so the dispatcher's own
   * device/integration lookups start after the ingestion response has been
   * returned — a slow or unreachable third-party endpoint must never show up
   * in the device's request latency.
   */
  private dispatchToIntegrations(
    device: Device,
    saved: Telemetry,
    data: Record<string, any> | undefined,
  ): void {
    setImmediate(() => {
      this.integrationDispatchService
        .dispatchTelemetry({
          deviceId: saved.deviceId,
          deviceKey: device.deviceKey,
          tenantId: saved.tenantId,
          deviceType: device.type,
          assetId: device.assetId,
          data: data ?? {},
          timestamp: saved.timestamp,
        })
        .catch((err) =>
          this.logger.error(`Integration dispatch error: ${err.message}`),
        );
    });
  }

  /**
   * Fire-and-forget so a slow action (a webhook, a delayed action) never
   * lengthens the ingestion response. The service swallows its own errors;
   * the catch is a backstop against an unhandled rejection.
   */
  private dispatchToAutomations(
    deviceId: string,
    tenantId: string,
    data: Record<string, any>,
  ): void {
    setImmediate(() => {
      this.automationService
        .evaluateTelemetryTriggers(deviceId, tenantId, data ?? {})
        .catch((err) =>
          this.logger.error(`Automation trigger eval failed: ${err.message}`),
        );
    });
  }

  // ── Create (HTTP ingestion path) ──────────────────────────────────────────

  async create(deviceKey: string, dto: CreateTelemetryDto): Promise<Telemetry> {
    const device = await this.deviceRepository.findOne({
      where: { deviceKey },
    });
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

    // Write-through cache of the latest reading. `saved`, not `dto`: the row
    // is what `getLatest()` returns, and it carries the id, deviceKey and
    // server-assigned timestamp the DTO does not have.
    //
    // The .catch() keeps a Redis outage from failing an ingest that has
    // already been committed to Postgres — a cache write is never allowed to
    // lose a reading.
    await this.cacheLatest(device.id, saved).catch((err) =>
      this.logger.error(`Redis cache failed: ${err.message}`),
    );

    // Update device activity
    await this.deviceRepository.update(
      { id: device.id },
      this.activityPatch(device, 1),
    );

    await this.evaluateProfileAlarms(device.id, dto.data);

    // Was a `logger.log` on every reading, left behind from verifying the
    // dispatch path — one line per telemetry point per device. Debug level, so
    // it is available when someone is looking and silent otherwise.
    this.logger.debug(
      `Dispatching to integrations for device ${saved.deviceId}`,
    );
    this.dispatchToIntegrations(device, saved, dto.data);

    this.dispatchToAutomations(device.id, device.tenantId, dto.data);

    return saved;
  }

  // ── Batch create ──────────────────────────────────────────────────────────

  async createBatch(
    deviceKey: string,
    dtos: CreateTelemetryDto[],
  ): Promise<Telemetry[]> {
    const device = await this.deviceRepository.findOne({
      where: { deviceKey },
    });
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
      this.activityPatch(device, dtos.length),
    );

    // Only the newest reading in the batch is evaluated — alarm rules are
    // level checks against current state, and replaying an entire backfill
    // would flap the alarm through every historical value.
    // Guarded: reduce() with no initial value throws on an empty array.
    if (dtos.length > 0) {
      const newest = dtos.reduce((latest, dto) =>
        new Date(dto.timestamp ?? 0) > new Date(latest.timestamp ?? 0)
          ? dto
          : latest,
      );

      await this.evaluateProfileAlarms(device.id, newest.data);

      // Same reasoning as the alarm check above: replaying a whole backfill
      // through the automation engine would re-fire every action per record.
      this.dispatchToAutomations(device.id, device.tenantId, newest.data);
    }

    // Unlike alarms, every record is dispatched: an integration forwarding to
    // a warehouse wants the whole series, not just the newest reading. Note
    // that Integration.rateLimiting (if enabled) throttles a large batch and
    // drops the overflow with a warning.
    saved.forEach((record, i) =>
      this.dispatchToIntegrations(device, record, dtos[i]?.data),
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
    const device = await this.resolveDeviceForUser(deviceId, userId);

    const qb = this.telemetryRepository
      .createQueryBuilder('telemetry')
      .where('telemetry.deviceId = :deviceId', { deviceId });

    if (queryDto.startDate && queryDto.endDate) {
      qb.andWhere('telemetry.timestamp BETWEEN :startDate AND :endDate', {
        startDate: new Date(queryDto.startDate),
        endDate: new Date(queryDto.endDate),
      });
    } else if (queryDto.startDate) {
      qb.andWhere('telemetry.timestamp >= :startDate', {
        startDate: new Date(queryDto.startDate),
      });
    } else if (queryDto.endDate) {
      qb.andWhere('telemetry.timestamp <= :endDate', {
        endDate: new Date(queryDto.endDate),
      });
    }

    if (queryDto.key) {
      qb.andWhere('telemetry.data ? :key', { key: queryDto.key });
    }

    const total = await qb.getCount();
    qb.orderBy(
      'telemetry.timestamp',
      queryDto.order === 'asc' ? 'ASC' : 'DESC',
    );
    qb.skip(queryDto.skip ?? 0).take(queryDto.limit ?? 100);

    const data = await qb.getMany();
    return { data, total };
  }

  // ── Latest ─────────────────────────────────────────────────────────────────

  /**
   * The device's most recent reading.
   *
   * This is the hottest read on the platform: every dashboard tile, every
   * floor-plan marker and every device-detail header polls it, so a tenant
   * with 100 devices on screen generates 100 of these per refresh. The query
   * it replaces is `ORDER BY timestamp DESC LIMIT 1` over the largest table in
   * the schema.
   *
   * ── The access check is NOT cached, deliberately ──────────────────────────
   *
   * `resolveDeviceForUser()` runs first and unconditionally. It is what stops
   * one tenant reading another's telemetry by uuid (§4g), and it is the one
   * thing in this method that must never be served from a cache: a cached
   * authorization decision that outlives an unassignment is a cross-tenant
   * read. Only the reading itself comes from Redis, and only after the caller
   * has been shown to be entitled to this device.
   */
  async getLatest(deviceId: string, userId: string): Promise<Telemetry> {
    const device = await this.resolveDeviceForUser(deviceId, userId);

    const cached = await this.latestCache.read(device.id);
    if (cached) return cached;

    const telemetry = await this.telemetryRepository.findOne({
      where: { deviceId },
      order: { timestamp: 'DESC' },
    });

    if (!telemetry)
      throw new NotFoundException('No telemetry data found for this device');

    // Populate for the next read. A cold cache after a deploy or an eviction
    // would otherwise never warm for a device that has stopped reporting,
    // which is the case that benefits most — a silent device is polled just as
    // often as a busy one.
    await this.latestCache
      .write(device.id, telemetry)
      .catch((err) => this.logger.error(`Redis write failed: ${err.message}`));

    return telemetry;
  }

  // ── Statistics ─────────────────────────────────────────────────────────────

  /**
   * Whole-range summary for a device.
   *
   * Over a wide range this reads `telemetry_rollups` instead of scanning raw
   * rows — a year of one-minute readings is ~525k rows per device, and the
   * aggregate over them is already stored as ~365 day-buckets. It falls back to
   * raw telemetry whenever the rollup read comes back empty, so the route
   * behaves identically before the first aggregation run and for a range the
   * rollups do not cover yet.
   *
   * `keys` is new and additive: the five denormalised fields are still returned
   * in their original shape, but a device reporting `co2` or `power` finally
   * gets statistics for those too.
   */
  async getStatistics(
    deviceId: string,
    userId: string,
    startDate?: string,
    endDate?: string,
  ): Promise<any> {
    const device = await this.resolveDeviceForUser(deviceId, userId);

    if (
      startDate &&
      endDate &&
      this.rollupService.shouldUseRollups(startDate, endDate)
    ) {
      const granularity = this.rollupService.pickGranularity(
        startDate,
        endDate,
      );
      const rollup = await this.rollupService.readStatistics(
        deviceId,
        granularity,
        new Date(startDate),
        new Date(endDate),
      );
      if (rollup.buckets > 0) {
        const k = (name: string) => rollup.keys[name] ?? null;
        return {
          totalRecords: rollup.totalRecords,
          temperature: this.statBlock(k('temperature')),
          humidity: this.statBlock(k('humidity')),
          pressure: this.statBlock(k('pressure')),
          battery: {
            avg: k('batteryLevel')?.avg ?? null,
            min: k('batteryLevel')?.min ?? null,
          },
          signal: { avg: k('signalStrength')?.avg ?? null },
          timeRange: { first: rollup.firstRecord, last: rollup.lastRecord },
          keys: rollup.keys,
          source: 'rollup',
          granularity,
        };
      }
    }

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
      source: 'raw',
    };
  }

  /** Shape one rollup key as the `{avg, min, max}` block this route has always returned. */
  private statBlock(
    stat: { avg: number | null; min: number | null; max: number | null } | null,
  ): { avg: number | null; min: number | null; max: number | null } {
    return {
      avg: stat?.avg ?? null,
      min: stat?.min ?? null,
      max: stat?.max ?? null,
    };
  }

  // ── Aggregated ─────────────────────────────────────────────────────────────

  /**
   * Per-period aggregates for a device.
   *
   * `interval` already matches the rollup granularities exactly, so a wide
   * range is answered by reading pre-built buckets rather than by
   * `DATE_TRUNC`-ing and grouping the raw table. The response keeps its
   * original shape and gains `keys` (every rolled-up key in the bucket, not
   * just the five denormalised columns) plus `source`.
   *
   * `count` is `rowCount` — telemetry rows in the bucket — which is what the
   * raw version's `COUNT(*)` meant. It is deliberately not the per-key sample
   * count: those differ whenever a reading omits a field.
   */
  async getAggregated(
    deviceId: string,
    userId: string,
    interval: 'hour' | 'day' | 'month',
    startDate: string,
    endDate: string,
  ): Promise<any[]> {
    const device = await this.resolveDeviceForUser(deviceId, userId);

    if (this.rollupService.shouldUseRollups(startDate, endDate)) {
      const rows = await this.rollupService.readAllKeys(
        deviceId,
        interval,
        new Date(startDate),
        new Date(endDate),
      );
      if (rows.length > 0) return this.pivotRollupBuckets(rows, interval);
    }

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
      source: 'raw',
    }));
  }

  /**
   * Turn the long/narrow rollup rows into the one-object-per-period shape the
   * `aggregated` route has always returned.
   */
  private pivotRollupBuckets(
    rows: Array<{
      bucket: Date;
      key: string;
      rowCount: number;
      sampleCount: number;
      min: number | null;
      max: number | null;
      avg: number | null;
      sum: number | null;
      first: number | null;
      last: number | null;
    }>,
    granularity: string,
  ): any[] {
    const byBucket = new Map<number, any>();

    for (const row of rows) {
      const stamp = row.bucket.getTime();
      let bucket = byBucket.get(stamp);
      if (!bucket) {
        bucket = {
          period: row.bucket,
          count: row.rowCount,
          temperature: { avg: null, min: null, max: null },
          humidity: { avg: null, min: null, max: null },
          pressure: { avg: null },
          battery: { avg: null },
          keys: {} as Record<string, unknown>,
          source: 'rollup',
          granularity,
        };
        byBucket.set(stamp, bucket);
      }

      bucket.keys[row.key] = {
        count: row.sampleCount,
        min: row.min,
        max: row.max,
        avg: row.avg,
        sum: row.sum,
        first: row.first,
        last: row.last,
      };

      if (row.key === 'temperature' || row.key === 'humidity') {
        bucket[row.key] = { avg: row.avg, min: row.min, max: row.max };
      } else if (row.key === 'pressure') {
        bucket.pressure = { avg: row.avg };
      } else if (row.key === 'batteryLevel') {
        bucket.battery = { avg: row.avg };
      }
    }

    return [...byBucket.values()].sort(
      (a, b) => a.period.getTime() - b.period.getTime(),
    );
  }

  // ── Time series ────────────────────────────────────────────────────────────

  /**
   * One key's series for a device.
   *
   * The raw path has a trap this one avoids: `.limit(limit)` with
   * `ORDER BY timestamp ASC` returns the OLDEST `limit` points, so a chart
   * asking for a year at `limit=1000` silently gets the first few days and
   * draws a line that stops. Over a wide range the rollup path returns one
   * point per bucket for the whole range instead, which is both complete and
   * smaller.
   *
   * Each rollup point carries `value` (the bucket mean) alongside `min`, `max`
   * and `count`, so a caller can draw a band rather than pretending the mean is
   * a reading. `value` keeps working for callers that only read that field.
   */
  async getTimeSeries(
    deviceId: string,
    userId: string,
    key: string,
    startDate: string,
    endDate: string,
    limit = 1000,
  ): Promise<any[]> {
    const device = await this.resolveDeviceForUser(deviceId, userId);

    if (this.rollupService.shouldUseRollups(startDate, endDate)) {
      const granularity = this.rollupService.pickGranularity(
        startDate,
        endDate,
      );
      const points = await this.rollupService.readSeries(
        deviceId,
        granularity,
        key,
        new Date(startDate),
        new Date(endDate),
      );
      if (points.length > 0) {
        return points.map((p) => ({
          timestamp: p.bucket,
          value: p.avg,
          min: p.min,
          max: p.max,
          avg: p.avg,
          sum: p.sum,
          first: p.first,
          last: p.last,
          count: p.sampleCount,
          granularity,
          source: 'rollup',
        }));
      }
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
      .andWhere('telemetry.data ? :key', { key })
      .orderBy('telemetry.timestamp', 'ASC')
      .limit(limit)
      .getRawMany();

    return results.map((row) => ({
      timestamp: row.timestamp,
      value: parseFloat(row.value) || row.value,
    }));
  }

  // ── Multi-key series ───────────────────────────────────────────────────────

  /**
   * Several telemetry keys for one device, in one call, optionally bucketed.
   *
   * ── Why this exists ──────────────────────────────────────────────────────
   * Every read above is single-key (`getTimeSeries`) or fixed-column
   * (`getAggregated`, which can only report the five denormalised columns a
   * rollup covers). The analytics surface needs neither: a dashboard chart
   * asks for "temperature and humidity between these two instants, averaged
   * into hourly buckets", with the keys chosen by the user and living only in
   * `data` jsonb. `POST /analytics/timeseries` and `GET /analytics/aggregate`
   * both read through here, so there is one access-control path and one
   * definition of what a bucket means.
   *
   * ── Raw vs bucketed ──────────────────────────────────────────────────────
   * Without a `bucketMs` this delegates straight to `getTimeSeries()` per key,
   * which keeps its rollup awareness: over a wide window the series comes from
   * `telemetry_rollups` instead of scanning a year of raw rows, and each point
   * carries `min`/`max`/`count` as well as the mean.
   *
   * With a `bucketMs` it is one SQL statement for every key at once:
   * `data->>key` cast to float, grouped by key and by a floor-divided epoch
   * bucket. N keys cost one query rather than N, which matters because a
   * widget asking for six keys would otherwise be six round trips per refresh.
   * The rollup tables are deliberately NOT consulted on this path — their
   * buckets are hour/day/month, and silently answering a 15-minute request
   * with hourly data would be a wrong chart rather than a slow one.
   *
   * ── Non-numeric values ───────────────────────────────────────────────────
   * A bucketed read filters to numeric values with a regex before the cast,
   * the same guard `AnalyticsService.expandKeys()` uses: `data` holds
   * `{"status":"online"}` alongside `{"temperature":21.4}`, and `::float` on
   * the former aborts the whole statement. A key that is never numeric
   * therefore comes back as an empty series from a bucketed read and as its
   * real string values from a raw one, which is the honest answer in both
   * cases — you cannot average "online".
   */
  async getMultiKeySeries(
    deviceId: string,
    userId: string,
    keys: string[],
    startDate: string,
    endDate: string,
    options: {
      /** Bucket width in milliseconds. 0 / undefined → raw samples. */
      bucketMs?: number;
      aggregation?: 'AVG' | 'MIN' | 'MAX' | 'SUM' | 'COUNT';
      limit?: number;
    } = {},
  ): Promise<Record<string, Array<Record<string, any>>>> {
    // The tenancy gate. Every other read in this file goes through the same
    // method for the same reason — see its own comment.
    const device = await this.resolveDeviceForUser(deviceId, userId);

    const unique = Array.from(
      new Set(keys.map((key) => String(key).trim()).filter(Boolean)),
    );
    if (unique.length === 0) return {};

    const limit = Math.min(Math.max(options.limit ?? 1000, 1), 50_000);
    const bucketMs = Number(options.bucketMs ?? 0);

    if (!Number.isFinite(bucketMs) || bucketMs < 1000) {
      const series = await Promise.all(
        unique.map((key) =>
          this.getTimeSeries(deviceId, userId, key, startDate, endDate, limit),
        ),
      );
      return Object.fromEntries(unique.map((key, index) => [key, series[index]]));
    }

    const aggregation = (options.aggregation ?? 'AVG').toUpperCase();
    // Whitelisted, not interpolated from the caller: this string lands inside
    // the SQL text, and an `@IsEnum` on the DTO is not something this service
    // can assume its callers applied.
    const sqlAggregate =
      {
        AVG: 'AVG(kv.value::float)',
        MIN: 'MIN(kv.value::float)',
        MAX: 'MAX(kv.value::float)',
        SUM: 'SUM(kv.value::float)',
        COUNT: 'COUNT(*)::float',
      }[aggregation] ?? 'AVG(kv.value::float)';

    const bucketSeconds = Math.max(1, Math.floor(bucketMs / 1000));

    const rows: Array<{
      key: string;
      bucket: Date;
      value: string;
      min: string;
      max: string;
      samples: string;
    }> = await this.telemetryRepository.query(
      `SELECT kv.key AS key,
              to_timestamp(FLOOR(EXTRACT(EPOCH FROM t.timestamp) / $5) * $5) AS bucket,
              ${sqlAggregate}     AS value,
              MIN(kv.value::float) AS min,
              MAX(kv.value::float) AS max,
              COUNT(*)             AS samples
         FROM telemetry t
         CROSS JOIN LATERAL jsonb_each_text(t.data) kv
        WHERE t."deviceId" = $1
          AND t.timestamp BETWEEN $2 AND $3
          AND t.deleted_at IS NULL
          AND kv.key = ANY($4)
          AND kv.value ~ '^-?[0-9]+(\\.[0-9]+)?$'
        GROUP BY kv.key, bucket
        ORDER BY kv.key, bucket ASC`,
      [
        deviceId,
        new Date(startDate),
        new Date(endDate),
        unique,
        bucketSeconds,
      ],
    );

    const out: Record<string, Array<Record<string, any>>> = Object.fromEntries(
      unique.map((key) => [key, [] as Array<Record<string, any>>]),
    );

    for (const row of rows) {
      const bucket = out[row.key];
      // Per-key rather than overall: one key reaching the cap must not
      // truncate the others, and the SQL is ordered by key then bucket.
      if (!bucket || bucket.length >= limit) continue;
      bucket.push({
        timestamp: row.bucket,
        value: row.value === null ? null : Number(row.value),
        min: row.min === null ? null : Number(row.min),
        max: row.max === null ? null : Number(row.max),
        count: Number(row.samples),
        aggregation,
        bucketMs: bucketSeconds * 1000,
        source: 'telemetry',
      });
    }

    this.logger.debug(
      `Multi-key series for ${device.deviceKey}: ${unique.length} key(s), ` +
        `${rows.length} bucket(s) at ${bucketSeconds}s`,
    );

    return out;
  }

  // ── Delete ─────────────────────────────────────────────────────────────────

  async deleteByDevice(deviceId: string, userId: string): Promise<number> {
    const device = await this.resolveDeviceForUser(deviceId, userId);

    const result = await this.telemetryRepository
      .createQueryBuilder()
      .delete()
      .where('"deviceId" = :deviceId', { deviceId })
      .execute();

    return result.affected ?? 0;
  }

  /**
   * Retention sweep for ONE tenant.
   *
   * This used to be `deleteOldData(daysToKeep = 90)`: no tenant scope, no
   * caller, no cron. Run as written it was a single unbounded
   * `DELETE FROM telemetry WHERE timestamp < cutoff` across every tenant on the
   * platform, applying one hardcoded 90 days to a FREE tenant entitled to 7 and
   * an ENTERPRISE tenant entitled to 365 alike — i.e. both a mass deletion and
   * the wrong one.
   *
   * It now delegates to `TelemetryRetentionService`, which reads the tenant's
   * own `Subscription.limits.dataRetentionDays`, refuses to run when that is
   * unset or below the floor, and deletes in bounded batches. The cron that
   * calls it on a schedule is `TelemetryMaintenanceService.enqueueCleanup()`;
   * this method stays for programmatic/one-off use and returns the row count.
   */
  async deleteOldData(tenantId: string): Promise<number> {
    const result = await this.retentionService.sweepTenant(tenantId);
    if (result.skipped) {
      this.logger.warn(
        `deleteOldData(${tenantId}) deleted nothing: ${result.skipped}`,
      );
    }
    return result.deleted;
  }

  // ── Rollups ────────────────────────────────────────────────────────────────

  /**
   * Raw rollup rows for a device — every key, or a named subset.
   *
   * `aggregated` pivots the same data into its fixed five-field shape; this is
   * the un-pivoted view, which is what a chart over an arbitrary sensor key
   * (`co2`, `power`, `pm25`) needs.
   */
  async getRollups(
    deviceId: string,
    // Second position, matching every other read on this service — and it is
    // load bearing, not decorative: resolveDeviceForUser() is what keeps this
    // route from serving another tenant's history.
    userId: string,
    granularity: TelemetryRollupGranularity,
    startDate: string,
    endDate: string,
    keys?: string[],
  ): Promise<any[]> {
    const device = await this.resolveDeviceForUser(deviceId, userId);

    const rows = await this.rollupService.readAllKeys(
      deviceId,
      granularity,
      new Date(startDate),
      new Date(endDate),
      keys,
    );

    return rows.map((row) => ({
      bucket: row.bucket,
      key: row.key,
      count: row.sampleCount,
      rowCount: row.rowCount,
      min: row.min,
      max: row.max,
      avg: row.avg,
      sum: row.sum,
      first: row.first,
      last: row.last,
      granularity,
    }));
  }

  /**
   * What retention and aggregation will do for this tenant, without doing it.
   *
   * Deleting telemetry is irreversible, so an operator needs to be able to see
   * the effective retention, where it came from, and how many rows are already
   * past it BEFORE the nightly sweep runs — and to notice a tenant being
   * skipped because nobody ever set `dataRetentionDays`.
   */
  async getMaintenanceStatus(tenantId: string): Promise<any> {
    const [retention, rollups] = await Promise.all([
      this.retentionService.preview(tenantId),
      this.rollupService.coverage(tenantId),
    ]);

    return {
      tenantId,
      retention,
      rollups,
      rollupSettings: {
        enabled: this.rollupService.settings.rollupEnabled,
        maxBucketsPerRun: this.rollupService.settings.rollupMaxBuckets,
        backfillDays: this.rollupService.settings.rollupBackfillDays,
        keyLimit: this.rollupService.settings.rollupKeyLimit,
        readMinRangeDays: this.rollupService.settings.rollupReadMinRangeDays,
      },
    };
  }

  // ── Count ──────────────────────────────────────────────────────────────────

  async getCountByDevice(deviceId: string, userId: string): Promise<number> {
    const device = await this.resolveDeviceForUser(deviceId, userId);

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
    data.forEach((r) =>
      Object.keys(r.data || {}).forEach((k) => allKeys.add(k)),
    );

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

  /**
   * ── What this used to be, and the four separate things wrong with it ──────
   *
   * It wrote `device:{id}:telemetry:latest` as a five-field hash and
   * `telemetry:{id}:recent` as a capped list — four Redis round trips on the
   * ingest hot path — and:
   *
   *  1. **Nothing read either of them.** `getLatest()`'s cache read was
   *     commented out, and no code anywhere touched `:recent`. The cost was
   *     real and the benefit was zero.
   *  2. **The hash had no TTL.** One key per device, forever, including for
   *     devices decommissioned a year ago. On a Redis shared with Bull, where
   *     eviction is what protects the queues, that is a slow leak with a
   *     consequence.
   *  3. **It was lossy.** Five scalars out of a row whose point is the
   *     `data` jsonb. The commented-out read reconstructed a fake `Telemetry`
   *     with no `id`, no `deviceKey` and no `data` — so switching it on as
   *     written would have made `GET /telemetry/:id/latest` start returning a
   *     different, emptier shape than the database path, intermittently,
   *     depending on cache state.
   *  4. **It was written from only ONE of the two ingest paths.** This method
   *     is called from `create()` (the HTTP path). The MQTT/CoAP path persists
   *     through `TelemetryConsumer`, which never wrote the cache. So for every
   *     MQTT device — the majority — the "latest" entry would have been
   *     whatever stale HTTP reading last arrived, or absent.
   *
   * Item 4 is the one that makes this a correctness story rather than a
   * performance one: a cache populated by one writer and read by a path that
   * serves both is not a slow cache, it is a wrong answer.
   *
   * ── What it is now ────────────────────────────────────────────────────────
   *
   * One key, `telemetry:latest:{deviceId}`, holding the **saved row** verbatim,
   * written by BOTH ingest paths (`TelemetryConsumer` calls
   * `cacheLatestRow()`), with a TTL, and read by `getLatest()`.
   *
   * **Invalidation:** every write is a full overwrite, so there is nothing to
   * invalidate on the write side — the newest reading replaces the previous
   * one by construction. The TTL covers the one case an overwrite cannot: the
   * retention sweep (§4h) deletes old rows, and for a device silent for longer
   * than its plan's retention that can delete the very row this key holds,
   * leaving a cached reading whose row no longer exists. `TELEMETRY_LATEST_CACHE_TTL`
   * bounds that to 5 minutes by default, which is also the staleness ceiling if
   * a write ever fails.
   */
  private async cacheLatest(
    deviceId: string,
    telemetry: Telemetry,
  ): Promise<void> {
    // The key, its TTL and its serialisation live in
    // TelemetryLatestCacheService, not here — `TelemetryConsumer` is the other
    // writer and must produce byte-identical entries, which is precisely what
    // two copies of this logic would stop doing the first time one changed.
    await this.latestCache.write(deviceId, telemetry);
  }

  // ══════════════════════════════════════════════════════════════════════════
  // ACCESS CONTROL
  // ══════════════════════════════════════════════════════════════════════════

  /**
   * Resolve a device for a caller, or 404.
   *
   * ── What this replaces ─────────────────────────────────────────────────────
   * Every read on this service did:
   *
   *     const device = await this.deviceRepository.findOne({ where: { id: deviceId } });
   *     if (!device) throw new NotFoundException('Device not found');
   *
   * — by id alone, with the `userId` argument accepted and then ignored. A
   * comment above one of them even claimed it "uses tenantId from the device
   * record for access control"; no such predicate existed anywhere in the file.
   *
   * The result was that `GET /telemetry/devices/:deviceId/*` served ANY
   * authenticated user ANY tenant's telemetry given a device id — history,
   * aggregates, statistics, CSV export — and `DELETE` on the same id destroyed
   * it. On an IoT platform the telemetry IS the product, so this was the
   * broadest data exposure in the codebase.
   *
   * The rule matches `DevicesService.applyAccessFilter()` so the two cannot
   * drift: SUPER_ADMIN sees everything, everyone else is confined to their
   * tenant, and customer-scoped roles to their customer. A device outside the
   * caller's scope answers **404 rather than 403**, so the endpoint cannot be
   * used to discover which device ids exist elsewhere.
   */
  private async resolveDeviceForUser(
    deviceId: string,
    userId: string,
  ): Promise<Device> {
    // The one place in this file that may load a device by id alone — the
    // check immediately below is what makes it safe.
    const device = await this.deviceRepository.findOne({
      where: { id: deviceId },
    });
    if (!device) throw new NotFoundException('Device not found');

    const caller = await this.loadCallerScope(userId);

    // No resolvable caller means no access. Failing open here would restore
    // exactly the hole this method exists to close.
    if (!caller) throw new NotFoundException('Device not found');
    if (caller.role === UserRole.SUPER_ADMIN) return device;

    if (!caller.tenantId || device.tenantId !== caller.tenantId) {
      throw new NotFoundException('Device not found');
    }

    if (
      caller.role === UserRole.CUSTOMER ||
      caller.role === UserRole.CUSTOMER_USER
    ) {
      if (!caller.customerId || device.customerId !== caller.customerId) {
        throw new NotFoundException('Device not found');
      }
    }

    return device;
  }

  /**
   * The caller's role and scope, cached briefly.
   *
   * Queried directly rather than by injecting `UsersService`, which would add
   * a module dependency (and a likely cycle) to the telemetry hot path for
   * three columns. The cache keeps a burst of chart requests from issuing one
   * user lookup per series; it is short and bounded because a role or customer
   * reassignment must take effect quickly and this map must not grow forever.
   */
  private readonly callerScopeCache = new Map<
    string,
    { expires: number; scope: CallerScope | null }
  >();

  private async loadCallerScope(userId: string): Promise<CallerScope | null> {
    if (!userId) return null;

    const cached = this.callerScopeCache.get(userId);
    if (cached && cached.expires > Date.now()) return cached.scope;

    const rows: Array<{
      role: UserRole;
      tenantId: string | null;
      customerId: string | null;
    }> = await this.deviceRepository.manager.query(
      `SELECT role, "tenantId", "customerId"
         FROM users
        WHERE id = $1 AND deleted_at IS NULL
        LIMIT 1`,
      [userId],
    );

    const scope = rows[0] ?? null;

    if (this.callerScopeCache.size > 5000) this.callerScopeCache.clear();
    this.callerScopeCache.set(userId, {
      expires: Date.now() + 30_000,
      scope,
    });

    return scope;
  }

}
