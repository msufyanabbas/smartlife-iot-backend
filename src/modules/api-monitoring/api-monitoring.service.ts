// src/modules/api-monitoring/api-monitoring.service.ts
import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, SelectQueryBuilder } from 'typeorm';
import { Cron } from '@nestjs/schedule';
import { APILog } from './entities/api-log.entity';
import { Subscription } from '@modules/subscriptions/entities/subscription.entity';
import {
  APILogFilterDto,
  ApiMonitoringStatsQueryDto,
  resolveTimeRangeHours,
} from './dto/api-log-filter.dto';
import { PaginatedResponseDto } from '@common/dto/pagination.dto';
import { RedisService } from '@lib/redis/redis.service';
import { KafkaService } from '@lib/kafka/kafka.service';

/** Rows a single CSV export may contain. */
const EXPORT_MAX_ROWS = 10_000;

/** Requests slower than this are "slow" unless the caller says otherwise. */
const DEFAULT_SLOW_MS = 1000;

export interface ApiLogScope {
  tenantId?: string;
  customerId?: string;
}

@Injectable()
export class ApiMonitoringService {
  private readonly logger = new Logger(ApiMonitoringService.name);

  constructor(
    @InjectRepository(APILog)
    private readonly apiLogRepository: Repository<APILog>,
    // Read through the repository rather than importing SubscriptionsModule —
    // the cycle-avoidance pattern used by FloorPlansService and AnalyticsService.
    @InjectRepository(Subscription)
    private readonly subscriptionRepository: Repository<Subscription>,
    // RedisModule and KafkaModule are @Global(), so no import is needed.
    private readonly redis: RedisService,
    private readonly kafka: KafkaService,
  ) {}

  // ═══════════════════════════════════════════════════════════════════════════
  // QUERY BUILDING
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Base tenant/customer-scoped query.
   *
   * An undefined tenantId means platform-wide. Only SUPER_ADMIN reaches the
   * service that way — the controller substitutes undefined by role, and
   * TenantIsolationGuard guarantees every other role carries a tenantId.
   */
  private scoped(scope: ApiLogScope): SelectQueryBuilder<APILog> {
    const qb = this.apiLogRepository.createQueryBuilder('l');

    if (scope.tenantId) {
      qb.where('l.tenantId = :tenantId', { tenantId: scope.tenantId });
    } else {
      qb.where('1 = 1');
    }

    if (scope.customerId) {
      qb.andWhere('l.customerId = :customerId', { customerId: scope.customerId });
    }

    return qb;
  }

  private since(hours: number): Date {
    return new Date(Date.now() - hours * 60 * 60 * 1000);
  }

  /**
   * Applies timeRange (relative, wins) or startDate/endDate (absolute).
   * Each bound is applied independently — passing only one used to be silently
   * ignored on several endpoints.
   */
  private applyWindow(qb: SelectQueryBuilder<APILog>, filters: APILogFilterDto): void {
    if (filters.timeRange) {
      qb.andWhere('l.timestamp >= :rangeStart', {
        rangeStart: this.since(resolveTimeRangeHours(filters.timeRange)),
      });
      return;
    }
    if (filters.startDate) {
      qb.andWhere('l.timestamp >= :startDate', { startDate: new Date(filters.startDate) });
    }
    if (filters.endDate) {
      qb.andWhere('l.timestamp <= :endDate', { endDate: new Date(filters.endDate) });
    }
  }

  private applyFilters(qb: SelectQueryBuilder<APILog>, filters: APILogFilterDto): void {
    if (filters.method) {
      qb.andWhere('l.method = :method', { method: filters.method });
    }
    if (filters.endpoint) {
      qb.andWhere('l.endpoint ILIKE :endpoint', { endpoint: `%${filters.endpoint}%` });
    }
    if (filters.statusCode) {
      qb.andWhere('l.statusCode = :statusCode', { statusCode: filters.statusCode });
    }
    if (filters.isError !== undefined) {
      // statusCode, not the isError column: rows written before isError existed
      // were backfilled, but this stays correct even if a writer forgets it.
      qb.andWhere(
        filters.isError ? 'l.statusCode >= 400' : 'l.statusCode < 400',
      );
    }
    if (filters.userId) {
      qb.andWhere('l.userId = :userId', { userId: filters.userId });
    }
    if (filters.minResponseTime !== undefined) {
      qb.andWhere('l.responseTime >= :minResponseTime', {
        minResponseTime: filters.minResponseTime,
      });
    }
    this.applyWindow(qb, filters);
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // WRITE
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Used by seeds and tests. The hot path (ApiLoggingInterceptor /
   * ApiLoggingMiddleware) inserts directly — it must not depend on this module.
   */
  async createLog(logData: Partial<APILog>): Promise<APILog> {
    const log = this.apiLogRepository.create(logData);
    return await this.apiLogRepository.save(log);
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // LOGS
  // ═══════════════════════════════════════════════════════════════════════════

  async getLogs(
    tenantId: string | undefined,
    filters: APILogFilterDto,
    customerId?: string,
  ): Promise<PaginatedResponseDto<APILog>> {
    const page = filters.page ?? 1;
    const limit = filters.limit ?? 50;

    const qb = this.scoped({ tenantId, customerId });
    this.applyFilters(qb, filters);

    const [data, total] = await qb
      .orderBy('l.timestamp', 'DESC')
      .skip((page - 1) * limit)
      .take(limit)
      .getManyAndCount();

    return PaginatedResponseDto.create(data, page, limit, total);
  }

  /** Logs for one user — the caller's own history on /logs/my. */
  async getUserLogs(
    tenantId: string | undefined,
    userId: string,
    filters: APILogFilterDto,
  ): Promise<PaginatedResponseDto<APILog>> {
    return this.getLogs(tenantId, { ...filters, userId } as APILogFilterDto);
  }

  async getErrors(
    tenantId: string | undefined,
    filters: APILogFilterDto,
    customerId?: string,
  ): Promise<PaginatedResponseDto<APILog>> {
    return this.getLogs(tenantId, { ...filters, isError: true } as APILogFilterDto, customerId);
  }

  async getSlowRequests(
    tenantId: string | undefined,
    filters: APILogFilterDto,
    customerId?: string,
  ): Promise<PaginatedResponseDto<APILog>> {
    const page = filters.page ?? 1;
    const limit = filters.limit ?? 50;

    const qb = this.scoped({ tenantId, customerId });
    this.applyFilters(qb, {
      ...filters,
      minResponseTime: filters.minResponseTime ?? DEFAULT_SLOW_MS,
    } as APILogFilterDto);

    const [data, total] = await qb
      .orderBy('l.responseTime', 'DESC')
      .skip((page - 1) * limit)
      .take(limit)
      .getManyAndCount();

    return PaginatedResponseDto.create(data, page, limit, total);
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // STATS — GET /api-monitoring/stats
  // ═══════════════════════════════════════════════════════════════════════════

  async getStats(
    tenantId: string | undefined,
    query: ApiMonitoringStatsQueryDto,
    customerId?: string,
  ): Promise<{
    timeRange: string;
    windowStart: Date;
    totalRequests: number;
    successRequests: number;
    errorRequests: number;
    errorRate: number;
    avgResponseTime: number;
    p50ResponseTime: number;
    p95ResponseTime: number;
    p99ResponseTime: number;
    requestsPerMinute: number;
    topEndpoints: Array<{
      endpoint: string;
      count: number;
      avgTime: number;
      errorRate: number;
    }>;
    topErrors: Array<{ statusCode: number; endpoint: string; count: number }>;
    slowestEndpoints: Array<{
      endpoint: string;
      avgTime: number;
      maxTime: number;
      count: number;
    }>;
  }> {
    const timeRange = query.timeRange ?? '24h';
    const hours = resolveTimeRangeHours(timeRange);
    const windowStart = this.since(hours);

    const base = (): SelectQueryBuilder<APILog> => {
      const qb = this.scoped({ tenantId, customerId }).andWhere(
        'l.timestamp >= :windowStart',
        { windowStart },
      );
      if (query.endpoint) {
        qb.andWhere('l.endpoint ILIKE :endpoint', { endpoint: `%${query.endpoint}%` });
      }
      return qb;
    };

    const [totals, percentiles, topEndpoints, topErrors, slowest] = await Promise.all([
      base()
        .select('COUNT(*)', 'total')
        .addSelect('COUNT(*) FILTER (WHERE l.statusCode >= 400)', 'errors')
        .addSelect('AVG(l.responseTime)', 'avgTime')
        .getRawOne(),

      // PERCENTILE_CONT runs in Postgres. Sorting the rows into Node to pick
      // the 95th (the obvious approach) would stream the entire window into
      // memory on every call.
      base()
        .select('PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY l.responseTime)', 'p50')
        .addSelect('PERCENTILE_CONT(0.95) WITHIN GROUP (ORDER BY l.responseTime)', 'p95')
        .addSelect('PERCENTILE_CONT(0.99) WITHIN GROUP (ORDER BY l.responseTime)', 'p99')
        .getRawOne(),

      base()
        .select('l.endpoint', 'endpoint')
        .addSelect('COUNT(*)', 'count')
        .addSelect('AVG(l.responseTime)', 'avgTime')
        .addSelect('COUNT(*) FILTER (WHERE l.statusCode >= 400)', 'errors')
        .groupBy('l.endpoint')
        .orderBy('count', 'DESC')
        .limit(10)
        .getRawMany(),

      base()
        .andWhere('l.statusCode >= 400')
        .select('l.statusCode', 'statusCode')
        .addSelect('l.endpoint', 'endpoint')
        .addSelect('COUNT(*)', 'count')
        .groupBy('l.statusCode')
        .addGroupBy('l.endpoint')
        .orderBy('count', 'DESC')
        .limit(10)
        .getRawMany(),

      base()
        .select('l.endpoint', 'endpoint')
        .addSelect('AVG(l.responseTime)', 'avgTime')
        .addSelect('MAX(l.responseTime)', 'maxTime')
        .addSelect('COUNT(*)', 'count')
        .groupBy('l.endpoint')
        // A single 8s outlier should not top the chart — require a few samples.
        .having('COUNT(*) >= 3')
        .orderBy('"avgTime"', 'DESC')
        .limit(5)
        .getRawMany(),
    ]);

    const total = this.int(totals?.total);
    const errors = this.int(totals?.errors);

    return {
      timeRange,
      windowStart,
      totalRequests: total,
      successRequests: total - errors,
      errorRequests: errors,
      errorRate: total > 0 ? Math.round((errors / total) * 1000) / 10 : 0,
      avgResponseTime: this.round(totals?.avgTime),
      p50ResponseTime: this.round(percentiles?.p50),
      p95ResponseTime: this.round(percentiles?.p95),
      p99ResponseTime: this.round(percentiles?.p99),
      requestsPerMinute: Math.round((total / (hours * 60)) * 100) / 100,
      topEndpoints: topEndpoints.map((e) => ({
        endpoint: e.endpoint,
        count: this.int(e.count),
        avgTime: this.round(e.avgTime),
        errorRate:
          this.int(e.count) > 0
            ? Math.round((this.int(e.errors) / this.int(e.count)) * 1000) / 10
            : 0,
      })),
      topErrors: topErrors.map((e) => ({
        statusCode: this.int(e.statusCode),
        endpoint: e.endpoint,
        count: this.int(e.count),
      })),
      slowestEndpoints: slowest.map((e) => ({
        endpoint: e.endpoint,
        avgTime: this.round(e.avgTime),
        maxTime: this.round(e.maxTime),
        count: this.int(e.count),
      })),
    };
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // DASHBOARD — GET /api-monitoring/dashboard
  // ═══════════════════════════════════════════════════════════════════════════

  async getDashboard(
    tenantId: string | undefined,
    customerId?: string,
  ): Promise<{
    today: { requests: number; errors: number; avgResponseTime: number };
    thisWeek: { requests: number; errors: number };
    thisMonth: { requests: number; errors: number };
    hourlyTrend: Array<{
      hour: string;
      timestamp: Date;
      requests: number;
      errors: number;
      avgTime: number;
    }>;
    statusCodeDistribution: Array<{
      statusCode: number;
      count: number;
      percentage: number;
    }>;
    subscription: {
      plan: string | null;
      used: number;
      limit: number;
      unlimited: boolean;
      percentage: number;
      loggedThisMonth: number;
    };
  }> {
    const now = new Date();

    const startOfDay = new Date(now);
    startOfDay.setHours(0, 0, 0, 0);

    const startOfWeek = new Date(now);
    startOfWeek.setDate(now.getDate() - 7);

    const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1, 0, 0, 0, 0);

    const last24h = this.since(24);

    const totalsSince = (start: Date) =>
      this.scoped({ tenantId, customerId })
        .andWhere('l.timestamp >= :start', { start })
        .select('COUNT(*)', 'requests')
        .addSelect('COUNT(*) FILTER (WHERE l.statusCode >= 400)', 'errors')
        .addSelect('AVG(l.responseTime)', 'avgTime')
        .getRawOne();

    const [today, week, month, hourlyTrend, statusDist, subscription] = await Promise.all([
      totalsSince(startOfDay),
      totalsSince(startOfWeek),
      totalsSince(startOfMonth),

      this.scoped({ tenantId, customerId })
        .andWhere('l.timestamp >= :start', { start: last24h })
        .select("DATE_TRUNC('hour', l.timestamp)", 'hour')
        .addSelect('COUNT(*)', 'requests')
        .addSelect('COUNT(*) FILTER (WHERE l.statusCode >= 400)', 'errors')
        .addSelect('AVG(l.responseTime)', 'avgTime')
        .groupBy("DATE_TRUNC('hour', l.timestamp)")
        .orderBy('hour', 'ASC')
        .getRawMany(),

      this.scoped({ tenantId, customerId })
        .andWhere('l.timestamp >= :start', { start: startOfMonth })
        .select('l.statusCode', 'statusCode')
        .addSelect('COUNT(*)', 'count')
        .groupBy('l.statusCode')
        .orderBy('count', 'DESC')
        .getRawMany(),

      tenantId
        ? this.subscriptionRepository.findOne({
            where: { tenantId },
            order: { createdAt: 'DESC' },
          })
        : Promise.resolve(null),
    ]);

    const statusTotal = statusDist.reduce((sum, r) => sum + this.int(r.count), 0);

    // The quota counter (subscription.usage.apiCalls, maintained by
    // UsageTrackingInterceptor) is authoritative for billing; the log count is
    // reported alongside it because the two legitimately differ — logs include
    // unauthenticated requests, the counter does not.
    const loggedThisMonth = this.int(month?.requests);
    const limit = subscription?.limits?.apiCallsPerMonth ?? -1;
    const used = subscription?.usage?.apiCalls ?? loggedThisMonth;
    const unlimited = limit === -1;

    return {
      today: {
        requests: this.int(today?.requests),
        errors: this.int(today?.errors),
        avgResponseTime: this.round(today?.avgTime),
      },
      thisWeek: {
        requests: this.int(week?.requests),
        errors: this.int(week?.errors),
      },
      thisMonth: {
        requests: loggedThisMonth,
        errors: this.int(month?.errors),
      },
      hourlyTrend: hourlyTrend.map((h) => ({
        hour: new Date(h.hour).toISOString().slice(11, 16), // HH:mm, UTC
        timestamp: new Date(h.hour),
        requests: this.int(h.requests),
        errors: this.int(h.errors),
        avgTime: this.round(h.avgTime),
      })),
      statusCodeDistribution: statusDist.map((s) => ({
        statusCode: this.int(s.statusCode),
        count: this.int(s.count),
        percentage:
          statusTotal > 0
            ? Math.round((this.int(s.count) / statusTotal) * 1000) / 10
            : 0,
      })),
      subscription: {
        plan: subscription?.plan ?? null,
        used,
        limit,
        unlimited,
        percentage: unlimited || limit === 0 ? 0 : Math.round((used / limit) * 100),
        loggedThisMonth,
      },
    };
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // EXPORT — GET /api-monitoring/export
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * CSV of the filtered logs, capped at EXPORT_MAX_ROWS.
   *
   * Bypasses getLogs' pagination cap (100) deliberately, and returns the cap
   * alongside the payload so the controller can tell the caller when the export
   * was truncated instead of silently handing over a partial file.
   */
  async exportLogs(
    tenantId: string | undefined,
    filters: APILogFilterDto,
    customerId?: string,
  ): Promise<{ csv: string; rowCount: number; truncated: boolean }> {
    const qb = this.scoped({ tenantId, customerId });
    this.applyFilters(qb, filters);

    const rows = await qb
      .orderBy('l.timestamp', 'DESC')
      .take(EXPORT_MAX_ROWS)
      .getMany();

    const headers = [
      'timestamp',
      'requestId',
      'method',
      'endpoint',
      'url',
      'statusCode',
      'responseTime',
      'isError',
      'userId',
      'userRole',
      'customerId',
      'ip',
      'userAgent',
      'requestSize',
      'responseSize',
      'errorMessage',
    ] as const;

    const csv = [
      headers.join(','),
      ...rows.map((row) =>
        headers.map((h) => this.csvCell((row as any)[h])).join(','),
      ),
    ].join('\r\n');

    return { csv, rowCount: rows.length, truncated: rows.length === EXPORT_MAX_ROWS };
  }

  /**
   * RFC 4180 quoting. Also neutralises spreadsheet formula injection: a cell
   * starting with = + - @ is executed by Excel/Sheets on open, and these cells
   * contain attacker-controlled data (user agents, URLs, error messages).
   */
  private csvCell(value: unknown): string {
    if (value === null || value === undefined) return '';
    if (value instanceof Date) return value.toISOString();

    let text = String(value);
    if (/^[=+\-@\t\r]/.test(text)) text = `'${text}`;

    if (/[",\r\n]/.test(text)) {
      return `"${text.replace(/"/g, '""')}"`;
    }
    return text;
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // METRICS (retained endpoints)
  // ═══════════════════════════════════════════════════════════════════════════

  async getMetrics(tenantId: string | undefined, customerId?: string) {
    const stats = await this.getStats(tenantId, { timeRange: '24h' }, customerId);

    const byMethod = await this.scoped({ tenantId, customerId })
      .andWhere('l.timestamp >= :start', { start: this.since(24) })
      .select('l.method', 'method')
      .addSelect('COUNT(*)', 'count')
      .groupBy('l.method')
      .getRawMany();

    return {
      totalRequests: stats.totalRequests,
      successRequests: stats.successRequests,
      errorRequests: stats.errorRequests,
      successRate:
        stats.totalRequests > 0
          ? Math.round((stats.successRequests / stats.totalRequests) * 1000) / 10
          : 0,
      errorRate: stats.errorRate,
      avgResponseTime: stats.avgResponseTime,
      p95ResponseTime: stats.p95ResponseTime,
      requestsByEndpoint: stats.topEndpoints.map((e) => ({
        endpoint: e.endpoint,
        count: e.count,
      })),
      requestsByMethod: byMethod.reduce(
        (acc, item) => {
          acc[item.method] = this.int(item.count);
          return acc;
        },
        {} as Record<string, number>,
      ),
    };
  }

  async getUserMetrics(tenantId: string | undefined, userId: string) {
    const raw = await this.scoped({ tenantId })
      .andWhere('l.userId = :userId', { userId })
      .andWhere('l.timestamp >= :start', { start: this.since(24) })
      .select('COUNT(*)', 'total')
      .addSelect('COUNT(*) FILTER (WHERE l.statusCode >= 400)', 'errors')
      .addSelect('AVG(l.responseTime)', 'avgTime')
      .getRawOne();

    const total = this.int(raw?.total);
    const errors = this.int(raw?.errors);

    return {
      totalRequests: total,
      successRequests: total - errors,
      errorRequests: errors,
      successRate: total > 0 ? Math.round(((total - errors) / total) * 1000) / 10 : 0,
      errorRate: total > 0 ? Math.round((errors / total) * 1000) / 10 : 0,
      avgResponseTime: this.round(raw?.avgTime),
    };
  }

  /** All-time totals by status code. */
  async getStatistics(tenantId: string | undefined, customerId?: string) {
    const [total, byStatus] = await Promise.all([
      this.scoped({ tenantId, customerId }).getCount(),
      this.scoped({ tenantId, customerId })
        .select('l.statusCode', 'statusCode')
        .addSelect('COUNT(*)', 'count')
        .groupBy('l.statusCode')
        .orderBy('count', 'DESC')
        .getRawMany(),
    ]);

    return {
      total,
      byStatusCode: byStatus.reduce(
        (acc, item) => {
          acc[this.int(item.statusCode)] = this.int(item.count);
          return acc;
        },
        {} as Record<number, number>,
      ),
    };
  }

  async getTopEndpoints(tenantId: string | undefined, customerId?: string) {
    const rows = await this.scoped({ tenantId, customerId })
      .andWhere('l.timestamp >= :start', { start: this.since(24) })
      .select('l.endpoint', 'endpoint')
      .addSelect('COUNT(*)', 'count')
      .addSelect('AVG(l.responseTime)', 'avgResponseTime')
      .addSelect('COUNT(*) FILTER (WHERE l.statusCode >= 400)', 'errors')
      .groupBy('l.endpoint')
      .orderBy('count', 'DESC')
      .limit(20)
      .getRawMany();

    return rows.map((r) => ({
      endpoint: r.endpoint,
      count: this.int(r.count),
      avgResponseTime: this.round(r.avgResponseTime),
      errorCount: this.int(r.errors),
    }));
  }

  /** Per-minute response times and request counts over the last hour. */
  async getPerformanceMetrics(tenantId: string | undefined, customerId?: string) {
    const rows = await this.scoped({ tenantId, customerId })
      .andWhere('l.timestamp >= :start', { start: this.since(1) })
      .select("DATE_TRUNC('minute', l.timestamp)", 'minute')
      .addSelect('AVG(l.responseTime)', 'avgResponseTime')
      .addSelect('MAX(l.responseTime)', 'maxResponseTime')
      .addSelect('COUNT(*)', 'requests')
      .addSelect('COUNT(*) FILTER (WHERE l.statusCode >= 400)', 'errors')
      .groupBy('minute')
      .orderBy('minute', 'ASC')
      .getRawMany();

    return {
      responseTimesByMinute: rows.map((r) => ({
        time: r.minute,
        avgResponseTime: this.round(r.avgResponseTime),
        maxResponseTime: this.round(r.maxResponseTime),
        requests: this.int(r.requests),
        errors: this.int(r.errors),
      })),
    };
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // HEALTH
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Real probes. This used to return the string 'healthy' for every service
   * unconditionally, which is worse than having no health endpoint at all.
   */
  async getHealth() {
    const [database, cache, messageQueue] = await Promise.all([
      this.apiLogRepository
        .query('SELECT 1')
        .then(() => 'healthy' as const)
        .catch(() => 'down' as const),
      this.redis.client
        .ping()
        .then((r: string) => (r === 'PONG' ? ('healthy' as const) : ('down' as const)))
        .catch(() => 'down' as const),
      Promise.resolve(this.kafka.isHealthy() ? ('healthy' as const) : ('down' as const)),
    ]);

    const services = { database, cache, messageQueue };
    const memory = process.memoryUsage();

    return {
      status: Object.values(services).every((s) => s === 'healthy')
        ? 'healthy'
        : 'degraded',
      timestamp: new Date(),
      services,
      uptime: Math.round(process.uptime()),
      memory: {
        heapUsedMB: Math.round(memory.heapUsed / 1024 / 1024),
        rssMB: Math.round(memory.rss / 1024 / 1024),
      },
    };
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // RETENTION
  // ═══════════════════════════════════════════════════════════════════════════

  /** Retention window in days — override with API_LOG_RETENTION_DAYS. */
  private retentionDays(): number {
    const configured = parseInt(process.env.API_LOG_RETENTION_DAYS ?? '', 10);
    return Number.isFinite(configured) && configured > 0 ? configured : 30;
  }

  /**
   * Hard-deletes logs past the retention window.
   *
   * Deliberately a hard DELETE, not the soft delete BaseEntity provides —
   * soft-deleting would keep every row forever and only hide it.
   */
  @Cron('0 3 * * *') // 03:00 daily
  async cleanupOldLogs(): Promise<void> {
    const days = this.retentionDays();
    const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000);

    const result = await this.apiLogRepository
      .createQueryBuilder()
      .delete()
      .where('timestamp < :cutoff', { cutoff })
      .execute();

    this.logger.log(
      `API log cleanup: deleted ${result.affected ?? 0} records older than ${days} days`,
    );
  }

  async deleteOldLogsForTenant(tenantId: string, daysOld: number): Promise<number> {
    const cutoff = new Date(Date.now() - daysOld * 24 * 60 * 60 * 1000);

    const result = await this.apiLogRepository
      .createQueryBuilder()
      .delete()
      .where('"tenantId" = :tenantId', { tenantId })
      .andWhere('timestamp < :cutoff', { cutoff })
      .execute();

    return result.affected ?? 0;
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // RAW-RESULT COERCION
  // Postgres returns COUNT/AVG as strings through the driver.
  // ═══════════════════════════════════════════════════════════════════════════

  private int(value: unknown): number {
    const n = parseInt(String(value ?? '0'), 10);
    return Number.isFinite(n) ? n : 0;
  }

  private round(value: unknown): number {
    const n = parseFloat(String(value ?? '0'));
    return Number.isFinite(n) ? Math.round(n) : 0;
  }
}
