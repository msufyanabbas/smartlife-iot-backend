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
  Query,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import { Roles } from '@common/decorators/index.decorator';
import { RequirePermissions } from '@common/decorators/permission.decorator';
import { CurrentUser } from '@common/decorators/current-user.decorator';
import { UserRole } from '@common/enums/index.enum';
import { User } from '@modules/index.entities';
import { ModbusDevicesService } from './modbus-devices.service';
import {
  CreateModbusDeviceDto,
  ModbusDeviceQueryDto,
  SetModbusEnabledDto,
  UpdateModbusDeviceDto,
} from './dto/modbus-device.dto';

/**
 * Modbus TCP/RTU fleet management.
 *
 * ─── Authorization ────────────────────────────────────────────────────────
 * **Every handler carries `@Roles(...)`.** `RolesGuard` returns true for a
 * handler with no `@Roles` metadata, so an undecorated route here would let any
 * authenticated account — including a `CUSTOMER_USER` of another organisation —
 * read this tenant's industrial network topology (hosts, ports, unit ids) and
 * write registers to its PLCs (§4g).
 *
 * `SUPER_ADMIN` is listed explicitly because `RolesGuard` gives it no bypass,
 * and `CUSTOMER`/`CUSTOMER_USER` are deliberately absent: a register map is
 * control-plane configuration for physical plant, not a customer-facing
 * resource.
 */
@ApiTags('modbus')
@Controller('modbus/devices')
@ApiBearerAuth()
export class ModbusDevicesController {
  constructor(private readonly service: ModbusDevicesService) {}

  /**
   * A Modbus device row is tenant-scoped, and SUPER_ADMIN legitimately has no
   * tenant. Rather than widen every signature to `string | undefined` and let
   * a falsy tenant produce an unscoped query (§4g), the tenant-less caller is
   * refused here with an explanation.
   */
  private tenantOf(user: User): string {
    if (!user?.tenantId) {
      throw new BadRequestException(
        'Modbus devices belong to a tenant. Sign in as a tenant ' +
          'administrator, or select a tenant first.',
      );
    }
    return user.tenantId;
  }

  @Get('capabilities')
  @Roles(UserRole.SUPER_ADMIN, UserRole.TENANT_ADMIN)
  @RequirePermissions('integrations:read')
  @ApiOperation({
    summary: 'Register types, data types and defaults the poller supports',
    description: 'The manifest the register-map editor is generated from.',
  })
  @ApiResponse({ status: 200, description: 'Modbus capabilities' })
  capabilities() {
    return this.service.getCapabilities();
  }

  @Get('status')
  @Roles(UserRole.SUPER_ADMIN, UserRole.TENANT_ADMIN)
  @RequirePermissions('integrations:read')
  @ApiOperation({
    summary: 'Poller state merged with the stored configuration',
    description:
      'Says whether the adapter is running, which devices it is connected ' +
      'to, and what the last poll of each one did.',
  })
  @ApiResponse({ status: 200, description: 'Runtime status' })
  status(@CurrentUser() user: User) {
    return this.service.getStatus(this.tenantOf(user));
  }

  @Get()
  @Roles(UserRole.SUPER_ADMIN, UserRole.TENANT_ADMIN)
  @RequirePermissions('integrations:list')
  @ApiOperation({ summary: 'Modbus devices for this tenant' })
  @ApiResponse({ status: 200, description: 'Paginated Modbus devices' })
  findAll(@CurrentUser() user: User, @Query() query: ModbusDeviceQueryDto) {
    return this.service.findAll(this.tenantOf(user), {
      page: query.page,
      limit: query.limit,
      search: query.search,
      enabled:
        query.enabled === undefined ? undefined : query.enabled === 'true',
    });
  }

  @Get(':id')
  @Roles(UserRole.SUPER_ADMIN, UserRole.TENANT_ADMIN)
  @RequirePermissions('integrations:read')
  @ApiOperation({ summary: 'One Modbus device, with its register map' })
  @ApiResponse({ status: 200, description: 'Modbus device' })
  @ApiResponse({ status: 404, description: 'Not found in this tenant' })
  findOne(@CurrentUser() user: User, @Param('id', ParseUUIDPipe) id: string) {
    return this.service.findOne(id, this.tenantOf(user));
  }

  @Post()
  @Roles(UserRole.SUPER_ADMIN, UserRole.TENANT_ADMIN)
  @RequirePermissions('integrations:create')
  @ApiOperation({
    summary: 'Register a Modbus endpoint',
    description:
      'The poller picks it up immediately — no restart. `deviceId` must be a ' +
      "device in the caller's tenant; telemetry lands on that device.",
  })
  @ApiResponse({ status: 201, description: 'Created' })
  @ApiResponse({ status: 400, description: 'Invalid register map or settings' })
  create(@CurrentUser() user: User, @Body() dto: CreateModbusDeviceDto) {
    return this.service.create(this.tenantOf(user), dto as any);
  }

  @Put(':id')
  @Roles(UserRole.SUPER_ADMIN, UserRole.TENANT_ADMIN)
  @RequirePermissions('integrations:update')
  @ApiOperation({ summary: 'Update a Modbus endpoint or its register map' })
  @ApiResponse({ status: 200, description: 'Updated' })
  update(
    @CurrentUser() user: User,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateModbusDeviceDto,
  ) {
    return this.service.update(id, this.tenantOf(user), dto as any);
  }

  /** PATCH is an alias of the same handler, for clients that prefer it. */
  @Patch(':id')
  @Roles(UserRole.SUPER_ADMIN, UserRole.TENANT_ADMIN)
  @RequirePermissions('integrations:update')
  @ApiOperation({ summary: 'Update a Modbus endpoint (alias of PUT)' })
  @ApiResponse({ status: 200, description: 'Updated' })
  patch(
    @CurrentUser() user: User,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateModbusDeviceDto,
  ) {
    return this.service.update(id, this.tenantOf(user), dto as any);
  }

  @Patch(':id/enabled')
  @Roles(UserRole.SUPER_ADMIN, UserRole.TENANT_ADMIN)
  @RequirePermissions('integrations:update')
  @ApiOperation({ summary: 'Start or stop polling this device' })
  @ApiResponse({ status: 200, description: 'Updated' })
  setEnabled(
    @CurrentUser() user: User,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: SetModbusEnabledDto,
  ) {
    return this.service.setEnabled(id, this.tenantOf(user), dto.enabled);
  }

  @Post(':id/test-read')
  @HttpCode(HttpStatus.OK)
  @Roles(UserRole.SUPER_ADMIN, UserRole.TENANT_ADMIN)
  @RequirePermissions('integrations:update')
  @ApiOperation({
    summary: 'Read the mapped registers once, now',
    description:
      'Connects, reads every register and returns the values with their ' +
      'errors. Nothing is published as telemetry, so a test does not pollute ' +
      "the device's history.",
  })
  @ApiResponse({ status: 200, description: 'Per-register read results' })
  testRead(@CurrentUser() user: User, @Param('id', ParseUUIDPipe) id: string) {
    return this.service.testRead(id, this.tenantOf(user));
  }

  @Delete(':id')
  @HttpCode(HttpStatus.OK)
  @Roles(UserRole.SUPER_ADMIN, UserRole.TENANT_ADMIN)
  @RequirePermissions('integrations:delete')
  @ApiOperation({ summary: 'Remove a Modbus endpoint (soft delete)' })
  @ApiResponse({ status: 200, description: 'Removed' })
  @ApiResponse({ status: 404, description: 'Not found in this tenant' })
  remove(@CurrentUser() user: User, @Param('id', ParseUUIDPipe) id: string) {
    return this.service.remove(id, this.tenantOf(user));
  }
}
