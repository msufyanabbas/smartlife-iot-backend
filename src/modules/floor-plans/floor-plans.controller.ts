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
  UseInterceptors,
  UploadedFile,
  BadRequestException,
} from '@nestjs/common';
import {
  ApiTags,
  ApiOperation,
  ApiResponse,
  ApiBearerAuth,
  ApiConsumes,
  ApiParam,
} from '@nestjs/swagger';
import { FileInterceptor } from '@nestjs/platform-express';
import { FloorPlansService } from './floor-plans.service';
import {
  CreateFloorPlanDto,
  AddDeviceToFloorPlanDto,
  AddZoneDto,
  Building3DMetadataDto,
} from './dto/create-floor-plan.dto';
import { UpdateFloorPlanDto } from './dto/update-floor-plan.dto';
import { UpdateFloorPlanSettingsDto } from './dto/floor-plan-settings.dto';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { User } from '../users/entities/user.entity';
import { PaginationDto } from '../../common/dto/pagination.dto';
import { ParseIdPipe } from '../../common/pipes/parse-id.pipe';

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

  @Get('asset/:assetId')
  @ApiOperation({ summary: 'Get all floor plans for an asset' })
  @ApiResponse({ status: 200, description: 'Floor plans for the asset' })
  @ApiParam({ name: 'assetId', type: 'string' })
  findByAsset(
    @CurrentUser() user: User,
    @Param('assetId') assetId: string,
  ) {
    return this.floorPlansService.findByAsset(assetId, user.id);
  }

  @Get('asset/:assetId/3d-simulation')
  @ApiOperation({ 
    summary: 'Get 3D simulation data for entire building',
    description: 'Returns complete 3D data including all floors, devices, and animations for frontend rendering'
  })
  @ApiResponse({ status: 200, description: '3D simulation data' })
  @ApiParam({ name: 'assetId', type: 'string' })
  get3DSimulationData(
    @CurrentUser() user: User,
    @Param('assetId') assetId: string,
  ) {
    return this.floorPlansService.get3DSimulationData(assetId, user.id);
  }

  @Get(':id')
  @ApiOperation({ summary: 'Get floor plan by ID' })
  findOne(@CurrentUser() user: User, @Param('id', ParseIdPipe) id: string) {
    return this.floorPlansService.findOne(id, user.id);
  }

  @Get(':id/geometry')
  @ApiOperation({ 
    summary: 'Get parsed DWG geometry',
    description: 'Returns the parsed geometric data from DWG file for 3D rendering'
  })
  @ApiResponse({ status: 200, description: 'Parsed geometry data' })
  getParsedGeometry(
    @CurrentUser() user: User,
    @Param('id', ParseIdPipe) id: string,
  ) {
    return this.floorPlansService.getParsedGeometry(id, user.id);
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

  // ============ DWG FILE UPLOAD ============

  @Post(':id/dwg-upload')
  @ApiOperation({ 
    summary: 'Upload DWG file for floor plan',
    description: 'Upload and parse DWG file. The parsing happens asynchronously.'
  })
  @ApiConsumes('multipart/form-data')
  @ApiResponse({ status: 200, description: 'DWG file uploaded, parsing started' })
  @UseInterceptors(FileInterceptor('file'))
  uploadDWG(
    @CurrentUser() user: User,
    @Param('id', ParseIdPipe) id: string,
    @UploadedFile() file: Express.Multer.File,
  ) {
    if (!file) {
      throw new BadRequestException('No file uploaded');
    }
    return this.floorPlansService.uploadDWGFile(id, user.id, file);
  }

  // ============ DEVICE MANAGEMENT ============

  @Post(':id/devices')
  @ApiOperation({ summary: 'Add device to floor plan with 3D data' })
  @ApiResponse({ status: 201, description: 'Device added to floor plan' })
  addDevice(
    @CurrentUser() user: User,
    @Param('id', ParseIdPipe) id: string,
    @Body() deviceDto: AddDeviceToFloorPlanDto,
  ) {
    return this.floorPlansService.addDevice(id, user.id, deviceDto);
  }

  @Patch(':id/devices/:deviceId/position')
  @ApiOperation({ summary: 'Update device 3D position on floor plan' })
  updateDevicePosition(
    @CurrentUser() user: User,
    @Param('id', ParseIdPipe) id: string,
    @Param('deviceId') deviceId: string,
    @Body() body: { position: { x: number; y: number; z: number } },
  ) {
    return this.floorPlansService.updateDevicePosition(
      id,
      deviceId,
      user.id,
      body.position,
    );
  }

  @Patch(':id/devices/:deviceId/animation')
  @ApiOperation({ summary: 'Update device animation settings' })
  @ApiResponse({ status: 200, description: 'Device animation updated' })
  updateDeviceAnimation(
    @CurrentUser() user: User,
    @Param('id', ParseIdPipe) id: string,
    @Param('deviceId') deviceId: string,
    @Body() animationData: any,
  ) {
    return this.floorPlansService.updateDeviceAnimation(
      id,
      deviceId,
      user.id,
      animationData,
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

  // ============ ZONE MANAGEMENT ============

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

  // ============ BUILDING 3D METADATA ============

  @Patch(':id/building-3d-metadata')
  @ApiOperation({ 
    summary: 'Update building 3D metadata',
    description: 'Configure building-level 3D properties like floor height, exterior model, etc.'
  })
  @ApiResponse({ status: 200, description: 'Building metadata updated' })
  updateBuilding3DMetadata(
    @CurrentUser() user: User,
    @Param('id', ParseIdPipe) id: string,
    @Body() metadata: Building3DMetadataDto,
  ) {
    return this.floorPlansService.updateBuilding3DMetadata(id, user.id, metadata);
  }

  // ============ SETTINGS ============

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