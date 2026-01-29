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
  @Roles(
    UserRole.SUPER_ADMIN,
    UserRole.TENANT_ADMIN,
    UserRole.CUSTOMER_ADMIN,
    UserRole.CUSTOMER_USER,
  )
  @ApiOperation({
    summary: 'Query audit logs (automatically filtered by role)',
    description: `
      Automatically shows logs based on your role:
      - SUPER_ADMIN: All logs across all tenants
      - TENANT_ADMIN: All logs in your tenant + all customer logs
      - CUSTOMER_ADMIN: All logs in your customer (excluding tenant admin activities)
      - CUSTOMER_USER: Only your own logs within your customer
    `,
  })
  @ApiQuery({ name: 'action', required: false, enum: AuditAction })
  @ApiQuery({ name: 'entityType', required: false, enum: AuditEntityType })
  @ApiQuery({ name: 'entityId', required: false })
  @ApiQuery({ name: 'severity', required: false, enum: AuditSeverity })
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
    return {
      message: 'Audit logs retrieved successfully',
      data: result.logs,
      meta: {
        total: result.total,
        page: result.page,
        limit: result.limit,
        totalPages: result.totalPages,
        context: {
          role: user.role,
          tenantId: user.tenantId,
          customerId: user.customerId,
        },
      },
    };
  }

  // ============================================
  // MODULE-SPECIFIC ENDPOINTS
  // ============================================

  /**
   * Get audit logs for Users module
   */
  @Get('modules/users')
  @Roles(
    UserRole.SUPER_ADMIN,
    UserRole.TENANT_ADMIN,
    UserRole.CUSTOMER_ADMIN,
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

    return {
      message: 'User module audit logs retrieved successfully',
      data: result.logs,
      meta: {
        total: result.total,
        page: result.page,
        limit: result.limit,
        totalPages: result.totalPages,
      },
    };
  }

  /**
   * Get audit logs for Devices module
   */
  @Get('modules/devices')
  @Roles(
    UserRole.SUPER_ADMIN,
    UserRole.TENANT_ADMIN,
    UserRole.CUSTOMER_ADMIN,
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

    return {
      message: 'Device module audit logs retrieved successfully',
      data: result.logs,
      meta: {
        total: result.total,
        page: result.page,
        limit: result.limit,
        totalPages: result.totalPages,
      },
    };
  }

  /**
   * Get audit logs for Alarms module
   */
  @Get('modules/alarms')
  @Roles(
    UserRole.SUPER_ADMIN,
    UserRole.TENANT_ADMIN,
    UserRole.CUSTOMER_ADMIN,
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

    return {
      message: 'Alarm module audit logs retrieved successfully',
      data: result.logs,
      meta: {
        total: result.total,
        page: result.page,
        limit: result.limit,
        totalPages: result.totalPages,
      },
    };
  }

  /**
   * Get audit logs for Device Profiles module
   */
  @Get('modules/device-profiles')
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

    return {
      message: 'Device profile module audit logs retrieved successfully',
      data: result.logs,
      meta: {
        total: result.total,
        page: result.page,
        limit: result.limit,
        totalPages: result.totalPages,
      },
    };
  }

  /**
   * Get audit logs for Assets module
   */
  @Get('modules/assets')
  @Roles(
    UserRole.SUPER_ADMIN,
    UserRole.TENANT_ADMIN,
    UserRole.CUSTOMER_ADMIN,
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

    return {
      message: 'Asset module audit logs retrieved successfully',
      data: result.logs,
      meta: {
        total: result.total,
        page: result.page,
        limit: result.limit,
        totalPages: result.totalPages,
      },
    };
  }

  /**
   * Get audit logs for Dashboards module
   */
  @Get('modules/dashboards')
  @Roles(
    UserRole.SUPER_ADMIN,
    UserRole.TENANT_ADMIN,
    UserRole.CUSTOMER_ADMIN,
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

    return {
      message: 'Dashboard module audit logs retrieved successfully',
      data: result.logs,
      meta: {
        total: result.total,
        page: result.page,
        limit: result.limit,
        totalPages: result.totalPages,
      },
    };
  }

  /**
   * Get audit logs for Customers module
   */
  @Get('modules/customers')
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

    return {
      message: 'Customer module audit logs retrieved successfully',
      data: result.logs,
      meta: {
        total: result.total,
        page: result.page,
        limit: result.limit,
        totalPages: result.totalPages,
      },
    };
  }

  // ============================================
  // STATISTICS & ANALYTICS
  // ============================================

  /**
   * Get audit statistics (auto-filtered by role)
   */
  @Get('statistics')
  @Roles(
    UserRole.SUPER_ADMIN,
    UserRole.TENANT_ADMIN,
    UserRole.CUSTOMER_ADMIN,
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
  @Roles(
    UserRole.SUPER_ADMIN,
    UserRole.TENANT_ADMIN,
    UserRole.CUSTOMER_ADMIN,
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
  @Roles(
    UserRole.SUPER_ADMIN,
    UserRole.TENANT_ADMIN,
    UserRole.CUSTOMER_ADMIN,
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
  @Roles(
    UserRole.SUPER_ADMIN,
    UserRole.TENANT_ADMIN,
    UserRole.CUSTOMER_ADMIN,
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
  @Roles(
    UserRole.SUPER_ADMIN,
    UserRole.TENANT_ADMIN,
    UserRole.CUSTOMER_ADMIN,
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
  @Roles(UserRole.SUPER_ADMIN)
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