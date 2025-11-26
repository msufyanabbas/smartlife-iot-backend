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
} from './dto/alarm.dto';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { User } from '../users/entities/user.entity';
import { ParseIdPipe } from '../../common/pipes/parse-id.pipe';

@ApiTags('alarms')
@Controller('alarms')
@UseGuards(JwtAuthGuard)
@ApiBearerAuth()
export class AlarmsController {
  constructor(private readonly alarmsService: AlarmsService) {}

  @Post()
  @ApiOperation({ summary: 'Create new alarm rule' })
  @ApiResponse({ status: 201, description: 'Alarm rule created successfully' })
  create(@CurrentUser() user: User, @Body() createDto: CreateAlarmDto) {
    return this.alarmsService.create(user.id, createDto);
  }

  @Get()
  @ApiOperation({ summary: 'Get all alarm rules' })
  @ApiResponse({ status: 200, description: 'List of alarm rules' })
  findAll(@CurrentUser() user: User, @Query() query: AlarmQueryDto) {
    return this.alarmsService.findAll(user.id, query);
  }

  @Get('active')
  @ApiOperation({ summary: 'Get active alarms' })
  @ApiResponse({ status: 200, description: 'List of active alarms' })
  getActive(@CurrentUser() user: User) {
    return this.alarmsService.getActive(user.id);
  }

  @Get('statistics')
  @ApiOperation({ summary: 'Get alarm statistics' })
  @ApiResponse({ status: 200, description: 'Alarm statistics' })
  getStatistics(@CurrentUser() user: User) {
    return this.alarmsService.getStatistics(user.id);
  }

  @Get('device/:deviceId/history')
  @ApiOperation({ summary: 'Get alarm history for device' })
  @ApiResponse({ status: 200, description: 'Alarm history' })
  getDeviceHistory(
    @CurrentUser() user: User,
    @Param('deviceId', ParseIdPipe) deviceId: string,
    @Query('days') days?: number,
  ) {
    return this.alarmsService.getDeviceHistory(
      user.id,
      deviceId,
      days ? parseInt(days.toString()) : 7,
    );
  }

  @Get(':id')
  @ApiOperation({ summary: 'Get alarm by ID' })
  @ApiResponse({ status: 200, description: 'Alarm found' })
  @ApiResponse({ status: 404, description: 'Alarm not found' })
  findOne(@Param('id', ParseIdPipe) id: string, @CurrentUser() user: User) {
    return this.alarmsService.findOne(id, user.id);
  }

  @Patch(':id')
  @ApiOperation({ summary: 'Update alarm rule' })
  @ApiResponse({ status: 200, description: 'Alarm updated' })
  update(
    @Param('id', ParseIdPipe) id: string,
    @CurrentUser() user: User,
    @Body() updateDto: UpdateAlarmDto,
  ) {
    return this.alarmsService.update(id, user.id, updateDto);
  }

  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Delete alarm rule' })
  @ApiResponse({ status: 204, description: 'Alarm deleted' })
  remove(@Param('id', ParseIdPipe) id: string, @CurrentUser() user: User) {
    return this.alarmsService.remove(id, user.id);
  }

  @Post(':id/acknowledge')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Acknowledge alarm' })
  @ApiResponse({ status: 200, description: 'Alarm acknowledged' })
  acknowledge(
    @Param('id', ParseIdPipe) id: string,
    @CurrentUser() user: User,
    @Body() acknowledgeDto?: AcknowledgeAlarmDto,
  ) {
    return this.alarmsService.acknowledge(id, user.id, acknowledgeDto);
  }

  @Post(':id/clear')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Clear alarm' })
  @ApiResponse({ status: 200, description: 'Alarm cleared' })
  clear(@Param('id', ParseIdPipe) id: string, @CurrentUser() user: User) {
    return this.alarmsService.clear(id, user.id);
  }

  @Post(':id/resolve')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Resolve alarm' })
  @ApiResponse({ status: 200, description: 'Alarm resolved' })
  resolve(
    @Param('id', ParseIdPipe) id: string,
    @CurrentUser() user: User,
    @Body() resolveDto: ResolveAlarmDto,
  ) {
    return this.alarmsService.resolve(id, user.id, resolveDto);
  }

  @Post(':id/enable')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Enable alarm rule' })
  @ApiResponse({ status: 200, description: 'Alarm enabled' })
  enable(@Param('id', ParseIdPipe) id: string, @CurrentUser() user: User) {
    return this.alarmsService.enable(id, user.id);
  }

  @Post(':id/disable')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Disable alarm rule' })
  @ApiResponse({ status: 200, description: 'Alarm disabled' })
  disable(@Param('id', ParseIdPipe) id: string, @CurrentUser() user: User) {
    return this.alarmsService.disable(id, user.id);
  }

  @Post(':id/test')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Test alarm rule with a value' })
  @ApiResponse({ status: 200, description: 'Test result' })
  test(
    @Param('id', ParseIdPipe) id: string,
    @CurrentUser() user: User,
    @Body() body: { value: number },
  ) {
    return this.alarmsService.testAlarm(id, user.id, body.value);
  }

  @Post('bulk/acknowledge')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Bulk acknowledge alarms' })
  @ApiResponse({ status: 200, description: 'Alarms acknowledged' })
  bulkAcknowledge(
    @CurrentUser() user: User,
    @Body() body: { alarmIds: string[] },
  ) {
    return this.alarmsService.bulkAcknowledge(user.id, body.alarmIds);
  }

  @Post('bulk/resolve')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Bulk resolve alarms' })
  @ApiResponse({ status: 200, description: 'Alarms resolved' })
  bulkResolve(
    @CurrentUser() user: User,
    @Body() body: { alarmIds: string[]; note: string },
  ) {
    return this.alarmsService.bulkResolve(user.id, body.alarmIds, body.note);
  }
}
