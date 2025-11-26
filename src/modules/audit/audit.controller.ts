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
} from '@nestjs/swagger';
import type { Response } from 'express';
import { AuditService } from './audit.service';
import { CreateAuditLogDto, QueryAuditLogsDto } from './dto/audit.dto';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { RolesGuard } from '../../common/guards/roles.guard';
import { Roles } from '../../common/decorators/roles.decorator';
import { UserRole } from '../users/entities/user.entity';
import {
  AuditAction,
  AuditEntityType,
  AuditSeverity,
} from './entities/audit-log.entity';

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
  async create(@Body() createAuditLogDto: CreateAuditLogDto) {
    const log = await this.auditService.log(createAuditLogDto);
    return {
      message: 'Audit log created successfully',
      data: log,
    };
  }

  /**
   * Query audit logs with filters
   */
  @Get()
  @Roles(UserRole.SUPER_ADMIN, UserRole.TENANT_ADMIN)
  @ApiOperation({ summary: 'Query audit logs' })
  @ApiQuery({ name: 'userId', required: false })
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
  @ApiResponse({ status: 200, description: 'Audit logs retrieved' })
  async findAll(@Query() queryDto: QueryAuditLogsDto) {
    const result = await this.auditService.findAll(queryDto);
    return {
      message: 'Audit logs retrieved successfully',
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
   * Get audit statistics
   */
  @Get('statistics')
  @Roles(UserRole.SUPER_ADMIN, UserRole.TENANT_ADMIN)
  @ApiOperation({ summary: 'Get audit statistics' })
  @ApiQuery({ name: 'startDate', required: false })
  @ApiQuery({ name: 'endDate', required: false })
  @ApiResponse({ status: 200, description: 'Statistics retrieved' })
  async getStatistics(
    @Query('startDate') startDate?: string,
    @Query('endDate') endDate?: string,
  ) {
    const start = startDate ? new Date(startDate) : undefined;
    const end = endDate ? new Date(endDate) : undefined;

    const stats = await this.auditService.getStatistics(start, end);
    return {
      message: 'Statistics retrieved successfully',
      data: stats,
    };
  }

  /**
   * Get recent audit logs
   */
  @Get('recent')
  @Roles(UserRole.SUPER_ADMIN, UserRole.TENANT_ADMIN)
  @ApiOperation({ summary: 'Get recent audit logs' })
  @ApiQuery({ name: 'hours', required: false, type: Number })
  @ApiQuery({ name: 'limit', required: false, type: Number })
  @ApiResponse({ status: 200, description: 'Recent logs retrieved' })
  async getRecent(
    @Query('hours') hours?: number,
    @Query('limit') limit?: number,
  ) {
    const logs = await this.auditService.getRecent(
      hours ? +hours : 24,
      limit ? +limit : 100,
    );
    return {
      message: 'Recent logs retrieved successfully',
      data: logs,
    };
  }

  /**
   * Get failed actions
   */
  @Get('failed')
  @Roles(UserRole.SUPER_ADMIN)
  @ApiOperation({ summary: 'Get failed actions' })
  @ApiQuery({ name: 'limit', required: false, type: Number })
  @ApiResponse({ status: 200, description: 'Failed actions retrieved' })
  async getFailedActions(@Query('limit') limit?: number) {
    const logs = await this.auditService.getFailedActions(limit ? +limit : 50);
    return {
      message: 'Failed actions retrieved successfully',
      data: logs,
    };
  }

  /**
   * Export audit logs to CSV
   */
  @Get('export/csv')
  @Roles(UserRole.SUPER_ADMIN, UserRole.TENANT_ADMIN)
  @ApiOperation({ summary: 'Export audit logs to CSV' })
  @ApiResponse({ status: 200, description: 'CSV file generated' })
  async exportCSV(@Query() queryDto: QueryAuditLogsDto, @Res() res: Response) {
    const csv = await this.auditService.exportToCSV(queryDto);

    res.header('Content-Type', 'text/csv');
    res.header(
      'Content-Disposition',
      `attachment; filename=audit-logs-${new Date().toISOString()}.csv`,
    );

    return res.send(csv);
  }

  /**
   * Get audit logs for a specific user
   */
  @Get('user/:userId')
  @Roles(UserRole.SUPER_ADMIN, UserRole.TENANT_ADMIN)
  @ApiOperation({ summary: 'Get audit logs for a user' })
  @ApiQuery({ name: 'limit', required: false, type: Number })
  @ApiResponse({ status: 200, description: 'User logs retrieved' })
  async findByUser(
    @Param('userId') userId: string,
    @Query('limit') limit?: number,
  ) {
    const logs = await this.auditService.findByUser(
      userId,
      limit ? +limit : 100,
    );
    return {
      message: 'User audit logs retrieved successfully',
      data: logs,
    };
  }

  /**
   * Get audit logs for a specific entity
   */
  @Get('entity/:entityType/:entityId')
  @Roles(UserRole.SUPER_ADMIN, UserRole.TENANT_ADMIN)
  @ApiOperation({ summary: 'Get audit logs for an entity' })
  @ApiResponse({ status: 200, description: 'Entity logs retrieved' })
  async findByEntity(
    @Param('entityType') entityType: AuditEntityType,
    @Param('entityId') entityId: string,
  ) {
    const logs = await this.auditService.findByEntity(entityType, entityId);
    return {
      message: 'Entity audit logs retrieved successfully',
      data: logs,
    };
  }

  /**
   * Get audit log by ID
   */
  @Get(':id')
  @Roles(UserRole.SUPER_ADMIN, UserRole.TENANT_ADMIN)
  @ApiOperation({ summary: 'Get audit log by ID' })
  @ApiResponse({ status: 200, description: 'Audit log retrieved' })
  @ApiResponse({ status: 404, description: 'Audit log not found' })
  async findOne(@Param('id') id: string) {
    const log = await this.auditService.findOne(id);
    return {
      message: 'Audit log retrieved successfully',
      data: log,
    };
  }

  /**
   * Delete old audit logs
   */
  @Delete('cleanup/:daysOld')
  @Roles(UserRole.SUPER_ADMIN)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Delete old audit logs' })
  @ApiResponse({ status: 200, description: 'Old logs deleted' })
  async deleteOld(@Param('daysOld') daysOld: number) {
    const deleted = await this.auditService.deleteOld(+daysOld);
    return {
      message: `Successfully deleted ${deleted} old audit logs`,
      data: { deleted },
    };
  }
}
