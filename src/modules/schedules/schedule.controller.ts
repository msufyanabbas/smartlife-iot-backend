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
import { SchedulesService } from './schedule.service';
import { CreateScheduleDto } from './dto/create-schedule.dto';
import { UpdateScheduleDto } from './dto/update-schedule.dto';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { User } from '../users/entities/user.entity';
import { PaginationDto } from '../../common/dto/pagination.dto';
import { ParseIdPipe } from '../../common/pipes/parse-id.pipe';

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
    @CurrentUser() user: User,
    @Body() createScheduleDto: CreateScheduleDto,
  ) {
    return this.schedulesService.create(user.id, createScheduleDto);
  }

  @Get()
  @ApiOperation({ summary: 'Get all schedules' })
  @ApiResponse({ status: 200, description: 'List of schedules' })
  findAll(@CurrentUser() user: User, @Query() paginationDto: PaginationDto) {
    return this.schedulesService.findAll(user.id, paginationDto);
  }

  @Get('statistics')
  @ApiOperation({ summary: 'Get schedule statistics' })
  getStatistics(@CurrentUser() user: User) {
    return this.schedulesService.getStatistics(user.id);
  }

  @Get(':id')
  @ApiOperation({ summary: 'Get schedule by ID' })
  findOne(@CurrentUser() user: User, @Param('id', ParseIdPipe) id: string) {
    return this.schedulesService.findOne(id, user.id);
  }

  @Get(':id/history')
  @ApiOperation({ summary: 'Get schedule execution history' })
  getHistory(
    @CurrentUser() user: User,
    @Param('id', ParseIdPipe) id: string,
    @Query('limit') limit?: number,
  ) {
    return this.schedulesService.getHistory(id, user.id, limit);
  }

  @Patch(':id')
  @ApiOperation({ summary: 'Update schedule' })
  update(
    @CurrentUser() user: User,
    @Param('id', ParseIdPipe) id: string,
    @Body() updateScheduleDto: UpdateScheduleDto,
  ) {
    return this.schedulesService.update(id, user.id, updateScheduleDto);
  }

  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Delete schedule' })
  remove(@CurrentUser() user: User, @Param('id', ParseIdPipe) id: string) {
    return this.schedulesService.remove(id, user.id);
  }

  @Post(':id/toggle')
  @ApiOperation({ summary: 'Toggle schedule status' })
  toggle(@CurrentUser() user: User, @Param('id', ParseIdPipe) id: string) {
    return this.schedulesService.toggle(id, user.id);
  }

  @Post(':id/execute')
  @ApiOperation({ summary: 'Execute schedule immediately' })
  execute(@CurrentUser() user: User, @Param('id', ParseIdPipe) id: string) {
    return this.schedulesService.execute(id, user.id);
  }
}
