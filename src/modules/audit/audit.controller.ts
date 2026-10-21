// src/modules/audit/audit.controller.ts
import {
  Controller,
  Get,
  Post,
  Body,
  Query,
  Param,
  UseGuards,
  Delete,
  HttpCode,
  HttpStatus,
  Res,
  BadRequestException,
} from '@nestjs/common';
import {
  ApiTags,
  ApiOperation,
  ApiResponse,
  ApiBearerAuth,
  ApiQuery,
  ApiParam,
} from '@nestjs/swagger';
import type { Response } from 'express';
import { AuditService } from '@modules/index.service';
import {
  CreateAuditLogDto,
  QueryAuditLogsDto,
  AuditLogResponseDto,
} from './dto/audit.dto';
import { JwtAuthGuard, RolesGuard } from '@common/guards/index.guards';
import { Roles, CurrentUser } from '@common/decorators/index.decorator';
import { User } from '@modules/index.entities';
import { UserRole, AuditAction, AuditEntityType, AuditSeverity } from '@common/enums/index.enum';
import { RequirePermissions } from '@common/decorators/permission.decorator';
import { Audit } from '@common/decorators/audit.decorator';

/**
 * Module slug → `AuditEntityType`, for `GET /audit/modules/:module`.
 *
 * Exported so the frontend's module list and the coverage guard read the same
 * table instead of each keeping its own copy — the drift between the client's
 * free-string `getByModule()` and the controller's seven literal routes is the
 * bug this table removes.
 *
 * The seven slugs the literal routes already serve are included so the generic
 * route answers identically if the literals are ever removed. Several slugs
 * intentionally map onto a shared type (`roles`, `permissions`, `groups` and
 * the rest are all stored as SETTINGS, distinguished by the row's
 * `description`), because `audit_logs.entityType` is a Postgres enum and
 * adding a member needs a migration — see `scripts/add-audit-decorators.py`.
 */
export const AUDIT_MODULE_ENTITY_TYPES: Record<string, AuditEntityType> = {
  users: AuditEntityType.USER,
  devices: AuditEntityType.DEVICE,
  alarms: AuditEntityType.ALARM,
  'device-profiles': AuditEntityType.DEVICE_PROFILE,
  assets: AuditEntityType.ASSET,
  dashboards: AuditEntityType.DASHBOARD,
  customers: AuditEntityType.CUSTOMER,
  tenants: AuditEntityType.TENANT,
  telemetry: AuditEntityType.TELEMETRY,
  notifications: AuditEntityType.NOTIFICATION,
  'rule-chains': AuditEntityType.RULE_CHAIN,
  'rule-nodes': AuditEntityType.RULE_NODE,
  widgets: AuditEntityType.WIDGET,
  integrations: AuditEntityType.INTEGRATION,
  subscriptions: AuditEntityType.SUBSCRIPTION,
  payments: AuditEntityType.PAYMENT,
  files: AuditEntityType.FILE,
  'api-keys': AuditEntityType.API_KEY,
  settings: AuditEntityType.SETTINGS,
};

@ApiTags('Audit')
@Controller('audit')
@UseGuards(JwtAuthGuard, RolesGuard)
@ApiBearerAuth()
export class AuditController {
  constructor(private readonly auditService: AuditService) {}

  /**
   * Create audit log entry (manual logging)
   */
  @Post()
  @RequirePermissions('audit:create')
  @Roles(UserRole.SUPER_ADMIN, UserRole.TENANT_ADMIN)
  @ApiOperation({ summary: 'Create audit log entry' })
  @ApiResponse({ status: 201, description: 'Audit log created' })
  async create(
    @Body() createAuditLogDto: CreateAuditLogDto,
    @CurrentUser() user: User,
  ) {
    const log = await this.auditService.log(createAuditLogDto);
    return {
      message: 'Audit log created successfully',
      data: log,
    };
  }

  /**
   * Query audit logs with AUTOMATIC role-based filtering
   * No need to specify tenantId or customerId - it's automatic!
   */
  @Get()
  @RequirePermissions('audit:read')
  @Roles(
    UserRole.SUPER_ADMIN,
    UserRole.TENANT_ADMIN,
    UserRole.CUSTOMER,
    UserRole.CUSTOMER_USER,
  )
  @ApiOperation({
    summary: 'Query audit logs (automatically filtered by role)',
    description: `
      Automatically shows logs based on your role:
      - SUPER_ADMIN: All logs across all tenants
      - TENANT_ADMIN: All logs in your tenant + all customer logs
      - CUSTOMER: All logs in your customer (excluding tenant admin activities)
      - CUSTOMER_USER: Only your own logs within your customer
    `,
  })
  @ApiQuery({ name: 'action', required: false, type: String, enum: AuditAction, enumName: 'AuditAction' })
  @ApiQuery({ name: 'entityType', required: false, type: String, enum: AuditEntityType, enumName: 'AuditEntityType' })
  @ApiQuery({ name: 'entityId', required: false })
  @ApiQuery({ name: 'severity', required: false, type: String, enum: AuditSeverity, enumName: 'AuditSeverity' })
  @ApiQuery({ name: 'success', required: false, type: Boolean })
  @ApiQuery({ name: 'startDate', required: false })
  @ApiQuery({ name: 'endDate', required: false })
  @ApiQuery({ name: 'search', required: false })
  @ApiQuery({ name: 'page', required: false, type: Number })
  @ApiQuery({ name: 'limit', required: false, type: Number })
  @ApiQuery({ name: 'sortOrder', required: false, enum: ['ASC', 'DESC'] })
  @ApiResponse({ status: 200, description: 'Audit logs retrieved' })
  async findAll(
    @Query() queryDto: QueryAuditLogsDto,
    @CurrentUser() user: User,
  ) {
    const result = await this.auditService.findAll(queryDto, user);
    // Standard { data, meta } envelope. `context` echoes back which role-based
    // filter was applied — carried alongside rather than inside meta, which is
    // strictly page metadata.
    return Object.assign(result, {
      context: {
        role: user.role,
        tenantId: user.tenantId,
        customerId: user.customerId,
      },
    });
  }

  // ============================================
  // MODULE-SPECIFIC ENDPOINTS
  // ============================================

  /**
   * Get audit logs for Users module
   */
  @Get('modules/users')
  @RequirePermissions('audit:read')
  @Roles(
    UserRole.SUPER_ADMIN,
    UserRole.TENANT_ADMIN,
    UserRole.CUSTOMER,
  )
  @ApiOperation({ summary: 'Get audit logs for Users module (auto-filtered)' })
  @ApiQuery({
    name: 'userId',
    required: false,
    description: 'Filter by specific user ID',
  })
  @ApiQuery({ name: 'page', required: false, type: Number })
  @ApiQuery({ name: 'limit', required: false, type: Number })
  @ApiQuery({ name: 'startDate', required: false })
  @ApiQuery({ name: 'endDate', required: false })
  @ApiResponse({ status: 200, description: 'User module logs retrieved' })
  async getUserModuleLogs(
    @Query() query: QueryAuditLogsDto,
    @CurrentUser() user: User,
  ) {
    const result = await this.auditService.findUserModuleLogs(
      query.entityId,
      user,
      {
        page: query.page,
        limit: query.limit,
        startDate: query.startDate,
        endDate: query.endDate,
        search: query.search,
      },
    );

    // findAll() already returns the standard { data, meta } envelope.
    return result;
  }

  /**
   * Get audit logs for Devices module
   */
  @Get('modules/devices')
  @RequirePermissions('audit:read')
  @Roles(
    UserRole.SUPER_ADMIN,
    UserRole.TENANT_ADMIN,
    UserRole.CUSTOMER,
  )
  @ApiOperation({
    summary: 'Get audit logs for Devices module (auto-filtered)',
  })
  @ApiQuery({
    name: 'deviceId',
    required: false,
    description: 'Filter by specific device ID',
  })
  @ApiQuery({ name: 'page', required: false, type: Number })
  @ApiQuery({ name: 'limit', required: false, type: Number })
  @ApiResponse({ status: 200, description: 'Device module logs retrieved' })
  async getDeviceModuleLogs(
    @Query() query: QueryAuditLogsDto,
    @CurrentUser() user: User,
  ) {
    const result = await this.auditService.findDeviceModuleLogs(
      query.entityId,
      user,
      {
        page: query.page,
        limit: query.limit,
        startDate: query.startDate,
        endDate: query.endDate,
        search: query.search,
      },
    );

    // findAll() already returns the standard { data, meta } envelope.
    return result;
  }

  /**
   * Get audit logs for Alarms module
   */
  @Get('modules/alarms')
  @RequirePermissions('audit:read')
  @Roles(
    UserRole.SUPER_ADMIN,
    UserRole.TENANT_ADMIN,
    UserRole.CUSTOMER,
  )
  @ApiOperation({
    summary: 'Get audit logs for Alarms module (auto-filtered)',
  })
  @ApiQuery({ name: 'alarmId', required: false })
  @ApiResponse({ status: 200, description: 'Alarm module logs retrieved' })
  async getAlarmModuleLogs(
    @Query() query: QueryAuditLogsDto,
    @CurrentUser() user: User,
  ) {
    const result = await this.auditService.findAlarmModuleLogs(
      query.entityId,
      user,
      {
        page: query.page,
        limit: query.limit,
        startDate: query.startDate,
        endDate: query.endDate,
      },
    );

    // findAll() already returns the standard { data, meta } envelope.
    return result;
  }

  /**
   * Get audit logs for Device Profiles module
   */
  @Get('modules/device-profiles')
  @RequirePermissions('audit:read')
  @Roles(UserRole.SUPER_ADMIN, UserRole.TENANT_ADMIN)
  @ApiOperation({
    summary: 'Get audit logs for Device Profiles module (auto-filtered)',
  })
  @ApiQuery({ name: 'profileId', required: false })
  @ApiResponse({
    status: 200,
    description: 'Device profile module logs retrieved',
  })
  async getDeviceProfileModuleLogs(
    @Query() query: QueryAuditLogsDto,
    @CurrentUser() user: User,
  ) {
    const result = await this.auditService.findDeviceProfileModuleLogs(
      query.entityId,
      user,
      {
        page: query.page,
        limit: query.limit,
        startDate: query.startDate,
        endDate: query.endDate,
      },
    );

    // findAll() already returns the standard { data, meta } envelope.
    return result;
  }

  /**
   * Get audit logs for Assets module
   */
  @Get('modules/assets')
  @RequirePermissions('audit:read')
  @Roles(
    UserRole.SUPER_ADMIN,
    UserRole.TENANT_ADMIN,
    UserRole.CUSTOMER,
  )
  @ApiOperation({
    summary: 'Get audit logs for Assets module (auto-filtered)',
  })
  @ApiQuery({ name: 'assetId', required: false })
  @ApiResponse({ status: 200, description: 'Asset module logs retrieved' })
  async getAssetModuleLogs(
    @Query() query: QueryAuditLogsDto,
    @CurrentUser() user: User,
  ) {
    const result = await this.auditService.findAssetModuleLogs(
      query.entityId,
      user,
      {
        page: query.page,
        limit: query.limit,
        startDate: query.startDate,
        endDate: query.endDate,
      },
    );

    // findAll() already returns the standard { data, meta } envelope.
    return result;
  }

  /**
   * Get audit logs for Dashboards module
   */
  @Get('modules/dashboards')
  @RequirePermissions('audit:read')
  @Roles(
    UserRole.SUPER_ADMIN,
    UserRole.TENANT_ADMIN,
    UserRole.CUSTOMER,
  )
  @ApiOperation({
    summary: 'Get audit logs for Dashboards module (auto-filtered)',
  })
  @ApiQuery({ name: 'dashboardId', required: false })
  @ApiResponse({ status: 200, description: 'Dashboard module logs retrieved' })
  async getDashboardModuleLogs(
    @Query() query: QueryAuditLogsDto,
    @CurrentUser() user: User,
  ) {
    const result = await this.auditService.findDashboardModuleLogs(
      query.entityId,
      user,
      {
        page: query.page,
        limit: query.limit,
        startDate: query.startDate,
        endDate: query.endDate,
      },
    );

    // findAll() already returns the standard { data, meta } envelope.
    return result;
  }

  /**
   * Get audit logs for Customers module
   */
  @Get('modules/customers')
  @RequirePermissions('audit:read')
  @Roles(UserRole.SUPER_ADMIN, UserRole.TENANT_ADMIN)
  @ApiOperation({
    summary: 'Get audit logs for Customers module (auto-filtered)',
  })
  @ApiQuery({ name: 'customerId', required: false })
  @ApiResponse({ status: 200, description: 'Customer module logs retrieved' })
  async getCustomerModuleLogs(
    @Query() query: QueryAuditLogsDto,
    @CurrentUser() user: User,
  ) {
    const result = await this.auditService.findCustomerModuleLogs(
      query.entityId,
      user,
      {
        page: query.page,
        limit: query.limit,
        startDate: query.startDate,
        endDate: query.endDate,
      },
    );

    // findAll() already returns the standard { data, meta } envelope.
    return result;
  }

  /**
   * Generic module feed — `GET /audit/modules/:module`.
   *
   * ── Why this exists ──────────────────────────────────────────────────────
   * The frontend's `auditApi.getByModule(module)` has always composed
   * `/audit/modules/${module}` from a free string, while this controller
   * declared only the seven literal routes above. Any other module — tenants,
   * integrations, subscriptions, roles — 404'd, and now that `@Audit()` covers
   * ~300 routes across 46 controllers there are far more entity types in the
   * table than there were literal routes to read them with.
   *
   * Declared AFTER the seven literals: Nest matches in declaration order, so a
   * parameterised segment above them would capture `modules/users` and the
   * specific handlers would be dead code — the same route-order trap §4o
   * documents for the HTTP ingest adapter.
   *
   * The module name is mapped through an explicit table rather than being cast
   * to the enum. An unknown value answers **400 with the valid list**, not an
   * empty page: an empty page is indistinguishable from "nothing happened",
   * which is the worst possible answer from an audit log.
   */
  @Get('modules/:module')
  @RequirePermissions('audit:read')
  @Roles(UserRole.SUPER_ADMIN, UserRole.TENANT_ADMIN, UserRole.CUSTOMER)
  @ApiOperation({
    summary: 'Get audit logs for any module by name (auto-filtered)',
  })
  @ApiParam({
    name: 'module',
    description: `One of: ${Object.keys(AUDIT_MODULE_ENTITY_TYPES).join(', ')}`,
  })
  @ApiQuery({ name: 'entityId', required: false })
  @ApiQuery({ name: 'page', required: false, type: Number })
  @ApiQuery({ name: 'limit', required: false, type: Number })
  @ApiResponse({ status: 200, description: 'Module logs retrieved' })
  @ApiResponse({ status: 400, description: 'Unknown module' })
  async getModuleLogs(
    @Param('module') moduleName: string,
    @Query() query: QueryAuditLogsDto,
    @CurrentUser() user: User,
  ) {
    const entityType = AUDIT_MODULE_ENTITY_TYPES[moduleName?.toLowerCase()];

    if (!entityType) {
      throw new BadRequestException(
        `Unknown audit module '${moduleName}'. Valid modules: ` +
          `${Object.keys(AUDIT_MODULE_ENTITY_TYPES).join(', ')}`,
      );
    }

    return this.auditService.findAll(
      {
        ...query,
        entityType,
      } as QueryAuditLogsDto,
      user,
    );
  }

  // ============================================
  // STATISTICS & ANALYTICS
  // ============================================

  /**
   * Get audit statistics (auto-filtered by role)
   */
  @Get('statistics')
  @RequirePermissions('audit:read')
  @Roles(
    UserRole.SUPER_ADMIN,
    UserRole.TENANT_ADMIN,
    UserRole.CUSTOMER,
  )
  @ApiOperation({ summary: 'Get audit statistics (auto-filtered)' })
  @ApiQuery({ name: 'startDate', required: false })
  @ApiQuery({ name: 'endDate', required: false })
  @ApiResponse({ status: 200, description: 'Statistics retrieved' })
  async getStatistics(
    @CurrentUser() user: User,
    @Query('startDate') startDate?: string,
    @Query('endDate') endDate?: string,
  ) {
    const start = startDate ? new Date(startDate) : undefined;
    const end = endDate ? new Date(endDate) : undefined;

    const stats = await this.auditService.getStatistics(user, start, end);
    return {
      message: 'Statistics retrieved successfully',
      data: stats,
    };
  }

  /**
   * Get recent audit logs (auto-filtered)
   */
  @Get('recent')
  @RequirePermissions('audit:read')
  @Roles(
    UserRole.SUPER_ADMIN,
    UserRole.TENANT_ADMIN,
    UserRole.CUSTOMER,
  )
  @ApiOperation({ summary: 'Get recent audit logs (auto-filtered)' })
  @ApiQuery({ name: 'hours', required: false, type: Number })
  @ApiQuery({ name: 'limit', required: false, type: Number })
  @ApiResponse({ status: 200, description: 'Recent logs retrieved' })
  async getRecent(
    @CurrentUser() user: User,
    @Query('hours') hours?: number,
    @Query('limit') limit?: number,
  ) {
    const logs = await this.auditService.getRecent(
      user,
      hours ? +hours : 24,
      limit ? +limit : 100,
    );
    return {
      message: 'Recent logs retrieved successfully',
      data: logs,
    };
  }

  /**
   * Get failed actions (auto-filtered)
   */
  @Get('failed')
  @RequirePermissions('audit:read')
  @Roles(
    UserRole.SUPER_ADMIN,
    UserRole.TENANT_ADMIN,
    UserRole.CUSTOMER,
  )
  @ApiOperation({ summary: 'Get failed actions (auto-filtered)' })
  @ApiQuery({ name: 'limit', required: false, type: Number })
  @ApiResponse({ status: 200, description: 'Failed actions retrieved' })
  async getFailedActions(
    @CurrentUser() user: User,
    @Query('limit') limit?: number,
  ) {
    const logs = await this.auditService.getFailedActions(
      user,
      limit ? +limit : 50,
    );
    return {
      message: 'Failed actions retrieved successfully',
      data: logs,
    };
  }

  /**
   * Export audit logs to CSV (auto-filtered)
   */
  @Get('export/csv')
  @RequirePermissions('audit:export')
  @Roles(
    UserRole.SUPER_ADMIN,
    UserRole.TENANT_ADMIN,
    UserRole.CUSTOMER,
  )
  @ApiOperation({ summary: 'Export audit logs to CSV (auto-filtered)' })
  @ApiResponse({ status: 200, description: 'CSV file generated' })
  async exportCSV(
    @Query() queryDto: QueryAuditLogsDto,
    @Res() res: Response,
    @CurrentUser() user: User,
  ) {
    const csv = await this.auditService.exportToCSV(queryDto, user);

    res.header('Content-Type', 'text/csv');
    res.header(
      'Content-Disposition',
      `attachment; filename=audit-logs-${new Date().toISOString()}.csv`,
    );

    return res.send(csv);
  }

  /**
   * Get audit log by ID (with automatic access control)
   */
  @Get(':id')
  @RequirePermissions('audit:read')
  @Roles(
    UserRole.SUPER_ADMIN,
    UserRole.TENANT_ADMIN,
    UserRole.CUSTOMER,
  )
  @ApiOperation({ summary: 'Get audit log by ID (auto-filtered)' })
  @ApiParam({ name: 'id', description: 'Audit log ID' })
  @ApiResponse({ status: 200, description: 'Audit log retrieved' })
  @ApiResponse({ status: 404, description: 'Audit log not found' })
  async findOne(@Param('id') id: string, @CurrentUser() user: User) {
    const log = await this.auditService.findOne(id, user);
    return {
      message: 'Audit log retrieved successfully',
      data: log,
    };
  }

  /**
   * Delete old audit logs (Super admin only)
   */
  @Delete('cleanup/:daysOld')
  @RequirePermissions('audit:delete')
  @Roles(UserRole.SUPER_ADMIN)
  // Purging the audit log is itself the most audit-worthy thing on this
  // controller — the row it writes is newer than the cutoff, so it survives
  // its own sweep and leaves a trace of who removed what.
  @Audit({
    action: AuditAction.DELETE,
    entityType: AuditEntityType.SETTINGS,
    description: 'manual audit log purge',
    severity: AuditSeverity.CRITICAL,
  })
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Delete old audit logs (Super admin only)' })
  @ApiParam({
    name: 'daysOld',
    description: 'Delete logs older than this many days',
  })
  @ApiResponse({ status: 200, description: 'Old logs deleted' })
  async deleteOld(
    @Param('daysOld') daysOld: number,
    @CurrentUser() user: User,
  ) {
    const deleted = await this.auditService.deleteOld(+daysOld, user);
    return {
      message: `Successfully deleted ${deleted} old audit logs`,
      data: { deleted },
    };
  }
}