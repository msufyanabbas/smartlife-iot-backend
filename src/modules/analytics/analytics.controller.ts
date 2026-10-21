// src/modules/analytics/analytics.controller.ts
//
// Every route is tenant-scoped: `tenantId` comes from the JWT via
// @CurrentUser('tenantId') and is passed as the first argument to the service,
// which refuses to run without it. `customerId` is passed alongside so a
// CUSTOMER / CUSTOMER_USER caller is narrowed to their own devices rather than
// seeing the whole tenant — the isolation gap the previous controller had on
// /dashboards, /data-consumption, /system-performance and /geo.
//
// No @UseGuards() here: the whole guard stack (throttle → jwt → roles → tenant
// isolation → customer access → subscription → …) is registered globally in
// GuardsModule. The decorators below only set the metadata those guards read.
import {
  Controller, Get, Post, Delete,
  Body, Query, Param, Res,
} from '@nestjs/common';
import type { Response } from 'express';
import { ApiTags, ApiParam, ApiBody } from '@nestjs/swagger';

import { AnalyticsService } from './analytics.service';
import {
  AnalyticsAggregation,
  AnalyticsEntityType,
  CreateAnalyticsDto,
  EntityAggregateQueryDto,
  EntityTimeSeriesDto,
  ExportAnalyticsDto,
  QueryAnalyticsDto,
  DeviceAnalyticsQueryDto,
  DeviceDetailQueryDto,
  GeoAnalyticsQueryDto,
  TimeRangeQueryDto,
  DateRangeQueryDto,
  RecordDashboardViewDto,
} from './dto/analytics.dto';
import { CurrentUser } from '@common/decorators/current-user.decorator';
import { Roles } from '@common/decorators/roles.decorator';
import { SwaggerAuth } from '@common/decorators/access-control.decorator';
import { ParseIdPipe } from '@common/pipes/parse-id.pipe';
import { UserRole } from '@common/enums/index.enum';
import { RequirePermissions } from '@common/decorators/permission.decorator';

/**
 * Read access for every authenticated role.
 *
 * SUPER_ADMIN is listed explicitly: RolesGuard compares `user.role` against the
 * required list with no special case for super admins, so omitting it would
 * lock them out rather than let them through.
 */
const AnalyticsReader = () =>
  Roles(UserRole.SUPER_ADMIN, UserRole.TENANT_ADMIN, UserRole.CUSTOMER, UserRole.CUSTOMER_USER);

@ApiTags('Analytics')
@Controller('analytics')
export class AnalyticsController {
  constructor(private readonly analyticsService: AnalyticsService) {}

  private csv(res: Response, rows: any[], filename: string) {
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    return res.send(this.analyticsService.toCsv(rows));
  }

  // ── 1. Overview ───────────────────────────────────────────────────────────

  @Get('overview')
  @RequirePermissions('analytics:read')
  @AnalyticsReader()
  @SwaggerAuth('Tenant dashboard summary', 'Overview retrieved')
  getOverview(
    @CurrentUser('tenantId') tenantId: string,
    @CurrentUser('customerId') customerId: string | null,
  ) {
    return this.analyticsService.getOverview(tenantId, customerId);
  }

  // ── 2. Device analytics list ──────────────────────────────────────────────

  @Get('devices')
  @RequirePermissions('analytics:read')
  @AnalyticsReader()
  @SwaggerAuth('Per-device analytics', 'Device analytics retrieved')
  async getDeviceAnalytics(
    @CurrentUser('tenantId') tenantId: string,
    @CurrentUser('customerId') customerId: string | null,
    @Query() query: DeviceAnalyticsQueryDto,
    @Res({ passthrough: true }) res: Response,
  ) {
    const data = await this.analyticsService.getDeviceAnalytics(tenantId, query, customerId);
    if (query.format === 'csv') return this.csv(res, data.devices, 'device-analytics.csv');
    return data;
  }

  // ── 3. Single device deep analytics ───────────────────────────────────────
  // Declared after 'devices' so the literal segment wins the route match.

  @Get('devices/:id')
  @RequirePermissions('analytics:read')
  @AnalyticsReader()
  @ApiParam({ name: 'id', description: 'Device UUID' })
  @SwaggerAuth('Single device deep analytics', 'Device detail retrieved')
  getDeviceDetail(
    @CurrentUser('tenantId') tenantId: string,
    @CurrentUser('customerId') customerId: string | null,
    @Param('id', ParseIdPipe) id: string,
    @Query() query: DeviceDetailQueryDto,
  ) {
    return this.analyticsService.getDeviceDetailAnalytics(id, tenantId, query, customerId);
  }

  // ── 4. Alarm analytics ────────────────────────────────────────────────────

  @Get('alarms')
  @RequirePermissions('analytics:read')
  @AnalyticsReader()
  @SwaggerAuth('Alarm analytics', 'Alarm analytics retrieved')
  getAlarmAnalytics(
    @CurrentUser('tenantId') tenantId: string,
    @CurrentUser('customerId') customerId: string | null,
    @Query() query: TimeRangeQueryDto,
  ) {
    return this.analyticsService.getAlarmAnalytics(tenantId, query, customerId);
  }

  // ── 5. Data consumption ───────────────────────────────────────────────────

  @Get('data-consumption')
  @RequirePermissions('analytics:read')
  @AnalyticsReader()
  @SwaggerAuth('Data consumption analytics', 'Data consumption retrieved')
  async getDataConsumption(
    @CurrentUser('tenantId') tenantId: string,
    @CurrentUser('customerId') customerId: string | null,
    @Query() query: TimeRangeQueryDto,
    @Res({ passthrough: true }) res: Response,
  ) {
    const data = await this.analyticsService.getDataConsumption(tenantId, query, customerId);
    if (query.format === 'csv') return this.csv(res, data.topConsumers, 'data-consumption.csv');
    return data;
  }

  // ── 6. System performance ─────────────────────────────────────────────────

  @Get('system-performance')
  @RequirePermissions('analytics:read')
  @AnalyticsReader()
  @SwaggerAuth('API and platform performance for this tenant', 'System performance retrieved')
  async getSystemPerformance(
    @CurrentUser('tenantId') tenantId: string,
    @Query() query: TimeRangeQueryDto,
    @Res({ passthrough: true }) res: Response,
  ) {
    const data = await this.analyticsService.getSystemPerformance(tenantId, query);
    if (query.format === 'csv') return this.csv(res, data.topEndpoints, 'system-performance.csv');
    return data;
  }

  // ── 7. Geo analytics ──────────────────────────────────────────────────────

  @Get('geo')
  @RequirePermissions('analytics:read')
  @AnalyticsReader()
  @SwaggerAuth('Device distribution by location', 'Geo analytics retrieved')
  async getGeoAnalytics(
    @CurrentUser('tenantId') tenantId: string,
    @CurrentUser('customerId') customerId: string | null,
    @Query() query: GeoAnalyticsQueryDto,
    @Res({ passthrough: true }) res: Response,
  ) {
    const data = await this.analyticsService.getGeoAnalytics(tenantId, query, customerId);
    if (query.format === 'csv') return this.csv(res, data.regionStats, 'geo-analytics.csv');
    return data;
  }

  // ── 8. Asset analytics ────────────────────────────────────────────────────

  @Get('assets')
  @RequirePermissions('analytics:read')
  @AnalyticsReader()
  @SwaggerAuth('Asset-level analytics', 'Asset analytics retrieved')
  async getAssetAnalytics(
    @CurrentUser('tenantId') tenantId: string,
    @CurrentUser('customerId') customerId: string | null,
    @Query() query: TimeRangeQueryDto,
    @Res({ passthrough: true }) res: Response,
  ) {
    const data = await this.analyticsService.getAssetAnalytics(tenantId, query, customerId);
    if (query.format === 'csv') return this.csv(res, data.assets, 'asset-analytics.csv');
    return data;
  }

  // ── 9. Dashboard analytics ────────────────────────────────────────────────

  @Get('dashboards')
  @RequirePermissions('analytics:read')
  @AnalyticsReader()
  @SwaggerAuth('Dashboard view and widget-load analytics', 'Dashboard analytics retrieved')
  getDashboardAnalytics(
    @CurrentUser('tenantId') tenantId: string,
    @Query() query: TimeRangeQueryDto,
  ) {
    return this.analyticsService.getDashboardAnalytics(tenantId, query);
  }

  @Get('energy')
  @RequirePermissions('analytics:read')
  @AnalyticsReader()
  @SwaggerAuth('Energy and environment analytics', 'Energy analytics retrieved')
  async getEnergyAnalytics(
    @CurrentUser('tenantId') tenantId: string,
    @CurrentUser('customerId') customerId: string | null,
    @Query() query: TimeRangeQueryDto,
    @Res({ passthrough: true }) res: Response,
  ) {
    const data = await this.analyticsService.getEnergyAnalytics(tenantId, query, customerId);
    if (query.format === 'csv') return this.csv(res, data.trend, 'energy-analytics.csv');
    return data;
  }

  @Post('dashboards/:dashboardId/view')
  // A view log is emitted while READING a dashboard, not by an author. There
  // is no `analytics:create` in the seeder, and gating a side-effect of
  // reading behind a stronger permission would stop view counts recording
  // for exactly the users who generate them.
  @RequirePermissions('analytics:read')
  @AnalyticsReader()
  @ApiParam({ name: 'dashboardId', description: 'Dashboard UUID' })
  @SwaggerAuth('Record a dashboard/widget view', 'View recorded')
  recordDashboardView(
    @CurrentUser('tenantId') tenantId: string,
    @CurrentUser('id') userId: string,
    @Param('dashboardId', ParseIdPipe) dashboardId: string,
    @Body() dto: RecordDashboardViewDto,
  ) {
    return this.analyticsService.recordDashboardView(dashboardId, tenantId, userId, dto);
  }

  // ── 9b. Entity time series / aggregate / export / realtime ───────────────
  //
  // The four routes the frontend's `analytics.api.ts` has always declared and
  // this controller never had. `POST /analytics/timeseries` was not a dead
  // declaration: `features/dashboard/services/dashboardService.ts` and
  // `features/analytics/hooks/index.ts` both call it, so every timeseries
  // dashboard widget was fetching a 404.
  //
  // Declared ABOVE `@Get()` and below the literal-segment routes so Nest's
  // route table resolves them: `@Get()` on this controller would otherwise be
  // matched first for nothing here (different paths), but `@Get('aggregate')`
  // must precede any future `@Get(':something')`.

  @Post('timeseries')
  @RequirePermissions('analytics:read')
  @AnalyticsReader()
  @SwaggerAuth(
    'Telemetry time series for a device or asset, several keys at once',
    'Time series retrieved',
  )
  @ApiBody({ type: EntityTimeSeriesDto })
  getTimeSeries(
    @CurrentUser('tenantId') tenantId: string,
    @CurrentUser('id') userId: string,
    @CurrentUser('customerId') customerId: string | null,
    @Body() dto: EntityTimeSeriesDto,
  ) {
    return this.analyticsService.getEntityTimeSeries(
      tenantId,
      userId,
      dto,
      customerId,
    );
  }

  @Get('aggregate')
  @RequirePermissions('analytics:read')
  @AnalyticsReader()
  @SwaggerAuth(
    'Bucketed telemetry aggregate for a device or asset',
    'Aggregate retrieved',
  )
  getAggregate(
    @CurrentUser('tenantId') tenantId: string,
    @CurrentUser('id') userId: string,
    @CurrentUser('customerId') customerId: string | null,
    @Query() query: EntityAggregateQueryDto,
  ) {
    // `keys` is comma-separated on this route because the client builds it
    // with `keys.join(',')`. The POST route above takes a real array.
    return this.analyticsService.getEntityTimeSeries(
      tenantId,
      userId,
      {
        entityId: query.entityId,
        entityType: query.entityType ?? AnalyticsEntityType.DEVICE,
        keys: query.keys
          .split(',')
          .map((key) => key.trim())
          .filter(Boolean),
        startTime: query.startTime,
        endTime: query.endTime,
        // An aggregate with no interval is a contradiction, so this route
        // defaults to hourly buckets rather than silently returning raw
        // samples under an `aggregation` the caller asked for.
        interval: query.interval ?? 3_600_000,
        aggregation: query.aggregation ?? AnalyticsAggregation.AVG,
        limit: query.limit,
      },
      customerId,
    );
  }

  @Post('export')
  // `analytics` seeds read / export / configure. This one is genuinely an
  // export, so it is the one route here that is not `analytics:read`.
  @RequirePermissions('analytics:export')
  @AnalyticsReader()
  @SwaggerAuth(
    'Export a telemetry time series as CSV, JSON or XLSX',
    'Export generated',
  )
  @ApiBody({ type: ExportAnalyticsDto })
  async exportData(
    @CurrentUser('tenantId') tenantId: string,
    @CurrentUser('id') userId: string,
    @CurrentUser('customerId') customerId: string | null,
    @Body() dto: ExportAnalyticsDto,
    @Res() res: Response,
  ) {
    const file = await this.analyticsService.exportEntityTimeSeries(
      tenantId,
      userId,
      dto,
      customerId,
    );
    // `@Res()` WITHOUT `passthrough` on purpose: this route answers with file
    // bytes, and TransformInterceptor would otherwise wrap a Buffer in
    // `{success, data, timestamp}` and hand the client JSON-encoded binary.
    // The client requests it with `responseType: 'blob'`.
    res.setHeader('Content-Type', file.mimeType);
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="${file.fileName}"`,
    );
    res.setHeader('Content-Length', String(file.content.byteLength));
    return res.send(file.content);
  }

  @Get('realtime')
  @RequirePermissions('analytics:read')
  @AnalyticsReader()
  @SwaggerAuth(
    'Live counters: messages per minute, devices reporting, active alarms',
    'Realtime statistics retrieved',
  )
  getRealtimeStats(
    @CurrentUser('tenantId') tenantId: string,
    @CurrentUser('customerId') customerId: string | null,
  ) {
    return this.analyticsService.getRealtimeStats(tenantId, customerId);
  }

  // ── 10. Telemetry & users ─────────────────────────────────────────────────

  @Get('telemetry')
  @RequirePermissions('analytics:read')
  @AnalyticsReader()
  @SwaggerAuth('Per-device telemetry record counts', 'Telemetry statistics retrieved')
  getTelemetryStats(
    @CurrentUser('tenantId') tenantId: string,
    @CurrentUser('customerId') customerId: string | null,
    @Query() query: DateRangeQueryDto,
  ) {
    return this.analyticsService.getTelemetryStats(
      tenantId,
      query.startDate ? new Date(query.startDate) : undefined,
      query.endDate ? new Date(query.endDate) : undefined,
      customerId,
    );
  }

  @Get('users')
  @RequirePermissions('analytics:read')
  @Roles(UserRole.SUPER_ADMIN, UserRole.TENANT_ADMIN)
  @SwaggerAuth('User activity analytics', 'User activity retrieved')
  getUserActivity(
    @CurrentUser('tenantId') tenantId: string,
    @Query() query: DateRangeQueryDto,
  ) {
    return this.analyticsService.getUserActivity(
      tenantId,
      query.startDate ? new Date(query.startDate) : undefined,
      query.endDate ? new Date(query.endDate) : undefined,
    );
  }

  // ── 11. Stored rollups ────────────────────────────────────────────────────

  @Get()
  @RequirePermissions('analytics:read')
  @AnalyticsReader()
  @SwaggerAuth('Query stored analytics rollup records', 'Analytics retrieved')
  findAll(
    @CurrentUser('tenantId') tenantId: string,
    @CurrentUser('customerId') customerId: string | null,
    @Query() query: QueryAnalyticsDto,
  ) {
    return this.analyticsService.findAll(tenantId, query, customerId);
  }

  @Post()
  @RequirePermissions('analytics:export')
  @Roles(UserRole.SUPER_ADMIN, UserRole.TENANT_ADMIN)
  @SwaggerAuth('Store an analytics rollup record', 'Analytics created')
  create(
    @CurrentUser('tenantId') tenantId: string,
    @CurrentUser('customerId') customerId: string | undefined,
    @Body() dto: CreateAnalyticsDto,
  ) {
    return this.analyticsService.create(tenantId, customerId, dto);
  }

  @Post('generate')
  @RequirePermissions('analytics:export')
  @Roles(UserRole.SUPER_ADMIN)
  @SwaggerAuth('Run the nightly rollup now, for all tenants', 'Rollup triggered')
  async generateAnalytics() {
    await this.analyticsService.generateDailyAnalytics();
    return { triggered: true };
  }

  // `analytics` seeds only read/export/configure — there is no
  // `analytics:delete`. Purging aggregates is an administrative
  // configuration action, so it is gated on `configure` rather than on
  // a string that can never be granted to anyone.
  @Delete('cleanup/:days')
  @RequirePermissions('analytics:configure')
  @Roles(UserRole.SUPER_ADMIN, UserRole.TENANT_ADMIN)
  @ApiParam({ name: 'days', description: 'Delete rollup rows older than this many days' })
  @SwaggerAuth('Delete old rollup records for this tenant', 'Records deleted')
  async deleteOld(
    @CurrentUser('tenantId') tenantId: string,
    @Param('days') days: string,
  ) {
    const deleted = await this.analyticsService.deleteOld(tenantId, Number(days));
    return { deleted };
  }
}
