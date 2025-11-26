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
import { DevicesService } from './devices.service';
import { CreateDeviceDto } from './dto/create-device.dto';
import { UpdateDeviceDto } from './dto/update-device.dto';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { User } from '../users/entities/user.entity';
import { PaginationDto } from '../../common/dto/pagination.dto';
import { ParseIdPipe } from '../../common/pipes/parse-id.pipe';
import { DeviceStatus } from './entities/device.entity';

@ApiTags('devices')
@Controller('devices')
@UseGuards(JwtAuthGuard)
@ApiBearerAuth()
export class DevicesController {
  constructor(private readonly devicesService: DevicesService) {}

  @Post()
  @ApiOperation({ summary: 'Create a new device' })
  @ApiResponse({ status: 201, description: 'Device created successfully' })
  @ApiResponse({ status: 409, description: 'Device already exists' })
  create(@CurrentUser() user: User, @Body() createDeviceDto: CreateDeviceDto) {
    return this.devicesService.create(user.id, createDeviceDto);
  }

  @Get()
  @ApiOperation({ summary: 'Get all devices with pagination' })
  @ApiResponse({ status: 200, description: 'List of devices' })
  findAll(@CurrentUser() user: User, @Query() paginationDto: PaginationDto) {
    return this.devicesService.findAll(user.id, paginationDto);
  }

  @Get('statistics')
  @ApiOperation({ summary: 'Get device statistics' })
  @ApiResponse({ status: 200, description: 'Device statistics' })
  getStatistics(@CurrentUser() user: User) {
    return this.devicesService.getStatistics(user.id);
  }

  @Get(':id')
  @ApiOperation({ summary: 'Get device by ID' })
  @ApiResponse({ status: 200, description: 'Device found' })
  @ApiResponse({ status: 404, description: 'Device not found' })
  findOne(@CurrentUser() user: User, @Param('id', ParseIdPipe) id: string) {
    return this.devicesService.findOne(id, user.id);
  }

  @Patch(':id')
  @ApiOperation({ summary: 'Update device' })
  @ApiResponse({ status: 200, description: 'Device updated' })
  @ApiResponse({ status: 404, description: 'Device not found' })
  update(
    @CurrentUser() user: User,
    @Param('id', ParseIdPipe) id: string,
    @Body() updateDeviceDto: UpdateDeviceDto,
  ) {
    return this.devicesService.update(id, user.id, updateDeviceDto);
  }

  @Post(':id/activate')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Activate device' })
  @ApiResponse({ status: 200, description: 'Device activated' })
  @ApiResponse({ status: 400, description: 'Device already active' })
  activate(@CurrentUser() user: User, @Param('id', ParseIdPipe) id: string) {
    return this.devicesService.activate(id, user.id);
  }

  @Post(':id/deactivate')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Deactivate device' })
  @ApiResponse({ status: 200, description: 'Device deactivated' })
  deactivate(@CurrentUser() user: User, @Param('id', ParseIdPipe) id: string) {
    return this.devicesService.deactivate(id, user.id);
  }

  @Get(':id/credentials')
  @ApiOperation({ summary: 'Get device MQTT credentials' })
  @ApiResponse({
    status: 200,
    description:
      'Device credentials retrieved (includes MQTT broker config for gateways)',
  })
  @ApiResponse({ status: 404, description: 'Device not found' })
  getCredentials(
    @CurrentUser() user: User,
    @Param('id', ParseIdPipe) id: string,
  ) {
    return this.devicesService.getCredentials(id, user.id);
  }

  @Post(':id/regenerate-credentials')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Regenerate device credentials' })
  @ApiResponse({ status: 200, description: 'Credentials regenerated' })
  regenerateCredentials(
    @CurrentUser() user: User,
    @Param('id', ParseIdPipe) id: string,
  ) {
    return this.devicesService.regenerateCredentials(id, user.id);
  }

  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Delete device' })
  @ApiResponse({ status: 204, description: 'Device deleted' })
  @ApiResponse({ status: 404, description: 'Device not found' })
  remove(@CurrentUser() user: User, @Param('id', ParseIdPipe) id: string) {
    return this.devicesService.remove(id, user.id);
  }

  @Post('bulk/status')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Bulk update device status' })
  @ApiResponse({ status: 200, description: 'Devices updated' })
  bulkUpdateStatus(
    @CurrentUser() user: User,
    @Body() body: { deviceIds: string[]; status: DeviceStatus },
  ) {
    return this.devicesService.bulkUpdateStatus(
      body.deviceIds,
      user.id,
      body.status,
    );
  }
}
