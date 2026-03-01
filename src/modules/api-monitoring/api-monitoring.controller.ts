// src/modules/api-monitoring/controllers/api-monitoring.controller.ts
import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiBearerAuth } from '@nestjs/swagger';
import { ApiMonitoringService } from './api-monitoring.service';
import { APILogFilterDto } from './dto/api-log-filter.dto';
import { JwtAuthGuard } from '@common/guards/jwt-auth.guard';
import { RolesGuard } from '@common/guards/roles.guard';
import { Roles } from '@common/decorators/roles.decorator';
import { CurrentUser } from '@common/decorators/current-user.decorator';
import { User } from '@modules/users/entities/user.entity';
import { UserRole } from '@common/enums/index.enum';

@ApiTags('api-monitoring')
@Controller('api-monitoring')
@UseGuards(JwtAuthGuard)
@ApiBearerAuth()
export class ApiMonitoringController {
  constructor(private readonly apiMonitoringService: ApiMonitoringService) {}

  @Get('logs')
  @ApiOperation({ summary: 'Get API logs' })
  getLogs(@CurrentUser() user: User, @Query() filters: APILogFilterDto) {
    return this.apiMonitoringService.getLogs(
      user.tenantId,
      filters,
      user.customerId,
    );
  }

  @Get('logs/my')
  @ApiOperation({ summary: 'Get my API logs' })
  getMyLogs(@CurrentUser() user: User, @Query() filters: APILogFilterDto) {
    return this.apiMonitoringService.getUserLogs(
      user.tenantId,
      user.id,
      filters,
    );
  }

  @Get('metrics')
  @ApiOperation({ summary: 'Get API metrics' })
  getMetrics(@CurrentUser() user: User) {
    return this.apiMonitoringService.getMetrics(
      user.tenantId,
      user.customerId,
    );
  }

  @Get('metrics/my')
  @ApiOperation({ summary: 'Get my API metrics' })
  getMyMetrics(@CurrentUser() user: User) {
    return this.apiMonitoringService.getUserMetrics(user.tenantId, user.id);
  }

  @Get('statistics')
  @ApiOperation({ summary: 'Get API statistics' })
  getStatistics(@CurrentUser() user: User) {
    return this.apiMonitoringService.getStatistics(
      user.tenantId,
      user.customerId,
    );
  }

  @Get('health')
  @ApiOperation({ summary: 'Get system health status' })
  getHealth() {
    return this.apiMonitoringService.getHealth();
  }

  @Get('performance')
  @ApiOperation({ summary: 'Get performance metrics' })
  getPerformanceMetrics(@CurrentUser() user: User) {
    return this.apiMonitoringService.getPerformanceMetrics(
      user.tenantId,
      user.customerId,
    );
  }

  @Get('errors')
  @ApiOperation({ summary: 'Get error logs' })
  getErrors(@CurrentUser() user: User, @Query() filters: APILogFilterDto) {
    return this.apiMonitoringService.getErrors(
      user.tenantId,
      filters,
      user.customerId,
    );
  }

  @Get('slow-requests')
  @ApiOperation({ summary: 'Get slow requests' })
  getSlowRequests(@CurrentUser() user: User, @Query() filters: APILogFilterDto) {
    return this.apiMonitoringService.getSlowRequests(
      user.tenantId,
      filters,
      user.customerId,
    );
  }

  @Get('endpoints/top')
  @ApiOperation({ summary: 'Get top endpoints by usage' })
  getTopEndpoints(@CurrentUser() user: User) {
    return this.apiMonitoringService.getTopEndpoints(
      user.tenantId,
      user.customerId,
    );
  }
}