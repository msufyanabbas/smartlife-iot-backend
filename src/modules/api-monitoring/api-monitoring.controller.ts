// src/modules/api-monitoring/api-monitoring.controller.ts
import { Controller, Get, Query, Res } from '@nestjs/common';
import {
  ApiTags,
  ApiOperation,
  ApiBearerAuth,
  ApiOkResponse,
  ApiProduces,
} from '@nestjs/swagger';
import type { Response } from 'express';
import { ApiMonitoringService } from './api-monitoring.service';
import {
  APILogFilterDto,
  ApiMonitoringStatsQueryDto,
} from './dto/api-log-filter.dto';
import { Roles } from '@common/decorators/roles.decorator';
import { CurrentUser } from '@common/decorators/current-user.decorator';
import { User } from '@modules/users/entities/user.entity';
import { UserRole } from '@common/enums/index.enum';

@ApiTags('api-monitoring')
@Controller('api-monitoring')
@ApiBearerAuth()
export class ApiMonitoringController {
  constructor(private readonly apiMonitoringService: ApiMonitoringService) {}

  /**
   * SUPER_ADMIN has no tenantId and is the only role that may read across
   * tenants; undefined means "no tenant predicate" in the service. Every other
   * role is pinned to its own tenant by TenantIsolationGuard.
   */
  private scopeOf(user: User): { tenantId?: string; customerId?: string } {
    if (user?.role === UserRole.SUPER_ADMIN) return {};
    return { tenantId: user?.tenantId, customerId: user?.customerId };
  }

  // ── Tenant-wide views (admins only) ────────────────────────────────────────
  // These expose every user's traffic plus 5xx stack traces, so they are not
  // for CUSTOMER / CUSTOMER_USER. The per-caller "/my" variants below are.

  @Get('dashboard')
  @Roles(UserRole.SUPER_ADMIN, UserRole.TENANT_ADMIN)
  @ApiOperation({
    summary: 'API monitoring dashboard',
    description:
      'Today / week / month totals, 24h hourly trend, status-code distribution ' +
      'and the tenant API-call quota.',
  })
  getDashboard(@CurrentUser() user: User) {
    const { tenantId, customerId } = this.scopeOf(user);
    return this.apiMonitoringService.getDashboard(tenantId, customerId);
  }

  @Get('stats')
  @Roles(UserRole.SUPER_ADMIN, UserRole.TENANT_ADMIN)
  @ApiOperation({
    summary: 'Aggregate API statistics',
    description:
      'Totals, error rate, p50/p95/p99 latency, requests-per-minute, top ' +
      'endpoints, top errors and slowest endpoints for the given window.',
  })
  getStats(
    @CurrentUser() user: User,
    @Query() query: ApiMonitoringStatsQueryDto,
  ) {
    const { tenantId, customerId } = this.scopeOf(user);
    return this.apiMonitoringService.getStats(tenantId, query, customerId);
  }

  @Get('logs')
  @Roles(UserRole.SUPER_ADMIN, UserRole.TENANT_ADMIN)
  @ApiOperation({ summary: 'Get API logs (paginated, filterable)' })
  getLogs(@CurrentUser() user: User, @Query() filters: APILogFilterDto) {
    const { tenantId, customerId } = this.scopeOf(user);
    return this.apiMonitoringService.getLogs(tenantId, filters, customerId);
  }

  @Get('export')
  @Roles(UserRole.SUPER_ADMIN, UserRole.TENANT_ADMIN)
  @ApiOperation({
    summary: 'Export API logs as CSV',
    description: 'Accepts the same filters as /logs. Capped at 10,000 rows.',
  })
  @ApiProduces('text/csv')
  @ApiOkResponse({ description: 'CSV file download' })
  async exportLogs(
    @CurrentUser() user: User,
    @Query() filters: APILogFilterDto,
    @Res() res: Response,
  ): Promise<void> {
    const { tenantId, customerId } = this.scopeOf(user);
    const { csv, rowCount, truncated } = await this.apiMonitoringService.exportLogs(
      tenantId,
      filters,
      customerId,
    );

    const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');

    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="api-logs-${stamp}.csv"`);
    // Tells the caller whether they got the whole result set or hit the cap.
    res.setHeader('X-Total-Rows', String(rowCount));
    res.setHeader('X-Truncated', String(truncated));
    // UTF-8 BOM so Excel reads non-ASCII user agents and paths correctly.
    res.send(`﻿${csv}`);
  }

  @Get('metrics')
  @Roles(UserRole.SUPER_ADMIN, UserRole.TENANT_ADMIN)
  @ApiOperation({ summary: 'Get API metrics (last 24h)' })
  getMetrics(@CurrentUser() user: User) {
    const { tenantId, customerId } = this.scopeOf(user);
    return this.apiMonitoringService.getMetrics(tenantId, customerId);
  }

  @Get('statistics')
  @Roles(UserRole.SUPER_ADMIN, UserRole.TENANT_ADMIN)
  @ApiOperation({ summary: 'All-time totals by status code' })
  getStatistics(@CurrentUser() user: User) {
    const { tenantId, customerId } = this.scopeOf(user);
    return this.apiMonitoringService.getStatistics(tenantId, customerId);
  }

  @Get('performance')
  @Roles(UserRole.SUPER_ADMIN, UserRole.TENANT_ADMIN)
  @ApiOperation({ summary: 'Per-minute performance for the last hour' })
  getPerformanceMetrics(@CurrentUser() user: User) {
    const { tenantId, customerId } = this.scopeOf(user);
    return this.apiMonitoringService.getPerformanceMetrics(tenantId, customerId);
  }

  @Get('errors')
  @Roles(UserRole.SUPER_ADMIN, UserRole.TENANT_ADMIN)
  @ApiOperation({ summary: 'Get error logs (status >= 400)' })
  getErrors(@CurrentUser() user: User, @Query() filters: APILogFilterDto) {
    const { tenantId, customerId } = this.scopeOf(user);
    return this.apiMonitoringService.getErrors(tenantId, filters, customerId);
  }

  @Get('slow-requests')
  @Roles(UserRole.SUPER_ADMIN, UserRole.TENANT_ADMIN)
  @ApiOperation({
    summary: 'Get slow requests',
    description: 'Defaults to >1000ms; override with minResponseTime.',
  })
  getSlowRequests(@CurrentUser() user: User, @Query() filters: APILogFilterDto) {
    const { tenantId, customerId } = this.scopeOf(user);
    return this.apiMonitoringService.getSlowRequests(tenantId, filters, customerId);
  }

  @Get('endpoints/top')
  @Roles(UserRole.SUPER_ADMIN, UserRole.TENANT_ADMIN)
  @ApiOperation({ summary: 'Top endpoints by usage (last 24h)' })
  getTopEndpoints(@CurrentUser() user: User) {
    const { tenantId, customerId } = this.scopeOf(user);
    return this.apiMonitoringService.getTopEndpoints(tenantId, customerId);
  }

  @Get('health')
  @Roles(UserRole.SUPER_ADMIN, UserRole.TENANT_ADMIN)
  @ApiOperation({
    summary: 'Platform health',
    description: 'Live probes of Postgres, Redis and Kafka plus process memory.',
  })
  getHealth() {
    return this.apiMonitoringService.getHealth();
  }

  // ── Per-caller views (any authenticated role) ──────────────────────────────

  @Get('logs/my')
  @ApiOperation({ summary: 'Get my API logs' })
  getMyLogs(@CurrentUser() user: User, @Query() filters: APILogFilterDto) {
    return this.apiMonitoringService.getUserLogs(user.tenantId, user.id, filters);
  }

  @Get('metrics/my')
  @ApiOperation({ summary: 'Get my API metrics (last 24h)' })
  getMyMetrics(@CurrentUser() user: User) {
    return this.apiMonitoringService.getUserMetrics(user.tenantId, user.id);
  }
}
