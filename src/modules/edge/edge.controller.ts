// src/modules/edge/edge.controller.ts
import {
  Body,
  Controller,
  Delete,
  ForbiddenException,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Patch,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiQuery, ApiTags } from '@nestjs/swagger';

import { EdgeService } from './edge.service';
import { CreateEdgeDto } from './dto/create-edge.dto';
import { UpdateEdgeDto } from './dto/update-edge.dto';
import { SendCommandDto } from './dto/send-command.dto';
import { AgentHeartbeatDto } from './dto/agent-heartbeat.dto';
import { AgentRegisterDto } from './dto/agent-register.dto';
import { AcknowledgeCommandDto } from './dto/acknowledge-command.dto';
import { EdgeQueryDto } from './dto/edge-query.dto';
import { EdgeEventQueryDto } from './dto/edge-event-query.dto';

import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { ParseIdPipe } from '../../common/pipes/parse-id.pipe';
import { Public } from '@/common/decorators/public.decorator';
import { User } from '../users/entities/user.entity';

@ApiTags('edge')
@Controller('edge')
export class EdgeController {
  constructor(private readonly edgeService: EdgeService) {}

  /**
   * Edges are tenant-scoped, but `User.tenantId` is optional (SUPER_ADMIN has
   * none). Say so plainly rather than letting `undefined` reach the repository,
   * which matches nothing and reads as a confusing 404.
   */
  private tenantOf(user: User): string {
    if (!user?.tenantId) {
      throw new ForbiddenException(
        'Edge devices are tenant-scoped; this account has no tenant context',
      );
    }
    return user.tenantId;
  }

  // ══════════════════════════════════════════════════════════════════════════
  // AGENT ROUTES (@Public — authenticated by edgeKey, not JWT)
  //
  // Declared before ':id' so that "agent" is never captured as an edge id.
  // ══════════════════════════════════════════════════════════════════════════

  @Post('agent/register')
  @Public()
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Edge agent first-boot registration (edgeKey + secret)' })
  agentRegister(@Body() body: AgentRegisterDto) {
    return this.edgeService.selfRegister(body);
  }

  @Post('agent/heartbeat')
  @Public()
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Edge agent heartbeat — authenticated by edgeKey in body' })
  agentHeartbeat(@Body() body: AgentHeartbeatDto) {
    return this.edgeService.handleHeartbeat(body.edgeKey, body);
  }

  @Get('agent/commands')
  @Public()
  @ApiOperation({ summary: 'Poll pending commands; marks them SENT' })
  @ApiQuery({ name: 'edgeKey', required: true })
  agentGetCommands(@Query('edgeKey') edgeKey: string) {
    return this.edgeService.getPendingCommands(edgeKey);
  }

  @Post('agent/commands/:commandId/acknowledge')
  @Public()
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Acknowledge command execution' })
  agentAcknowledge(
    @Param('commandId', ParseIdPipe) commandId: string,
    @Body() body: AcknowledgeCommandDto,
  ) {
    return this.edgeService.acknowledgeCommand(
      commandId,
      body.edgeKey,
      body.success,
      body.error,
    );
  }

  // ══════════════════════════════════════════════════════════════════════════
  // MANAGEMENT ROUTES (JWT)
  // ══════════════════════════════════════════════════════════════════════════

  @Post()
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Create an edge device' })
  create(@CurrentUser() user: User, @Body() dto: CreateEdgeDto) {
    return this.edgeService.create(dto, this.tenantOf(user), user.id);
  }

  @Get()
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'List edge devices' })
  findAll(@CurrentUser() user: User, @Query() query: EdgeQueryDto) {
    return this.edgeService.findAll(this.tenantOf(user), query);
  }

  @Get(':id')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Get one edge device' })
  findOne(@CurrentUser() user: User, @Param('id', ParseIdPipe) id: string) {
    return this.edgeService.findOne(id, this.tenantOf(user));
  }

  @Patch(':id')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Update an edge device' })
  update(
    @CurrentUser() user: User,
    @Param('id', ParseIdPipe) id: string,
    @Body() dto: UpdateEdgeDto,
  ) {
    return this.edgeService.update(id, dto, this.tenantOf(user), user.id);
  }

  @Delete(':id')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Soft-delete an edge device' })
  remove(@CurrentUser() user: User, @Param('id', ParseIdPipe) id: string) {
    return this.edgeService.remove(id, this.tenantOf(user));
  }

  // ── Activation ─────────────────────────────────────────────────────────────

  @Post(':id/activate')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Issue agent credentials — secret returned once' })
  activate(@CurrentUser() user: User, @Param('id', ParseIdPipe) id: string) {
    return this.edgeService.activate(id, this.tenantOf(user));
  }

  // ── Devices ────────────────────────────────────────────────────────────────

  @Get(':id/devices')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'List devices assigned to this edge' })
  getDevices(@CurrentUser() user: User, @Param('id', ParseIdPipe) id: string) {
    return this.edgeService.getDevices(id, this.tenantOf(user));
  }

  @Post(':id/devices')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Assign a device to this edge' })
  assignDevice(
    @CurrentUser() user: User,
    @Param('id', ParseIdPipe) id: string,
    @Body('deviceId', ParseIdPipe) deviceId: string,
  ) {
    return this.edgeService.assignDevice(id, deviceId, this.tenantOf(user));
  }

  @Delete(':id/devices/:deviceId')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Unassign a device from this edge' })
  removeDevice(
    @CurrentUser() user: User,
    @Param('id', ParseIdPipe) id: string,
    @Param('deviceId', ParseIdPipe) deviceId: string,
  ) {
    return this.edgeService.removeDevice(id, deviceId, this.tenantOf(user));
  }

  // ── Config & sync ──────────────────────────────────────────────────────────

  @Get(':id/config')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Full configuration bundle for the agent' })
  getConfig(@CurrentUser() user: User, @Param('id', ParseIdPipe) id: string) {
    return this.edgeService.getConfigBundle(id, this.tenantOf(user));
  }

  @Post(':id/sync')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Queue a configuration sync' })
  sync(@CurrentUser() user: User, @Param('id', ParseIdPipe) id: string) {
    return this.edgeService.triggerSync(id, this.tenantOf(user), user.id);
  }

  @Get(':id/sync-status')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Sync state and assignment counts' })
  syncStatus(@CurrentUser() user: User, @Param('id', ParseIdPipe) id: string) {
    return this.edgeService.getSyncStatus(id, this.tenantOf(user));
  }

  // ── Commands ───────────────────────────────────────────────────────────────

  @Post(':id/commands')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Queue a command for the edge agent' })
  sendCommand(
    @CurrentUser() user: User,
    @Param('id', ParseIdPipe) id: string,
    @Body() dto: SendCommandDto,
  ) {
    return this.edgeService.sendCommand(id, this.tenantOf(user), dto, user.id);
  }

  @Get(':id/commands')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Command history (latest 50)' })
  @ApiQuery({ name: 'status', required: false })
  getCommands(
    @CurrentUser() user: User,
    @Param('id', ParseIdPipe) id: string,
    @Query('status') status?: string,
  ) {
    return this.edgeService.getCommands(id, this.tenantOf(user), status);
  }

  // ── Events & metrics ───────────────────────────────────────────────────────

  @Get(':id/events')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Edge event log' })
  getEvents(
    @CurrentUser() user: User,
    @Param('id', ParseIdPipe) id: string,
    @Query() query: EdgeEventQueryDto,
  ) {
    return this.edgeService.getEvents(id, this.tenantOf(user), query);
  }

  @Get(':id/metrics')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Current status and metric summary' })
  getMetrics(@CurrentUser() user: User, @Param('id', ParseIdPipe) id: string) {
    return this.edgeService.getMetrics(id, this.tenantOf(user));
  }

  @Get(':id/metrics/history')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Metric time series from heartbeat snapshots' })
  @ApiQuery({ name: 'hours', required: false, type: Number, example: 24 })
  getMetricsHistory(
    @CurrentUser() user: User,
    @Param('id', ParseIdPipe) id: string,
    @Query('hours') hours?: number,
  ) {
    return this.edgeService.getMetricsHistory(
      id,
      this.tenantOf(user),
      hours ? Number(hours) : 24,
    );
  }

  // ── Rule chain assignment ──────────────────────────────────────────────────

  @Post(':id/rule-chains/:ruleChainId')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Assign a rule chain to this edge' })
  assignRuleChain(
    @CurrentUser() user: User,
    @Param('id', ParseIdPipe) id: string,
    @Param('ruleChainId', ParseIdPipe) ruleChainId: string,
  ) {
    return this.edgeService.assignRuleChain(id, ruleChainId, this.tenantOf(user));
  }

  @Delete(':id/rule-chains/:ruleChainId')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Unassign a rule chain' })
  removeRuleChain(
    @CurrentUser() user: User,
    @Param('id', ParseIdPipe) id: string,
    @Param('ruleChainId', ParseIdPipe) ruleChainId: string,
  ) {
    return this.edgeService.removeRuleChain(id, ruleChainId, this.tenantOf(user));
  }

  // ── Dashboard assignment ───────────────────────────────────────────────────

  @Post(':id/dashboards/:dashboardId')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Assign a dashboard to this edge' })
  assignDashboard(
    @CurrentUser() user: User,
    @Param('id', ParseIdPipe) id: string,
    @Param('dashboardId', ParseIdPipe) dashboardId: string,
  ) {
    return this.edgeService.assignDashboard(id, dashboardId, this.tenantOf(user));
  }

  @Delete(':id/dashboards/:dashboardId')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Unassign a dashboard' })
  removeDashboard(
    @CurrentUser() user: User,
    @Param('id', ParseIdPipe) id: string,
    @Param('dashboardId', ParseIdPipe) dashboardId: string,
  ) {
    return this.edgeService.removeDashboard(id, dashboardId, this.tenantOf(user));
  }
}
