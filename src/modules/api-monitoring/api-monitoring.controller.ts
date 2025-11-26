import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiBearerAuth } from '@nestjs/swagger';
import { ApiMonitoringService } from './api-monitoring.service';
import { APILogFilterDto } from './dto/api-log-filter.dto';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { User } from '../users/entities/user.entity';

@ApiTags('api-monitoring')
@Controller('api-monitoring')
@UseGuards(JwtAuthGuard)
@ApiBearerAuth()
export class ApiMonitoringController {
  constructor(private readonly apiMonitoringService: ApiMonitoringService) {}

  @Get('logs')
  @ApiOperation({ summary: 'Get API logs' })
  getLogs(@CurrentUser() user: User, @Query() filters: APILogFilterDto) {
    return this.apiMonitoringService.getLogs(user.id, filters);
  }

  @Get('metrics')
  @ApiOperation({ summary: 'Get API metrics' })
  getMetrics(@CurrentUser() user: User) {
    return this.apiMonitoringService.getMetrics(user.id);
  }

  @Get('statistics')
  @ApiOperation({ summary: 'Get API statistics' })
  getStatistics(@CurrentUser() user: User) {
    return this.apiMonitoringService.getStatistics(user.id);
  }

  @Get('health')
  @ApiOperation({ summary: 'Get system health status' })
  getHealth() {
    return this.apiMonitoringService.getHealth();
  }

  @Get('performance')
  @ApiOperation({ summary: 'Get performance metrics' })
  getPerformanceMetrics(@CurrentUser() user: User) {
    return this.apiMonitoringService.getPerformanceMetrics(user.id);
  }
}
