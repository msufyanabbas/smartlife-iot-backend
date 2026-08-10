import {
  Controller,
  Get,
  Post,
  Body,
  Patch,
  Param,
  Delete,
  UseGuards,
  Query,
  HttpCode,
  HttpStatus,
} from '@nestjs/common';
import {
  ApiTags,
  ApiOperation,
  ApiResponse,
  ApiBearerAuth,
  ApiQuery,
} from '@nestjs/swagger';
import { IntegrationsService } from './integrations.service';
import { CreateIntegrationDto } from './dto/create-integration.dto';
import { UpdateIntegrationDto } from './dto/update-integration.dto';
import { IntegrationActivityDto } from './dto/integration-activity.dto';
import { TuyaCommandDto } from './dto/tuya-command.dto';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { User } from '../users/entities/user.entity';
import { PaginationDto } from '../../common/dto/pagination.dto';
import { ParseIdPipe } from '../../common/pipes/parse-id.pipe';

@ApiTags('integrations')
@Controller('integrations')
@UseGuards(JwtAuthGuard)
@ApiBearerAuth()
export class IntegrationsController {
  constructor(private readonly integrationsService: IntegrationsService) {}

  @Post()
  @ApiOperation({ summary: 'Create a new integration' })
  @ApiResponse({ status: 201, description: 'Integration created successfully' })
  @ApiResponse({ status: 409, description: 'Integration already exists' })
  create(
    @CurrentUser() user: User,
    @Body() createIntegrationDto: CreateIntegrationDto,
  ) {
    return this.integrationsService.create(user, createIntegrationDto);
  }

  @Get()
  @ApiOperation({ summary: 'Get all integrations with pagination' })
  @ApiResponse({ status: 200, description: 'List of integrations' })
  findAll(@CurrentUser() user: User, @Query() paginationDto: PaginationDto) {
    return this.integrationsService.findAll(user.id, paginationDto);
  }

  @Get('statistics')
  @ApiOperation({ summary: 'Get integration statistics' })
  @ApiResponse({ status: 200, description: 'Integration statistics' })
  getStatistics(@CurrentUser() user: User) {
    return this.integrationsService.getStatistics(user.id);
  }

  @Get('recent-activity')
  @ApiOperation({
    summary: 'Get recent integration activity',
    description:
      'Recent activity feed derived from integration state (no dedicated event log exists). ' +
      "Entries are ordered by each integration's most recent relevant timestamp.",
  })
  @ApiQuery({
    name: 'limit',
    required: false,
    description: 'Max entries (default 10, max 50)',
    example: 10,
  })
  @ApiQuery({
    name: 'page',
    required: false,
    description: 'Page number, 1-based (default 1)',
    example: 1,
  })
  @ApiQuery({
    name: 'type',
    required: false,
    description:
      'Filter by integration type (cloud | webhook | mqtt | notification | api | database)',
  })
  @ApiResponse({
    status: 200,
    description: 'Recent integration activity (paginated).',
    type: IntegrationActivityDto,
    isArray: true,
  })
  getRecentActivity(
    @CurrentUser() user: User,
    @Query('limit') limit?: string,
    @Query('page') page?: string,
    @Query('type') type?: string,
  ) {
    return this.integrationsService.getRecentActivity(user.id, {
      limit,
      page,
      type,
    });
  }

  @Get(':id')
  @ApiOperation({ summary: 'Get integration by ID' })
  @ApiResponse({ status: 200, description: 'Integration details' })
  @ApiResponse({ status: 404, description: 'Integration not found' })
  findOne(@CurrentUser() user: User, @Param('id', ParseIdPipe) id: string) {
    return this.integrationsService.findOne(id, user.id);
  }

  @Patch(':id')
  @ApiOperation({ summary: 'Update integration' })
  @ApiResponse({ status: 200, description: 'Integration updated successfully' })
  @ApiResponse({ status: 404, description: 'Integration not found' })
  update(
    @CurrentUser() user: User,
    @Param('id', ParseIdPipe) id: string,
    @Body() updateIntegrationDto: UpdateIntegrationDto,
  ) {
    return this.integrationsService.update(id, user.id, updateIntegrationDto);
  }

  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Delete integration' })
  @ApiResponse({ status: 204, description: 'Integration deleted successfully' })
  @ApiResponse({ status: 404, description: 'Integration not found' })
  remove(@CurrentUser() user: User, @Param('id', ParseIdPipe) id: string) {
    return this.integrationsService.remove(id, user.id);
  }

  @Post(':id/toggle')
  @ApiOperation({ summary: 'Toggle integration status' })
  @ApiResponse({ status: 200, description: 'Status toggled successfully' })
  @ApiResponse({ status: 404, description: 'Integration not found' })
  toggleStatus(
    @CurrentUser() user: User,
    @Param('id', ParseIdPipe) id: string,
  ) {
    return this.integrationsService.toggleStatus(id, user.id);
  }

  @Post(':id/test')
  @ApiOperation({
    summary: 'Test integration connection',
    description:
      'Probes the endpoint through the same adapter dispatch uses. NOTE this ' +
      'sends a real test payload (webhook/HTTP POST, MQTT publish, AWS IoT ' +
      'publish), so subscribers will see it. Returns ' +
      '{ connected, message, latencyMs }.',
  })
  @ApiResponse({ status: 200, description: 'Connection test result' })
  @ApiResponse({ status: 404, description: 'Integration not found' })
  testConnection(
    @CurrentUser() user: User,
    @Param('id', ParseIdPipe) id: string,
  ) {
    return this.integrationsService.testConnection(id, user.id);
  }

  // ══════════════════════════════════════════════════════════════════════════
  // TUYA
  // ══════════════════════════════════════════════════════════════════════════

  @Get(':id/tuya/devices')
  @ApiOperation({
    summary: 'List Tuya devices bound to this integration',
    description:
      'Requires a TUYA integration (or a legacy CLOUD one carrying Tuya credentials).',
  })
  @ApiResponse({ status: 200, description: 'Tuya devices' })
  @ApiResponse({ status: 400, description: 'Not a Tuya integration' })
  @ApiResponse({ status: 404, description: 'Integration not found' })
  getTuyaDevices(
    @CurrentUser() user: User,
    @Param('id', ParseIdPipe) id: string,
  ) {
    return this.integrationsService.getTuyaDevices(id, user.id);
  }

  @Post(':id/tuya/command')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Send a command to a Tuya device',
    description:
      'Body: { tuyaDeviceId, commands: [{ code, value }] }. Commands are passed ' +
      'through to POST /v1.0/devices/{id}/commands on the Tuya OpenAPI.',
  })
  @ApiResponse({ status: 200, description: 'Command accepted by Tuya' })
  @ApiResponse({ status: 400, description: 'Not a Tuya integration, or Tuya rejected the command' })
  @ApiResponse({ status: 404, description: 'Integration not found' })
  sendTuyaCommand(
    @CurrentUser() user: User,
    @Param('id', ParseIdPipe) id: string,
    @Body() body: TuyaCommandDto,
  ) {
    return this.integrationsService.sendTuyaCommand(id, user.id, body);
  }

  @Get(':id/tuya/device/:tuyaDeviceId/status')
  @ApiOperation({ summary: 'Get the current datapoint status of a Tuya device' })
  @ApiResponse({ status: 200, description: 'Tuya device status' })
  @ApiResponse({ status: 400, description: 'Not a Tuya integration, or Tuya rejected the request' })
  @ApiResponse({ status: 404, description: 'Integration not found' })
  getTuyaDeviceStatus(
    @CurrentUser() user: User,
    @Param('id', ParseIdPipe) id: string,
    @Param('tuyaDeviceId') tuyaDeviceId: string,
  ) {
    return this.integrationsService.getTuyaDeviceStatus(
      id,
      user.id,
      tuyaDeviceId,
    );
  }
}
