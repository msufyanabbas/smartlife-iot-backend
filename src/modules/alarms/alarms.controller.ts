// src/modules/alarms/controllers/alarms.controller.ts
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
} from '@nestjs/swagger';
import { AlarmsService } from './alarms.service';
import {
  CreateAlarmDto,
  UpdateAlarmDto,
  AlarmQueryDto,
  AcknowledgeAlarmDto,
  ResolveAlarmDto,
  TestAlarmDto,
  BulkAcknowledgeAlarmDto,
  BulkResolveAlarmDto,
  AssignAlarmDto,
} from './dto/alarm.dto';
import { JwtAuthGuard } from '@common/guards/jwt-auth.guard';
import { CurrentUser } from '@common/decorators/current-user.decorator';
import { User } from '@modules/users/entities/user.entity';
import { ParseIdPipe } from '@common/pipes/parse-id.pipe';
import { RequirePermissions } from '@common/decorators/permission.decorator';
import { Audit } from '@common/decorators/audit.decorator';
import { AuditAction, AuditEntityType, AuditSeverity } from '@common/enums/index.enum';

@ApiTags('alarms')
@Controller('alarms')
@UseGuards(JwtAuthGuard)
@ApiBearerAuth()
export class AlarmsController {
  constructor(private readonly alarmsService: AlarmsService) {}

  @Post()
  @RequirePermissions('alerts:create')
  @ApiOperation({ summary: 'Create new alarm rule' })
  @ApiResponse({ status: 201, description: 'Alarm rule created successfully' })
  create(@CurrentUser() user: User, @Body() createDto: CreateAlarmDto) {
    return this.alarmsService.create(user, createDto);
  }

  @Get()
  @RequirePermissions('alerts:list')
  @ApiOperation({ summary: 'Get all alarm rules' })
  @ApiResponse({ status: 200, description: 'List of alarm rules' })
  findAll(@CurrentUser() user: User, @Query() query: AlarmQueryDto) {
    return this.alarmsService.findAll(user, query);
  }

  @Get('active')
  @RequirePermissions('alerts:list')
  @ApiOperation({ summary: 'Get active alarms' })
  @ApiResponse({ status: 200, description: 'List of active alarms' })
  getActive(@CurrentUser() user: User) {
    return this.alarmsService.getActive(user);
  }

  @Get('statistics')
  @RequirePermissions('alerts:list')
  @ApiOperation({ summary: 'Get alarm statistics' })
  @ApiResponse({ status: 200, description: 'Alarm statistics' })
  getStatistics(@CurrentUser() user: User) {
    return this.alarmsService.getStatistics(user);
  }

  @Get('critical')
  @RequirePermissions('alerts:list')
  @ApiOperation({ summary: 'Get critical unacknowledged alarms' })
  @ApiResponse({ status: 200, description: 'Critical alarms' })
  getCritical(@CurrentUser() user: User) {
    return this.alarmsService.getCritical(user);
  }

  // Declared before @Get(':id') — a literal segment must be registered ahead
  // of the param route or Nest matches 'counts' as an id.
  @Get('counts')
  @RequirePermissions('alerts:list')
  @ApiOperation({
    summary: 'Alarm counts for a dashboard',
    description:
      'Counts bucketed in the ThingsBoard active/cleared × ack/unack shape, ' +
      'derived from the stored status plus acknowledgedAt. Dormant ' +
      'device-profile rules are reported under `inactive` rather than being ' +
      'folded into the cleared bucket. Severity counts cover raised alarms ' +
      '(active + acknowledged) only. For the richer payload — most-triggered ' +
      'and recent lists — use GET /alarms/statistics.',
  })
  @ApiResponse({ status: 200, description: 'Alarm counts' })
  getCounts(@CurrentUser() user: User) {
    return this.alarmsService.getCounts(user);
  }

  @Get('device/:deviceId')
  @RequirePermissions('alerts:read')
  @ApiOperation({ summary: 'Get alarms for a specific device' })
  @ApiResponse({ status: 200, description: 'Device alarms' })
  getDeviceAlarms(
    @CurrentUser() user: User,
    @Param('deviceId', ParseIdPipe) deviceId: string,
  ) {
    return this.alarmsService.getDeviceAlarms(user, deviceId);
  }

  @Get('device/:deviceId/history')
  @RequirePermissions('alerts:read')
  @ApiOperation({ summary: 'Get alarm history for device' })
  @ApiResponse({ status: 200, description: 'Alarm history' })
  getDeviceHistory(
    @CurrentUser() user: User,
    @Param('deviceId', ParseIdPipe) deviceId: string,
    @Query('days') days?: number,
  ) {
    return this.alarmsService.getDeviceHistory(
      user,
      deviceId,
      days ? parseInt(days.toString()) : 7,
    );
  }

  @Get(':id')
  @RequirePermissions('alerts:read')
  @ApiOperation({ summary: 'Get alarm by ID' })
  @ApiResponse({ status: 200, description: 'Alarm found' })
  @ApiResponse({ status: 404, description: 'Alarm not found' })
  findOne(@Param('id', ParseIdPipe) id: string, @CurrentUser() user: User) {
    return this.alarmsService.findOne(id, user);
  }

  // ':id/escalation-history' is a distinct path from ':id', so ordering
  // relative to it does not matter — but it stays next to it for readability.
  @Get(':id/escalation-history')
  @RequirePermissions('alerts:read')
  @ApiOperation({
    summary: 'Get alarm escalation history',
    description:
      'Escalation timeline for an alarm: current level, per-level dispatch ' +
      'history, and the rules in force (the alarm override when set, ' +
      'otherwise the severity default).',
  })
  @ApiResponse({ status: 200, description: 'Escalation timeline' })
  @ApiResponse({ status: 404, description: 'Alarm not found' })
  getEscalationHistory(
    @Param('id', ParseIdPipe) id: string,
    @CurrentUser() user: User,
  ) {
    return this.alarmsService.getEscalationHistory(id, user.tenantId);
  }

  @Patch(':id')
  @Audit({
    action: AuditAction.UPDATE,
    entityType: AuditEntityType.ALARM,
  })
  @RequirePermissions('alerts:update')
  @ApiOperation({ summary: 'Update alarm rule' })
  @ApiResponse({ status: 200, description: 'Alarm updated' })
  update(
    @Param('id', ParseIdPipe) id: string,
    @CurrentUser() user: User,
    @Body() updateDto: UpdateAlarmDto,
  ) {
    return this.alarmsService.update(id, user.tenantId, updateDto);
  }

  @Delete(':id')
  @Audit({
    action: AuditAction.DELETE,
    entityType: AuditEntityType.ALARM,
    severity: AuditSeverity.WARNING,
  })
  @RequirePermissions('alerts:delete')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Delete alarm rule' })
  @ApiResponse({ status: 204, description: 'Alarm deleted' })
  remove(@Param('id', ParseIdPipe) id: string, @CurrentUser() user: User) {
    return this.alarmsService.remove(id, user.tenantId);
  }

  @Post(':id/acknowledge')
  @RequirePermissions('alerts:update')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Acknowledge alarm' })
  @ApiResponse({ status: 200, description: 'Alarm acknowledged' })
  acknowledge(
    @Param('id', ParseIdPipe) id: string,
    @CurrentUser() user: User,
    @Body() acknowledgeDto?: AcknowledgeAlarmDto,
  ) {
    return this.alarmsService.acknowledge(id, user.tenantId, user.id, acknowledgeDto);
  }

  @Post(':id/clear')
  @RequirePermissions('alerts:update')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Clear alarm',
    description:
      'Records the operator in clearedBy. An automatic clear by the rule ' +
      'engine leaves clearedBy null, which is how the two are told apart.',
  })
  @ApiResponse({ status: 200, description: 'Alarm cleared' })
  clear(@Param('id', ParseIdPipe) id: string, @CurrentUser() user: User) {
    return this.alarmsService.clear(id, user.tenantId, user.id);
  }

  @Patch(':id/assign')
  @Audit({
    action: AuditAction.UPDATE,
    entityType: AuditEntityType.ALARM,
  })
  @RequirePermissions('alerts:update')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Assign an alarm to a user for handling',
    description:
      'Pass userId: null to unassign. The assignee must belong to the same ' +
      'tenant, otherwise the alarm would be assigned to someone who cannot ' +
      'see it.',
  })
  @ApiResponse({ status: 200, description: 'Alarm assigned' })
  @ApiResponse({ status: 404, description: 'Alarm or assignee not found' })
  assign(
    @Param('id', ParseIdPipe) id: string,
    @CurrentUser() user: User,
    @Body() assignDto: AssignAlarmDto,
  ) {
    return this.alarmsService.assign(id, user.tenantId, assignDto.userId);
  }

  @Post(':id/resolve')
  @RequirePermissions('alerts:update')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Resolve alarm' })
  @ApiResponse({ status: 200, description: 'Alarm resolved' })
  resolve(
    @Param('id', ParseIdPipe) id: string,
    @CurrentUser() user: User,
    @Body() resolveDto: ResolveAlarmDto,
  ) {
    return this.alarmsService.resolve(id, user.tenantId, user.id, resolveDto);
  }

  @Post(':id/enable')
  @Audit({
    action: AuditAction.ACTIVATE,
    entityType: AuditEntityType.ALARM,
  })
  @RequirePermissions('alerts:update')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Enable alarm rule' })
  @ApiResponse({ status: 200, description: 'Alarm enabled' })
  enable(@Param('id', ParseIdPipe) id: string, @CurrentUser() user: User) {
    return this.alarmsService.enable(id, user.tenantId);
  }

  @Post(':id/disable')
  @Audit({
    action: AuditAction.DEACTIVATE,
    entityType: AuditEntityType.ALARM,
    severity: AuditSeverity.WARNING,
  })
  @RequirePermissions('alerts:update')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Disable alarm rule' })
  @ApiResponse({ status: 200, description: 'Alarm disabled' })
  disable(@Param('id', ParseIdPipe) id: string, @CurrentUser() user: User) {
    return this.alarmsService.disable(id, user.tenantId);
  }

  @Post(':id/test')
  @Audit({
    action: AuditAction.UPDATE,
    entityType: AuditEntityType.ALARM,
  })
  @RequirePermissions('alerts:update')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Test alarm rule with a value' })
  @ApiResponse({ status: 200, description: 'Test result' })
  test(
    @Param('id', ParseIdPipe) id: string,
    @CurrentUser() user: User,
    @Body() body: TestAlarmDto,
  ) {
    return this.alarmsService.testAlarm(id, user.tenantId, body.value);
  }

  @Post('bulk/acknowledge')
  @RequirePermissions('alerts:create')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Bulk acknowledge alarms' })
  @ApiResponse({ status: 200, description: 'Alarms acknowledged' })
  bulkAcknowledge(
    @CurrentUser() user: User,
    @Body() body: BulkAcknowledgeAlarmDto,
  ) {
    return this.alarmsService.bulkAcknowledge(user.tenantId, user.id, body.alarmIds);
  }

  @Post('bulk/clear')
  @RequirePermissions('alerts:create')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Bulk clear alarms' })
  @ApiResponse({ status: 200, description: 'Alarms cleared' })
  bulkClear(
    @CurrentUser() user: User,
    @Body() body: { alarmIds: string[] },
  ) {
    return this.alarmsService.bulkClear(user.tenantId, body.alarmIds);
  }

  @Post('bulk/resolve')
  @RequirePermissions('alerts:create')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Bulk resolve alarms' })
  @ApiResponse({ status: 200, description: 'Alarms resolved' })
  bulkResolve(
    @CurrentUser() user: User,
    @Body() body: BulkResolveAlarmDto,
  ) {
    return this.alarmsService.bulkResolve(user.tenantId, user.id, body.alarmIds, body.note);
  }
}