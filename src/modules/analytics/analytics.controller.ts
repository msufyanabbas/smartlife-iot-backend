// src/modules/analytics/controllers/analytics.controller.ts
import {
  Controller,
  Get,
  Post,
  Body,
  Query,
  UseGuards,
  Delete,
  Param,
} from '@nestjs/common';
import {
  ApiTags,
  ApiOperation,
  ApiResponse,
  ApiBearerAuth,
  ApiQuery,
} from '@nestjs/swagger';
import { AnalyticsService } from './analytics.service';
import {
  CreateAnalyticsDto,
  QueryAnalyticsDto,
  DeviceAnalyticsDto,
  TelemetryStatQueryDto,
} from './dto/analytics.dto';
import { JwtAuthGuard } from '@common/guards/jwt-auth.guard';
import { RolesGuard } from '@common/guards/roles.guard';
import { Roles } from '@common/decorators/roles.decorator';
import { CurrentUser } from '@common/decorators/current-user.decorator';
import { User } from '@modules/users/entities/user.entity';
import { UserRole } from '@common/enums/index.enum';

@ApiTags('Analytics')
@Controller('analytics')
@UseGuards(JwtAuthGuard)
@ApiBearerAuth()
export class AnalyticsController {
  constructor(private readonly analyticsService: AnalyticsService) {}

  @Post()
  @UseGuards(RolesGuard)
  @Roles(UserRole.SUPER_ADMIN, UserRole.TENANT_ADMIN)
  @ApiOperation({ summary: 'Create analytics record' })
  @ApiResponse({ status: 201, description: 'Analytics created' })
  async create(
    @CurrentUser() user: User,
    @Body() createAnalyticsDto: CreateAnalyticsDto,
  ) {
    const analytics = await this.analyticsService.create(
      user.tenantId,
      user.customerId,
      createAnalyticsDto,
    );
    return {
      message: 'Analytics created successfully',
      data: analytics,
    };
  }

  @Get()
  @ApiOperation({ summary: 'Query analytics' })
  @ApiResponse({ status: 200, description: 'Analytics retrieved' })
  async findAll(
    @CurrentUser() user: User,
    @Query() queryDto: QueryAnalyticsDto,
  ) {
    const result = await this.analyticsService.findAll(
      user.tenantId,
      queryDto,
      user.customerId,
    );
    return {
      message: 'Analytics retrieved successfully',
      data: result.data,
      meta: {
        total: result.total,
        page: result.page,
        limit: result.limit,
        totalPages: result.totalPages,
      },
    };
  }

  @Get('overview')
  @ApiOperation({ summary: 'Get system overview' })
  @ApiResponse({ status: 200, description: 'Overview retrieved' })
  async getOverview(@CurrentUser() user: User) {
    const overview = await this.analyticsService.getSystemOverview(
      user.tenantId,
      user.customerId,
    );
    return {
      message: 'System overview retrieved successfully',
      data: overview,
    };
  }

  @Get('devices')
  @ApiOperation({ summary: 'Get device analytics' })
  @ApiResponse({ status: 200, description: 'Device analytics retrieved' })
  async getDeviceAnalytics(
    @CurrentUser() user: User,
    @Query() dto: DeviceAnalyticsDto,
  ) {
    const analytics = await this.analyticsService.getDeviceAnalytics(
      user.tenantId,
      dto,
      user.customerId,
    );
    return {
      message: 'Device analytics retrieved successfully',
      data: analytics,
    };
  }

  @Get('telemetry')
  @ApiOperation({ summary: 'Get telemetry statistics' })
  @ApiQuery({ name: 'startDate', required: false })
  @ApiQuery({ name: 'endDate', required: false })
  @ApiResponse({ status: 200, description: 'Telemetry stats retrieved' })
  async getTelemetryStats(
    @CurrentUser() user: User,
    @Query() queryDto: TelemetryStatQueryDto,
  ) {
    const stats = await this.analyticsService.getTelemetryStats(
      user.tenantId,
      queryDto.startDate ? new Date(queryDto.startDate) : undefined,
      queryDto.endDate ? new Date(queryDto.endDate) : undefined,
      user.customerId,
    );
    return {
      message: 'Telemetry statistics retrieved successfully',
      data: stats,
    };
  }

  @Get('alarms')
  @ApiOperation({ summary: 'Get alarm analytics' })
  @ApiQuery({ name: 'startDate', required: false })
  @ApiQuery({ name: 'endDate', required: false })
  @ApiResponse({ status: 200, description: 'Alarm analytics retrieved' })
  async getAlarmAnalytics(
    @CurrentUser() user: User,
    @Query() queryDto: TelemetryStatQueryDto,
  ) {
    const analytics = await this.analyticsService.getAlarmAnalytics(
      user.tenantId,
      queryDto.startDate ? new Date(queryDto.startDate) : undefined,
      queryDto.endDate ? new Date(queryDto.endDate) : undefined,
      user.customerId,
    );
    return {
      message: 'Alarm analytics retrieved successfully',
      data: analytics,
    };
  }

  @Get('users')
  @UseGuards(RolesGuard)
  @Roles(UserRole.SUPER_ADMIN, UserRole.TENANT_ADMIN)
  @ApiOperation({ summary: 'Get user activity analytics' })
  @ApiQuery({ name: 'startDate', required: false })
  @ApiQuery({ name: 'endDate', required: false })
  @ApiResponse({ status: 200, description: 'User analytics retrieved' })
  async getUserActivity(
    @CurrentUser() user: User,
    @Query() queryDto: TelemetryStatQueryDto,
  ) {
    const analytics = await this.analyticsService.getUserActivity(
      user.tenantId,
      queryDto.startDate ? new Date(queryDto.startDate) : undefined,
      queryDto.endDate ? new Date(queryDto.endDate) : undefined,
    );
    return {
      message: 'User activity analytics retrieved successfully',
      data: analytics,
    };
  }

  @Post('generate')
  @UseGuards(RolesGuard)
  @Roles(UserRole.SUPER_ADMIN)
  @ApiOperation({ summary: 'Manually generate daily analytics' })
  @ApiResponse({ status: 200, description: 'Analytics generated' })
  async generateAnalytics(@CurrentUser() user: User) {
    await this.analyticsService.generateDailyAnalytics();
    return {
      message: 'Analytics generation started',
    };
  }

  @Delete('cleanup/:days')
  @UseGuards(RolesGuard)
  @Roles(UserRole.SUPER_ADMIN)
  @ApiOperation({ summary: 'Delete old analytics' })
  @ApiResponse({ status: 200, description: 'Old analytics deleted' })
  async deleteOld(
    @CurrentUser() user: User,
    @Param('days') days: number,
  ) {
    const deleted = await this.analyticsService.deleteOld(
      user.tenantId,
      +days,
    );
    return {
      message: `Deleted ${deleted} old analytics records`,
      data: { deleted },
    };
  }
}