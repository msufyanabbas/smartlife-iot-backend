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
import { ApiTags, ApiParam } from '@nestjs/swagger';

import { AnalyticsService } from './analytics.service';
import {
  CreateAnalyticsDto,
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
  @AnalyticsReader()
  @SwaggerAuth('Dashboard view and widget-load analytics', 'Dashboard analytics retrieved')
  getDashboardAnalytics(
    @CurrentUser('tenantId') tenantId: string,
    @Query() query: TimeRangeQueryDto,
  ) {
    return this.analyticsService.getDashboardAnalytics(tenantId, query);
  }

  @Get('energy')
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

  // ── 10. Telemetry & users ─────────────────────────────────────────────────

  @Get('telemetry')
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
  @Roles(UserRole.SUPER_ADMIN)
  @SwaggerAuth('Run the nightly rollup now, for all tenants', 'Rollup triggered')
  async generateAnalytics() {
    await this.analyticsService.generateDailyAnalytics();
    return { triggered: true };
  }

  @Delete('cleanup/:days')
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
