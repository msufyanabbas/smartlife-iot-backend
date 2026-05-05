// src/modules/edge/edge.controller.ts
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
  ApiBearerAuth,
  ApiOperation,
  ApiQuery,
} from '@nestjs/swagger';
import { EdgeService } from './edge.service';
import { CreateEdgeInstanceDto } from './dto/create-edge-instance.dto';
import { UpdateEdgeInstanceDto } from './dto/update-edge-instance.dto';
import { HeartbeatDto } from './dto/heartbeat.dto';
import { DispatchCommandDto } from './dto/dispatch-command.dto';
import { AckCommandDto } from './dto/ack-command.dto';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { PaginationDto } from '../../common/dto/pagination.dto';
import { ParseIdPipe } from '../../common/pipes/parse-id.pipe';
import { Public } from '@/common/decorators/public.decorator';

interface AuthenticatedUser {
  id: string;
  tenantId: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// All routes except heartbeat and agent-facing routes require JWT
// ─────────────────────────────────────────────────────────────────────────────

@ApiTags('edge')
@Controller('edge')
export class EdgeController {
  constructor(private readonly edgeService: EdgeService) {}

  // ── Authenticated routes ───────────────────────────────────────────────────

  @Post()
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Create edge instance — returns edgeToken once' })
  create(
    @CurrentUser() user: AuthenticatedUser,
    @Body() createDto: CreateEdgeInstanceDto,
  ) {
    return this.edgeService.create(user.id, user.tenantId, createDto);
  }

  @Get()
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'List edge instances' })
  findAll(
    @CurrentUser() user: AuthenticatedUser,
    @Query() paginationDto: PaginationDto,
  ) {
    return this.edgeService.findAll(user.id, user.tenantId, paginationDto);
  }

  @Get('statistics')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Get aggregate edge statistics' })
  getStatistics(@CurrentUser() user: AuthenticatedUser) {
    return this.edgeService.getStatistics(user.id, user.tenantId);
  }

  @Get(':id')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Get single edge instance' })
  findOne(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseIdPipe) id: string,
  ) {
    return this.edgeService.findOne(id, user.id, user.tenantId);
  }

  @Patch(':id')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Update edge instance' })
  update(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseIdPipe) id: string,
    @Body() updateDto: UpdateEdgeInstanceDto,
  ) {
    return this.edgeService.update(id, user.id, user.tenantId, updateDto);
  }

  @Delete(':id')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Soft-delete edge instance' })
  remove(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseIdPipe) id: string,
  ) {
    return this.edgeService.remove(id, user.id, user.tenantId);
  }

  @Get(':id/regenerate-token')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Rotate edge token (admin)' })
  regenerateToken(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseIdPipe) id: string,
  ) {
    return this.edgeService.regenerateToken(id, user.id, user.tenantId);
  }

  // ── Metrics history ────────────────────────────────────────────────────────

  @Get(':id/metrics')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Get metrics history for an edge instance' })
  @ApiQuery({ name: 'hours', required: false, type: Number, example: 24 })
  getMetricsHistory(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseIdPipe) id: string,
    @Query('hours') hours?: number,
  ) {
    return this.edgeService.getMetricsHistory(
      id,
      user.id,
      user.tenantId,
      hours ? Number(hours) : 24,
    );
  }

  // ── Device association ─────────────────────────────────────────────────────

  @Get(':id/devices')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'List devices assigned to this edge' })
  getDevices(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseIdPipe) id: string,
  ) {
    return this.edgeService.getDevices(id, user.id, user.tenantId);
  }

  @Post(':id/devices/:deviceId')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Assign a device to this edge' })
  assignDevice(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseIdPipe) id: string,
    @Param('deviceId', ParseIdPipe) deviceId: string,
  ) {
    return this.edgeService.assignDevice(
      id,
      deviceId,
      user.id,
      user.tenantId,
    );
  }

  @Delete(':id/devices/:deviceId')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Unassign a device from this edge' })
  unassignDevice(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseIdPipe) id: string,
    @Param('deviceId', ParseIdPipe) deviceId: string,
  ) {
    return this.edgeService.unassignDevice(
      id,
      deviceId,
      user.id,
      user.tenantId,
    );
  }

  // ── Command dispatch ───────────────────────────────────────────────────────

  @Post(':id/command')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Dispatch a command to an edge instance' })
  dispatchCommand(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseIdPipe) id: string,
    @Body() dto: DispatchCommandDto,
  ) {
    return this.edgeService.dispatchCommand(
      id,
      user.id,
      user.tenantId,
      dto,
    );
  }

  // ── Agent-facing routes (no JwtAuthGuard — secured by edgeToken in body) ──

  @Post(':id/heartbeat')
  @Public()
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Edge agent heartbeat — authenticated by edgeToken in body',
  })
  heartbeat(
    @Param('id', ParseIdPipe) id: string,
    @Body() dto: HeartbeatDto,
  ) {
    return this.edgeService.heartbeat(id, dto);
  }

  @Get(':id/commands/pending')
  @Public()
  @ApiOperation({
    summary: 'Poll for pending commands — authenticated by edgeToken query param',
  })
  @ApiQuery({ name: 'edgeToken', required: true })
  getPendingCommands(
    @Param('id', ParseIdPipe) id: string,
    @Query('edgeToken') edgeToken: string,
  ) {
    return this.edgeService.getPendingCommands(id, edgeToken);
  }

  @Post(':id/commands/:commandId/ack')
  @Public()
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Acknowledge command execution — authenticated by edgeToken in body',
  })
  ackCommand(
    @Param('id', ParseIdPipe) id: string,
    @Param('commandId', ParseIdPipe) commandId: string,
    @Body() dto: AckCommandDto & { edgeToken: string },
  ) {
    return this.edgeService.ackCommand(id, commandId, dto.edgeToken, dto);
  }
}