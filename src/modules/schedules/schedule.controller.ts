// src/modules/schedules/schedule.controller.ts
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
import { SchedulesService } from './schedule.service';
import { CreateScheduleDto } from './dto/create-schedule.dto';
import { UpdateScheduleDto } from './dto/update-schedule.dto';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { PaginationDto } from '../../common/dto/pagination.dto';
import { ParseIdPipe } from '../../common/pipes/parse-id.pipe';

// Extend the User type to include tenantId from the JWT payload
interface AuthenticatedUser {
  id: string;
  tenantId: string;
}

@ApiTags('schedules')
@Controller('schedules')
@UseGuards(JwtAuthGuard)
@ApiBearerAuth()
export class SchedulesController {
  constructor(private readonly schedulesService: SchedulesService) {}

  @Post()
  @ApiOperation({ summary: 'Create a new schedule' })
  @ApiResponse({ status: 201, description: 'Schedule created successfully' })
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
  @ApiOperation({ summary: 'Get all schedules for the current user' })
  @ApiResponse({ status: 200, description: 'Paginated list of schedules' })
  findAll(
    @CurrentUser() user: AuthenticatedUser,
    @Query() paginationDto: PaginationDto,
  ) {
    return this.schedulesService.findAll(user.id, user.tenantId, paginationDto);
  }

  @Get('statistics')
  @ApiOperation({ summary: 'Get schedule statistics for the current user' })
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

  @Get(':id/history')
  @ApiOperation({ summary: 'Get paginated execution history for a schedule' })
  @ApiQuery({ name: 'page', required: false, type: Number })
  @ApiQuery({ name: 'limit', required: false, type: Number })
  getHistory(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseIdPipe) id: string,
    @Query('page') page?: number,
    @Query('limit') limit?: number,
  ) {
    return this.schedulesService.getHistory(id, user.id, user.tenantId, {
      page,
      limit,
    });
  }

  @Patch(':id')
  @ApiOperation({ summary: 'Update a schedule' })
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
  @ApiOperation({ summary: 'Soft-delete a schedule' })
  remove(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseIdPipe) id: string,
  ) {
    return this.schedulesService.remove(id, user.id, user.tenantId);
  }

  @Post(':id/toggle')
  @ApiOperation({ summary: 'Toggle schedule enabled/disabled' })
  toggle(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseIdPipe) id: string,
  ) {
    return this.schedulesService.toggle(id, user.id, user.tenantId);
  }

  @Post(':id/execute')
  @ApiOperation({ summary: 'Trigger a schedule to run immediately' })
  execute(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseIdPipe) id: string,
  ) {
    return this.schedulesService.execute(id, user.id, user.tenantId);
  }
}