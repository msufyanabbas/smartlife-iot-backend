import {
  Controller,
  Get,
  Post,
  Body,
  Param,
  Query,
  Delete,
  UseGuards,
  HttpCode,
  HttpStatus,
  Header,
} from '@nestjs/common';
import {
  ApiTags,
  ApiOperation,
  ApiResponse,
  ApiBearerAuth,
  ApiQuery,
} from '@nestjs/swagger';
import { TelemetryService } from './telemetry.service';
import { CreateTelemetryDto } from './dto/create-telemetry.dto';
import { QueryTelemetryDto } from './dto/telemetry-query.dto';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { User } from '../users/entities/user.entity';
import { ParseIdPipe } from '../../common/pipes/parse-id.pipe';

@ApiTags('telemetry')
@Controller('telemetry')
@UseGuards(JwtAuthGuard)
@ApiBearerAuth()
export class TelemetryController {
  constructor(private readonly telemetryService: TelemetryService) {}

  @Post('devices/:deviceKey')
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({ summary: 'Create telemetry data for a device' })
  @ApiResponse({ status: 201, description: 'Telemetry created successfully' })
  @ApiResponse({ status: 404, description: 'Device not found' })
  create(
    @Param('deviceKey') deviceKey: string,
    @Body() createTelemetryDto: CreateTelemetryDto,
  ) {
    return this.telemetryService.create(deviceKey, createTelemetryDto);
  }

  @Post('devices/:deviceKey/batch')
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({ summary: 'Create multiple telemetry records (batch)' })
  @ApiResponse({ status: 201, description: 'Batch telemetry created' })
  @ApiResponse({ status: 404, description: 'Device not found' })
  createBatch(
    @Param('deviceKey') deviceKey: string,
    @Body() telemetryData: CreateTelemetryDto[],
  ) {
    return this.telemetryService.createBatch(deviceKey, telemetryData);
  }

  @Get('devices/:deviceId')
  @ApiOperation({ summary: 'Query telemetry data for a device' })
  @ApiResponse({ status: 200, description: 'Telemetry data retrieved' })
  @ApiResponse({ status: 404, description: 'Device not found' })
  findByDevice(
    @CurrentUser() user: User,
    @Param('deviceId', ParseIdPipe) deviceId: string,
    @Query() queryDto: QueryTelemetryDto,
  ) {
    return this.telemetryService.findByDevice(deviceId, user.id, queryDto);
  }

  @Get('devices/:deviceId/latest')
  @ApiOperation({ summary: 'Get latest telemetry for a device' })
  @ApiResponse({ status: 200, description: 'Latest telemetry retrieved' })
  @ApiResponse({ status: 404, description: 'Device or telemetry not found' })
  getLatest(
    @CurrentUser() user: User,
    @Param('deviceId', ParseIdPipe) deviceId: string,
  ) {
    return this.telemetryService.getLatest(deviceId, user.id);
  }

  @Get('devices/:deviceId/statistics')
  @ApiOperation({ summary: 'Get telemetry statistics for a device' })
  @ApiResponse({ status: 200, description: 'Statistics retrieved' })
  @ApiQuery({ name: 'startDate', required: false, type: String })
  @ApiQuery({ name: 'endDate', required: false, type: String })
  getStatistics(
    @CurrentUser() user: User,
    @Param('deviceId', ParseIdPipe) deviceId: string,
    @Query('startDate') startDate?: string,
    @Query('endDate') endDate?: string,
  ) {
    return this.telemetryService.getStatistics(
      deviceId,
      user.id,
      startDate,
      endDate,
    );
  }

  @Get('devices/:deviceId/aggregated')
  @ApiOperation({ summary: 'Get aggregated telemetry data' })
  @ApiResponse({ status: 200, description: 'Aggregated data retrieved' })
  @ApiQuery({
    name: 'interval',
    enum: ['hour', 'day', 'month'],
    required: true,
  })
  @ApiQuery({ name: 'startDate', required: true, type: String })
  @ApiQuery({ name: 'endDate', required: true, type: String })
  getAggregated(
    @CurrentUser() user: User,
    @Param('deviceId', ParseIdPipe) deviceId: string,
    @Query('interval') interval: 'hour' | 'day' | 'month',
    @Query('startDate') startDate: string,
    @Query('endDate') endDate: string,
  ) {
    return this.telemetryService.getAggregated(
      deviceId,
      user.id,
      interval,
      startDate,
      endDate,
    );
  }

  @Get('devices/:deviceId/timeseries')
  @ApiOperation({ summary: 'Get time series data for a specific key' })
  @ApiResponse({ status: 200, description: 'Time series data retrieved' })
  @ApiQuery({ name: 'key', required: true, type: String })
  @ApiQuery({ name: 'startDate', required: true, type: String })
  @ApiQuery({ name: 'endDate', required: true, type: String })
  @ApiQuery({ name: 'limit', required: false, type: Number })
  getTimeSeries(
    @CurrentUser() user: User,
    @Param('deviceId', ParseIdPipe) deviceId: string,
    @Query('key') key: string,
    @Query('startDate') startDate: string,
    @Query('endDate') endDate: string,
    @Query('limit') limit?: number,
  ) {
    return this.telemetryService.getTimeSeries(
      deviceId,
      user.id,
      key,
      startDate,
      endDate,
      limit ? parseInt(limit.toString()) : 1000,
    );
  }

  @Get('devices/:deviceId/count')
  @ApiOperation({ summary: 'Get telemetry record count for a device' })
  @ApiResponse({ status: 200, description: 'Count retrieved' })
  getCount(
    @CurrentUser() user: User,
    @Param('deviceId', ParseIdPipe) deviceId: string,
  ) {
    return this.telemetryService.getCountByDevice(deviceId, user.id);
  }

  @Get('devices/:deviceId/export')
  @Header('Content-Type', 'text/csv')
  @Header('Content-Disposition', 'attachment; filename="telemetry.csv"')
  @ApiOperation({ summary: 'Export telemetry data as CSV' })
  @ApiResponse({ status: 200, description: 'CSV data' })
  @ApiQuery({ name: 'startDate', required: false, type: String })
  @ApiQuery({ name: 'endDate', required: false, type: String })
  async exportCSV(
    @CurrentUser() user: User,
    @Param('deviceId', ParseIdPipe) deviceId: string,
    @Query('startDate') startDate?: string,
    @Query('endDate') endDate?: string,
  ) {
    return await this.telemetryService.exportToCSV(
      deviceId,
      user.id,
      startDate,
      endDate,
    );
  }

  @Delete('devices/:deviceId')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Delete all telemetry data for a device' })
  @ApiResponse({ status: 204, description: 'Telemetry deleted' })
  @ApiResponse({ status: 404, description: 'Device not found' })
  deleteByDevice(
    @CurrentUser() user: User,
    @Param('deviceId', ParseIdPipe) deviceId: string,
  ) {
    return this.telemetryService.deleteByDevice(deviceId, user.id);
  }
}
