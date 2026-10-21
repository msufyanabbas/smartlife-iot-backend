import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';
import PDFDocument from 'pdfkit';
import { Device } from '@modules/devices/entities/device.entity';
import { Alarm } from '@modules/alarms/entities/alarm.entity';
import { User } from '@modules/users/entities/user.entity';
import { TelemetryService } from '@modules/telemetry/telemetry.service';
import { AnalyticsService } from '@modules/analytics/analytics.service';
import { AuditService } from '@modules/audit/audit.service';
import { AnalyticsTimeRange } from '@modules/analytics/dto/analytics.dto';
import type { ReportDefinition } from './entities/report-template.entity';
import {
  XLSX_MIME_TYPE,
  buildXlsxBuffer,
  sanitiseSheetName,
} from '@common/utils/xlsx.util';
import {
  REPORT_SOURCES,
  ReportColumnManifest,
  ReportDateRangeMode,
  ReportEntityKind,
  ReportFormat,
  ReportGroupingInterval,
} from './report.enum';

export const REPORT_DEFAULT_ROW_LIMIT = 50_000;
/** A preview exists to check a definition, not to move data. */
export const REPORT_PREVIEW_ROW_LIMIT = 100;

export interface ReportPeriod {
  from: Date;
  to: Date;
  requestedHours?: number;
  /** Set when the backing service snapped the window to one of its own. */
  snappedTo?: string;
}

export interface ReportRowSet {
  columns: ReportColumnManifest[];
  rows: Array<Record<string, unknown>>;
  period: ReportPeriod;
  /** True when the row limit cut the result short. */
  truncated: boolean;
}

export interface RenderedReport {
  content: Buffer;
  mimeType: string;
  extension: string;
}

/**
 * Turns a `ReportDefinition` into rows, then into a file.
 *
 * ── It is deliberately not a query engine ─────────────────────────────────
 * Every row source delegates to a service that already exists — see
 * `backedBy` on each entry in `REPORT_SOURCES`. The only queries written here
 * are the tenant-scoped entity selections (`devices`, `alarms`) that pick WHICH
 * rows a source runs over; the aggregation and timeseries work is
 * `TelemetryService`'s and `AnalyticsService`'s.
 *
 * ── The tenant check in front of TelemetryService is load bearing ─────────
 * `TelemetryService.getTimeSeries/getAggregated/getStatistics` take a
 * `deviceId` and a `userId` and look the device up by id ALONE — they do not
 * filter by tenant (the comment in that file says the tenant on the device
 * record is used for access control, but no such predicate exists in the
 * query). So every device a report touches is resolved here first, through a
 * `tenantId`-scoped query, and only ids that came back are passed down. A
 * report whose definition names another tenant's device ids returns nothing
 * for them rather than their data.
 */
@Injectable()
export class ReportGeneratorService {
  private readonly logger = new Logger(ReportGeneratorService.name);

  constructor(
    @InjectRepository(Device)
    private readonly deviceRepo: Repository<Device>,
    @InjectRepository(Alarm)
    private readonly alarmRepo: Repository<Alarm>,
    private readonly telemetryService: TelemetryService,
    private readonly analyticsService: AnalyticsService,
    private readonly auditService: AuditService,
  ) {}

  // ══════════════════════════════════════════════════════════════════════════
  // ROWS
  // ══════════════════════════════════════════════════════════════════════════

  async buildRowSet(
    tenantId: string,
    definition: ReportDefinition,
    options: {
      /** Needed by the AUDIT_LOG source, whose service filters by caller role. */
      runAs?: User | null;
      rowLimit?: number;
    } = {},
  ): Promise<ReportRowSet> {
    const manifest = REPORT_SOURCES[definition.entity];
    if (!manifest) {
      throw new BadRequestException(
        `Unknown report entity "${definition.entity}"`,
      );
    }

    const limit = Math.min(
      options.rowLimit ?? definition.limit ?? REPORT_DEFAULT_ROW_LIMIT,
      definition.limit ?? REPORT_DEFAULT_ROW_LIMIT,
    );
    const period = this.resolvePeriod(definition);
    const columns = this.resolveColumns(definition, manifest.columns);

    let rows: Array<Record<string, unknown>>;

    switch (definition.entity) {
      case ReportEntityKind.DEVICE_TELEMETRY:
        rows = await this.rawTelemetryRows(tenantId, definition, period, limit);
        break;
      case ReportEntityKind.DEVICE_TELEMETRY_AGGREGATED:
        rows = await this.aggregatedTelemetryRows(
          tenantId,
          definition,
          period,
          limit,
        );
        break;
      case ReportEntityKind.DEVICE_TELEMETRY_STATISTICS:
        rows = await this.telemetryStatisticsRows(
          tenantId,
          definition,
          period,
          limit,
        );
        break;
      case ReportEntityKind.DEVICE_INVENTORY:
        rows = await this.deviceInventoryRows(tenantId, definition, period, limit);
        break;
      case ReportEntityKind.DEVICE_ANALYTICS:
        rows = await this.deviceAnalyticsRows(tenantId, definition, period, limit);
        break;
      case ReportEntityKind.ALARM_HISTORY:
        rows = await this.alarmHistoryRows(tenantId, definition, period, limit);
        break;
      case ReportEntityKind.AUDIT_LOG:
        rows = await this.auditLogRows(definition, period, limit, options.runAs);
        break;
      default:
        throw new BadRequestException(
          `Report entity "${definition.entity}" has no row source`,
        );
    }

    const truncated = rows.length > limit;
    if (truncated) rows = rows.slice(0, limit);

    // Project to the requested columns, in the requested order. Doing it here
    // rather than in each source keeps every source free to return its natural
    // shape and keeps the column contract in one place.
    const projected = rows.map((row) => {
      const out: Record<string, unknown> = {};
      for (const column of columns) out[column.key] = row[column.key] ?? null;
      return out;
    });

    return { columns, rows: projected, period, truncated };
  }

  // ── DEVICE_TELEMETRY — TelemetryService.getTimeSeries() ───────────────────

  private async rawTelemetryRows(
    tenantId: string,
    definition: ReportDefinition,
    period: ReportPeriod,
    limit: number,
  ): Promise<Array<Record<string, unknown>>> {
    const keys = definition.filters?.telemetryKeys ?? [];
    if (keys.length === 0) {
      throw new BadRequestException({
        message: 'DEVICE_TELEMETRY needs at least one telemetry key',
        errors: [
          'definition.filters.telemetryKeys must list at least one key — ' +
            'TelemetryService.getTimeSeries() reads one series per (device, key). ' +
            'Use DEVICE_TELEMETRY_AGGREGATED or DEVICE_TELEMETRY_STATISTICS for a ' +
            'summary across keys.',
        ],
      });
    }

    const devices = await this.resolveDevices(tenantId, definition);
    const rows: Array<Record<string, unknown>> = [];
    const from = period.from.toISOString();
    const to = period.to.toISOString();

    for (const device of devices) {
      for (const key of keys) {
        // Per (device, key) budget, so one chatty device cannot consume the
        // whole limit and silently hide every other device from the report.
        const perSeries = Math.max(
          1,
          Math.ceil(limit / Math.max(1, devices.length * keys.length)),
        );
        const series = await this.telemetryService.getTimeSeries(
          device.id,
          device.userId,
          key,
          from,
          to,
          perSeries,
        );
        for (const point of series) {
          rows.push({
            deviceId: device.id,
            deviceName: device.name,
            deviceKey: device.deviceKey,
            key,
            timestamp: point.timestamp,
            value: point.value,
          });
        }
        if (rows.length > limit) return rows;
      }
    }

    // Chronological across devices, which is what a reader of a raw export
    // expects; the per-series calls return each series already ordered.
    rows.sort(
      (a, b) =>
        new Date(a.timestamp as string).getTime() -
        new Date(b.timestamp as string).getTime(),
    );
    return rows;
  }

  // ── DEVICE_TELEMETRY_AGGREGATED — TelemetryService.getAggregated() ────────

  private async aggregatedTelemetryRows(
    tenantId: string,
    definition: ReportDefinition,
    period: ReportPeriod,
    limit: number,
  ): Promise<Array<Record<string, unknown>>> {
    const interval = this.resolveInterval(definition);
    const devices = await this.resolveDevices(tenantId, definition);
    const rows: Array<Record<string, unknown>> = [];

    for (const device of devices) {
      const buckets = await this.telemetryService.getAggregated(
        device.id,
        device.userId,
        interval,
        period.from.toISOString(),
        period.to.toISOString(),
      );
      for (const bucket of buckets) {
        rows.push({
          deviceId: device.id,
          deviceName: device.name,
          period: bucket.period,
          count: bucket.count,
          temperatureAvg: bucket.temperature?.avg ?? null,
          temperatureMin: bucket.temperature?.min ?? null,
          temperatureMax: bucket.temperature?.max ?? null,
          humidityAvg: bucket.humidity?.avg ?? null,
          humidityMin: bucket.humidity?.min ?? null,
          humidityMax: bucket.humidity?.max ?? null,
          pressureAvg: bucket.pressure?.avg ?? null,
          batteryAvg: bucket.battery?.avg ?? null,
        });
      }
      if (rows.length > limit) return rows;
    }

    return rows;
  }

  // ── DEVICE_TELEMETRY_STATISTICS — TelemetryService.getStatistics() ────────

  private async telemetryStatisticsRows(
    tenantId: string,
    definition: ReportDefinition,
    period: ReportPeriod,
    limit: number,
  ): Promise<Array<Record<string, unknown>>> {
    const devices = (await this.resolveDevices(tenantId, definition)).slice(
      0,
      limit,
    );
    const rows: Array<Record<string, unknown>> = [];

    for (const device of devices) {
      const stats = await this.telemetryService.getStatistics(
        device.id,
        device.userId,
        period.from.toISOString(),
        period.to.toISOString(),
      );
      rows.push({
        deviceId: device.id,
        deviceName: device.name,
        totalRecords: stats.totalRecords,
        temperatureAvg: stats.temperature?.avg ?? null,
        temperatureMin: stats.temperature?.min ?? null,
        temperatureMax: stats.temperature?.max ?? null,
        humidityAvg: stats.humidity?.avg ?? null,
        humidityMin: stats.humidity?.min ?? null,
        humidityMax: stats.humidity?.max ?? null,
        pressureAvg: stats.pressure?.avg ?? null,
        batteryAvg: stats.battery?.avg ?? null,
        signalAvg: stats.signal?.avg ?? null,
        firstRecord: stats.timeRange?.first ?? null,
        lastRecord: stats.timeRange?.last ?? null,
      });
    }

    return rows;
  }

  // ── DEVICE_INVENTORY — tenant-scoped Device repository ───────────────────

  private async deviceInventoryRows(
    tenantId: string,
    definition: ReportDefinition,
    period: ReportPeriod,
    limit: number,
  ): Promise<Array<Record<string, unknown>>> {
    const qb = this.deviceQuery(tenantId, definition)
      .andWhere('d.createdAt BETWEEN :from AND :to', {
        from: period.from,
        to: period.to,
      })
      .orderBy('d.name', 'ASC')
      .take(limit + 1);

    const devices = await qb.getMany();
    return devices.map((d) => ({
      id: d.id,
      name: d.name,
      deviceKey: d.deviceKey,
      type: d.type,
      status: d.status,
      protocol: d.protocol,
      manufacturer: d.manufacturer ?? null,
      model: d.model ?? null,
      assetId: d.assetId ?? null,
      customerId: d.customerId ?? null,
      deviceProfileId: d.deviceProfileId ?? null,
      lastSeenAt: d.lastSeenAt ?? null,
      messageCount: d.messageCount ?? 0,
      errorCount: d.errorCount ?? 0,
      createdAt: d.createdAt,
    }));
  }

  // ── DEVICE_ANALYTICS — AnalyticsService.getDeviceAnalytics() ─────────────

  private async deviceAnalyticsRows(
    tenantId: string,
    definition: ReportDefinition,
    period: ReportPeriod,
    limit: number,
  ): Promise<Array<Record<string, unknown>>> {
    const timeRange = this.snapToAnalyticsRange(period);
    period.snappedTo = timeRange;

    const rows: Array<Record<string, unknown>> = [];
    // The analytics service paginates at 100 per page, so walk it rather than
    // reimplementing its query with a bigger LIMIT.
    const pageSize = 100;
    for (let page = 1; rows.length <= limit; page += 1) {
      const result = await this.analyticsService.getDeviceAnalytics(
        tenantId,
        {
          timeRange,
          page,
          limit: pageSize,
          type: definition.filters?.deviceType?.[0],
          status: definition.filters?.deviceStatus?.[0],
        },
        definition.filters?.customerId ?? null,
      );
      rows.push(...result.devices);
      if (page >= (result.meta?.totalPages ?? 1)) break;
    }

    return rows;
  }

  // ── ALARM_HISTORY — tenant-scoped Alarm repository ───────────────────────

  private async alarmHistoryRows(
    tenantId: string,
    definition: ReportDefinition,
    period: ReportPeriod,
    limit: number,
  ): Promise<Array<Record<string, unknown>>> {
    const filters = definition.filters ?? {};
    const qb = this.alarmRepo
      .createQueryBuilder('a')
      .leftJoin('a.device', 'device')
      .addSelect(['device.id', 'device.name'])
      .where('a.tenantId = :tenantId', { tenantId })
      .andWhere('a.createdAt BETWEEN :from AND :to', {
        from: period.from,
        to: period.to,
      });

    if (filters.deviceIds?.length) {
      // Scoped to this tenant's devices first, so a foreign id matches nothing.
      const ids = (await this.resolveDeviceIds(tenantId, filters.deviceIds)) ?? [];
      qb.andWhere('a.deviceId IN (:...deviceIds)', {
        deviceIds: ids.length ? ids : [NO_SUCH_UUID],
      });
    }
    if (filters.alarmSeverity?.length) {
      qb.andWhere('a.severity IN (:...severities)', {
        severities: filters.alarmSeverity,
      });
    }
    if (filters.alarmStatus?.length) {
      qb.andWhere('a.status IN (:...statuses)', { statuses: filters.alarmStatus });
    }
    if (filters.customerId) {
      qb.andWhere('a.customerId = :customerId', {
        customerId: filters.customerId,
      });
    }

    const alarms = await qb
      .orderBy('a.createdAt', 'DESC')
      .take(limit + 1)
      .getMany();

    return alarms.map((a) => ({
      id: a.id,
      name: a.name,
      severity: a.severity,
      status: a.status,
      deviceId: a.deviceId ?? null,
      deviceName: a.device?.name ?? null,
      message: a.message ?? null,
      currentValue: a.currentValue ?? null,
      triggerCount: a.triggerCount ?? 0,
      triggeredAt: a.triggeredAt ?? null,
      lastTriggeredAt: a.lastTriggeredAt ?? null,
      acknowledgedAt: a.acknowledgedAt ?? null,
      clearedAt: a.clearedAt ?? null,
      resolvedAt: a.resolvedAt ?? null,
      createdAt: a.createdAt,
    }));
  }

  // ── AUDIT_LOG — AuditService.findAll() ───────────────────────────────────

  private async auditLogRows(
    definition: ReportDefinition,
    period: ReportPeriod,
    limit: number,
    runAs?: User | null,
  ): Promise<Array<Record<string, unknown>>> {
    if (!runAs) {
      throw new BadRequestException(
        'An AUDIT_LOG report needs an identity to run as. AuditService applies ' +
          'role-based filtering from the caller, so a scheduled run requires the ' +
          'template’s saved userId to still resolve to a user.',
      );
    }

    const filters = definition.filters ?? {};
    // AuditService caps its own page at 1000, so walk pages up to the limit
    // rather than asking it for more than it will give.
    const pageSize = 1000;
    const rows: Array<Record<string, unknown>> = [];

    for (let page = 1; rows.length <= limit; page += 1) {
      const result = await this.auditService.findAll(
        {
          startDate: period.from.toISOString(),
          endDate: period.to.toISOString(),
          action: filters.auditAction as any,
          entityType: filters.auditEntityType as any,
          success: filters.auditSuccess,
          search: filters.search,
          page,
          limit: pageSize,
        } as any,
        runAs,
      );

      rows.push(
        ...result.data.map((log) => ({
          timestamp: log.timestamp,
          action: log.action,
          entityType: log.entityType,
          entityId: log.entityId ?? null,
          entityName: log.entityName ?? null,
          userName: log.userName ?? null,
          userEmail: log.userEmail ?? null,
          severity: log.severity,
          success: log.success,
          description: log.description ?? null,
          ipAddress: log.ipAddress ?? null,
        })),
      );

      if (page >= (result.meta?.totalPages ?? 1)) break;
    }

    return rows;
  }

  // ══════════════════════════════════════════════════════════════════════════
  // ENTITY SELECTION (tenant-scoped — see the class comment)
  // ══════════════════════════════════════════════════════════════════════════

  private deviceQuery(tenantId: string, definition: ReportDefinition) {
    const filters = definition.filters ?? {};
    const qb = this.deviceRepo
      .createQueryBuilder('d')
      .where('d.tenantId = :tenantId', { tenantId });

    if (filters.deviceIds?.length) {
      qb.andWhere('d.id IN (:...deviceIds)', { deviceIds: filters.deviceIds });
    }
    if (filters.deviceStatus?.length) {
      qb.andWhere('d.status IN (:...statuses)', {
        statuses: filters.deviceStatus,
      });
    }
    if (filters.deviceType?.length) {
      qb.andWhere('d.type IN (:...types)', { types: filters.deviceType });
    }
    if (filters.assetIds?.length) {
      qb.andWhere('d.assetId IN (:...assetIds)', { assetIds: filters.assetIds });
    }
    if (filters.customerId) {
      qb.andWhere('d.customerId = :customerId', {
        customerId: filters.customerId,
      });
    }
    return qb;
  }

  /**
   * The devices a telemetry report will read, resolved through a tenant-scoped
   * query. Only ids that came back here are ever handed to `TelemetryService`,
   * whose own lookups are by device id alone.
   */
  private async resolveDevices(
    tenantId: string,
    definition: ReportDefinition,
  ): Promise<Device[]> {
    const devices = await this.deviceQuery(tenantId, definition)
      .orderBy('d.name', 'ASC')
      // A telemetry report over thousands of devices is one TelemetryService
      // call per device; the cap is stated rather than discovered as a timeout.
      .take(MAX_DEVICES_PER_TELEMETRY_REPORT)
      .getMany();

    if (devices.length === 0) {
      this.logger.warn(
        `Report for tenant ${tenantId} matched no devices — filters: ${JSON.stringify(
          definition.filters ?? {},
        )}`,
      );
    }
    return devices;
  }

  private async resolveDeviceIds(
    tenantId: string,
    candidateIds: string[],
  ): Promise<string[]> {
    const rows = await this.deviceRepo.find({
      where: { tenantId, id: In(candidateIds) },
      select: ['id'],
    });
    return rows.map((r) => r.id);
  }

  // ══════════════════════════════════════════════════════════════════════════
  // DEFINITION RESOLUTION
  // ══════════════════════════════════════════════════════════════════════════

  resolvePeriod(definition: ReportDefinition): ReportPeriod {
    const range = definition.dateRange;

    if (range?.mode === ReportDateRangeMode.ABSOLUTE) {
      if (!range.from || !range.to) {
        throw new BadRequestException(
          'An ABSOLUTE date range needs both `from` and `to`',
        );
      }
      const from = new Date(range.from);
      const to = new Date(range.to);
      if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime())) {
        throw new BadRequestException('`from` and `to` must be valid instants');
      }
      if (from >= to) {
        throw new BadRequestException('`from` must be earlier than `to`');
      }
      return { from, to };
    }

    const hours = range?.lastHours ?? 24;
    const to = new Date();
    return {
      from: new Date(to.getTime() - hours * 3_600_000),
      to,
      requestedHours: hours,
    };
  }

  private resolveColumns(
    definition: ReportDefinition,
    available: ReportColumnManifest[],
  ): ReportColumnManifest[] {
    const manifest = REPORT_SOURCES[definition.entity];
    const requested = definition.columns?.length
      ? definition.columns
      : manifest.defaultColumns;

    const byKey = new Map(available.map((c) => [c.key, c] as const));
    const unknown = requested.filter((key) => !byKey.has(key));
    if (unknown.length) {
      throw new BadRequestException({
        message: `${unknown.length} column(s) are not produced by ${definition.entity}`,
        errors: unknown.map(
          (key) =>
            `column "${key}" is not available on ${definition.entity}; valid keys: ${available
              .map((c) => c.key)
              .join(', ')}`,
        ),
      });
    }

    return requested.map((key) => byKey.get(key)!);
  }

  private resolveInterval(
    definition: ReportDefinition,
  ): 'hour' | 'day' | 'month' {
    switch (definition.grouping?.interval) {
      case ReportGroupingInterval.HOUR:
        return 'hour';
      case ReportGroupingInterval.MONTH:
        return 'month';
      case ReportGroupingInterval.DAY:
      default:
        return 'day';
    }
  }

  /**
   * `AnalyticsService.getDeviceAnalytics()` takes one of five fixed windows, so
   * an arbitrary range is snapped to the nearest one that is at least as long
   * as the request. The chosen window is reported on the execution row rather
   * than left for the reader to infer from numbers that do not match the dates
   * on the cover.
   */
  private snapToAnalyticsRange(period: ReportPeriod): AnalyticsTimeRange {
    const hours =
      period.requestedHours ??
      (period.to.getTime() - period.from.getTime()) / 3_600_000;

    if (hours <= 1) return AnalyticsTimeRange.ONE_HOUR;
    if (hours <= 24) return AnalyticsTimeRange.ONE_DAY;
    if (hours <= 24 * 7) return AnalyticsTimeRange.SEVEN_DAYS;
    if (hours <= 24 * 30) return AnalyticsTimeRange.THIRTY_DAYS;
    return AnalyticsTimeRange.NINETY_DAYS;
  }

  // ══════════════════════════════════════════════════════════════════════════
  // RENDERING
  // ══════════════════════════════════════════════════════════════════════════

  async render(
    rowSet: ReportRowSet,
    format: ReportFormat,
    meta: { name: string; generatedAt: Date; tenantId: string },
  ): Promise<RenderedReport> {
    switch (format) {
      case ReportFormat.JSON:
        return {
          content: Buffer.from(
            JSON.stringify(
              {
                report: meta.name,
                generatedAt: meta.generatedAt.toISOString(),
                period: {
                  from: rowSet.period.from.toISOString(),
                  to: rowSet.period.to.toISOString(),
                  snappedTo: rowSet.period.snappedTo ?? null,
                },
                columns: rowSet.columns,
                rowCount: rowSet.rows.length,
                truncated: rowSet.truncated,
                rows: rowSet.rows,
              },
              null,
              2,
            ),
            'utf8',
          ),
          mimeType: 'application/json',
          extension: 'json',
        };

      case ReportFormat.PDF:
        return {
          content: await this.renderPdf(rowSet, meta),
          mimeType: 'application/pdf',
          extension: 'pdf',
        };

      case ReportFormat.XLSX:
        return {
          content: await this.renderXlsx(rowSet, meta),
          mimeType: XLSX_MIME_TYPE,
          extension: 'xlsx',
        };

      case ReportFormat.CSV:
      default:
        return {
          content: Buffer.from(this.renderCsv(rowSet), 'utf8'),
          mimeType: 'text/csv; charset=utf-8',
          extension: 'csv',
        };
    }
  }

  /**
   * RFC 4180 CSV.
   *
   * Every field is quoted and embedded quotes are doubled. The existing
   * exporters in this codebase do not do this consistently —
   * `TelemetryService.exportToCSV()` joins raw values with commas, so a device
   * named "Lobby, North" shifts every later column on that row — and a report
   * is the one artefact where that silently corrupts someone's spreadsheet.
   * CRLF line endings, because Excel on Windows treats a bare LF file as one
   * long row in some locales.
   */
  renderCsv(rowSet: ReportRowSet): string {
    const escape = (value: unknown): string => {
      if (value === null || value === undefined) return '""';
      const text =
        value instanceof Date
          ? value.toISOString()
          : typeof value === 'object'
            ? JSON.stringify(value)
            : String(value);
      return `"${text.replace(/"/g, '""')}"`;
    };

    const header = rowSet.columns.map((c) => escape(c.label)).join(',');
    const body = rowSet.rows.map((row) =>
      rowSet.columns.map((c) => escape(row[c.key])).join(','),
    );
    return [header, ...body].join('\r\n') + '\r\n';
  }

  /**
   * A real .xlsx workbook.
   *
   * Structured deliberately like `renderPdf()` below: the same cover block,
   * then the same table, so the three binary-ish formats describe a run
   * identically and a reader comparing a PDF against a spreadsheet of the same
   * execution sees the same period, row count and truncation warning.
   *
   * Two things it does that the PDF cannot:
   *
   *  · **No column cap.** `MAX_PDF_COLUMNS` exists because an A4 landscape
   *    cell is a few characters wide past twelve columns; a spreadsheet has no
   *    such limit, so every column is written. A report that is unreadable as
   *    a PDF is the reason to pick this format.
   *  · **Typed cells.** Timestamps land as real date cells and numbers as
   *    numbers, so the recipient can sort and pivot. That is the whole
   *    difference from CSV, which Excel re-guesses per locale — the `"30.000"`
   *    vs `30` problem that bites elsewhere in this codebase.
   *
   * The workbook builder lives in `@common/utils/xlsx.util` rather than here
   * because `POST /analytics/export` renders the same way; see that file's
   * header.
   */
  private renderXlsx(
    rowSet: ReportRowSet,
    meta: { name: string; generatedAt: Date },
  ): Promise<Buffer> {
    const notes = [
      meta.name,
      `Generated ${meta.generatedAt.toISOString()}`,
      `Period ${rowSet.period.from.toISOString()} → ${rowSet.period.to.toISOString()}` +
        (rowSet.period.snappedTo
          ? ` (analytics window snapped to ${rowSet.period.snappedTo})`
          : ''),
      `${rowSet.rows.length} row(s)` +
        (rowSet.truncated ? ' — TRUNCATED at the row limit' : ''),
    ];

    return buildXlsxBuffer([
      {
        // The report's own name, cleaned of the characters Excel refuses in a
        // tab name and clipped to 31 — a longer or `/`-bearing name makes the
        // workbook unopenable rather than oddly titled.
        name: sanitiseSheetName(meta.name, 'Report'),
        columns: rowSet.columns.map((c) => ({ key: c.key, label: c.label })),
        rows: rowSet.rows,
        notes,
      },
    ]);
  }

  /**
   * A paginated landscape table, built the same way
   * `subscriptions/invoice-pdf.service.ts` builds an invoice: a `PDFDocument`
   * streamed into buffers and resolved on `end`.
   *
   * Columns are laid out across the content width proportionally. Beyond
   * `MAX_PDF_COLUMNS` the cells become unreadable, so the extra columns are
   * dropped and a line on the cover says which — a PDF that silently omits
   * data is worse than one that says it did.
   */
  private renderPdf(
    rowSet: ReportRowSet,
    meta: { name: string; generatedAt: Date },
  ): Promise<Buffer> {
    return new Promise((resolve, reject) => {
      const doc = new PDFDocument({ margin: 40, size: 'A4', layout: 'landscape' });
      const chunks: Buffer[] = [];
      doc.on('data', (chunk) => chunks.push(chunk as Buffer));
      doc.on('end', () => resolve(Buffer.concat(chunks)));
      doc.on('error', reject);

      const columns = rowSet.columns.slice(0, MAX_PDF_COLUMNS);
      const dropped = rowSet.columns.length - columns.length;

      const left = doc.page.margins.left;
      const contentWidth =
        doc.page.width - doc.page.margins.left - doc.page.margins.right;
      const colWidth = contentWidth / columns.length;
      const rowHeight = 18;

      // ── Cover block ─────────────────────────────────────────────────────
      doc
        .fontSize(18)
        .font('Helvetica-Bold')
        .fillColor('#1a1a2e')
        .text(meta.name, left, doc.page.margins.top);

      doc
        .fontSize(9)
        .font('Helvetica')
        .fillColor('#6b7280')
        .text(
          `Generated ${meta.generatedAt.toISOString()} · ` +
            `period ${rowSet.period.from.toISOString()} → ${rowSet.period.to.toISOString()}` +
            (rowSet.period.snappedTo
              ? ` (analytics window snapped to ${rowSet.period.snappedTo})`
              : '') +
            ` · ${rowSet.rows.length} row(s)` +
            (rowSet.truncated ? ' — TRUNCATED at the row limit' : '') +
            (dropped > 0
              ? ` · ${dropped} column(s) omitted for width: ${rowSet.columns
                  .slice(MAX_PDF_COLUMNS)
                  .map((c) => c.label)
                  .join(', ')}`
              : ''),
        );

      let y = doc.y + 14;

      const drawHeader = () => {
        doc.rect(left, y, contentWidth, rowHeight).fillColor('#f3f4f6').fill();
        doc.fontSize(8).font('Helvetica-Bold').fillColor('#374151');
        columns.forEach((column, index) => {
          doc.text(column.label, left + index * colWidth + 4, y + 5, {
            width: colWidth - 8,
            ellipsis: true,
            lineBreak: false,
          });
        });
        y += rowHeight;
      };

      drawHeader();

      doc.fontSize(8).font('Helvetica').fillColor('#1a1a2e');
      for (const row of rowSet.rows) {
        if (y + rowHeight > doc.page.height - doc.page.margins.bottom) {
          doc.addPage({ margin: 40, size: 'A4', layout: 'landscape' });
          y = doc.page.margins.top;
          drawHeader();
          doc.fontSize(8).font('Helvetica').fillColor('#1a1a2e');
        }

        columns.forEach((column, index) => {
          const value = row[column.key];
          const text =
            value === null || value === undefined
              ? ''
              : value instanceof Date
                ? value.toISOString()
                : typeof value === 'object'
                  ? JSON.stringify(value)
                  : String(value);
          doc.text(text, left + index * colWidth + 4, y + 5, {
            width: colWidth - 8,
            ellipsis: true,
            lineBreak: false,
          });
        });

        doc
          .moveTo(left, y + rowHeight)
          .lineTo(left + contentWidth, y + rowHeight)
          .lineWidth(0.25)
          .strokeColor('#e5e7eb')
          .stroke();
        y += rowHeight;
      }

      if (rowSet.rows.length === 0) {
        doc
          .fontSize(10)
          .font('Helvetica-Oblique')
          .fillColor('#9ca3af')
          .text('No rows matched this report’s definition.', left, y + 8);
      }

      doc.end();
    });
  }
}

/** Impossible id, so an `IN ()` predicate can be made to match nothing. */
const NO_SUCH_UUID = '00000000-0000-0000-0000-000000000000';

/**
 * A telemetry report issues one `TelemetryService` call per device (per key for
 * the raw source). The cap keeps a tenant-wide report from turning into
 * thousands of round trips; beyond it, narrow the report with a device filter
 * or a group.
 */
const MAX_DEVICES_PER_TELEMETRY_REPORT = 500;

/** More columns than this and an A4 landscape cell is a few characters wide. */
const MAX_PDF_COLUMNS = 12;
