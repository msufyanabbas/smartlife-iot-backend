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
import { FloorPlansService, Actor } from './floor-plans.service';
import {
  CreateFloorPlanDto,
  AddZoneDto,
  Building3DMetadataDto,
} from './dto/create-floor-plan.dto';
import { PlaceDeviceDto, UpdatePlacementDto } from './dto/place-device.dto';
import { GenerateModelDto } from './dto/generate-model.dto';
import { UpdateFloorPlanDto } from './dto/update-floor-plan.dto';
import { UpdateFloorPlanSettingsDto } from './dto/floor-plan-settings.dto';
import { FloorPlanQueryDto } from './dto/floor-plan-query.dto';
import { DEFAULT_STANDARD_FILTER } from './mesh/cad-standard.filter';
import { DisplayGeometryQueryDto } from './dto/display-geometry-query.dto';
import {
  CreateFloorPlanWidgetDto,
  ExecuteWidgetActionDto,
  ImportWidgetsFromDrawingDto,
  UpdateFloorPlanWidgetDto,
} from './dto/floor-plan-widget.dto';
import { FloorPlanWidgetsService } from './widgets/floor-plan-widgets.service';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { ParseIdPipe } from '../../common/pipes/parse-id.pipe';
import {
  AuditAction,
  AuditEntityType,
  AuditSeverity,
  UserRole,
} from '@common/enums/index.enum';
import { Roles } from '@common/decorators/roles.decorator';
import { Audit } from '@common/decorators/audit.decorator';
import { User } from '@modules/users/entities/user.entity';
import { RequirePermissions } from '@common/decorators/permission.decorator';

/** 50 MB cap on uploads — previously there was no limit at all. */
const MAX_UPLOAD_BYTES = 50 * 1024 * 1024;

@ApiTags('floor-plans')
@Controller('floor-plans')
@UseGuards(JwtAuthGuard)
@ApiBearerAuth()
export class FloorPlansController {
  constructor(
    private readonly floorPlansService: FloorPlansService,
    private readonly widgetsService: FloorPlanWidgetsService,
  ) {}

  private actor(userId: string, tenantId: string, role?: UserRole): Actor {
    return { userId, tenantId, role };
  }

  @Post()
  @RequirePermissions('floor_plans:create')
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
  @RequirePermissions('floor_plans:list')
  @ApiOperation({ summary: 'Get all floor plans' })
  @ApiResponse({ status: 200, description: 'List of floor plans' })
  findAll(
    @CurrentUser('tenantId') tenantId: string,
    @Query() query: FloorPlanQueryDto,
  ) {
    return this.floorPlansService.findAll(tenantId, query, query.assetId);
  }

  @Get('statistics')
  @RequirePermissions('floor_plans:list')
  @ApiOperation({ summary: 'Get floor plan statistics' })
  getStatistics(@CurrentUser('tenantId') tenantId: string) {
    return this.floorPlansService.getStatistics(tenantId);
  }

  @Get('asset/:assetId')
  @RequirePermissions('floor_plans:read')
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
  @RequirePermissions('floor_plans:read')
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
  @RequirePermissions('floor_plans:read')
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
  @RequirePermissions('floor_plans:read')
  @ApiOperation({ summary: 'Get parsed DWG geometry' })
  getParsedGeometry(
    @CurrentUser('tenantId') tenantId: string,
    @Param('id', ParseIdPipe) id: string,
  ) {
    return this.floorPlansService.getParsedGeometry(id, tenantId);
  }

  /**
   * Geometry ready to DRAW — the standard applied, walls paired, openings cut.
   *
   * `:id/geometry` above returns the parser's RAW output, which is every line
   * in the drawing offered as a wall candidate. That is the right answer for
   * the import wizard, which reports what is in the file, and the wrong one
   * for a 3D viewer, which was extruding the title block and the text.
   *
   * On declaration order: this does NOT need to precede the single-segment
   * id route, because `display-geometry` is a second path segment and a
   * one-segment pattern cannot match two. The ordering trap (§4o) applies to a
   * parameterised segment declared ABOVE a literal one at the same depth,
   * which is not the case here.
   *
   * (Deliberately phrased without quoting a route decorator: a grep for
   * declared routes picks up a decorator quoted in a comment and reports a
   * duplicate that does not exist — the §4p trap, which cost a few minutes
   * when this very file was audited.)
   */
  @Get(':id/display-geometry')
  @RequirePermissions('floor_plans:read')
  @ApiOperation({
    summary: 'Get draw-ready geometry: standard applied, walls paired, openings cut',
    description:
      'Every length is in METRES. Walls arrive already split into the solid pieces around ' +
      'their doors and windows, so a renderer draws plain boxes and the opening is real. ' +
      'Query flags turn individual transformations off for comparison: ' +
      'enforceStandard=false returns unfiltered geometry (the old viewer behaviour), ' +
      'pairWalls=false leaves each drawn face as its own wall, ' +
      'cutOpenings=false leaves walls whole, ' +
      'detectXVoids=false ignores the X convention.',
  })
  @ApiResponse({ status: 200, description: 'Draw-ready geometry plus what the standard excluded' })
  @ApiResponse({ status: 404, description: 'The plan has no parsed drawing yet' })
  getDisplayGeometry(
    @CurrentUser('tenantId') tenantId: string,
    @Param('id', ParseIdPipe) id: string,
    @Query() query: DisplayGeometryQueryDto,
  ) {
    return this.floorPlansService.getDisplayGeometry(id, tenantId, {
      enforceStandard: query.enforceStandard ?? true,
      // Merged into the standard options rather than replacing them: a bare
      // `{ keepUnrecognised }` would drop `enforce` and silently turn the
      // whole filter off, which is the opposite of a narrower setting.
      standard: {
        ...DEFAULT_STANDARD_FILTER,
        keepUnrecognised: query.keepUnrecognised ?? false,
      },
      pairWalls: query.pairWalls ?? true,
      cutOpenings: query.cutOpenings ?? true,
      detectXVoids: query.detectXVoids ?? true,
      ...(query.wallHeight !== undefined ? { wallHeight: query.wallHeight } : {}),
    });
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // CONTROL WIDGETS
  //
  // Lights, air conditioners, switches, sensors and scenes placed on the plan.
  // See `widgets/floor-plan-widgets.service.ts` for the three decisions behind
  // the design; the one that matters on this controller is that the ACTION
  // route names a widget and a stored action id, and carries no method, no
  // params and no device. Those come from the stored row, so this cannot be
  // used to send an arbitrary command to an arbitrary device (§4n).
  // ═══════════════════════════════════════════════════════════════════════════

  @Get(':id/widgets')
  @RequirePermissions('floor_plans:read')
  @Roles(
    UserRole.SUPER_ADMIN,
    UserRole.TENANT_ADMIN,
    UserRole.USER,
    UserRole.CUSTOMER,
    UserRole.CUSTOMER_USER,
  )
  @ApiOperation({
    summary: 'The control widgets on this floor plan',
    description:
      'Positions are in METRES in the drawing\'s own coordinates — the same space as ' +
      '`display-geometry`, so a widget lands where the drawing puts the fitting.',
  })
  listWidgets(
    @CurrentUser() user: User,
    @Param('id', ParseIdPipe) id: string,
  ) {
    return this.widgetsService.list(id, user);
  }

  @Get(':id/widgets/devices')
  @RequirePermissions('floor_plans:read')
  @Roles(
    UserRole.SUPER_ADMIN,
    UserRole.TENANT_ADMIN,
    UserRole.USER,
    UserRole.CUSTOMER,
    UserRole.CUSTOMER_USER,
  )
  @ApiOperation({
    summary: 'Every device the widgets on this plan read or command',
    description:
      'One call so a viewer can subscribe to the whole plan\'s telemetry at once, rather than ' +
      'a request per widget. Includes the devices named inside scene actions.',
  })
  widgetDeviceIds(
    @CurrentUser() user: User,
    @Param('id', ParseIdPipe) id: string,
  ) {
    return this.widgetsService.deviceIdsForPlan(id, user);
  }

  @Get('widgets/by-device/:deviceId')
  @RequirePermissions('floor_plans:read')
  @Roles(
    UserRole.SUPER_ADMIN,
    UserRole.TENANT_ADMIN,
    UserRole.USER,
    UserRole.CUSTOMER,
    UserRole.CUSTOMER_USER,
  )
  @ApiOperation({
    summary: 'Which floor-plan widgets read or command this device',
    description:
      'Answers "what breaks if I delete this device?". Deleting a device sets a widget\'s ' +
      'deviceId to NULL rather than removing the control, so a plan would otherwise ' +
      'accumulate dead switches with nothing pointing at them.\n\n' +
      'Includes widgets that reach the device only through a SCENE action, which a plain ' +
      'column match would miss.',
  })
  widgetsByDevice(
    @CurrentUser() user: User,
    @Param('deviceId', ParseIdPipe) deviceId: string,
  ) {
    return this.widgetsService.findByDevice(deviceId, user);
  }

  @Post(':id/widgets')
  @RequirePermissions('floor_plans:update')
  @Roles(UserRole.SUPER_ADMIN, UserRole.TENANT_ADMIN, UserRole.CUSTOMER)
  @Audit({
    action: AuditAction.CREATE,
    entityType: AuditEntityType.SETTINGS,
    description: 'Floor-plan control widget created',
  })
  @ApiOperation({ summary: 'Place a control widget on the plan' })
  createWidget(
    @CurrentUser() user: User,
    @Param('id', ParseIdPipe) id: string,
    @Body() dto: CreateFloorPlanWidgetDto,
  ) {
    return this.widgetsService.create(id, user, dto as any);
  }

  @Post(':id/widgets/import-from-drawing')
  @RequirePermissions('floor_plans:update')
  @Roles(UserRole.SUPER_ADMIN, UserRole.TENANT_ADMIN, UserRole.CUSTOMER)
  @HttpCode(HttpStatus.OK)
  @Audit({
    action: AuditAction.CREATE,
    entityType: AuditEntityType.SETTINGS,
    description: 'Floor-plan widgets imported from the drawing',
  })
  @ApiOperation({
    summary: 'Create widgets from the drawing\'s own equipment symbols',
    description:
      'The CAD standard already says where the equipment is: light fittings on E-LITE, HVAC ' +
      'on M-HVAC-EQPM, and the rest of the master template\'s section 9 legend. This places one ' +
      'widget per symbol, at the mounting height the standard gives for that layer, inside ' +
      'whichever zone contains it.\n\n' +
      'Widgets land UNBOUND and DISABLED: a drawing says where a light is, not which device ' +
      'controls it, and guessing that would wire a switch to the wrong lamp. Idempotent — ' +
      're-importing after the drawing changes adds what is new and leaves the rest alone.',
  })
  importWidgets(
    @CurrentUser() user: User,
    @Param('id', ParseIdPipe) id: string,
    @Body() dto: ImportWidgetsFromDrawingDto,
  ) {
    return this.widgetsService.importFromDrawing(id, user, { kinds: dto.kinds });
  }

  @Patch(':id/widgets/:widgetId')
  @RequirePermissions('floor_plans:update')
  @Roles(UserRole.SUPER_ADMIN, UserRole.TENANT_ADMIN, UserRole.CUSTOMER)
  @Audit({
    action: AuditAction.UPDATE,
    entityType: AuditEntityType.SETTINGS,
    description: 'Floor-plan control widget updated',
  })
  @ApiOperation({ summary: 'Update a control widget' })
  updateWidget(
    @CurrentUser() user: User,
    @Param('id', ParseIdPipe) id: string,
    @Param('widgetId', ParseIdPipe) widgetId: string,
    @Body() dto: UpdateFloorPlanWidgetDto,
  ) {
    return this.widgetsService.update(id, widgetId, user, dto as any);
  }

  @Delete(':id/widgets/:widgetId')
  @RequirePermissions('floor_plans:update')
  @Roles(UserRole.SUPER_ADMIN, UserRole.TENANT_ADMIN, UserRole.CUSTOMER)
  @HttpCode(HttpStatus.NO_CONTENT)
  @Audit({
    action: AuditAction.DELETE,
    entityType: AuditEntityType.SETTINGS,
    description: 'Floor-plan control widget removed',
  })
  @ApiOperation({ summary: 'Remove a control widget' })
  async removeWidget(
    @CurrentUser() user: User,
    @Param('id', ParseIdPipe) id: string,
    @Param('widgetId', ParseIdPipe) widgetId: string,
  ) {
    await this.widgetsService.remove(id, widgetId, user);
  }

  @Post(':id/widgets/:widgetId/action')
  // `devices:control` — the same permission the gateway's own command route
  // demands. A widget must not be a way around it.
  @RequirePermissions('devices:control')
  // CUSTOMER_USER is admitted deliberately: an operator is the person who
  // presses the switch, and refusing them their own HMI would make the
  // feature pointless. What protects the plant is that the command is fixed
  // by the stored widget, not that operators are locked out (§4n).
  @Roles(
    UserRole.SUPER_ADMIN,
    UserRole.TENANT_ADMIN,
    UserRole.CUSTOMER,
    UserRole.CUSTOMER_USER,
  )
  @HttpCode(HttpStatus.OK)
  @Audit({
    action: AuditAction.UPDATE,
    entityType: AuditEntityType.DEVICE,
    severity: AuditSeverity.WARNING,
    description: 'Floor-plan widget action executed',
  })
  @ApiOperation({
    summary: 'Press a widget\'s control',
    description:
      'Names the WIDGET and one of its STORED actions. The method, the parameters and the ' +
      'target device are read from the stored widget — this route accepts none of them, so it ' +
      'cannot be used to send an arbitrary command to an arbitrary device.',
  })
  @ApiResponse({ status: 200, description: 'Command dispatched' })
  @ApiResponse({ status: 400, description: 'Unknown action, disabled widget, or no gateway' })
  @ApiResponse({ status: 404, description: 'Plan, widget or device not in your scope' })
  executeWidgetAction(
    @CurrentUser() user: User,
    @Param('id', ParseIdPipe) id: string,
    @Param('widgetId', ParseIdPipe) widgetId: string,
    @Body() dto: ExecuteWidgetActionDto,
  ) {
    return this.widgetsService.executeAction(id, widgetId, dto.actionId, user, {
      waitForResponse: dto.waitForResponse,
    });
  }

  @Patch(':id')
  @RequirePermissions('floor_plans:update')
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
  @RequirePermissions('floor_plans:delete')
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
  @RequirePermissions('floor_plans:update')
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
  @RequirePermissions('floor_plans:update')
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

  @Post(':id/model/generate')
  @RequirePermissions('floor_plans:update')
  @ApiOperation({
    summary: 'Generate a 3D model from the parsed DWG/DXF geometry',
    description:
      'Extrudes the already-parsed floor plan geometry into a real 3D model: walls become ' +
      'solids with door and window openings cut out of them, rooms become floor slabs, ' +
      'columns and stairs become massing. Requires the plan to have been parsed already.',
  })
  @ApiParam({ name: 'id', type: 'string' })
  generateModel(
    @CurrentUser('id') userId: string,
    @CurrentUser('tenantId') tenantId: string,
    @Param('id', ParseIdPipe) id: string,
    @Body() dto: GenerateModelDto,
  ) {
    return this.floorPlansService.generateModel(
      id,
      this.actor(userId, tenantId),
      dto,
    );
  }

  @Post(':id/model/preview')
  @RequirePermissions('floor_plans:update')
  @HttpCode(200)
  @ApiOperation({
    summary: 'Preview what a generated model would contain',
    description:
      'Runs the same build as /model/generate but writes nothing. Use it to check triangle ' +
      'counts and warnings — particularly openings that matched no wall — before committing.',
  })
  @ApiParam({ name: 'id', type: 'string' })
  previewModel(
    @CurrentUser('tenantId') tenantId: string,
    @Param('id', ParseIdPipe) id: string,
    @Body() dto: GenerateModelDto,
  ) {
    return this.floorPlansService.previewModel(id, tenantId, dto);
  }

  @Get(':id/model')
  @RequirePermissions('floor_plans:read')
  @ApiOperation({
    summary: 'Download the floor plan 3D model file',
    description:
      'Served through StorageService, so it works on any replica. It used to ' +
      'stream from an absolute path rebuilt on the fly, which only the replica ' +
      'that handled the upload could open.',
  })
  async getModel(
    @CurrentUser('tenantId') tenantId: string,
    @Param('id', ParseIdPipe) id: string,
    @Res() res: Response,
  ) {
    const { buffer, contentType, fileName } =
      await this.floorPlansService.getModelFile(id, tenantId);

    this.sendFile(res, buffer, contentType, fileName);
  }

  @Get(':id/dwg')
  @RequirePermissions('floor_plans:read')
  @ApiOperation({
    summary: 'Download the uploaded DWG/DXF source drawing',
    description:
      'The driver-independent read path for the source file. The static ' +
      '/uploads mount serves the same bytes only while the storage driver is ' +
      'local and only on the replica that received the upload.',
  })
  async getDwg(
    @CurrentUser('tenantId') tenantId: string,
    @Param('id', ParseIdPipe) id: string,
    @Res() res: Response,
  ) {
    const { buffer, contentType, fileName } =
      await this.floorPlansService.getDwgFile(id, tenantId);

    this.sendFile(res, buffer, contentType, fileName);
  }

  @Get(':id/preview')
  @RequirePermissions('floor_plans:read')
  @ApiOperation({
    summary: 'Fetch the generated PNG preview of the floor plan',
    description:
      'Rendered from the parsed geometry after a DWG/DXF upload. Sent inline ' +
      'so it can be used directly as an <img> source.',
  })
  async getPreview(
    @CurrentUser('tenantId') tenantId: string,
    @Param('id', ParseIdPipe) id: string,
    @Res() res: Response,
  ) {
    const { buffer, contentType, fileName } =
      await this.floorPlansService.getPreviewFile(id, tenantId);

    this.sendFile(res, buffer, contentType, fileName, 'inline');
  }

  /**
   * One place that writes the bytes out.
   *
   * `@Res()` bypasses the global TransformInterceptor, which is the point — it
   * would otherwise wrap the body in the standard envelope. Content-Length is
   * set explicitly because the buffer is already in memory, so the response is
   * not chunked and a client can show real progress.
   */
  private sendFile(
    res: Response,
    buffer: Buffer,
    contentType: string,
    fileName: string,
    disposition: 'attachment' | 'inline' = 'attachment',
  ): void {
    res.setHeader('Content-Type', contentType);
    res.setHeader('Content-Length', buffer.length);
    res.setHeader(
      'Content-Disposition',
      `${disposition}; filename="${fileName}"`,
    );
    res.end(buffer);
  }

  // ============ DEVICE PLACEMENT ============

  @Get(':id/devices')
  @RequirePermissions('floor_plans:read')
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
  @RequirePermissions('floor_plans:read')
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
  @RequirePermissions('floor_plans:update')
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
  @RequirePermissions('floor_plans:update')
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
  @RequirePermissions('floor_plans:update')
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
  @RequirePermissions('floor_plans:update')
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
  @RequirePermissions('floor_plans:update')
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

  @Post(':id/clone')
  @RequirePermissions('floor_plans:update')
  @ApiOperation({
    summary: 'Duplicate a floor plan',
    description:
      'Copies geometry, zones, settings and 3D metadata under a new name. Device ' +
      'placements are deliberately NOT copied — a device is in one physical place, ' +
      'and duplicating placements would claim the same hardware sits on two floors. ' +
      'If the source floor is already taken the copy is created without a floor ' +
      'assigned, since a floor holds one plan.',
  })
  @ApiParam({ name: 'id', type: 'string' })
  clone(
    @CurrentUser('id') userId: string,
    @CurrentUser('tenantId') tenantId: string,
    @Param('id', ParseIdPipe) id: string,
    @Body() body: { name?: string; newName?: string },
  ) {
    return this.floorPlansService.clone(
      id,
      this.actor(userId, tenantId),
      body?.newName ?? body?.name ?? '',
    );
  }

  @Get(':id/zones')
  @RequirePermissions('floor_plans:read')
  @ApiOperation({
    summary: 'List the zones of a floor plan',
    description:
      'Zones are stored on the floor plan row, so this is a lightweight projection — ' +
      'it avoids pulling the whole plan (including parsed geometry, which can be ' +
      'megabytes) just to read the zone list back.',
  })
  @ApiParam({ name: 'id', type: 'string' })
  getZones(
    @CurrentUser('tenantId') tenantId: string,
    @Param('id', ParseIdPipe) id: string,
  ) {
    return this.floorPlansService.getZones(id, tenantId);
  }

  @Post(':id/zones')
  @RequirePermissions('floor_plans:update')
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
  @RequirePermissions('floor_plans:update')
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
  @RequirePermissions('floor_plans:update')
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
  @RequirePermissions('floor_plans:update')
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
  @RequirePermissions('floor_plans:read')
  @ApiOperation({ summary: 'Get floor plan settings' })
  getSettings(
    @CurrentUser('tenantId') tenantId: string,
    @Param('id', ParseIdPipe) id: string,
  ) {
    return this.floorPlansService.getSettings(id, tenantId);
  }

  @Patch(':id/settings')
  @RequirePermissions('floor_plans:update')
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
  @RequirePermissions('floor_plans:update')
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
