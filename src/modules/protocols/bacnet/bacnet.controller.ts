// src/modules/protocols/bacnet/bacnet.controller.ts
import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Put,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import { BacnetService } from './bacnet.service';
import {
  BACNET_OBJECT_TYPES,
  BACNET_PROPERTIES,
  BacnetDiscoverDto,
  CreateBacnetDeviceDto,
  UpdateBacnetDeviceDto,
} from './dto/bacnet-device.dto';
import { Roles } from '@common/decorators/roles.decorator';
import { CurrentUser } from '@common/decorators/current-user.decorator';
import { RequirePermissions } from '@common/decorators/permission.decorator';
import { UserRole } from '@common/enums/index.enum';
import { User } from '@modules/index.entities';

/**
 * ─────────────────────────────────────────────────────────────────────────────
 * BACnet/IP device management
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * EVERY handler carries `@Roles`, and `SUPER_ADMIN` is listed explicitly
 * because `RolesGuard` gives it no bypass. An undecorated handler would be open
 * to every authenticated account on the platform (CLAUDE.md §4g).
 */
@ApiTags('BACnet')
@Controller('bacnet')
@ApiBearerAuth()
export class BacnetController {
  constructor(private readonly service: BacnetService) {}

  private tenantOf(user: User): string {
    if (!user?.tenantId) {
      throw new BadRequestException(
        'BACnet devices belong to an organisation. Sign in as a tenant ' +
          'administrator, or select a tenant first.',
      );
    }
    return user.tenantId;
  }

  @Get('object-types')
  @Roles(UserRole.SUPER_ADMIN, UserRole.TENANT_ADMIN, UserRole.CUSTOMER)
  @ApiOperation({
    summary: 'Object types and properties this platform can read',
    description:
      'The mapping form is generated from this. Deliberately a short list: ' +
      'these cover essentially every point a BMS exposes for monitoring, while ' +
      'the remaining ~50 BACnet object types are schedules, trend logs and ' +
      'notification classes — configuration rather than telemetry.',
  })
  getObjectTypes() {
    return {
      objectTypes: BACNET_OBJECT_TYPES.map((value) => ({
        value,
        label: value,
        // Binary present values are an enumerated 0/1 meaning inactive/active,
        // so the form should default them to a boolean series.
        defaultDataType: value.startsWith('binary') ? 'boolean' : 'number',
      })),
      properties: BACNET_PROPERTIES.map((value) => ({ value, label: value })),
      defaultPort: 47808,
      maxDeviceInstance: 4_194_302,
    };
  }

  @Get('status')
  @Roles(UserRole.SUPER_ADMIN, UserRole.TENANT_ADMIN, UserRole.CUSTOMER)
  @RequirePermissions('devices:read')
  @ApiOperation({
    summary: 'Which of this organisation’s BACnet devices are being polled',
    description:
      'Also reports whether the adapter is switched on at all, since "no ' +
      'readings" with a disabled poller is otherwise indistinguishable from a ' +
      'network fault.',
  })
  getStatus(@CurrentUser() user: User) {
    return this.service.getStatus(this.tenantOf(user));
  }

  @Get()
  @Roles(UserRole.SUPER_ADMIN, UserRole.TENANT_ADMIN, UserRole.CUSTOMER)
  @RequirePermissions('devices:read')
  @ApiOperation({ summary: 'BACnet devices for this organisation' })
  findAll(@CurrentUser() user: User) {
    return this.service.findAll(this.tenantOf(user));
  }

  @Get(':id')
  @Roles(UserRole.SUPER_ADMIN, UserRole.TENANT_ADMIN)
  @RequirePermissions('devices:read')
  @ApiOperation({ summary: 'One BACnet device' })
  @ApiResponse({
    status: 404,
    description: 'Not found, or not in your organisation',
  })
  findOne(@CurrentUser() user: User, @Param('id', ParseUUIDPipe) id: string) {
    return this.service.findOne(id, this.tenantOf(user));
  }

  @Post()
  @Roles(UserRole.SUPER_ADMIN, UserRole.TENANT_ADMIN)
  @RequirePermissions('devices:create')
  @ApiOperation({ summary: 'Register a BACnet device' })
  @ApiResponse({ status: 201, description: 'Created' })
  create(@CurrentUser() user: User, @Body() dto: CreateBacnetDeviceDto) {
    return this.service.create(this.tenantOf(user), user.id, dto);
  }

  @Put(':id')
  @Roles(UserRole.SUPER_ADMIN, UserRole.TENANT_ADMIN)
  @RequirePermissions('devices:update')
  @ApiOperation({ summary: 'Update a BACnet device' })
  update(
    @CurrentUser() user: User,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateBacnetDeviceDto,
  ) {
    return this.service.update(id, this.tenantOf(user), user.id, dto);
  }

  // A separate method, not a second decorator on `update`: Nest's
  // RequestMapping overwrites the path/method metadata, so stacking @Put and
  // @Patch on one handler registers only one of them.
  @Patch(':id')
  @Roles(UserRole.SUPER_ADMIN, UserRole.TENANT_ADMIN)
  @RequirePermissions('devices:update')
  @ApiOperation({ summary: 'Update a BACnet device (alias of PUT)' })
  patch(
    @CurrentUser() user: User,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateBacnetDeviceDto,
  ) {
    return this.service.update(id, this.tenantOf(user), user.id, dto);
  }

  @Patch(':id/enabled')
  @Roles(UserRole.SUPER_ADMIN, UserRole.TENANT_ADMIN)
  @RequirePermissions('devices:update')
  @ApiOperation({ summary: 'Enable or disable polling of this device' })
  setEnabled(
    @CurrentUser() user: User,
    @Param('id', ParseUUIDPipe) id: string,
    @Body('enabled') enabled: boolean,
  ) {
    return this.service.setEnabled(id, this.tenantOf(user), enabled !== false);
  }

  @Delete(':id')
  @Roles(UserRole.SUPER_ADMIN, UserRole.TENANT_ADMIN)
  @RequirePermissions('devices:delete')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Delete a BACnet device' })
  async remove(
    @CurrentUser() user: User,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    await this.service.remove(id, this.tenantOf(user));
    return { success: true };
  }

  // ══════════════════════════════════════════════════════════════════════════
  // LIVE OPERATIONS
  // ══════════════════════════════════════════════════════════════════════════

  @Post('discover')
  @Roles(UserRole.SUPER_ADMIN, UserRole.TENANT_ADMIN)
  @RequirePermissions('devices:create')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Broadcast Who-Is and return the devices that answered',
    description:
      'BACnet addresses a device by its INSTANCE NUMBER — a 22-bit integer ' +
      'that is not on the nameplate, not derivable from the IP and not ' +
      'guessable. This route is how an operator gets it: each answer carries ' +
      'the address, the instance number and (unless `describe:false`) the ' +
      'controller’s own objectName, modelName and vendorName, plus ' +
      '`alreadyRegistered` so a device that is already configured is obvious.\n\n' +
      'Who-Is is a UDP broadcast and does not cross subnets: the platform has ' +
      'to be on the BACnet network, or reach it through a BBMD. Pass `address` ' +
      'to unicast one instead.',
  })
  @ApiResponse({
    status: 503,
    description:
      'The adapter is disabled (BACNET_ENABLED is not true), so no Who-Is can be sent',
  })
  discover(@CurrentUser() user: User, @Body() dto: BacnetDiscoverDto) {
    return this.service.discover(this.tenantOf(user), dto);
  }

  @Post(':id/test')
  @Roles(UserRole.SUPER_ADMIN, UserRole.TENANT_ADMIN)
  @RequirePermissions('devices:update')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Poll this controller now and report every object’s outcome',
    description:
      'Reads through the same code path the scheduler uses, so a pass means ' +
      'the poller will work. It DOES ingest — the reading goes through the ' +
      'unified telemetry path — because a test that discarded the values would ' +
      'not prove the part that matters. `failed[]` names every object the ' +
      'controller refused, and `method` says whether ReadPropertyMultiple was ' +
      'accepted or the single-read fallback was used.',
  })
  test(@CurrentUser() user: User, @Param('id', ParseUUIDPipe) id: string) {
    return this.service.testRead(id, this.tenantOf(user));
  }
}
