// src/modules/analytics/analytics.service.ts
//
// Every figure returned by this service is read from Postgres. There are no
// synthetic series, no Math.random(), and no hardcoded percentages.
//
// ─── Two facts about this schema drive most of the SQL below ────────────────
//
// 1. `telemetry` has NO key/value columns. One row is one *reading set*:
//    `data jsonb` (e.g. {"temperature":34.29,"co2":622,"status":"online"})
//    plus denormalised `temperature/humidity/pressure/latitude/longitude/
//    batteryLevel/signalStrength` columns. Anything "per telemetry key" is
//    therefore a LATERAL expansion of `data` — see expandKeys() below — not a
//    GROUP BY on a key column.
//
// 2. `telemetry.tenantId` exists and is indexed as (tenantId, deviceId,
//    timestamp). Queries scope on that column directly rather than joining
//    `devices`, so the composite index is actually used. The join is added
//    only when a customer-scoped caller needs `device.customerId`.
//
// ─── Isolation ──────────────────────────────────────────────────────────────
// tenantId is required on every public method and always comes from the JWT.
// A CUSTOMER / CUSTOMER_USER caller additionally narrows to their customerId,
// so one customer can never read another's devices inside a shared tenant.

import {
  Injectable,
  Logger,
  NotFoundException,
  BadRequestException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, In, Between, MoreThanOrEqual, SelectQueryBuilder } from 'typeorm';
import { Cron, CronExpression } from '@nestjs/schedule';
import { promises as fs } from 'fs';

import { Analytics } from './entities/analytics.entity';
import { DashboardViewLog } from './entities/dashboard-view-log.entity';
import { Device } from '@modules/devices/entities/device.entity';
import { Telemetry } from '@modules/telemetry/entities/telemetry.entity';
import { Alarm } from '@modules/alarms/entities/alarm.entity';
import { Asset } from '@modules/assets/entities/asset.entity';
import { APILog } from '@modules/api-monitoring/entities/api-log.entity';
import { Attribute } from '@modules/attributes/entities/attribute.entity';
import { DeviceCommand } from '@modules/device-commands/entities/device-commands.entity';
import { User } from '@modules/users/entities/user.entity';
import { Tenant } from '@modules/tenants/entities/tenant.entity';
import { Dashboard } from '@modules/dashboards/entities/dashboard.entity';
import { Subscription } from '@modules/subscriptions/entities/subscription.entity';

import { AnalyticsType, AnalyticsPeriod } from '@common/enums/analytics.enum';
import { DeviceStatus, AlarmSeverity, AlarmStatus } from '@common/enums/index.enum';
import { RedisService } from '@lib/redis/redis.service';
import { KafkaService } from '@lib/kafka/kafka.service';

import {
  AnalyticsTimeRange,
  CreateAnalyticsDto,
  QueryAnalyticsDto,
  DeviceAnalyticsQueryDto,
  DeviceDetailQueryDto,
  GeoAnalyticsQueryDto,
  TimeRangeQueryDto,
  RecordDashboardViewDto,
} from './dto/analytics.dto';
import { PaginatedResponseDto } from '@common/dto/pagination.dto';

// ── Alarm status groupings ──────────────────────────────────────────────────
// This platform stores a flat 5-value AlarmStatus; ThingsBoard's ACTIVE_UNACK /
// ACTIVE_ACK / CLEARED_UNACK / CLEARED_ACK are *derived* (Alarm.tbStatus, an
// @AfterLoad hook) and are NOT stored, so they can never appear in a WHERE
// clause. These are the storable equivalents.
const ACTIVE_ALARM_STATUSES = [AlarmStatus.ACTIVE, AlarmStatus.ACKNOWLEDGED];
const CLOSED_ALARM_STATUSES = [AlarmStatus.CLEARED, AlarmStatus.RESOLVED];

/** Matches an integer or decimal, optionally signed — used to skip string values in `data`. */
const NUMERIC_JSON_VALUE = String.raw`^-?[0-9]+(\.[0-9]+)?$`;

const BYTES_PER_MB = 1_048_576;

interface ResolvedRange {
  since: Date;
  until: Date;
  hours: number;
  days: number;
  /** Postgres DATE_TRUNC unit appropriate to the window length. */
  bucket: 'hour' | 'day';
}

@Injectable()
export class AnalyticsService {
  private readonly logger = new Logger(AnalyticsService.name);

  constructor(
    @InjectRepository(Analytics)
    private readonly analyticsRepo: Repository<Analytics>,
    @InjectRepository(DashboardViewLog)
    private readonly viewLogRepo: Repository<DashboardViewLog>,
    @InjectRepository(Device)
    private readonly deviceRepo: Repository<Device>,
    @InjectRepository(Telemetry)
    private readonly telemetryRepo: Repository<Telemetry>,
    @InjectRepository(Alarm)
    private readonly alarmRepo: Repository<Alarm>,
    @InjectRepository(Asset)
    private readonly assetRepo: Repository<Asset>,
    @InjectRepository(APILog)
    private readonly apiLogRepo: Repository<APILog>,
    @InjectRepository(Attribute)
    private readonly attributeRepo: Repository<Attribute>,
    @InjectRepository(DeviceCommand)
    private readonly commandRepo: Repository<DeviceCommand>,
    @InjectRepository(User)
    private readonly userRepo: Repository<User>,
    @InjectRepository(Tenant)
    private readonly tenantRepo: Repository<Tenant>,
    @InjectRepository(Dashboard)
    private readonly dashboardRepo: Repository<Dashboard>,
    // Subscription is read through its repository rather than by importing
    // SubscriptionsModule — the same cycle-avoidance pattern DashboardsService
    // and FloorPlansService use.
    @InjectRepository(Subscription)
    private readonly subscriptionRepo: Repository<Subscription>,
    // Both are @Global() providers; no module import needed.
    private readonly redis: RedisService,
    private readonly kafka: KafkaService,
  ) {}

  // ══════════════════════════════════════════════════════════════════════════
  // SCOPING HELPERS
  // ══════════════════════════════════════════════════════════════════════════

  /**
   * Every public method starts here.
   *
   * SUPER_ADMIN carries no tenantId, so an unguarded `WHERE tenantId = NULL`
   * silently matched nothing and every endpoint reported zeros. Failing loudly
   * is the honest behaviour: analytics is a per-tenant view, and a super admin
   * must say which tenant they mean.
   */
  private assertTenant(tenantId: string | undefined | null): string {
    if (!tenantId) {
      throw new BadRequestException(
        'Analytics is tenant-scoped. This account has no tenant context — ' +
          'call as a tenant user, or pass ?tenantId= as a super admin.',
      );
    }
    return tenantId;
  }

  /**
   * Device ids visible to this caller. Returns null when the caller is not
   * customer-scoped (meaning "all devices in the tenant"), so callers can skip
   * the extra predicate entirely.
   */
  private async visibleDeviceIds(
    tenantId: string,
    customerId?: string | null,
  ): Promise<string[] | null> {
    if (!customerId) return null;
    const rows = await this.deviceRepo.find({
      where: { tenantId, customerId },
      select: ['id'],
    });
    return rows.map((r) => r.id);
  }

  private resolveRange(timeRange?: AnalyticsTimeRange): ResolvedRange {
    const hoursByRange: Record<AnalyticsTimeRange, number> = {
      [AnalyticsTimeRange.ONE_HOUR]: 1,
      [AnalyticsTimeRange.ONE_DAY]: 24,
      [AnalyticsTimeRange.SEVEN_DAYS]: 24 * 7,
      [AnalyticsTimeRange.THIRTY_DAYS]: 24 * 30,
      [AnalyticsTimeRange.NINETY_DAYS]: 24 * 90,
    };
    const hours = hoursByRange[timeRange ?? AnalyticsTimeRange.ONE_DAY];
    const until = new Date();
    return {
      since: new Date(until.getTime() - hours * 3_600_000),
      until,
      hours,
      days: hours / 24,
      // Anything up to 48h reads better hour-by-hour; longer windows would
      // return hundreds of near-empty buckets.
      bucket: hours <= 48 ? 'hour' : 'day',
    };
  }

  private startOfToday(): Date {
    const d = new Date();
    d.setHours(0, 0, 0, 0);
    return d;
  }

  // ══════════════════════════════════════════════════════════════════════════
  // RAW SQL BUILDING BLOCKS
  //
  // `data jsonb` is expanded with LATERAL jsonb_each_text, which TypeORM's
  // QueryBuilder cannot express. Everything is parameterised ($1, $2, …) —
  // no caller input is ever interpolated into these strings.
  // ══════════════════════════════════════════════════════════════════════════

  /**
   * Numeric min/max/avg/sample-count for every key in `data`, for one device.
   * Non-numeric values (e.g. "status":"online") are filtered out by regex so
   * the ::float cast can never fail.
   */
  private async expandKeys(
    tenantId: string,
    deviceId: string,
    since: Date,
    until: Date,
  ): Promise<Array<{ key: string; min: string; max: string; avg: string; samples: string }>> {
    return this.telemetryRepo.query(
      `SELECT kv.key            AS key,
              MIN(kv.value::float) AS min,
              MAX(kv.value::float) AS max,
              AVG(kv.value::float) AS avg,
              COUNT(*)             AS samples
         FROM telemetry t
         CROSS JOIN LATERAL jsonb_each_text(t.data) kv
        WHERE t."tenantId" = $1
          AND t."deviceId" = $2
          AND t.timestamp BETWEEN $3 AND $4
          AND t.deleted_at IS NULL
          AND kv.value ~ $5
        GROUP BY kv.key
        ORDER BY kv.key`,
      [tenantId, deviceId, since, until, NUMERIC_JSON_VALUE],
    );
  }

  /** Most recent value of every key for one device, numeric or not. */
  private async latestKeyValues(
    tenantId: string,
    deviceId: string,
  ): Promise<Array<{ key: string; value: string; timestamp: Date }>> {
    return this.telemetryRepo.query(
      `SELECT DISTINCT ON (kv.key) kv.key AS key, kv.value AS value, t.timestamp AS timestamp
         FROM telemetry t
         CROSS JOIN LATERAL jsonb_each_text(t.data) kv
        WHERE t."tenantId" = $1
          AND t."deviceId" = $2
          AND t.deleted_at IS NULL
        ORDER BY kv.key, t.timestamp DESC`,
      [tenantId, deviceId],
    );
  }

  /**
   * Real bytes per telemetry row, measured from the physical table size rather
   * than assumed. Falls back to a stated constant only when the table is empty
   * (nothing to measure), and the caller is told which happened.
   */
  private async telemetryBytesPerRow(): Promise<{ bytesPerRow: number; measured: boolean }> {
    const [row] = await this.telemetryRepo.query(
      `SELECT pg_total_relation_size('telemetry') AS total_bytes,
              (SELECT COUNT(*) FROM telemetry)    AS row_count`,
    );
    const totalBytes = Number(row?.total_bytes ?? 0);
    const rowCount = Number(row?.row_count ?? 0);
    if (!rowCount || !totalBytes) return { bytesPerRow: 0, measured: false };
    return { bytesPerRow: totalBytes / rowCount, measured: true };
  }

  // ══════════════════════════════════════════════════════════════════════════
  // 1. OVERVIEW — GET /analytics/overview
  // ══════════════════════════════════════════════════════════════════════════

  async getOverview(tenantIdRaw: string, customerId?: string | null) {
    const tenantId = this.assertTenant(tenantIdRaw);
    const deviceIds = await this.visibleDeviceIds(tenantId, customerId);
    // A customer with zero devices must see zeros, not the whole tenant —
    // `IN ()` is invalid SQL, so an impossible sentinel stands in.
    const scopedIds = deviceIds?.length ? deviceIds : deviceIds ? ['00000000-0000-0000-0000-000000000000'] : null;

    const startOfDay = this.startOfToday();
    const startOfWeek = new Date(Date.now() - 7 * 24 * 3_600_000);
    const startOfMonth = new Date();
    startOfMonth.setDate(1);
    startOfMonth.setHours(0, 0, 0, 0);

    const deviceWhere: any = { tenantId };
    if (customerId) deviceWhere.customerId = customerId;

    const alarmWhere: any = { tenantId };
    if (customerId) alarmWhere.customerId = customerId;

    const telemetryCount = (since: Date) => {
      const qb = this.telemetryRepo
        .createQueryBuilder('t')
        .where('t.tenantId = :tenantId', { tenantId })
        .andWhere('t.timestamp >= :since', { since });
      if (scopedIds) qb.andWhere('t.deviceId IN (:...scopedIds)', { scopedIds });
      return qb.getCount();
    };

    const [
      totalDevices,
      onlineDevices,
      messagesToday,
      messagesWeek,
      messagesMonth,
      totalActive,
      critical,
      warning,
      info,
      error,
      resolvedToday,
      totalAssets,
      assetsWithDevices,
      subscription,
      peak,
    ] = await Promise.all([
      this.deviceRepo.count({ where: deviceWhere }),
      this.deviceRepo.count({ where: { ...deviceWhere, status: DeviceStatus.ACTIVE } }),
      telemetryCount(startOfDay),
      telemetryCount(startOfWeek),
      telemetryCount(startOfMonth),
      this.alarmRepo.count({ where: { ...alarmWhere, status: In(ACTIVE_ALARM_STATUSES) } }),
      this.alarmRepo.count({ where: { ...alarmWhere, severity: AlarmSeverity.CRITICAL, status: In(ACTIVE_ALARM_STATUSES) } }),
      this.alarmRepo.count({ where: { ...alarmWhere, severity: AlarmSeverity.WARNING, status: In(ACTIVE_ALARM_STATUSES) } }),
      this.alarmRepo.count({ where: { ...alarmWhere, severity: AlarmSeverity.INFO, status: In(ACTIVE_ALARM_STATUSES) } }),
      this.alarmRepo.count({ where: { ...alarmWhere, severity: AlarmSeverity.ERROR, status: In(ACTIVE_ALARM_STATUSES) } }),
      // CLEARED sets clearedAt, RESOLVED sets resolvedAt — COALESCE covers both
      // so an operator-resolved alarm is not missed from today's tally.
      this.alarmRepo
        .createQueryBuilder('a')
        .where('a.tenantId = :tenantId', { tenantId })
        .andWhere('a.status IN (:...statuses)', { statuses: CLOSED_ALARM_STATUSES })
        .andWhere('COALESCE(a.clearedAt, a.resolvedAt) >= :startOfDay', { startOfDay })
        .andWhere(customerId ? 'a.customerId = :customerId' : '1=1', { customerId })
        .getCount(),
      this.assetRepo.count({ where: customerId ? { tenantId, customerId } : { tenantId } }),
      this.countAssetsWithDevices(tenantId, customerId),
      this.subscriptionRepo.findOne({ where: { tenantId } }),
      this.peakTelemetryHour(tenantId, startOfWeek, scopedIds),
    ]);

    const devicesLimit = subscription?.limits?.devices ?? -1;
    // SubscriptionLimits has no telemetry-message ceiling; apiCallsPerMonth is
    // the closest declared quota, and -1 (the platform's "unlimited" sentinel)
    // is returned when the plan defines neither.
    const messagesLimit = subscription?.limits?.apiCallsPerMonth ?? -1;

    const usagePercentage =
      devicesLimit > 0 ? Math.round((totalDevices / devicesLimit) * 100) : 0;

    return {
      devices: {
        total: totalDevices,
        online: onlineDevices,
        offline: totalDevices - onlineDevices,
        onlinePercentage: totalDevices > 0 ? Math.round((onlineDevices / totalDevices) * 100) : 0,
      },
      telemetry: {
        totalMessagesToday: messagesToday,
        totalMessagesThisWeek: messagesWeek,
        totalMessagesThisMonth: messagesMonth,
        // Elapsed hours, not a flat 24 — dividing by 24 at 09:00 understates
        // the rate by ~3x and made the number useless before noon.
        avgMessagesPerHour: Math.round(
          messagesToday / Math.max(1, (Date.now() - startOfDay.getTime()) / 3_600_000),
        ),
        peakHour: peak.label,
        peakHourMessages: peak.count,
      },
      alarms: {
        totalActive,
        critical,
        error,
        warning,
        info,
        resolvedToday,
      },
      assets: {
        total: totalAssets,
        withDevices: assetsWithDevices,
      },
      subscription: {
        plan: subscription?.plan ?? null,
        devicesUsed: totalDevices,
        devicesLimit,
        messagesUsed: messagesMonth,
        messagesLimit,
        usagePercentage,
      },
    };
  }

  /** Assets that have at least one device attached, tenant-scoped. */
  private async countAssetsWithDevices(tenantId: string, customerId?: string | null): Promise<number> {
    const qb = this.deviceRepo
      .createQueryBuilder('d')
      .select('COUNT(DISTINCT d.assetId)', 'count')
      .where('d.tenantId = :tenantId', { tenantId })
      .andWhere('d.assetId IS NOT NULL');
    if (customerId) qb.andWhere('d.customerId = :customerId', { customerId });
    const row = await qb.getRawOne();
    return parseInt(row?.count ?? '0', 10);
  }

  /** Busiest hour-of-day by telemetry volume in the given window. */
  private async peakTelemetryHour(
    tenantId: string,
    since: Date,
    scopedIds: string[] | null,
  ): Promise<{ label: string; hour: number | null; count: number }> {
    const qb = this.telemetryRepo
      .createQueryBuilder('t')
      .select('EXTRACT(HOUR FROM t.timestamp)', 'hour')
      .addSelect('COUNT(*)', 'count')
      .where('t.tenantId = :tenantId', { tenantId })
      .andWhere('t.timestamp >= :since', { since });
    if (scopedIds) qb.andWhere('t.deviceId IN (:...scopedIds)', { scopedIds });

    const row = await qb.groupBy('hour').orderBy('count', 'DESC').limit(1).getRawOne();
    if (!row) return { label: 'N/A', hour: null, count: 0 };

    const hour = Math.round(parseFloat(row.hour));
    return {
      label: `${String(hour).padStart(2, '0')}:00`,
      hour,
      count: parseInt(row.count, 10),
    };
  }

  // ══════════════════════════════════════════════════════════════════════════
  // 2. DEVICE ANALYTICS LIST — GET /analytics/devices
  // ══════════════════════════════════════════════════════════════════════════

  async getDeviceAnalytics(
    tenantIdRaw: string,
    query: DeviceAnalyticsQueryDto,
    customerId?: string | null,
  ) {
    const tenantId = this.assertTenant(tenantIdRaw);
    const { since, until, days } = this.resolveRange(query.timeRange);
    const page = query.page ?? 1;
    const limit = query.limit ?? 20;

    const qb = this.deviceRepo
      .createQueryBuilder('d')
      .where('d.tenantId = :tenantId', { tenantId });

    if (customerId) qb.andWhere('d.customerId = :customerId', { customerId });
    if (query.type) qb.andWhere('d.type = :type', { type: query.type });
    if (query.status) qb.andWhere('d.status = :status', { status: query.status });

    // activeAlarms is computed after the page is fetched, so it cannot be a SQL
    // sort key; fall back to messageCount for it.
    const sortColumn =
      query.sortBy && query.sortBy !== 'activeAlarms' ? query.sortBy : 'messageCount';
    qb.orderBy(`d.${sortColumn}`, query.sortOrder ?? 'DESC', 'NULLS LAST')
      .skip((page - 1) * limit)
      .take(limit);

    const [devices, total] = await qb.getManyAndCount();
    const deviceIds = devices.map((d) => d.id);

    const [alarmCounts, keyCounts, windowCounts] = await Promise.all([
      this.activeAlarmCountsByDevice(tenantId, deviceIds),
      this.distinctKeyCountsByDevice(tenantId, deviceIds, since, until),
      this.telemetryCountsByDevice(tenantId, deviceIds, since, until),
    ]);

    const { bytesPerRow, measured } = await this.telemetryBytesPerRow();

    const rows = devices.map((d) => {
      const messagesInWindow = windowCounts.get(d.id) ?? 0;
      return {
        id: d.id,
        name: d.name,
        type: d.type,
        status: d.status,
        lastSeenAt: d.lastSeenAt ?? null,
        /** Lifetime counter maintained by the ingestion path. */
        messageCount: d.messageCount ?? 0,
        /** Messages inside the requested window — the figure the UI charts. */
        messagesInWindow,
        errorCount: d.errorCount ?? 0,
        uptimePercentage: this.uptimePercentage(d, since, until),
        activeAlarms: alarmCounts.get(d.id) ?? 0,
        /** Measured from pg_total_relation_size / row count, not assumed. */
        dataGeneratedBytes: Math.round(messagesInWindow * bytesPerRow),
        telemetryKeyCount: keyCounts.get(d.id) ?? 0,
      };
    });

    if (query.sortBy === 'activeAlarms') {
      rows.sort((a, b) =>
        query.sortOrder === 'ASC'
          ? a.activeAlarms - b.activeAlarms
          : b.activeAlarms - a.activeAlarms,
      );
    }

    return {
      devices: rows,
      period: { since, until, days },
      bytesPerRowMeasured: measured,
      meta: PaginatedResponseDto.create(rows, page, limit, total).meta,
    };
  }

  /**
   * Share of the window during which the device was last seen.
   *
   * A device reporting now scores 100; one last seen at the start of the window
   * scores ~0; one never seen scores 0. This is a real function of lastSeenAt
   * rather than the previous `status === active ? 99.8 : 0` constant, which
   * carried no information the `status` field did not already have.
   */
  private uptimePercentage(device: Device, since: Date, until: Date): number {
    if (!device.lastSeenAt) return 0;
    const windowMs = until.getTime() - since.getTime();
    if (windowMs <= 0) return 0;
    const silentMs = Math.max(0, until.getTime() - new Date(device.lastSeenAt).getTime());
    const pct = 100 * (1 - Math.min(1, silentMs / windowMs));
    return Math.round(pct * 10) / 10;
  }

  private async activeAlarmCountsByDevice(
    tenantId: string,
    deviceIds: string[],
  ): Promise<Map<string, number>> {
    if (!deviceIds.length) return new Map();
    const rows = await this.alarmRepo
      .createQueryBuilder('a')
      .select('a.deviceId', 'deviceId')
      .addSelect('COUNT(*)', 'count')
      .where('a.tenantId = :tenantId', { tenantId })
      .andWhere('a.deviceId IN (:...deviceIds)', { deviceIds })
      .andWhere('a.status IN (:...statuses)', { statuses: ACTIVE_ALARM_STATUSES })
      .groupBy('a.deviceId')
      .getRawMany();
    return new Map(rows.map((r) => [r.deviceId, parseInt(r.count, 10)]));
  }

  private async telemetryCountsByDevice(
    tenantId: string,
    deviceIds: string[],
    since: Date,
    until: Date,
  ): Promise<Map<string, number>> {
    if (!deviceIds.length) return new Map();
    const rows = await this.telemetryRepo
      .createQueryBuilder('t')
      .select('t.deviceId', 'deviceId')
      .addSelect('COUNT(*)', 'count')
      .where('t.tenantId = :tenantId', { tenantId })
      .andWhere('t.deviceId IN (:...deviceIds)', { deviceIds })
      .andWhere('t.timestamp BETWEEN :since AND :until', { since, until })
      .groupBy('t.deviceId')
      .getRawMany();
    return new Map(rows.map((r) => [r.deviceId, parseInt(r.count, 10)]));
  }

  /** Distinct jsonb keys each device has reported in the window. */
  private async distinctKeyCountsByDevice(
    tenantId: string,
    deviceIds: string[],
    since: Date,
    until: Date,
  ): Promise<Map<string, number>> {
    if (!deviceIds.length) return new Map();
    const rows: Array<{ deviceId: string; count: string }> = await this.telemetryRepo.query(
      `SELECT t."deviceId" AS "deviceId", COUNT(DISTINCT k) AS count
         FROM telemetry t
         CROSS JOIN LATERAL jsonb_object_keys(t.data) k
        WHERE t."tenantId" = $1
          AND t."deviceId" = ANY($2::uuid[])
          AND t.timestamp BETWEEN $3 AND $4
          AND t.deleted_at IS NULL
        GROUP BY t."deviceId"`,
      [tenantId, deviceIds, since, until],
    );
    return new Map(rows.map((r) => [r.deviceId, parseInt(r.count, 10)]));
  }

  // ══════════════════════════════════════════════════════════════════════════
  // 3. SINGLE DEVICE DEEP ANALYTICS — GET /analytics/devices/:id
  // ══════════════════════════════════════════════════════════════════════════

  async getDeviceDetailAnalytics(
    deviceId: string,
    tenantIdRaw: string,
    query: DeviceDetailQueryDto,
    customerId?: string | null,
  ) {
    const tenantId = this.assertTenant(tenantIdRaw);

    // Tenant (and customer) membership is proven here, before any other query
    // touches this deviceId — a foreign id 404s rather than leaking counts.
    const where: any = { id: deviceId, tenantId };
    if (customerId) where.customerId = customerId;
    const device = await this.deviceRepo.findOne({ where, relations: ['deviceProfile'] });
    if (!device) throw new NotFoundException('Device not found');

    const { since, until, days } = this.resolveRange(query.timeRange);
    const keys = query.keys?.split(',').map((k) => k.trim()).filter(Boolean) ?? [];

    const [records, summaryRows, latestRows, alarms, activeAlarms, hourly, windowMessages] =
      await Promise.all([
        this.telemetryRepo.find({
          where: { tenantId, deviceId, timestamp: Between(since, until) },
          order: { timestamp: 'DESC' },
          take: 200,
        }),
        this.expandKeys(tenantId, deviceId, since, until),
        this.latestKeyValues(tenantId, deviceId),
        this.alarmRepo.find({
          where: { deviceId, tenantId },
          order: { triggeredAt: 'DESC' },
          take: 10,
        }),
        this.alarmRepo.count({
          where: { deviceId, tenantId, status: In(ACTIVE_ALARM_STATUSES) },
        }),
        this.telemetryRepo
          .createQueryBuilder('t')
          .select("DATE_TRUNC('hour', t.timestamp)", 'hour')
          .addSelect('COUNT(*)', 'count')
          .where('t.tenantId = :tenantId', { tenantId })
          .andWhere('t.deviceId = :deviceId', { deviceId })
          .andWhere('t.timestamp >= :since', { since: new Date(Date.now() - 24 * 3_600_000) })
          .groupBy("DATE_TRUNC('hour', t.timestamp)")
          .orderBy('hour', 'ASC')
          .getRawMany(),
        this.telemetryRepo.count({
          where: { tenantId, deviceId, timestamp: Between(since, until) },
        }),
      ]);

    const latestMap = new Map(latestRows.map((r) => [r.key, r.value]));
    const { bytesPerRow } = await this.telemetryBytesPerRow();

    // One telemetry row carries many keys; flatten to {timestamp,key,value}
    // triples so the trend is charted per key, filtered by ?keys= when given.
    const telemetryTrend: Array<{ timestamp: string; key: string; value: any }> = [];
    for (const record of records) {
      for (const [key, value] of Object.entries(record.data ?? {})) {
        if (keys.length && !keys.includes(key)) continue;
        telemetryTrend.push({ timestamp: record.timestamp.toISOString(), key, value });
      }
    }

    // 3dp, not 2 — a device emitting a few hundred rows over 90 days works out
    // to ~0.004 MB/day, which two decimals would report as a flat "0.00".
    const dataRateMBPerDay = (windowMessages * bytesPerRow) / BYTES_PER_MB / Math.max(1, days);

    return {
      device: {
        id: device.id,
        name: device.name,
        type: device.type,
        status: device.status,
        lastSeenAt: device.lastSeenAt ?? null,
        firmwareVersion: device.firmwareVersion ?? null,
        location: device.location ?? null,
        latitude: device.latitude ?? null,
        longitude: device.longitude ?? null,
        deviceKey: device.deviceKey,
        deviceProfileName: device.deviceProfile?.name ?? null,
      },
      stats: {
        uptimePercentage: this.uptimePercentage(device, since, until),
        dataRate: `${dataRateMBPerDay.toFixed(3)} MB/day`,
        messagesInWindow: windowMessages,
        totalMessages: device.messageCount ?? 0,
        errorCount: device.errorCount ?? 0,
        activeAlarms,
        lastSeenAgo: this.humaniseAge(device.lastSeenAt),
      },
      telemetryTrend,
      telemetrySummary: summaryRows.map((s) => ({
        key: s.key,
        min: Math.round(parseFloat(s.min) * 100) / 100,
        max: Math.round(parseFloat(s.max) * 100) / 100,
        avg: Math.round(parseFloat(s.avg) * 100) / 100,
        samples: parseInt(s.samples, 10),
        latest: latestMap.get(s.key) ?? null,
      })),
      alarmHistory: alarms.map((a) => ({
        id: a.id,
        name: a.name,
        severity: a.severity,
        status: a.status,
        tbStatus: a.tbStatus,
        triggeredAt: a.triggeredAt ?? null,
        clearedAt: a.clearedAt ?? null,
        acknowledgedAt: a.acknowledgedAt ?? null,
        durationMinutes:
          a.clearedAt && a.triggeredAt
            ? Math.round(
                (new Date(a.clearedAt).getTime() - new Date(a.triggeredAt).getTime()) / 60_000,
              )
            : null,
      })),
      hourlyActivity: hourly.map((h) => ({
        hour: new Date(h.hour).toISOString(),
        messageCount: parseInt(h.count, 10),
      })),
      period: { since, until, days },
    };
  }

  private humaniseAge(at?: Date | null): string {
    if (!at) return 'Never';
    const ms = Date.now() - new Date(at).getTime();
    if (ms < 60_000) return `${Math.floor(ms / 1000)}s ago`;
    if (ms < 3_600_000) return `${Math.floor(ms / 60_000)}m ago`;
    if (ms < 86_400_000) return `${Math.floor(ms / 3_600_000)}h ago`;
    return `${Math.floor(ms / 86_400_000)}d ago`;
  }

  // ══════════════════════════════════════════════════════════════════════════
  // 4. ALARM ANALYTICS — GET /analytics/alarms
  // ══════════════════════════════════════════════════════════════════════════

  async getAlarmAnalytics(
    tenantIdRaw: string,
    query: TimeRangeQueryDto,
    customerId?: string | null,
  ) {
    const tenantId = this.assertTenant(tenantIdRaw);
    const { since, until, bucket } = this.resolveRange(query.timeRange);

    const startOfDay = this.startOfToday();
    const startOfYesterday = new Date(startOfDay.getTime() - 86_400_000);

    const base: any = { tenantId };
    if (customerId) base.customerId = customerId;

    /** Applies the tenant (and, for a customer caller, the customer) predicate. */
    const scoped = (qb: SelectQueryBuilder<Alarm>): SelectQueryBuilder<Alarm> => {
      qb.where('a.tenantId = :tenantId', { tenantId });
      if (customerId) qb.andWhere('a.customerId = :customerId', { customerId });
      return qb;
    };

    const closedBetween = (from: Date, to: Date) =>
      scoped(this.alarmRepo.createQueryBuilder('a'))
        .andWhere('a.status IN (:...statuses)', { statuses: CLOSED_ALARM_STATUSES })
        .andWhere('COALESCE(a.clearedAt, a.resolvedAt) BETWEEN :from AND :to', { from, to })
        .getCount();

    const [
      totalActive, critical, error, warning, info,
      resolvedToday, resolvedYesterday,
      criticalYesterday, warningYesterday, infoYesterday,
    ] = await Promise.all([
      this.alarmRepo.count({ where: { ...base, status: In(ACTIVE_ALARM_STATUSES) } }),
      this.alarmRepo.count({ where: { ...base, severity: AlarmSeverity.CRITICAL, status: In(ACTIVE_ALARM_STATUSES) } }),
      this.alarmRepo.count({ where: { ...base, severity: AlarmSeverity.ERROR, status: In(ACTIVE_ALARM_STATUSES) } }),
      this.alarmRepo.count({ where: { ...base, severity: AlarmSeverity.WARNING, status: In(ACTIVE_ALARM_STATUSES) } }),
      this.alarmRepo.count({ where: { ...base, severity: AlarmSeverity.INFO, status: In(ACTIVE_ALARM_STATUSES) } }),
      closedBetween(startOfDay, new Date()),
      closedBetween(startOfYesterday, startOfDay),
      this.alarmRepo.count({ where: { ...base, severity: AlarmSeverity.CRITICAL, triggeredAt: Between(startOfYesterday, startOfDay) } }),
      this.alarmRepo.count({ where: { ...base, severity: AlarmSeverity.WARNING, triggeredAt: Between(startOfYesterday, startOfDay) } }),
      this.alarmRepo.count({ where: { ...base, severity: AlarmSeverity.INFO, triggeredAt: Between(startOfYesterday, startOfDay) } }),
    ]);

    const criticalToday = await this.alarmRepo.count({
      where: { ...base, severity: AlarmSeverity.CRITICAL, triggeredAt: MoreThanOrEqual(startOfDay) },
    });
    const warningToday = await this.alarmRepo.count({
      where: { ...base, severity: AlarmSeverity.WARNING, triggeredAt: MoreThanOrEqual(startOfDay) },
    });
    const infoToday = await this.alarmRepo.count({
      where: { ...base, severity: AlarmSeverity.INFO, triggeredAt: MoreThanOrEqual(startOfDay) },
    });

    // `bucket` is chosen by resolveRange from a closed enum, never from raw
    // input, so interpolating it into DATE_TRUNC cannot be injected.
    const trendRows = await scoped(this.alarmRepo.createQueryBuilder('a'))
      .select(`DATE_TRUNC('${bucket}', a.triggeredAt)`, 'bucket')
      .addSelect("COUNT(*) FILTER (WHERE a.severity = 'critical')", 'critical')
      .addSelect("COUNT(*) FILTER (WHERE a.severity = 'error')", 'error')
      .addSelect("COUNT(*) FILTER (WHERE a.severity = 'warning')", 'warning')
      .addSelect("COUNT(*) FILTER (WHERE a.severity = 'info')", 'info')
      .andWhere('a.triggeredAt BETWEEN :since AND :until', { since, until })
      .groupBy(`DATE_TRUNC('${bucket}', a.triggeredAt)`)
      .orderBy('bucket', 'ASC')
      .getRawMany();

    const topSources = await scoped(this.alarmRepo.createQueryBuilder('a'))
      .select('a.name', 'name')
      .addSelect('a.severity', 'severity')
      .addSelect('a.deviceId', 'deviceId')
      .addSelect('COUNT(*)', 'count')
      .addSelect('MAX(a.triggeredAt)', 'lastTriggeredAt')
      .andWhere('a.triggeredAt BETWEEN :since AND :until', { since, until })
      .groupBy('a.name, a.severity, a.deviceId')
      .orderBy('count', 'DESC')
      .limit(10)
      .getRawMany();

    const byDevice = await scoped(this.alarmRepo.createQueryBuilder('a'))
      .select('a.deviceId', 'deviceId')
      .addSelect('COUNT(*)', 'count')
      .addSelect('MAX(a.triggeredAt)', 'lastAlarm')
      .andWhere('a.triggeredAt BETWEEN :since AND :until', { since, until })
      .andWhere('a.deviceId IS NOT NULL')
      .groupBy('a.deviceId')
      .orderBy('count', 'DESC')
      .limit(10)
      .getRawMany();

    // Time-to-acknowledge, in minutes, over alarms actually acknowledged.
    const response = await scoped(this.alarmRepo.createQueryBuilder('a'))
      .select('AVG(EXTRACT(EPOCH FROM (a.acknowledgedAt - a.triggeredAt)) / 60)', 'avgMinutes')
      .addSelect(
        "AVG(EXTRACT(EPOCH FROM (a.acknowledgedAt - a.triggeredAt)) / 60) FILTER (WHERE a.severity = 'critical')",
        'criticalAvg',
      )
      .addSelect('COUNT(*)', 'sampleSize')
      .andWhere('a.acknowledgedAt IS NOT NULL')
      .andWhere('a.triggeredAt IS NOT NULL')
      .andWhere('a.triggeredAt BETWEEN :since AND :until', { since, until })
      .getRawOne();

    // Mean time to resolve — how long alarms stayed open before being closed.
    const resolution = await scoped(this.alarmRepo.createQueryBuilder('a'))
      .select(
        'AVG(EXTRACT(EPOCH FROM (COALESCE(a.clearedAt, a.resolvedAt) - a.triggeredAt)) / 60)',
        'avgMinutes',
      )
      .addSelect('COUNT(*)', 'sampleSize')
      .andWhere('COALESCE(a.clearedAt, a.resolvedAt) IS NOT NULL')
      .andWhere('a.triggeredAt IS NOT NULL')
      .andWhere('a.triggeredAt BETWEEN :since AND :until', { since, until })
      .getRawOne();

    const deviceIds = [
      ...new Set([...topSources, ...byDevice].map((r) => r.deviceId).filter(Boolean)),
    ] as string[];
    const deviceNames = await this.deviceNameMap(tenantId, deviceIds);

    return {
      summary: {
        totalActive,
        critical,
        error,
        warning,
        info,
        resolvedToday,
        // Today's newly-triggered counts vs the same figure for yesterday.
        // Comparing *active* totals against yesterday's *triggered* totals (as
        // the old code did) subtracted two different quantities.
        vsYesterday: {
          critical: criticalToday - criticalYesterday,
          warning: warningToday - warningYesterday,
          info: infoToday - infoYesterday,
          resolved: resolvedToday - resolvedYesterday,
        },
        todayTriggered: { critical: criticalToday, warning: warningToday, info: infoToday },
      },
      trends: trendRows.map((t: any) => ({
        bucket: new Date(t.bucket).toISOString(),
        critical: parseInt(t.critical, 10) || 0,
        error: parseInt(t.error, 10) || 0,
        warning: parseInt(t.warning, 10) || 0,
        info: parseInt(t.info, 10) || 0,
      })),
      topSources: topSources.map((s: any) => ({
        name: s.name,
        count: parseInt(s.count, 10),
        severity: s.severity,
        deviceId: s.deviceId ?? null,
        deviceName: s.deviceId ? deviceNames.get(s.deviceId) ?? null : null,
        lastTriggeredAt: s.lastTriggeredAt,
      })),
      responseTime: {
        avgMinutes: this.round1(response?.avgMinutes),
        criticalAvgMinutes: this.round1(response?.criticalAvg),
        acknowledgedSampleSize: parseInt(response?.sampleSize ?? '0', 10),
        avgResolutionMinutes: this.round1(resolution?.avgMinutes),
        resolvedSampleSize: parseInt(resolution?.sampleSize ?? '0', 10),
      },
      byDevice: byDevice.map((d: any) => ({
        deviceId: d.deviceId,
        deviceName: deviceNames.get(d.deviceId) ?? null,
        alarmCount: parseInt(d.count, 10),
        lastAlarm: d.lastAlarm,
      })),
      period: { since, until },
    };
  }

  /** null rather than 0 when there is nothing to average — 0 minutes is a claim. */
  private round1(value: string | number | null | undefined): number | null {
    if (value === null || value === undefined) return null;
    const n = typeof value === 'number' ? value : parseFloat(value);
    return Number.isFinite(n) ? Math.round(n * 10) / 10 : null;
  }

  private async deviceNameMap(tenantId: string, ids: string[]): Promise<Map<string, string>> {
    if (!ids.length) return new Map();
    const devices = await this.deviceRepo.find({
      where: { id: In(ids), tenantId },
      select: ['id', 'name'],
    });
    return new Map(devices.map((d) => [d.id, d.name]));
  }

  // ══════════════════════════════════════════════════════════════════════════
  // 5. DATA CONSUMPTION — GET /analytics/data-consumption
  // ══════════════════════════════════════════════════════════════════════════

  async getDataConsumption(
    tenantIdRaw: string,
    query: TimeRangeQueryDto,
    customerId?: string | null,
  ) {
    const tenantId = this.assertTenant(tenantIdRaw);
    const { since, until, days, bucket } = this.resolveRange(query.timeRange);
    const prevSince = new Date(since.getTime() - (until.getTime() - since.getTime()));

    const deviceIds = await this.visibleDeviceIds(tenantId, customerId);
    const scopedIds = deviceIds?.length
      ? deviceIds
      : deviceIds
        ? ['00000000-0000-0000-0000-000000000000']
        : null;

    const telemetryQb = () => {
      const qb = this.telemetryRepo.createQueryBuilder('t').where('t.tenantId = :tenantId', { tenantId });
      if (scopedIds) qb.andWhere('t.deviceId IN (:...scopedIds)', { scopedIds });
      return qb;
    };

    const [totalMessages, prevMessages, trendRows, hourlyRows, topDevices, attributeWrites, commandCount, apiCalls] =
      await Promise.all([
        telemetryQb().andWhere('t.timestamp BETWEEN :since AND :until', { since, until }).getCount(),
        telemetryQb().andWhere('t.timestamp BETWEEN :prevSince AND :since', { prevSince, since }).getCount(),
        telemetryQb()
          .select(`DATE_TRUNC('${bucket}', t.timestamp)`, 'bucket')
          .addSelect('COUNT(*)', 'messages')
          .andWhere('t.timestamp BETWEEN :since AND :until', { since, until })
          .groupBy(`DATE_TRUNC('${bucket}', t.timestamp)`)
          .orderBy('bucket', 'ASC')
          .getRawMany(),
        telemetryQb()
          .select('EXTRACT(HOUR FROM t.timestamp)', 'hour')
          .addSelect('COUNT(*)', 'messages')
          .andWhere('t.timestamp BETWEEN :since AND :until', { since, until })
          .groupBy('hour')
          .orderBy('hour', 'ASC')
          .getRawMany(),
        telemetryQb()
          .select('t.deviceId', 'deviceId')
          .addSelect('COUNT(*)', 'messages')
          .andWhere('t.timestamp BETWEEN :since AND :until', { since, until })
          .groupBy('t.deviceId')
          .orderBy('messages', 'DESC')
          .limit(10)
          .getRawMany(),
        // Real counts, not a fixed fraction of the telemetry total.
        this.attributeRepo
          .createQueryBuilder('at')
          .where('at.tenantId = :tenantId', { tenantId })
          .andWhere('at.updatedAt BETWEEN :since AND :until', { since, until })
          .getCount(),
        this.commandRepo
          .createQueryBuilder('c')
          .where('c.tenantId = :tenantId', { tenantId })
          .andWhere('c.createdAt BETWEEN :since AND :until', { since, until })
          .getCount(),
        this.apiLogRepo
          .createQueryBuilder('l')
          .where('l.tenantId = :tenantId', { tenantId })
          .andWhere('l.timestamp BETWEEN :since AND :until', { since, until })
          .getCount(),
      ]);

    const { bytesPerRow, measured } = await this.telemetryBytesPerRow();
    const deviceNames = await this.deviceNameMap(
      tenantId,
      topDevices.map((d) => d.deviceId).filter(Boolean),
    );

    const peakHourRow = [...hourlyRows].sort(
      (a, b) => parseInt(b.messages, 10) - parseInt(a.messages, 10),
    )[0];

    // Logical payload size vs bytes actually on disk (indexes, TOAST and
    // per-row overhead included) — a real ratio, replacing the old 87.5 literal.
    const logicalBytes = await this.logicalPayloadBytes(tenantId, since, until, scopedIds);
    const physicalBytes = totalMessages * bytesPerRow;
    const storageEfficiency =
      physicalBytes > 0 ? Math.round((logicalBytes / physicalBytes) * 1000) / 10 : null;

    return {
      summary: {
        totalMessages,
        avgDailyMessages: Math.round(totalMessages / Math.max(1, days)),
        peakHour: peakHourRow
          ? `${String(Math.round(parseFloat(peakHourRow.hour))).padStart(2, '0')}:00`
          : 'N/A',
        estimatedBytes: Math.round(physicalBytes),
        bytesPerRow: Math.round(bytesPerRow),
        bytesPerRowMeasured: measured,
        storageEfficiencyPercent: storageEfficiency,
        vsLastPeriodPercent:
          prevMessages > 0 ? Math.round(((totalMessages - prevMessages) / prevMessages) * 100) : null,
        previousPeriodMessages: prevMessages,
      },
      trend: trendRows.map((d) => ({
        bucket: new Date(d.bucket).toISOString(),
        messages: parseInt(d.messages, 10),
        estimatedBytes: Math.round(parseInt(d.messages, 10) * bytesPerRow),
      })),
      byType: {
        telemetry: totalMessages,
        attributes: attributeWrites,
        commands: commandCount,
        apiCalls,
      },
      topConsumers: topDevices.map((d) => ({
        type: 'device' as const,
        id: d.deviceId,
        name: deviceNames.get(d.deviceId) ?? null,
        messages: parseInt(d.messages, 10),
        estimatedBytes: Math.round(parseInt(d.messages, 10) * bytesPerRow),
        percentage:
          totalMessages > 0
            ? Math.round((parseInt(d.messages, 10) / totalMessages) * 1000) / 10
            : 0,
      })),
      hourlyDistribution: hourlyRows.map((h) => ({
        hour: Math.round(parseFloat(h.hour)),
        messages: parseInt(h.messages, 10),
      })),
      period: { since, until, days },
    };
  }

  /** Sum of octet lengths of the raw jsonb payloads actually stored. */
  private async logicalPayloadBytes(
    tenantId: string,
    since: Date,
    until: Date,
    scopedIds: string[] | null,
  ): Promise<number> {
    const rows = await this.telemetryRepo.query(
      `SELECT COALESCE(SUM(octet_length(t.data::text)), 0) AS bytes
         FROM telemetry t
        WHERE t."tenantId" = $1
          AND t.timestamp BETWEEN $2 AND $3
          AND t.deleted_at IS NULL
          AND ($4::uuid[] IS NULL OR t."deviceId" = ANY($4::uuid[]))`,
      [tenantId, since, until, scopedIds],
    );
    return Number(rows?.[0]?.bytes ?? 0);
  }

  // ══════════════════════════════════════════════════════════════════════════
  // 6. SYSTEM PERFORMANCE — GET /analytics/system-performance
  // ══════════════════════════════════════════════════════════════════════════

  async getSystemPerformance(tenantIdRaw: string, query: TimeRangeQueryDto) {
    const tenantId = this.assertTenant(tenantIdRaw);
    const { since, until, bucket } = this.resolveRange(query.timeRange);

    const logQb = () =>
      this.apiLogRepo
        .createQueryBuilder('l')
        .where('l.tenantId = :tenantId', { tenantId })
        .andWhere('l.timestamp BETWEEN :since AND :until', { since, until });

    const [totals, trendRows, topEndpoints, errorTypes, hourlyRows, recentErrors, health] =
      await Promise.all([
        logQb()
          .select('COUNT(*)', 'total')
          .addSelect('COUNT(*) FILTER (WHERE l.statusCode >= 400)', 'errors')
          .addSelect('AVG(l.responseTime)', 'avgResponseTime')
          .addSelect(
            'PERCENTILE_CONT(0.95) WITHIN GROUP (ORDER BY l.responseTime)',
            'p95ResponseTime',
          )
          .addSelect('MAX(l.responseTime)', 'maxResponseTime')
          .getRawOne(),
        logQb()
          .select(`DATE_TRUNC('${bucket}', l.timestamp)`, 'bucket')
          .addSelect('AVG(l.responseTime)', 'avgResponseTime')
          .addSelect('COUNT(*)', 'total')
          .addSelect('COUNT(*) FILTER (WHERE l.statusCode >= 400)', 'errors')
          .groupBy(`DATE_TRUNC('${bucket}', l.timestamp)`)
          .orderBy('bucket', 'ASC')
          .getRawMany(),
        logQb()
          .select('l.endpoint', 'endpoint')
          .addSelect('COUNT(*)', 'calls')
          .addSelect('AVG(l.responseTime)', 'avgResponseTime')
          .addSelect('COUNT(*) FILTER (WHERE l.statusCode >= 400)', 'errors')
          .groupBy('l.endpoint')
          .orderBy('calls', 'DESC')
          .limit(10)
          .getRawMany(),
        logQb()
          .select('l.statusCode', 'statusCode')
          .addSelect('COUNT(*)', 'count')
          .andWhere('l.statusCode >= 400')
          .groupBy('l.statusCode')
          .orderBy('count', 'DESC')
          .getRawMany(),
        logQb()
          .select('EXTRACT(HOUR FROM l.timestamp)', 'hour')
          .addSelect('COUNT(*)', 'calls')
          .groupBy('hour')
          .orderBy('calls', 'DESC')
          .limit(1)
          .getRawOne(),
        this.apiLogRepo.find({
          where: { tenantId, statusCode: MoreThanOrEqual(500), timestamp: Between(since, until) },
          order: { timestamp: 'DESC' },
          take: 10,
          select: ['id', 'method', 'endpoint', 'statusCode', 'errorMessage', 'timestamp'],
        }),
        this.checkSystemHealth(),
      ]);

    const totalCalls = parseInt(totals?.total ?? '0', 10);
    const totalErrors = parseInt(totals?.errors ?? '0', 10);

    return {
      summary: {
        totalApiCalls: totalCalls,
        avgResponseTime: this.round1(totals?.avgResponseTime),
        p95ResponseTime: this.round1(totals?.p95ResponseTime),
        maxResponseTime: totals?.maxResponseTime ? parseInt(totals.maxResponseTime, 10) : null,
        totalErrors,
        errorRate: totalCalls > 0 ? Math.round((totalErrors / totalCalls) * 1000) / 10 : 0,
        peakUsageHour: hourlyRows
          ? `${String(Math.round(parseFloat(hourlyRows.hour))).padStart(2, '0')}:00`
          : 'N/A',
      },
      apiResponseTrend: trendRows.map((l) => {
        const total = parseInt(l.total, 10);
        const errors = parseInt(l.errors, 10);
        return {
          bucket: new Date(l.bucket).toISOString(),
          avgResponseTime: this.round1(l.avgResponseTime),
          calls: total,
          errorRate: total > 0 ? Math.round((errors / total) * 1000) / 10 : 0,
        };
      }),
      errorBreakdown: errorTypes.map((e) => ({
        type: `HTTP ${e.statusCode}`,
        statusCode: parseInt(e.statusCode, 10),
        count: parseInt(e.count, 10),
        percentage:
          totalErrors > 0 ? Math.round((parseInt(e.count, 10) / totalErrors) * 1000) / 10 : 0,
      })),
      topEndpoints: topEndpoints.map((e) => {
        const calls = parseInt(e.calls, 10);
        const errors = parseInt(e.errors, 10);
        return {
          endpoint: e.endpoint,
          calls,
          avgResponseTime: this.round1(e.avgResponseTime),
          errorRate: calls > 0 ? Math.round((errors / calls) * 1000) / 10 : 0,
        };
      }),
      systemHealth: health,
      recentAlerts: recentErrors.map((l) => ({
        message: `${l.method} ${l.endpoint} → ${l.statusCode}${l.errorMessage ? `: ${l.errorMessage}` : ''}`,
        type: 'error' as const,
        timestamp: l.timestamp,
      })),
      period: { since, until },
    };
  }

  /**
   * Every dependency is probed for real:
   *   database  — SELECT 1 against the pool
   *   cache     — Redis PING
   *   messageQueue — the shared Kafka producer's live connection state
   *   fileStorage  — write+unlink of a probe file in the upload directory
   * The previous implementation returned three of these as string literals.
   */
  private async checkSystemHealth(): Promise<{
    database: 'healthy' | 'down';
    cache: 'healthy' | 'down';
    messageQueue: 'healthy' | 'down';
    fileStorage: 'healthy' | 'down';
    checkedAt: Date;
  }> {
    const uploadDir = process.env.UPLOAD_PATH || './uploads';

    const [database, cache, messageQueue, fileStorage] = await Promise.all([
      this.analyticsRepo.query('SELECT 1').then(() => 'healthy' as const).catch(() => 'down' as const),
      this.redis.client
        .ping()
        .then((r: string) => (r === 'PONG' ? ('healthy' as const) : ('down' as const)))
        .catch(() => 'down' as const),
      Promise.resolve(this.kafka.isHealthy() ? ('healthy' as const) : ('down' as const)),
      (async () => {
        const probe = `${uploadDir}/.analytics-health-probe`;
        try {
          await fs.mkdir(uploadDir, { recursive: true });
          await fs.writeFile(probe, 'ok');
          await fs.unlink(probe);
          return 'healthy' as const;
        } catch {
          return 'down' as const;
        }
      })(),
    ]);

    return { database, cache, messageQueue, fileStorage, checkedAt: new Date() };
  }

  // ══════════════════════════════════════════════════════════════════════════
  // 7. GEO ANALYTICS — GET /analytics/geo
  // ══════════════════════════════════════════════════════════════════════════

  async getGeoAnalytics(
    tenantIdRaw: string,
    query: GeoAnalyticsQueryDto,
    customerId?: string | null,
  ) {
    const tenantId = this.assertTenant(tenantIdRaw);
    const { since, until } = this.resolveRange(query.timeRange);

    const qb = this.deviceRepo
      .createQueryBuilder('d')
      .where('d.tenantId = :tenantId', { tenantId });
    if (customerId) qb.andWhere('d.customerId = :customerId', { customerId });
    if (query.region) qb.andWhere('d.location ILIKE :region', { region: `%${query.region}%` });

    const devices = await qb.getMany();
    const deviceIds = devices.map((d) => d.id);

    const [alarmCounts, messageCounts] = await Promise.all([
      this.activeAlarmCountsByDevice(tenantId, deviceIds),
      this.telemetryCountsByDevice(tenantId, deviceIds, since, until),
    ]);
    const { bytesPerRow } = await this.telemetryBytesPerRow();

    // Grouped on the device's own `location` string — no invented world-region
    // taxonomy and no hardcoded lat/lng per continent. Devices with no location
    // are reported under 'Unlocated' rather than being silently bucketed.
    const regions = new Map<
      string,
      { devices: number; online: number; alarms: number; messages: number; lat: number[]; lng: number[] }
    >();

    for (const d of devices) {
      const region = d.location?.trim() || 'Unlocated';
      if (!regions.has(region)) {
        regions.set(region, { devices: 0, online: 0, alarms: 0, messages: 0, lat: [], lng: [] });
      }
      const r = regions.get(region)!;
      r.devices++;
      if (d.status === DeviceStatus.ACTIVE) r.online++;
      r.alarms += alarmCounts.get(d.id) ?? 0;
      r.messages += messageCounts.get(d.id) ?? 0;
      if (d.latitude != null && d.longitude != null) {
        r.lat.push(Number(d.latitude));
        r.lng.push(Number(d.longitude));
      }
    }

    const avg = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);

    return {
      devices: devices.map((d) => ({
        id: d.id,
        name: d.name,
        type: d.type,
        status: d.status,
        latitude: d.latitude != null ? Number(d.latitude) : null,
        longitude: d.longitude != null ? Number(d.longitude) : null,
        location: d.location ?? null,
        lastSeenAt: d.lastSeenAt ?? null,
        activeAlarms: alarmCounts.get(d.id) ?? 0,
        messagesInWindow: messageCounts.get(d.id) ?? 0,
      })),
      regionStats: Array.from(regions.entries()).map(([region, s]) => ({
        region,
        deviceCount: s.devices,
        onlineCount: s.online,
        offlineCount: s.devices - s.online,
        messages: s.messages,
        dataGeneratedBytes: Math.round(s.messages * bytesPerRow),
        activeAlarms: s.alarms,
        /** Active alarms per device — a ratio, computed, not sampled. */
        alertRate: s.devices > 0 ? Math.round((s.alarms / s.devices) * 100) / 100 : 0,
        centroid: { latitude: avg(s.lat), longitude: avg(s.lng) },
        status:
          s.devices === 0 ? 'offline' : s.online === s.devices ? 'online' : s.online === 0 ? 'offline' : 'degraded',
      })),
      summary: {
        totalDevices: devices.length,
        locatedDevices: devices.filter((d) => d.latitude != null && d.longitude != null).length,
        regions: regions.size,
      },
      period: { since, until },
    };
  }

  // ══════════════════════════════════════════════════════════════════════════
  // 8. ASSET ANALYTICS — GET /analytics/assets
  // ══════════════════════════════════════════════════════════════════════════

  async getAssetAnalytics(
    tenantIdRaw: string,
    query: TimeRangeQueryDto,
    customerId?: string | null,
  ) {
    const tenantId = this.assertTenant(tenantIdRaw);
    const { since, until } = this.resolveRange(query.timeRange);

    const where: any = { tenantId };
    if (customerId) where.customerId = customerId;

    const [assets, totalAssets] = await this.assetRepo.findAndCount({
      where,
      order: { createdAt: 'DESC' },
      take: 100,
    });
    const assetIds = assets.map((a) => a.id);

    // One query for every device on every listed asset; grouped in memory
    // rather than a query per asset.
    const devices = assetIds.length
      ? await this.deviceRepo.find({
          where: { tenantId, assetId: In(assetIds) },
          select: ['id', 'assetId', 'status', 'lastSeenAt'],
        })
      : [];

    const devicesByAsset = new Map<string, typeof devices>();
    for (const d of devices) {
      if (!d.assetId) continue;
      const list = devicesByAsset.get(d.assetId) ?? [];
      list.push(d);
      devicesByAsset.set(d.assetId, list);
    }

    const deviceIds = devices.map((d) => d.id);
    const [alarmCounts, messageCounts, keyStats] = await Promise.all([
      this.activeAlarmCountsByDevice(tenantId, deviceIds),
      this.telemetryCountsByDevice(tenantId, deviceIds, since, until),
      this.assetKeyStats(tenantId, deviceIds, since, until),
    ]);

    const byType: Record<string, number> = {};
    for (const a of assets) byType[a.type ?? 'unknown'] = (byType[a.type ?? 'unknown'] ?? 0) + 1;

    const rows = assets.map((a) => {
      const own = devicesByAsset.get(a.id) ?? [];
      const activeAlarms = own.reduce((s, d) => s + (alarmCounts.get(d.id) ?? 0), 0);
      const messages = own.reduce((s, d) => s + (messageCounts.get(d.id) ?? 0), 0);
      const lastActivity = own
        .map((d) => d.lastSeenAt)
        .filter(Boolean)
        .sort((x, y) => new Date(y!).getTime() - new Date(x!).getTime())[0];

      // Telemetry averages across every device on this asset, per key.
      const summary: Record<string, { avg: number; min: number; max: number; samples: number }> = {};
      for (const d of own) {
        for (const s of keyStats.get(d.id) ?? []) {
          const existing = summary[s.key];
          if (!existing) {
            summary[s.key] = { avg: s.avg, min: s.min, max: s.max, samples: s.samples };
          } else {
            const total = existing.samples + s.samples;
            existing.avg =
              Math.round(((existing.avg * existing.samples + s.avg * s.samples) / total) * 100) / 100;
            existing.min = Math.min(existing.min, s.min);
            existing.max = Math.max(existing.max, s.max);
            existing.samples = total;
          }
        }
      }

      return {
        id: a.id,
        name: a.name,
        type: a.type,
        deviceCount: own.length,
        onlineDeviceCount: own.filter((d) => d.status === DeviceStatus.ACTIVE).length,
        activeAlarms,
        messagesInWindow: messages,
        lastActivity: lastActivity ?? null,
        location: a.location ?? null,
        telemetrySummary: summary,
      };
    });

    return {
      summary: {
        totalAssets,
        listed: rows.length,
        byType,
        withDevices: rows.filter((r) => r.deviceCount > 0).length,
        withAlarms: rows.filter((r) => r.activeAlarms > 0).length,
      },
      assets: rows,
      period: { since, until },
    };
  }

  /** Per-device numeric key stats for a set of devices, in one LATERAL query. */
  private async assetKeyStats(
    tenantId: string,
    deviceIds: string[],
    since: Date,
    until: Date,
  ): Promise<Map<string, Array<{ key: string; min: number; max: number; avg: number; samples: number }>>> {
    if (!deviceIds.length) return new Map();
    const rows: Array<{ deviceId: string; key: string; min: string; max: string; avg: string; samples: string }> =
      await this.telemetryRepo.query(
        `SELECT t."deviceId"        AS "deviceId",
                kv.key              AS key,
                MIN(kv.value::float) AS min,
                MAX(kv.value::float) AS max,
                AVG(kv.value::float) AS avg,
                COUNT(*)             AS samples
           FROM telemetry t
           CROSS JOIN LATERAL jsonb_each_text(t.data) kv
          WHERE t."tenantId" = $1
            AND t."deviceId" = ANY($2::uuid[])
            AND t.timestamp BETWEEN $3 AND $4
            AND t.deleted_at IS NULL
            AND kv.value ~ $5
          GROUP BY t."deviceId", kv.key`,
        [tenantId, deviceIds, since, until, NUMERIC_JSON_VALUE],
      );

    const map = new Map<string, Array<{ key: string; min: number; max: number; avg: number; samples: number }>>();
    for (const r of rows) {
      const list = map.get(r.deviceId) ?? [];
      list.push({
        key: r.key,
        min: Math.round(parseFloat(r.min) * 100) / 100,
        max: Math.round(parseFloat(r.max) * 100) / 100,
        avg: Math.round(parseFloat(r.avg) * 100) / 100,
        samples: parseInt(r.samples, 10),
      });
      map.set(r.deviceId, list);
    }
    return map;
  }

  // ══════════════════════════════════════════════════════════════════════════
  // 9. DASHBOARD ANALYTICS — GET /analytics/dashboards
  // ══════════════════════════════════════════════════════════════════════════

  async getDashboardAnalytics(tenantIdRaw: string, query: TimeRangeQueryDto) {
    const tenantId = this.assertTenant(tenantIdRaw);
    const { since, until, days } = this.resolveRange(query.timeRange);

    const dashboards = await this.dashboardRepo.find({ where: { tenantId } });
    const dashboardIds = dashboards.map((d) => d.id);

    const [viewStats, widgetStats] = await Promise.all([
      dashboardIds.length
        ? this.viewLogRepo
            .createQueryBuilder('vl')
            .select('vl.dashboardId', 'dashboardId')
            .addSelect('COUNT(*)', 'views')
            .addSelect('AVG(vl.loadTimeMs)', 'avgLoad')
            .addSelect(
              'PERCENTILE_CONT(0.95) WITHIN GROUP (ORDER BY vl.loadTimeMs)',
              'p95Load',
            )
            .addSelect('COUNT(*) FILTER (WHERE vl.errorOccurred)', 'errors')
            .where('vl.tenantId = :tenantId', { tenantId })
            .andWhere('vl.dashboardId IN (:...dashboardIds)', { dashboardIds })
            .andWhere('vl.viewedAt BETWEEN :since AND :until', { since, until })
            .groupBy('vl.dashboardId')
            .getRawMany()
        : Promise.resolve([]),
      dashboardIds.length
        ? this.viewLogRepo
            .createQueryBuilder('vl')
            .select('vl.dashboardId', 'dashboardId')
            .addSelect('vl.widgetId', 'widgetId')
            .addSelect('AVG(vl.loadTimeMs)', 'avgLoad')
            .addSelect('COUNT(*)', 'views')
            .where('vl.tenantId = :tenantId', { tenantId })
            .andWhere('vl.dashboardId IN (:...dashboardIds)', { dashboardIds })
            .andWhere('vl.widgetId IS NOT NULL')
            .andWhere('vl.viewedAt BETWEEN :since AND :until', { since, until })
            .groupBy('vl.dashboardId, vl.widgetId')
            .getRawMany()
        : Promise.resolve([]),
    ]);

    const statsById = new Map(viewStats.map((s) => [s.dashboardId, s]));
    const widgetsById = new Map<string, any[]>();
    for (const w of widgetStats) {
      const list = widgetsById.get(w.dashboardId) ?? [];
      list.push(w);
      widgetsById.set(w.dashboardId, list);
    }

    return {
      dashboards: dashboards.map((d) => {
        const s = statsById.get(d.id);
        const views = parseInt(s?.views ?? '0', 10);
        const errors = parseInt(s?.errors ?? '0', 10);
        return {
          dashboardId: d.id,
          dashboardName: d.name,
          visibility: d.visibility,
          widgetCount: d.widgets?.length ?? 0,
          lastUpdated: d.updatedAt,
          lastViewedAt: d.lastViewedAt ?? null,
          /** Lifetime counter on the dashboard row. */
          totalViewCount: d.viewCount ?? 0,
          performanceMetrics: {
            viewsInWindow: views,
            viewsPerDay: Math.round((views / Math.max(1, days)) * 10) / 10,
            avgLoadTimeMs: this.round1(s?.avgLoad),
            p95LoadTimeMs: this.round1(s?.p95Load),
            errorCount: errors,
            errorRatePercent: views > 0 ? Math.round((errors / views) * 1000) / 10 : 0,
          },
          widgetPerformance: (widgetsById.get(d.id) ?? []).map((w) => {
            const avg = parseFloat(w.avgLoad ?? '0');
            return {
              widgetId: w.widgetId,
              views: parseInt(w.views, 10),
              loadTimeMs: Math.round(avg),
              status: avg < 1000 ? 'good' : avg < 3000 ? 'slow' : 'poor',
            };
          }),
        };
      }),
      summary: {
        totalDashboards: dashboards.length,
        // Sum of the per-dashboard window counts — no view logs yet means 0,
        // which is the truth rather than an estimate.
        totalViewsInWindow: viewStats.reduce((s, v) => s + parseInt(v.views, 10), 0),
      },
      period: { since, until, days },
    };
  }

  async recordDashboardView(
    dashboardId: string,
    tenantIdRaw: string,
    userId: string,
    dto: RecordDashboardViewDto,
  ): Promise<DashboardViewLog> {
    const tenantId = this.assertTenant(tenantIdRaw);

    // The dashboard must belong to the caller's tenant — otherwise a view log
    // could be written against another tenant's dashboard id.
    const dashboard = await this.dashboardRepo.findOne({
      where: { id: dashboardId, tenantId },
      select: ['id'],
    });
    if (!dashboard) throw new NotFoundException('Dashboard not found');

    return this.viewLogRepo.save(
      this.viewLogRepo.create({
        dashboardId,
        tenantId,
        userId,
        widgetId: dto.widgetId,
        loadTimeMs: dto.loadTimeMs,
        errorOccurred: dto.errorOccurred ?? false,
        errorMessage: dto.errorMessage,
      }),
    );
  }

  // ══════════════════════════════════════════════════════════════════════════
  // 9b. ENERGY ANALYTICS — GET /analytics/energy
  //
  // Pre-existing endpoint, kept. It previously matched on `t.key`, a column
  // that does not exist, so every call was a 400. Rewritten against `data`.
  // ══════════════════════════════════════════════════════════════════════════

  /** jsonb keys treated as energy/environment signals, matched case-insensitively. */
  private static readonly ENERGY_KEYS = ['co2', 'energy', 'power', 'kwh', 'watt', 'current', 'voltage'];
  private static readonly CLIMATE_KEYS = ['temperature', 'temp', 'humidity'];

  async getEnergyAnalytics(
    tenantIdRaw: string,
    query: TimeRangeQueryDto,
    customerId?: string | null,
  ) {
    const tenantId = this.assertTenant(tenantIdRaw);
    const { since, until, bucket } = this.resolveRange(query.timeRange);

    const watched = [...AnalyticsService.ENERGY_KEYS, ...AnalyticsService.CLIMATE_KEYS];
    const deviceIds = await this.visibleDeviceIds(tenantId, customerId);

    // One pass over the window: per-bucket, per-key averages for the watched
    // keys only. `bucket` comes from the closed AnalyticsTimeRange enum.
    const trendRows: Array<{ bucket: Date; key: string; avg: string; samples: string }> =
      await this.telemetryRepo.query(
        `SELECT DATE_TRUNC('${bucket}', t.timestamp) AS bucket,
                LOWER(kv.key)        AS key,
                AVG(kv.value::float) AS avg,
                COUNT(*)             AS samples
           FROM telemetry t
           CROSS JOIN LATERAL jsonb_each_text(t.data) kv
          WHERE t."tenantId" = $1
            AND t.timestamp BETWEEN $2 AND $3
            AND t.deleted_at IS NULL
            AND kv.value ~ $4
            AND LOWER(kv.key) = ANY($5::text[])
            AND ($6::uuid[] IS NULL OR t."deviceId" = ANY($6::uuid[]))
          GROUP BY 1, 2
          ORDER BY 1 ASC`,
        [tenantId, since, until, NUMERIC_JSON_VALUE, watched, deviceIds],
      );

    // Latest reading of each watched key across the tenant.
    const latestRows: Array<{ key: string; value: string; timestamp: Date; deviceId: string }> =
      await this.telemetryRepo.query(
        `SELECT DISTINCT ON (LOWER(kv.key))
                LOWER(kv.key) AS key, kv.value AS value, t.timestamp AS timestamp, t."deviceId" AS "deviceId"
           FROM telemetry t
           CROSS JOIN LATERAL jsonb_each_text(t.data) kv
          WHERE t."tenantId" = $1
            AND t.deleted_at IS NULL
            AND kv.value ~ $2
            AND LOWER(kv.key) = ANY($3::text[])
            AND ($4::uuid[] IS NULL OR t."deviceId" = ANY($4::uuid[]))
          ORDER BY LOWER(kv.key), t.timestamp DESC`,
        [tenantId, NUMERIC_JSON_VALUE, watched, deviceIds],
      );

    const latest = new Map(latestRows.map((r) => [r.key, parseFloat(r.value)]));

    // Devices actually reporting an energy key, with their most recent reading.
    const energyDevices: Array<{ deviceId: string; name: string; status: string; lastSeenAt: Date | null; keys: string[] }> =
      await this.telemetryRepo.query(
        `SELECT d.id AS "deviceId", d.name AS name, d.status AS status, d."lastSeenAt" AS "lastSeenAt",
                ARRAY_AGG(DISTINCT LOWER(kv.key)) AS keys
           FROM telemetry t
           CROSS JOIN LATERAL jsonb_each_text(t.data) kv
           JOIN devices d ON d.id = t."deviceId"
          WHERE t."tenantId" = $1
            AND t.timestamp BETWEEN $2 AND $3
            AND t.deleted_at IS NULL
            AND LOWER(kv.key) = ANY($4::text[])
            AND ($5::uuid[] IS NULL OR t."deviceId" = ANY($5::uuid[]))
          GROUP BY d.id, d.name, d.status, d."lastSeenAt"
          ORDER BY d.name`,
        [tenantId, since, until, AnalyticsService.ENERGY_KEYS, deviceIds],
      );

    // Pivot the trend into one row per bucket.
    const byBucket = new Map<string, Record<string, number>>();
    for (const r of trendRows) {
      const iso = new Date(r.bucket).toISOString();
      const slot = byBucket.get(iso) ?? {};
      slot[r.key] = Math.round(parseFloat(r.avg) * 100) / 100;
      byBucket.set(iso, slot);
    }

    const alarmQb = this.alarmRepo
      .createQueryBuilder('a')
      .where('a.tenantId = :tenantId', { tenantId })
      .andWhere(
        `(${watched.map((_, i) => `LOWER(a.name) LIKE :p${i} OR LOWER(a.message) LIKE :p${i}`).join(' OR ')})`,
        watched.reduce((acc, k, i) => ({ ...acc, [`p${i}`]: `%${k}%` }), {}),
      )
      .orderBy('a.triggeredAt', 'DESC', 'NULLS LAST')
      .take(10);
    if (customerId) alarmQb.andWhere('a.customerId = :customerId', { customerId });
    const recentAlerts = await alarmQb.getMany();

    // Thresholds are configuration, not measurement — surfaced explicitly so a
    // caller can see what the suggestions were compared against.
    const CO2_THRESHOLD = Number(process.env.ANALYTICS_CO2_THRESHOLD ?? 1000); // ppm
    const TEMP_THRESHOLD = Number(process.env.ANALYTICS_TEMP_THRESHOLD ?? 28); // °C

    const suggestions: Array<{ priority: string; suggestion: string; basis: string }> = [];
    const co2 = latest.get('co2');
    const temperature = latest.get('temperature') ?? latest.get('temp');
    if (co2 !== undefined && co2 > CO2_THRESHOLD) {
      suggestions.push({
        priority: 'high',
        suggestion: 'Increase ventilation rate',
        basis: `Latest CO2 ${co2}ppm exceeds the ${CO2_THRESHOLD}ppm threshold`,
      });
    }
    if (temperature !== undefined && temperature > TEMP_THRESHOLD) {
      suggestions.push({
        priority: 'medium',
        suggestion: 'Adjust thermostat setpoints',
        basis: `Latest temperature ${temperature}°C exceeds the ${TEMP_THRESHOLD}°C threshold`,
      });
    }

    return {
      latest: Object.fromEntries(
        latestRows.map((r) => [
          r.key,
          { value: parseFloat(r.value), at: r.timestamp, deviceId: r.deviceId },
        ]),
      ),
      thresholds: { co2: CO2_THRESHOLD, temperature: TEMP_THRESHOLD },
      trend: Array.from(byBucket.entries()).map(([b, values]) => ({ bucket: b, ...values })),
      connectedDevices: energyDevices.map((d) => ({
        deviceId: d.deviceId,
        name: d.name,
        status: d.status,
        lastSeenAt: d.lastSeenAt,
        reportedKeys: d.keys,
      })),
      recentAlerts: recentAlerts.map((a) => ({
        id: a.id,
        name: a.name,
        message: a.message ?? null,
        severity: a.severity,
        status: a.status,
        triggeredAt: a.triggeredAt ?? null,
      })),
      optimizationSuggestions: suggestions,
      period: { since, until },
    };
  }

  // ══════════════════════════════════════════════════════════════════════════
  // 10. TELEMETRY & USER ACTIVITY (kept endpoints)
  // ══════════════════════════════════════════════════════════════════════════

  async getTelemetryStats(
    tenantIdRaw: string,
    startDate?: Date,
    endDate?: Date,
    customerId?: string | null,
  ) {
    const tenantId = this.assertTenant(tenantIdRaw);
    const start = startDate ?? new Date(Date.now() - 24 * 3_600_000);
    const end = endDate ?? new Date();

    const qb = this.telemetryRepo
      .createQueryBuilder('t')
      .select('t.deviceId', 'deviceId')
      .addSelect('COUNT(*)', 'count')
      .addSelect('MIN(t.timestamp)', 'firstRecord')
      .addSelect('MAX(t.timestamp)', 'lastRecord')
      .where('t.tenantId = :tenantId', { tenantId })
      .andWhere('t.timestamp BETWEEN :start AND :end', { start, end });

    if (customerId) {
      qb.innerJoin('t.device', 'device').andWhere('device.customerId = :customerId', { customerId });
    }

    const stats = await qb.groupBy('t.deviceId').getRawMany();
    const names = await this.deviceNameMap(tenantId, stats.map((s) => s.deviceId));

    return {
      startDate: start,
      endDate: end,
      devices: stats.map((s) => ({
        deviceId: s.deviceId,
        deviceName: names.get(s.deviceId) ?? null,
        recordCount: parseInt(s.count, 10),
        firstRecord: s.firstRecord,
        lastRecord: s.lastRecord,
      })),
      totalRecords: stats.reduce((sum, s) => sum + parseInt(s.count, 10), 0),
    };
  }

  async getUserActivity(tenantIdRaw: string, startDate?: Date, endDate?: Date) {
    const tenantId = this.assertTenant(tenantIdRaw);
    const start = startDate ?? new Date(Date.now() - 24 * 3_600_000);
    const end = endDate ?? new Date();

    const [totalUsers, activeUsers, byRoleRows] = await Promise.all([
      this.userRepo.count({ where: { tenantId } }),
      this.userRepo
        .createQueryBuilder('u')
        .where('u.tenantId = :tenantId', { tenantId })
        .andWhere('u.lastLoginAt BETWEEN :start AND :end', { start, end })
        .getCount(),
      this.userRepo
        .createQueryBuilder('u')
        .select('u.role', 'role')
        .addSelect('COUNT(*)', 'count')
        .where('u.tenantId = :tenantId', { tenantId })
        .groupBy('u.role')
        .getRawMany(),
    ]);

    return {
      startDate: start,
      endDate: end,
      totalUsers,
      activeUsers,
      byRole: byRoleRows.reduce(
        (acc, r) => ({ ...acc, [r.role]: parseInt(r.count, 10) }),
        {} as Record<string, number>,
      ),
    };
  }

  // ══════════════════════════════════════════════════════════════════════════
  // 11. STORED ROLLUPS — GET/POST /analytics, DELETE /analytics/cleanup/:days
  // ══════════════════════════════════════════════════════════════════════════

  async create(
    tenantIdRaw: string,
    customerId: string | undefined,
    dto: CreateAnalyticsDto,
  ): Promise<Analytics> {
    const tenantId = this.assertTenant(tenantIdRaw);
    return this.analyticsRepo.save(
      this.analyticsRepo.create({
        ...dto,
        tenantId,
        customerId,
        timestamp: new Date(dto.timestamp),
      }),
    );
  }

  async findAll(tenantIdRaw: string, dto: QueryAnalyticsDto, customerId?: string | null) {
    const tenantId = this.assertTenant(tenantIdRaw);
    const page = dto.page ?? 1;
    const limit = dto.limit ?? 50;

    const qb = this.analyticsRepo.createQueryBuilder('a').where('a.tenantId = :tenantId', { tenantId });

    if (customerId) qb.andWhere('a.customerId = :customerId', { customerId });
    if (dto.type) qb.andWhere('a.type = :type', { type: dto.type });
    if (dto.period) qb.andWhere('a.period = :period', { period: dto.period });
    if (dto.entityId) qb.andWhere('a.entityId = :entityId', { entityId: dto.entityId });
    if (dto.entityType) qb.andWhere('a.entityType = :entityType', { entityType: dto.entityType });
    if (dto.startDate && dto.endDate) {
      qb.andWhere('a.timestamp BETWEEN :start AND :end', {
        start: new Date(dto.startDate),
        end: new Date(dto.endDate),
      });
    }

    const [data, total] = await qb
      .orderBy('a.timestamp', 'DESC')
      .skip((page - 1) * limit)
      .take(limit)
      .getManyAndCount();

    return PaginatedResponseDto.create(data, page, limit, total);
  }

  async deleteOld(tenantIdRaw: string, daysOld: number): Promise<number> {
    const tenantId = this.assertTenant(tenantIdRaw);
    if (!Number.isFinite(daysOld) || daysOld < 1) {
      throw new BadRequestException('days must be a positive integer');
    }
    const cutoff = new Date(Date.now() - daysOld * 86_400_000);
    const result = await this.analyticsRepo
      .createQueryBuilder()
      .delete()
      .where('tenantId = :tenantId', { tenantId })
      .andWhere('timestamp < :cutoff', { cutoff })
      .execute();
    return result.affected ?? 0;
  }

  // ══════════════════════════════════════════════════════════════════════════
  // 12. NIGHTLY ROLLUP
  //
  // Writes one row per tenant per type into `analytics`, so the historical
  // series survives telemetry retention pruning.
  // ══════════════════════════════════════════════════════════════════════════

  @Cron(CronExpression.EVERY_DAY_AT_MIDNIGHT)
  async generateDailyAnalytics(): Promise<void> {
    const start = this.startOfToday();
    start.setDate(start.getDate() - 1);
    const end = this.startOfToday();

    const tenants = await this.tenantRepo.find({ select: ['id'] });
    for (const tenant of tenants) {
      try {
        await this.rollupTenant(tenant.id, start, end);
        this.logger.log(`Daily analytics generated for tenant ${tenant.id}`);
      } catch (err: any) {
        this.logger.error(`Analytics rollup failed for tenant ${tenant.id}: ${err?.message}`);
      }
    }
  }

  private async rollupTenant(tenantId: string, start: Date, end: Date): Promise<void> {
    const [telemetryRows, deviceCount, activeDevices, alarmsBySeverity, apiCalls, apiErrors, viewLogs] =
      await Promise.all([
        this.telemetryRepo
          .createQueryBuilder('t')
          .where('t.tenantId = :tenantId', { tenantId })
          .andWhere('t.timestamp BETWEEN :start AND :end', { start, end })
          .getCount(),
        this.deviceRepo.count({ where: { tenantId } }),
        this.deviceRepo.count({ where: { tenantId, status: DeviceStatus.ACTIVE } }),
        this.alarmRepo
          .createQueryBuilder('a')
          .select('a.severity', 'severity')
          .addSelect('COUNT(*)', 'count')
          .where('a.tenantId = :tenantId', { tenantId })
          .andWhere('a.triggeredAt BETWEEN :start AND :end', { start, end })
          .groupBy('a.severity')
          .getRawMany(),
        this.apiLogRepo
          .createQueryBuilder('l')
          .where('l.tenantId = :tenantId', { tenantId })
          .andWhere('l.timestamp BETWEEN :start AND :end', { start, end })
          .getCount(),
        this.apiLogRepo
          .createQueryBuilder('l')
          .where('l.tenantId = :tenantId', { tenantId })
          .andWhere('l.timestamp BETWEEN :start AND :end', { start, end })
          .andWhere('l.statusCode >= 400')
          .getCount(),
        this.viewLogRepo
          .createQueryBuilder('vl')
          .select('vl.dashboardId', 'dashboardId')
          .addSelect('COUNT(*)', 'views')
          .addSelect('AVG(vl.loadTimeMs)', 'avgLoad')
          .where('vl.tenantId = :tenantId', { tenantId })
          .andWhere('vl.viewedAt BETWEEN :start AND :end', { start, end })
          .groupBy('vl.dashboardId')
          .getRawMany(),
      ]);

    const { bytesPerRow } = await this.telemetryBytesPerRow();

    await this.upsertRollup(tenantId, AnalyticsType.TELEMETRY_STATS, start, {
      telemetryRows,
      deviceCount,
      activeDevices,
    });

    await this.upsertRollup(tenantId, AnalyticsType.DATA_CONSUMPTION, start, {
      telemetryRows,
      estimatedBytes: Math.round(telemetryRows * bytesPerRow),
      bytesPerRow: Math.round(bytesPerRow),
    });

    await this.upsertRollup(tenantId, AnalyticsType.ALARM_FREQUENCY, start, {
      total: alarmsBySeverity.reduce((s, r) => s + parseInt(r.count, 10), 0),
      bySeverity: alarmsBySeverity.reduce(
        (acc, r) => ({ ...acc, [r.severity]: parseInt(r.count, 10) }),
        {} as Record<string, number>,
      ),
    });

    await this.upsertRollup(tenantId, AnalyticsType.SYSTEM_PERFORMANCE, start, {
      apiCalls,
      apiErrors,
      errorRate: apiCalls > 0 ? Math.round((apiErrors / apiCalls) * 1000) / 10 : 0,
    });

    const health = await this.checkSystemHealth();
    await this.upsertRollup(tenantId, AnalyticsType.SYSTEM_HEALTH, start, health as any);

    for (const v of viewLogs) {
      await this.upsertRollup(
        tenantId,
        AnalyticsType.DASHBOARD_PERFORMANCE,
        start,
        { viewCount: parseInt(v.views, 10), avgLoadMs: Math.round(parseFloat(v.avgLoad ?? '0')) },
        { entityId: v.dashboardId, entityType: 'dashboard' },
      );
    }
  }

  /**
   * Idempotent rollup write.
   *
   * The previous cron inserted unconditionally, so a manual re-run (or the
   * retry path) duplicated every row for that day — there is no unique
   * constraint on the table to stop it. Updating the matching row keeps
   * re-runs safe.
   */
  private async upsertRollup(
    tenantId: string,
    type: AnalyticsType,
    timestamp: Date,
    metrics: Record<string, any>,
    entity?: { entityId: string; entityType: string },
  ): Promise<void> {
    const where: any = { tenantId, type, period: AnalyticsPeriod.DAILY, timestamp };
    if (entity) where.entityId = entity.entityId;

    const existing = await this.analyticsRepo.findOne({ where });
    if (existing) {
      existing.metrics = metrics;
      existing.metadata = { calculatedAt: new Date(), sources: ['postgres'] };
      await this.analyticsRepo.save(existing);
      return;
    }

    await this.analyticsRepo.save(
      this.analyticsRepo.create({
        tenantId,
        type,
        period: AnalyticsPeriod.DAILY,
        timestamp,
        metrics,
        metadata: { calculatedAt: new Date(), sources: ['postgres'] },
        ...(entity ?? {}),
      }),
    );
  }

  // ══════════════════════════════════════════════════════════════════════════
  // CSV
  // ══════════════════════════════════════════════════════════════════════════

  toCsv(rows: Record<string, any>[]): string {
    if (!rows?.length) return '';
    const headers = Object.keys(rows[0]);
    const lines = rows.map((r) =>
      headers
        .map((h) => {
          const v = r[h];
          if (v === null || v === undefined) return '';
          if (typeof v === 'object') return `"${JSON.stringify(v).replace(/"/g, '""')}"`;
          return `"${String(v).replace(/"/g, '""')}"`;
        })
        .join(','),
    );
    return [headers.join(','), ...lines].join('\n');
  }
}
