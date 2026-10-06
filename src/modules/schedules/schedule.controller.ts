// src/modules/schedules/schedule.controller.ts
import {
  Controller,
  Get,
  Post,
  Body,
  Patch,
  Param,
  Delete,
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
import { SchedulesService } from './schedule.service';
import { CreateScheduleDto } from './dto/create-schedule.dto';
import { UpdateScheduleDto } from './dto/update-schedule.dto';
import { QueryScheduleExecutionDto } from './dto/query-execution.dto';
import { CurrentUser } from '@common/decorators/current-user.decorator';
import { Roles } from '@common/decorators/roles.decorator';
import { PaginationDto } from '@common/dto/pagination.dto';
import { ParseIdPipe } from '@common/pipes/parse-id.pipe';
import { UserRole } from '@common/enums/index.enum';

/**
 * `@CurrentUser()` yields the full User; only these two fields are used, and
 * both are already on the JWT payload — no DB round-trip to resolve the caller.
 */
interface AuthenticatedUser {
  id: string;
  tenantId: string;
}

@ApiTags('schedules')
@Controller('schedules')
@ApiBearerAuth()
// JwtAuthGuard is registered globally in GuardsModule — a local @UseGuards
// would run it a second time on every request in this controller.
@Roles(
  UserRole.SUPER_ADMIN,
  UserRole.TENANT_ADMIN,
  UserRole.CUSTOMER,
  UserRole.CUSTOMER_USER,
)
export class SchedulesController {
  constructor(private readonly schedulesService: SchedulesService) {}

  @Post()
  @ApiOperation({ summary: 'Create a new schedule' })
  @ApiResponse({ status: 201, description: 'Schedule created' })
  @ApiResponse({ status: 400, description: 'Invalid timing or actionConfig' })
  create(
    @CurrentUser() user: AuthenticatedUser,
    @Body() createScheduleDto: CreateScheduleDto,
  ) {
    return this.schedulesService.create(
      user.id,
      user.tenantId,
      createScheduleDto,
    );
  }

  @Get()
  @ApiOperation({ summary: "List the current user's schedules" })
  findAll(
    @CurrentUser() user: AuthenticatedUser,
    @Query() paginationDto: PaginationDto,
  ) {
    return this.schedulesService.findAll(user.id, user.tenantId, paginationDto);
  }

  @Post('validate-cron')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Validate a cron expression',
    description:
      'Checks a 5-field cron expression and returns the next few fire times, so the ' +
      'UI can confirm an expression means what the user thinks before the schedule is ' +
      'saved. "0 0 * * 0" parses fine and runs weekly, not daily — only the preview ' +
      'makes that obvious.',
  })
  validateCron(@Body() body: { expression?: string; timezone?: string }) {
    return this.schedulesService.validateCronExpression(
      body?.expression ?? '',
      body?.timezone,
    );
  }

  @Get('statistics')
  @ApiOperation({ summary: 'Schedule counts, run totals and success rate' })
  getStatistics(@CurrentUser() user: AuthenticatedUser) {
    return this.schedulesService.getStatistics(user.id, user.tenantId);
  }

  @Get(':id')
  @ApiOperation({ summary: 'Get a schedule by ID' })
  findOne(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseIdPipe) id: string,
  ) {
    return this.schedulesService.findOne(id, user.id, user.tenantId);
  }

  // ── Execution history ─────────────────────────────────────────────────────

  @Get(':id/executions')
  @ApiOperation({ summary: 'Paginated execution history for a schedule' })
  @ApiResponse({ status: 200, description: 'Executions plus lifetime summary' })
  getExecutions(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseIdPipe) id: string,
    @Query() query: QueryScheduleExecutionDto,
  ) {
    return this.schedulesService.getExecutions(
      id,
      user.id,
      user.tenantId,
      query,
    );
  }

  @Get(':id/executions/latest')
  @ApiOperation({
    summary: 'Most recent execution — did the last run succeed?',
  })
  getLatestExecution(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseIdPipe) id: string,
  ) {
    return this.schedulesService.getLatestExecution(id, user.id, user.tenantId);
  }

  /**
   * @deprecated Alias for `GET :id/executions`, kept so existing clients do
   * not 404 after the `schedule_execution_logs` table was replaced.
   */
  @Get(':id/history')
  @ApiOperation({
    summary: 'DEPRECATED — use GET /schedules/:id/executions',
    deprecated: true,
  })
  getHistory(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseIdPipe) id: string,
    @Query() query: QueryScheduleExecutionDto,
  ) {
    return this.schedulesService.getExecutions(
      id,
      user.id,
      user.tenantId,
      query,
    );
  }

  // ── Mutations ─────────────────────────────────────────────────────────────

  @Patch(':id')
  @ApiOperation({ summary: 'Update a schedule' })
  @ApiResponse({ status: 400, description: 'Merged schedule is invalid' })
  update(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseIdPipe) id: string,
    @Body() updateScheduleDto: UpdateScheduleDto,
  ) {
    return this.schedulesService.update(
      id,
      user.id,
      user.tenantId,
      updateScheduleDto,
    );
  }

  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Soft-delete a schedule and stop its timer' })
  remove(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseIdPipe) id: string,
  ) {
    return this.schedulesService.remove(id, user.id, user.tenantId);
  }

  @Post(':id/toggle')
  @ApiOperation({ summary: 'Enable/disable a schedule' })
  toggle(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseIdPipe) id: string,
  ) {
    return this.schedulesService.toggle(id, user.id, user.tenantId);
  }

  @Post(':id/run')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Run a schedule immediately',
    description:
      'Works on disabled schedules too, so a schedule can be tested before it is armed. Does not shift the automatic cadence.',
  })
  run(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseIdPipe) id: string,
  ) {
    return this.schedulesService.run(id, user.id, user.tenantId);
  }

  /** @deprecated Alias for `POST :id/run`. */
  @Post(':id/execute')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'DEPRECATED — use POST /schedules/:id/run',
    deprecated: true,
  })
  execute(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseIdPipe) id: string,
  ) {
    return this.schedulesService.run(id, user.id, user.tenantId);
  }
}
