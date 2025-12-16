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
import { FloorPlansService } from './floor-plans.service';
import {
  CreateFloorPlanDto,
  AddDeviceToFloorPlanDto,
  AddZoneDto,
} from './dto/create-floor-plan.dto';
import { UpdateFloorPlanDto } from './dto/update-floor-plan.dto';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { User } from '../users/entities/user.entity';
import { PaginationDto } from '../../common/dto/pagination.dto';
import { ParseIdPipe } from '../../common/pipes/parse-id.pipe';
import { UpdateFloorPlanSettingsDto } from './dto/floor-plan-settings.dto';

@ApiTags('floor-plans')
@Controller('floor-plans')
@UseGuards(JwtAuthGuard)
@ApiBearerAuth()
export class FloorPlansController {
  constructor(private readonly floorPlansService: FloorPlansService) {}

  @Post()
  @ApiOperation({ summary: 'Create a new floor plan' })
  @ApiResponse({ status: 201, description: 'Floor plan created successfully' })
  create(
    @CurrentUser() user: User,
    @Body() createFloorPlanDto: CreateFloorPlanDto,
  ) {
    return this.floorPlansService.create(user.id, createFloorPlanDto);
  }

  @Get()
  @ApiOperation({ summary: 'Get all floor plans' })
  @ApiResponse({ status: 200, description: 'List of floor plans' })
  findAll(@CurrentUser() user: User, @Query() paginationDto: PaginationDto) {
    return this.floorPlansService.findAll(user.id, paginationDto);
  }

  @Get('statistics')
  @ApiOperation({ summary: 'Get floor plan statistics' })
  getStatistics(@CurrentUser() user: User) {
    return this.floorPlansService.getStatistics(user.id);
  }

  @Get(':id')
  @ApiOperation({ summary: 'Get floor plan by ID' })
  findOne(@CurrentUser() user: User, @Param('id', ParseIdPipe) id: string) {
    return this.floorPlansService.findOne(id, user.id);
  }

  @Patch(':id')
  @ApiOperation({ summary: 'Update floor plan' })
  update(
    @CurrentUser() user: User,
    @Param('id', ParseIdPipe) id: string,
    @Body() updateFloorPlanDto: UpdateFloorPlanDto,
  ) {
    return this.floorPlansService.update(id, user.id, updateFloorPlanDto);
  }

  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Delete floor plan' })
  remove(@CurrentUser() user: User, @Param('id', ParseIdPipe) id: string) {
    return this.floorPlansService.remove(id, user.id);
  }

  @Post(':id/devices')
  @ApiOperation({ summary: 'Add device to floor plan' })
  addDevice(
    @CurrentUser() user: User,
    @Param('id', ParseIdPipe) id: string,
    @Body() deviceDto: AddDeviceToFloorPlanDto,
  ) {
    return this.floorPlansService.addDevice(id, user.id, deviceDto);
  }

  @Patch(':id/devices/:deviceId')
  @ApiOperation({ summary: 'Update device position on floor plan' })
  updateDevicePosition(
    @CurrentUser() user: User,
    @Param('id', ParseIdPipe) id: string,
    @Param('deviceId') deviceId: string,
    @Body() body: { position: { x: number; y: number } },
  ) {
    return this.floorPlansService.updateDevicePosition(
      id,
      deviceId,
      user.id,
      body.position,
    );
  }

  @Delete(':id/devices/:deviceId')
  @ApiOperation({ summary: 'Remove device from floor plan' })
  removeDevice(
    @CurrentUser() user: User,
    @Param('id', ParseIdPipe) id: string,
    @Param('deviceId') deviceId: string,
  ) {
    return this.floorPlansService.removeDevice(id, deviceId, user.id);
  }

  @Post(':id/zones')
  @ApiOperation({ summary: 'Add zone to floor plan' })
  addZone(
    @CurrentUser() user: User,
    @Param('id', ParseIdPipe) id: string,
    @Body() zoneDto: AddZoneDto,
  ) {
    return this.floorPlansService.addZone(id, user.id, zoneDto);
  }

  @Patch(':id/zones/:zoneId')
  @ApiOperation({ summary: 'Update zone on floor plan' })
  updateZone(
    @CurrentUser() user: User,
    @Param('id', ParseIdPipe) id: string,
    @Param('zoneId') zoneId: string,
    @Body() zoneDto: Partial<AddZoneDto>,
  ) {
    return this.floorPlansService.updateZone(id, zoneId, user.id, zoneDto);
  }

  @Delete(':id/zones/:zoneId')
  @ApiOperation({ summary: 'Remove zone from floor plan' })
  removeZone(
    @CurrentUser() user: User,
    @Param('id', ParseIdPipe) id: string,
    @Param('zoneId') zoneId: string,
  ) {
    return this.floorPlansService.removeZone(id, zoneId, user.id);
  }

  @Get(':id/settings')
  @ApiOperation({ summary: 'Get floor plan settings' })
  @ApiResponse({ status: 200, description: 'Floor plan settings retrieved' })
  getSettings(
    @CurrentUser() user: User,
    @Param('id', ParseIdPipe) id: string,
  ) {
    return this.floorPlansService.getSettings(id, user.id);
  }

  @Patch(':id/settings')
  @ApiOperation({ summary: 'Update floor plan settings' })
  @ApiResponse({ status: 200, description: 'Floor plan settings updated' })
  updateSettings(
    @CurrentUser() user: User,
    @Param('id', ParseIdPipe) id: string,
    @Body() settingsDto: UpdateFloorPlanSettingsDto,
  ) {
    return this.floorPlansService.updateSettings(id, user.id, settingsDto);
  }

  @Post(':id/settings/reset')
  @ApiOperation({ summary: 'Reset floor plan settings to default' })
  @ApiResponse({ status: 200, description: 'Floor plan settings reset to default' })
  resetSettings(
    @CurrentUser() user: User,
    @Param('id', ParseIdPipe) id: string,
  ) {
    return this.floorPlansService.resetSettings(id, user.id);
  }
}
