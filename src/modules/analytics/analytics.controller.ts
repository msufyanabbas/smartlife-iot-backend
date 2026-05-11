// src/modules/analytics/analytics.controller.ts
import {
  Controller, Get, Post, Body, Query, UseGuards,
  Delete, Param, Res, HttpStatus,
} from '@nestjs/common';
import type { Response } from 'express';  // ← import type, not import
import {
  ApiTags, ApiOperation, ApiResponse,
  ApiBearerAuth, ApiQuery, ApiParam,
} from '@nestjs/swagger';
import { AnalyticsService } from './analytics.service';
import {
  CreateAnalyticsDto,
  QueryAnalyticsDto,
  DeviceAnalyticsDto,
  TelemetryStatQueryDto,
  RecordDashboardViewDto,
  GeoAnalyticsQueryDto,
  EnergyAnalyticsQueryDto,
  DataConsumptionQueryDto,
  SystemPerformanceQueryDto,
} from './dto/analytics.dto';
import { JwtAuthGuard }  from '@common/guards/jwt-auth.guard';
import { RolesGuard }    from '@common/guards/roles.guard';
import { Roles }         from '@common/decorators/roles.decorator';
import { CurrentUser }   from '@common/decorators/current-user.decorator';
import { User }          from '@modules/users/entities/user.entity';
import { UserRole }      from '@common/enums/index.enum';

@ApiTags('Analytics')
@Controller('analytics')
@UseGuards(JwtAuthGuard)
@ApiBearerAuth()
export class AnalyticsController {
  constructor(private readonly analyticsService: AnalyticsService) {}

  // ── helper — assert tenantId is present ──────────────────────────────────
  // Avoids repeating the non-null assertion on every method call.
  private tenantId(user: User): string {
    return user.tenantId!;
  }

  // ── core ─────────────────────────────────────────────────────────────────

  @Post()
  @UseGuards(RolesGuard)
  @Roles(UserRole.SUPER_ADMIN, UserRole.TENANT_ADMIN)
  @ApiOperation({ summary: 'Create analytics record' })
  async create(@CurrentUser() user: User, @Body() dto: CreateAnalyticsDto) {
    const data = await this.analyticsService.create(
      this.tenantId(user), user.customerId, dto,
    );
    return { message: 'Analytics created successfully', data };
  }

  @Get()
  @ApiOperation({ summary: 'Query analytics records' })
  async findAll(@CurrentUser() user: User, @Query() dto: QueryAnalyticsDto) {
    const result = await this.analyticsService.findAll(
      this.tenantId(user), dto, user.customerId,
    );
    return { message: 'Analytics retrieved', data: result.data, meta: result };
  }

  // ── overview ──────────────────────────────────────────────────────────────

  @Get('overview')
  @ApiOperation({ summary: 'Platform overview' })
  async getOverview(@CurrentUser() user: User) {
    const data = await this.analyticsService.getSystemOverview(
      this.tenantId(user), user.customerId,
    );
    return { message: 'Overview retrieved', data };
  }

  // ── device analytics ─────────────────────────────────────────────────────

  @Get('devices')
  @ApiOperation({ summary: 'Device analytics list' })
  @ApiQuery({ name: 'format', required: false, enum: ['json', 'csv'] })
  async getDeviceAnalytics(
    @CurrentUser() user: User,
    @Query() dto: DeviceAnalyticsDto,
    @Res({ passthrough: true }) res: Response,  // ← move required param last
  ) {
    const data = await this.analyticsService.getDeviceAnalytics(
      this.tenantId(user), dto, user.customerId,
    );
    if (dto.format === 'csv') {
      const csv = this.analyticsService.toCsv(data.devices);
      res.setHeader('Content-Type', 'text/csv');
      res.setHeader('Content-Disposition', 'attachment; filename="device-analytics.csv"');
      return res.send(csv);
    }
    return { message: 'Device analytics retrieved', data };
  }

  @Get('devices/:deviceId')
  @ApiOperation({ summary: 'Device drill-down' })
  @ApiParam({ name: 'deviceId' })
  @ApiQuery({ name: 'days',   required: false, type: Number })
  @ApiQuery({ name: 'format', required: false, enum: ['json', 'csv'] })
  async getDeviceDrillDown(
    @CurrentUser() user: User,
    @Param('deviceId') deviceId: string,
    @Query('days') days: number | undefined,
    @Query('format') format: 'json' | 'csv' | undefined,
    @Res({ passthrough: true }) res: Response,
  ) {
    const data = await this.analyticsService.getDeviceDrillDown(
      deviceId, this.tenantId(user), days ? Number(days) : 7,
    );
    if (!data) {
      res.status(HttpStatus.NOT_FOUND).json({ message: 'Device not found' });
      return;
    }
    if (format === 'csv') {
      const csv = this.analyticsService.toCsv(data.dataGenerationTrend);
      res.setHeader('Content-Type', 'text/csv');
      res.setHeader('Content-Disposition', `attachment; filename="device-${deviceId}-trend.csv"`);
      return res.send(csv);
    }
    return { message: 'Device drill-down retrieved', data };
  }

  // ── dashboard analytics ───────────────────────────────────────────────────

  @Get('dashboards')
  @ApiOperation({ summary: 'Dashboard analytics' })
  @ApiQuery({ name: 'days',   required: false, type: Number })
  @ApiQuery({ name: 'format', required: false, enum: ['json', 'csv'] })
  async getDashboardAnalytics(
    @CurrentUser() user: User,
    @Query('days') days: number | undefined,
    @Query('format') format: 'json' | 'csv' | undefined,
    @Res({ passthrough: true }) res: Response,
  ) {
    const data = await this.analyticsService.getDashboardAnalytics(
      this.tenantId(user), days ? Number(days) : 7,
    );
    if (format === 'csv') {
      const csv = this.analyticsService.toCsv(data.dashboards);
      res.setHeader('Content-Type', 'text/csv');
      res.setHeader('Content-Disposition', 'attachment; filename="dashboard-analytics.csv"');
      return res.send(csv);
    }
    return { message: 'Dashboard analytics retrieved', data };
  }

  @Post('dashboards/:dashboardId/view')
  @ApiOperation({ summary: 'Record a dashboard view' })
  @ApiParam({ name: 'dashboardId' })
  async recordDashboardView(
    @CurrentUser() user: User,
    @Param('dashboardId') dashboardId: string,
    @Body() dto: RecordDashboardViewDto,
  ) {
    const data = await this.analyticsService.recordDashboardView(
      dashboardId, this.tenantId(user), user.id, dto,
    );
    return { message: 'View recorded', data };
  }

  // ── data consumption ─────────────────────────────────────────────────────

  @Get('data-consumption')
  @ApiOperation({ summary: 'Data consumption analytics' })
  @ApiQuery({ name: 'format', required: false, enum: ['json', 'csv'] })
  async getDataConsumption(
    @CurrentUser() user: User,
    @Query() dto: DataConsumptionQueryDto,
    @Res({ passthrough: true }) res: Response,
  ) {
    const data = await this.analyticsService.getDataConsumption(
      this.tenantId(user), dto,
    );
    if (dto.format === 'csv') {
      const csv = this.analyticsService.toCsv(data.consumptionBreakdown);
      res.setHeader('Content-Type', 'text/csv');
      res.setHeader('Content-Disposition', 'attachment; filename="data-consumption.csv"');
      return res.send(csv);
    }
    return { message: 'Data consumption analytics retrieved', data };
  }

  // ── system performance ────────────────────────────────────────────────────

  @Get('system-performance')
  @ApiOperation({ summary: 'System performance analytics' })
  @ApiQuery({ name: 'format', required: false, enum: ['json', 'csv'] })
  async getSystemPerformance(
    @CurrentUser() user: User,
    @Query() dto: SystemPerformanceQueryDto,
    @Res({ passthrough: true }) res: Response,
  ) {
    const data = await this.analyticsService.getSystemPerformance(
      this.tenantId(user), dto,
    );
    if (dto.format === 'csv') {
      const csv = this.analyticsService.toCsv(data.responseTimeTrends as any[]);
      res.setHeader('Content-Type', 'text/csv');
      res.setHeader('Content-Disposition', 'attachment; filename="system-performance.csv"');
      return res.send(csv);
    }
    return { message: 'System performance analytics retrieved', data };
  }

  // ── geo analytics ─────────────────────────────────────────────────────────

  @Get('geo')
  @ApiOperation({ summary: 'Geo analytics' })
  @ApiQuery({ name: 'format', required: false, enum: ['json', 'csv'] })
  async getGeoAnalytics(
    @CurrentUser() user: User,
    @Query() dto: GeoAnalyticsQueryDto,
    @Res({ passthrough: true }) res: Response,
  ) {
    const data = await this.analyticsService.getGeoAnalytics(
      this.tenantId(user), dto,
    );
    if (dto.format === 'csv') {
      const csv = this.analyticsService.toCsv(data.regionalStats);
      res.setHeader('Content-Type', 'text/csv');
      res.setHeader('Content-Disposition', 'attachment; filename="geo-analytics.csv"');
      return res.send(csv);
    }
    return { message: 'Geo analytics retrieved', data };
  }

  // ── energy management ─────────────────────────────────────────────────────

  @Get('energy')
  @ApiOperation({ summary: 'Energy management analytics' })
  @ApiQuery({ name: 'format', required: false, enum: ['json', 'csv'] })
  async getEnergyAnalytics(
    @CurrentUser() user: User,
    @Query() dto: EnergyAnalyticsQueryDto,
    @Res({ passthrough: true }) res: Response,
  ) {
    const data = await this.analyticsService.getEnergyAnalytics(
      this.tenantId(user), dto,
    );
    if (dto.format === 'csv') {
      const csv = this.analyticsService.toCsv(data.trendAnalysis);
      res.setHeader('Content-Type', 'text/csv');
      res.setHeader('Content-Disposition', 'attachment; filename="energy-analytics.csv"');
      return res.send(csv);
    }
    return { message: 'Energy analytics retrieved', data };
  }

  // ── legacy endpoints ──────────────────────────────────────────────────────

  @Get('telemetry')
  @ApiOperation({ summary: 'Telemetry statistics' })
  async getTelemetryStats(@CurrentUser() user: User, @Query() dto: TelemetryStatQueryDto) {
    const data = await this.analyticsService.getTelemetryStats(
      this.tenantId(user),
      dto.startDate ? new Date(dto.startDate) : undefined,
      dto.endDate   ? new Date(dto.endDate)   : undefined,
      user.customerId,
    );
    return { message: 'Telemetry statistics retrieved', data };
  }

  @Get('alarms')
  @ApiOperation({ summary: 'Alarm analytics' })
  async getAlarmAnalytics(@CurrentUser() user: User, @Query() dto: TelemetryStatQueryDto) {
    const data = await this.analyticsService.getAlarmAnalytics(
      this.tenantId(user),
      dto.startDate ? new Date(dto.startDate) : undefined,
      dto.endDate   ? new Date(dto.endDate)   : undefined,
      user.customerId,
    );
    return { message: 'Alarm analytics retrieved', data };
  }

  @Get('users')
  @UseGuards(RolesGuard)
  @Roles(UserRole.SUPER_ADMIN, UserRole.TENANT_ADMIN)
  @ApiOperation({ summary: 'User activity analytics' })
  async getUserActivity(@CurrentUser() user: User, @Query() dto: TelemetryStatQueryDto) {
    const data = await this.analyticsService.getUserActivity(
      this.tenantId(user),
      dto.startDate ? new Date(dto.startDate) : undefined,
      dto.endDate   ? new Date(dto.endDate)   : undefined,
    );
    return { message: 'User activity analytics retrieved', data };
  }

  @Post('generate')
  @UseGuards(RolesGuard)
  @Roles(UserRole.SUPER_ADMIN)
  @ApiOperation({ summary: 'Manually trigger daily analytics generation' })
  async generateAnalytics() {
    await this.analyticsService.generateDailyAnalytics();
    return { message: 'Analytics generation triggered' };
  }

  @Delete('cleanup/:days')
  @UseGuards(RolesGuard)
  @Roles(UserRole.SUPER_ADMIN)
  @ApiOperation({ summary: 'Delete analytics older than N days' })
  async deleteOld(@CurrentUser() user: User, @Param('days') days: number) {
    const deleted = await this.analyticsService.deleteOld(this.tenantId(user), +days);
    return { message: `Deleted ${deleted} records`, data: { deleted } };
  }
}