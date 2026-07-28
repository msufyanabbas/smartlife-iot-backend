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
  Res,
} from '@nestjs/common';
import {
  ApiTags,
  ApiOperation,
  ApiResponse,
  ApiBearerAuth,
  ApiBody,
  ApiConsumes,
  ApiExtraModels,
  ApiParam,
  ApiQuery,
  getSchemaPath,
} from '@nestjs/swagger';
import { FileInterceptor } from '@nestjs/platform-express';
import type { File as MulterFile } from 'multer';
import type { Response } from 'express';
import { createReadStream } from 'fs';
import { FloorPlansService, Actor } from './floor-plans.service';
import {
  CreateFloorPlanDto,
  AddZoneDto,
  Building3DMetadataDto,
} from './dto/create-floor-plan.dto';
import { PlaceDeviceDto, UpdatePlacementDto } from './dto/place-device.dto';
import { UpdateFloorPlanDto } from './dto/update-floor-plan.dto';
import { UpdateFloorPlanSettingsDto } from './dto/floor-plan-settings.dto';
import { FloorPlanQueryDto } from './dto/floor-plan-query.dto';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { ParseIdPipe } from '../../common/pipes/parse-id.pipe';
import { UserRole } from '@common/enums/index.enum';

/** 50 MB cap on uploads — previously there was no limit at all. */
const MAX_UPLOAD_BYTES = 50 * 1024 * 1024;

@ApiTags('floor-plans')
@Controller('floor-plans')
@UseGuards(JwtAuthGuard)
@ApiBearerAuth()
export class FloorPlansController {
  constructor(private readonly floorPlansService: FloorPlansService) {}

  private actor(userId: string, tenantId: string, role?: UserRole): Actor {
    return { userId, tenantId, role };
  }

  @Post()
  @ApiOperation({
    summary: 'Create a new floor plan',
    description:
      'floorNumber is required when the asset is multi-floor (configuration.totalFloors > 1) ' +
      'and must be one of the floors declared in configuration.floorsData. ' +
      'One floor plan per floor per asset. Subject to the plan\'s maxFloorPlans limit.',
  })
  @ApiResponse({ status: 201, description: 'Floor plan created successfully' })
  @ApiResponse({ status: 400, description: 'Missing or invalid floorNumber' })
  @ApiResponse({ status: 403, description: 'Subscription floor plan limit reached' })
  @ApiResponse({ status: 409, description: 'That floor already has a plan' })
  // Accepts JSON *or* multipart/form-data with an optional `file` (DWG/DXF).
  // Without FileInterceptor multer never runs, so a multipart request reaches the
  // ValidationPipe with an empty body — that is where "name must be a string"
  // came from, not from the pipe failing to coerce the strings.
  @ApiConsumes('application/json', 'multipart/form-data')
  @ApiExtraModels(CreateFloorPlanDto)
  @ApiBody({
    schema: {
      allOf: [
        { $ref: getSchemaPath(CreateFloorPlanDto) },
        {
          type: 'object',
          properties: {
            file: {
              type: 'string',
              format: 'binary',
              description:
                'Optional DWG/DXF uploaded in the same request. Equivalent to ' +
                'calling POST /floor-plans/:id/dwg-upload afterwards.',
            },
          },
        },
      ],
    },
  })
  @UseInterceptors(
    FileInterceptor('file', { limits: { fileSize: MAX_UPLOAD_BYTES } }),
  )
  create(
    @CurrentUser('id') userId: string,
    @CurrentUser('tenantId') tenantId: string,
    @CurrentUser('role') role: UserRole,
    @Body() createFloorPlanDto: CreateFloorPlanDto,
    @UploadedFile() file?: MulterFile,
  ) {
    return this.floorPlansService.create(
      this.actor(userId, tenantId, role),
      createFloorPlanDto,
      file,
    );
  }

  @Get()
  @ApiOperation({ summary: 'Get all floor plans' })
  @ApiResponse({ status: 200, description: 'List of floor plans' })
  findAll(
    @CurrentUser('tenantId') tenantId: string,
    @Query() query: FloorPlanQueryDto,
  ) {
    return this.floorPlansService.findAll(tenantId, query, query.assetId);
  }

  @Get('statistics')
  @ApiOperation({ summary: 'Get floor plan statistics' })
  getStatistics(@CurrentUser('tenantId') tenantId: string) {
    return this.floorPlansService.getStatistics(tenantId);
  }

  @Get('asset/:assetId')
  @ApiOperation({
    summary: 'Get all floor plans for an asset, ordered by floor number',
    description:
      'Returns one entry per floor plan with its device count, whether a DXF has been ' +
      'uploaded (hasDxf) and a parsed-geometry summary (room/wall/door/window counts and area).',
  })
  @ApiParam({ name: 'assetId', type: 'string' })
  findByAsset(
    @CurrentUser('tenantId') tenantId: string,
    @Param('assetId') assetId: string,
  ) {
    return this.floorPlansService.getAssetFloorPlansOverview(assetId, tenantId);
  }

  @Get('asset/:assetId/3d-simulation')
  @ApiOperation({
    summary: 'Get 3D simulation data for entire building',
    description:
      'Returns complete 3D data including all floors, placed devices and animations for frontend rendering',
  })
  @ApiParam({ name: 'assetId', type: 'string' })
  get3DSimulationData(
    @CurrentUser('tenantId') tenantId: string,
    @Param('assetId') assetId: string,
  ) {
    return this.floorPlansService.get3DSimulationData(assetId, tenantId);
  }

  @Get(':id')
  @ApiOperation({
    summary: 'Get floor plan by ID',
    description:
      'Returns the floor plan with its linked asset, placed devices (incl. latest telemetry and active alarms), device count and preview URL.',
  })
  findOne(
    @CurrentUser('tenantId') tenantId: string,
    @Param('id', ParseIdPipe) id: string,
  ) {
    return this.floorPlansService.findOneEnriched(id, tenantId);
  }

  @Get(':id/geometry')
  @ApiOperation({ summary: 'Get parsed DWG geometry' })
  getParsedGeometry(
    @CurrentUser('tenantId') tenantId: string,
    @Param('id', ParseIdPipe) id: string,
  ) {
    return this.floorPlansService.getParsedGeometry(id, tenantId);
  }

  @Patch(':id')
  @ApiOperation({ summary: 'Update floor plan' })
  update(
    @CurrentUser('id') userId: string,
    @CurrentUser('tenantId') tenantId: string,
    @Param('id', ParseIdPipe) id: string,
    @Body() updateFloorPlanDto: UpdateFloorPlanDto,
  ) {
    return this.floorPlansService.update(
      id,
      this.actor(userId, tenantId),
      updateFloorPlanDto,
    );
  }

  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Delete floor plan' })
  remove(
    @CurrentUser('id') userId: string,
    @CurrentUser('tenantId') tenantId: string,
    @Param('id', ParseIdPipe) id: string,
  ) {
    return this.floorPlansService.remove(id, this.actor(userId, tenantId));
  }

  // ============ DWG FILE UPLOAD ============

  @Post(':id/dwg-upload')
  @ApiOperation({
    summary: 'Upload DWG/DXF file for floor plan',
    description:
      'Upload and parse a DWG or DXF file. Parsing happens asynchronously.',
  })
  @ApiConsumes('multipart/form-data')
  @UseInterceptors(
    FileInterceptor('file', { limits: { fileSize: MAX_UPLOAD_BYTES } }),
  )
  uploadDWG(
    @CurrentUser('id') userId: string,
    @CurrentUser('tenantId') tenantId: string,
    @Param('id', ParseIdPipe) id: string,
    @UploadedFile() file: MulterFile,
  ) {
    if (!file) {
      throw new BadRequestException('No file uploaded');
    }
    return this.floorPlansService.uploadDWGFile(
      id,
      this.actor(userId, tenantId),
      file,
    );
  }

  // ============ 3D MODEL FILE ============

  @Post(':id/model')
  @ApiOperation({
    summary: 'Upload a 3D model for the floor plan',
    description: 'Accepts .obj, .gltf, .glb or .fbx',
  })
  @ApiConsumes('multipart/form-data')
  @UseInterceptors(
    FileInterceptor('file', { limits: { fileSize: MAX_UPLOAD_BYTES } }),
  )
  uploadModel(
    @CurrentUser('id') userId: string,
    @CurrentUser('tenantId') tenantId: string,
    @Param('id', ParseIdPipe) id: string,
    @UploadedFile() file: MulterFile,
  ) {
    if (!file) {
      throw new BadRequestException('No file uploaded');
    }
    return this.floorPlansService.uploadModel(
      id,
      this.actor(userId, tenantId),
      file,
    );
  }

  @Get(':id/model')
  @ApiOperation({ summary: 'Download the floor plan 3D model file' })
  async getModel(
    @CurrentUser('tenantId') tenantId: string,
    @Param('id', ParseIdPipe) id: string,
    @Res() res: Response,
  ) {
    const {
      path: filePath,
      contentType,
      fileName,
    } = await this.floorPlansService.getModelFile(id, tenantId);

    // @Res() bypasses the global TransformInterceptor so the raw bytes are sent.
    res.setHeader('Content-Type', contentType);
    res.setHeader('Content-Disposition', `attachment; filename="${fileName}"`);
    createReadStream(filePath).pipe(res);
  }

  // ============ DEVICE PLACEMENT ============

  @Get(':id/devices')
  @ApiOperation({
    summary: 'Get devices placed on this floor plan',
    description:
      'Returns each placement with device info, latest telemetry values and active alarm count.',
  })
  getPlacedDevices(
    @CurrentUser('tenantId') tenantId: string,
    @Param('id', ParseIdPipe) id: string,
  ) {
    return this.floorPlansService
      .getPlacedDevices(id, tenantId)
      .then((rows) => rows.map(({ legacy, ...rest }) => rest));
  }

  @Get(':id/available-devices')
  @ApiOperation({
    summary: 'Device picker list for this floor plan',
    description:
      "Devices linked to this floor plan's asset, excluding any already placed on THIS plan. " +
      'Devices placed on another floor of the same asset are included with isAvailable: false ' +
      'and placedOnFloor set, so the picker can grey them out.',
  })
  getAvailableDevices(
    @CurrentUser('tenantId') tenantId: string,
    @Param('id', ParseIdPipe) id: string,
  ) {
    return this.floorPlansService.getAvailableDevices(id, tenantId);
  }

  @Post(':id/devices')
  @ApiOperation({
    summary: 'Place a device on the floor plan',
    description:
      'Body accepts { deviceId, x, y, z? } or the legacy { deviceId, position: {x,y,z} }. ' +
      'Re-placing an already-placed device updates its position instead of duplicating it. ' +
      "The device MUST be linked to the floor plan's asset — otherwise 400. " +
      "Use GET /floor-plans/:id/available-devices for the valid list. " +
      "New placements are subject to the plan's maxDevicesPerFloorPlan limit.",
  })
  @ApiResponse({ status: 201, description: 'Device placed' })
  @ApiResponse({ status: 400, description: 'Device is not linked to this floor plan\'s asset' })
  @ApiResponse({ status: 403, description: 'Subscription device-per-floor-plan limit reached' })
  addDevice(
    @CurrentUser('id') userId: string,
    @CurrentUser('tenantId') tenantId: string,
    @CurrentUser('role') role: UserRole,
    @Param('id', ParseIdPipe) id: string,
    @Body() deviceDto: PlaceDeviceDto,
  ) {
    return this.floorPlansService.placeDevice(
      id,
      this.actor(userId, tenantId, role),
      deviceDto,
    );
  }

  @Patch(':id/devices/:deviceId')
  @ApiOperation({ summary: 'Move / update a placed device' })
  updatePlacement(
    @CurrentUser('id') userId: string,
    @CurrentUser('tenantId') tenantId: string,
    @Param('id', ParseIdPipe) id: string,
    @Param('deviceId') deviceId: string,
    @Body() dto: UpdatePlacementDto,
  ) {
    return this.floorPlansService.updatePlacement(
      id,
      deviceId,
      this.actor(userId, tenantId),
      dto,
    );
  }

  @Delete(':id/devices/:deviceId')
  @ApiOperation({ summary: 'Remove device from floor plan' })
  removeDevice(
    @CurrentUser('id') userId: string,
    @CurrentUser('tenantId') tenantId: string,
    @Param('id', ParseIdPipe) id: string,
    @Param('deviceId') deviceId: string,
  ) {
    return this.floorPlansService.removePlacement(
      id,
      deviceId,
      this.actor(userId, tenantId),
    );
  }

  // ── Back-compat aliases for the original position/animation routes ────────

  @Patch(':id/devices/:deviceId/position')
  @ApiOperation({ summary: 'Update device 3D position (legacy alias)' })
  updateDevicePosition(
    @CurrentUser('id') userId: string,
    @CurrentUser('tenantId') tenantId: string,
    @Param('id', ParseIdPipe) id: string,
    @Param('deviceId') deviceId: string,
    @Body() dto: UpdatePlacementDto,
  ) {
    return this.floorPlansService.updatePlacement(
      id,
      deviceId,
      this.actor(userId, tenantId),
      dto,
    );
  }

  @Patch(':id/devices/:deviceId/animation')
  @ApiOperation({ summary: 'Update device animation settings (legacy alias)' })
  updateDeviceAnimation(
    @CurrentUser('id') userId: string,
    @CurrentUser('tenantId') tenantId: string,
    @Param('id', ParseIdPipe) id: string,
    @Param('deviceId') deviceId: string,
    @Body() dto: UpdatePlacementDto,
  ) {
    return this.floorPlansService.updatePlacement(
      id,
      deviceId,
      this.actor(userId, tenantId),
      dto,
    );
  }

  // ============ ZONE MANAGEMENT ============

  @Post(':id/zones')
  @ApiOperation({ summary: 'Add zone to floor plan' })
  addZone(
    @CurrentUser('id') userId: string,
    @CurrentUser('tenantId') tenantId: string,
    @Param('id', ParseIdPipe) id: string,
    @Body() zoneDto: AddZoneDto,
  ) {
    return this.floorPlansService.addZone(
      id,
      this.actor(userId, tenantId),
      zoneDto,
    );
  }

  @Patch(':id/zones/:zoneId')
  @ApiOperation({ summary: 'Update zone on floor plan' })
  updateZone(
    @CurrentUser('id') userId: string,
    @CurrentUser('tenantId') tenantId: string,
    @Param('id', ParseIdPipe) id: string,
    @Param('zoneId') zoneId: string,
    @Body() zoneDto: Partial<AddZoneDto>,
  ) {
    return this.floorPlansService.updateZone(
      id,
      zoneId,
      this.actor(userId, tenantId),
      zoneDto,
    );
  }

  @Delete(':id/zones/:zoneId')
  @ApiOperation({ summary: 'Remove zone from floor plan' })
  removeZone(
    @CurrentUser('id') userId: string,
    @CurrentUser('tenantId') tenantId: string,
    @Param('id', ParseIdPipe) id: string,
    @Param('zoneId') zoneId: string,
  ) {
    return this.floorPlansService.removeZone(
      id,
      zoneId,
      this.actor(userId, tenantId),
    );
  }

  // ============ BUILDING 3D METADATA ============

  @Patch(':id/building-3d-metadata')
  @ApiOperation({ summary: 'Update building 3D metadata' })
  updateBuilding3DMetadata(
    @CurrentUser('id') userId: string,
    @CurrentUser('tenantId') tenantId: string,
    @Param('id', ParseIdPipe) id: string,
    @Body() metadata: Building3DMetadataDto,
  ) {
    return this.floorPlansService.updateBuilding3DMetadata(
      id,
      this.actor(userId, tenantId),
      metadata,
    );
  }

  // ============ SETTINGS ============

  @Get(':id/settings')
  @ApiOperation({ summary: 'Get floor plan settings' })
  getSettings(
    @CurrentUser('tenantId') tenantId: string,
    @Param('id', ParseIdPipe) id: string,
  ) {
    return this.floorPlansService.getSettings(id, tenantId);
  }

  @Patch(':id/settings')
  @ApiOperation({ summary: 'Update floor plan settings' })
  updateSettings(
    @CurrentUser('id') userId: string,
    @CurrentUser('tenantId') tenantId: string,
    @Param('id', ParseIdPipe) id: string,
    @Body() settingsDto: UpdateFloorPlanSettingsDto,
  ) {
    return this.floorPlansService.updateSettings(
      id,
      this.actor(userId, tenantId),
      settingsDto,
    );
  }

  @Post(':id/settings/reset')
  @ApiOperation({ summary: 'Reset floor plan settings to default' })
  resetSettings(
    @CurrentUser('id') userId: string,
    @CurrentUser('tenantId') tenantId: string,
    @Param('id', ParseIdPipe) id: string,
  ) {
    return this.floorPlansService.resetSettings(
      id,
      this.actor(userId, tenantId),
    );
  }
}
