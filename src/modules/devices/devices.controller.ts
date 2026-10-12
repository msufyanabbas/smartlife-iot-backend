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
  ForbiddenException,
} from '@nestjs/common';
import {
  ApiTags,
  ApiOperation,
  ApiResponse,
  ApiBearerAuth,
} from '@nestjs/swagger';
import { DevicesService } from './devices.service';
import { DeviceConnectivityService } from './device-connectivity.service';
import { CreateDeviceDto } from './dto/create-device.dto';
import { UpdateDeviceDto } from './dto/update-device.dto';
import { JwtAuthGuard } from '@common/guards/jwt-auth.guard';
import { CurrentUser, ResolvedCustomerId, ResolvedTenantId } from '@common/decorators/current-user.decorator';
import { User } from '@modules/users/entities/user.entity';
import { AuditAction, AuditEntityType, UserRole } from '@common/enums/index.enum';
import { PaginationDto } from '@common/dto/pagination.dto';
import { ParseIdPipe } from '@common/pipes/parse-id.pipe';
import { DeviceStatus } from '@common/enums/index.enum';
import { Roles } from '@common/decorators/roles.decorator';
import { RolesGuard, SubscriptionLimitGuard } from '@common/guards/index.guards';
import { RequireSubscriptionLimit } from '@common/decorators/subscription.decorator';
import { ResourceType } from '@common/guards/subscription-limit.guard';
import { SubscriptionsService } from '@modules/subscriptions/subscriptions.service';
import { CustomerAccessGuard } from '@common/guards/customer-access.guard';
import { Notify } from '@common/decorators/notify.decorator';
import { NotificationChannel, NotificationPriority, NotificationType } from '@common/enums/index.enum';
import { Audit } from '@common/decorators/audit.decorator';
import { CodecRegistryService } from './codecs/codec-registry.service';
import { SwaggerAuth, TenantOrCustomerAdmin } from '@/common/decorators/access-control.decorator';
import { Public } from '@common/decorators/public.decorator';
import { Throttle } from '@nestjs/throttler';
import {
  ProvisionDeviceDto,
  ProvisionDeviceResponseDto,
} from './dto/provision-device.dto';
import { DeviceCredentialsSummaryDto } from './dto/device-credentials-summary.dto';
import {
  BulkDeleteDevicesDto,
  BulkUpdateDevicesDto,
} from './dto/bulk-device.dto';
import { BulkResultDto } from '@common/dto/bulk-operation.dto';
// Device control endpoints (command, rpc, telemetry) live in GatewayController
// at POST /gateway/devices/:deviceKey/command|rpc|telemetry.
// Keeping them here would create a circular dependency:
//   DevicesController needs GatewayService
//   GatewayModule imports DevicesModule

@ApiTags('devices')
@Controller('devices')
@UseGuards(JwtAuthGuard, RolesGuard, SubscriptionLimitGuard)
@ApiBearerAuth()
export class DevicesController {
  constructor(
    private readonly devicesService: DevicesService,
    private readonly subscriptionsService: SubscriptionsService,
    private readonly codecRegistry: CodecRegistryService,
    private readonly deviceConnectivityService: DeviceConnectivityService,
  ) {}

  // ── Provisioning (public) ─────────────────────────────────────────────────
  //
  // Declared first so it is matched before any ':id' route. @Public() is
  // honoured by every guard in the global stack, so no JWT is required — the
  // profile's provision key/secret pair is the credential. Throttled because
  // an unauthenticated endpoint that can create rows is a brute-force target.

  @Post('provision')
  @Public()
  @Throttle({ default: { limit: 10, ttl: 60000 } })
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Self-register a device against a device profile (public)',
    description:
      'Authenticated by the DeviceProfile provision key/secret, not by JWT. ' +
      'Always returns HTTP 200 — check the `status` field. Re-provisioning an ' +
      'already-provisioned device returns its existing credentials rather ' +
      'than creating a duplicate.',
  })
  @ApiResponse({
    status: 200,
    description: 'Provisioning outcome',
    type: ProvisionDeviceResponseDto,
  })
  async provision(
    @Body() provisionDeviceDto: ProvisionDeviceDto,
  ): Promise<ProvisionDeviceResponseDto> {
    return this.devicesService.provisionDevice(provisionDeviceDto);
  }

  // ── Device management ─────────────────────────────────────────────────────

  @Post()
  @Roles(UserRole.USER, UserRole.TENANT_ADMIN, UserRole.CUSTOMER_USER, UserRole.CUSTOMER)
  @Audit({ action: AuditAction.CREATE, entityType: AuditEntityType.DEVICE })
  @Notify({
    type: NotificationType.DEVICE,
    channels: [NotificationChannel.IN_APP, NotificationChannel.EMAIL],
    priority: NotificationPriority.NORMAL,
    title: 'Device Created',
    message: 'Device "{entityName}" has been created successfully',
    recipients: 'self',
    entityType: 'device',
    action: { label: 'View Device', urlTemplate: '/devices/{entityId}' },
  })
  @RequireSubscriptionLimit({ resource: ResourceType.DEVICE })
  @ApiOperation({ summary: 'Create a new device' })
  @ApiResponse({ status: 201, description: 'Device created successfully' })
  @ApiResponse({ status: 403, description: 'Device limit reached' })
  @ApiResponse({ status: 409, description: 'Device already exists' })
  async create(@CurrentUser() user: User, @Body() createDeviceDto: CreateDeviceDto) {
    const device = await this.devicesService.create(user, createDeviceDto);
    return { message: 'Device created successfully', data: device };
  }

  @Get()
  @Roles(UserRole.USER, UserRole.TENANT_ADMIN, UserRole.SUPER_ADMIN, UserRole.CUSTOMER_USER, UserRole.CUSTOMER)
  @ApiOperation({ summary: 'Get all devices with pagination' })
  @ApiResponse({ status: 200, description: 'List of devices' })
  findAll(
    @ResolvedCustomerId() customerId: string | undefined,
    @CurrentUser() user: User,
    @Query() paginationDto: PaginationDto,
  ) {
    return this.devicesService.findAll(user.tenantId, user.customerId, user, paginationDto);
  }

  @Get(':id/capabilities')
@ApiOperation({ summary: 'Get capabilities for a specific device' })
async getDeviceCapabilities(
  @CurrentUser() user: User,
  @Param('id') id: string,
) {
  const device = await this.devicesService.findOne(id, user);
 
  // Resolution priority: codecId → manufacturer+model → null
  const codecId      = device.metadata?.codecId as string | undefined;
  const manufacturer = (device.metadata?.manufacturer as string) ?? device.manufacturer;
  const model        = (device.metadata?.model as string)        ?? device.model;
 
  const capabilities =
    (codecId      ? this.codecRegistry.getCapabilities(codecId)                    : null) ??
    (manufacturer && model ? this.codecRegistry.getCapabilitiesByModel(manufacturer, model) : null);
 
  return {
    message: 'Device capabilities retrieved successfully',
    data: capabilities ?? {
      codecId:       codecId ?? null,
      manufacturer,
      model,
      description:   'No capability definition available for this device',
      telemetryKeys: [],
      commands:      [],
      uiComponents:  [],
    },
  };
}

  @Get('statistics')
  @ApiOperation({ summary: 'Get device statistics' })
  getStatistics(@CurrentUser() user: User) {
    return this.devicesService.getStatistics(user);
  }

  @Get(':id')
  @ApiOperation({ summary: 'Get device by ID' })
  @ApiResponse({ status: 200, description: 'Device found' })
  @ApiResponse({ status: 404, description: 'Device not found' })
  findOne(@CurrentUser() user: User, @Param('id', ParseIdPipe) id: string) {
    return this.devicesService.findOne(id, user);
  }

  // ── Bulk operations (declared before ':id' so 'bulk' is not read as an id) ─

  @Post('bulk/delete')
  @Roles(UserRole.TENANT_ADMIN, UserRole.SUPER_ADMIN)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Bulk soft-delete devices (max 100 per request)',
    description:
      'Partial success is the normal outcome: this route always answers 200 and ' +
      'returns one entry per requested id in `outcomes`, so a caller can see ' +
      'exactly which ids failed and why. Every id is re-resolved against the ' +
      "caller's own tenant (and customer, for customer roles) server-side; an id " +
      'belonging to another tenant comes back as `not_found` and is NOT deleted. ' +
      'At most 100 ids per request — more is a 400 from validation. Deletes are ' +
      'soft (`deleted_at` is set; the row stays).\n\n' +
      'CASCADES: device credentials are hard-deleted (the DB CASCADE does not ' +
      'fire on a soft delete, so credentials would otherwise keep authenticating ' +
      'MQTT connections); floor-plan placements are soft-removed; ' +
      'customer/user device assignments are removed and the denormalised ' +
      'counters they feed (`customers.usageCounters.devices`, ' +
      '`customer_user_limits.usageCounters.devices`) are decremented; ' +
      '`subscriptions.usage.devices` is decremented once per tenant for the ' +
      'number actually deleted, so a delete gives the plan quota back.\n\n' +
      'RETAINED: telemetry, attributes, alarms and queued commands are kept — ' +
      "deleting a device is an inventory action, not a request to erase its " +
      'history.\n\n' +
      'BLOCKS: a device with an ACTIVE or ACKNOWLEDGED alarm is returned as ' +
      '`blocked`; clear or resolve the alarm first.\n\n' +
      'Each id is committed in its own transaction, so one blocked or failing ' +
      'id never rolls back the others.',
  })
  @ApiResponse({ status: 200, description: 'Per-id outcomes', type: BulkResultDto })
  @ApiResponse({ status: 400, description: 'More than 100 ids, or a malformed id' })
  bulkDelete(@CurrentUser() user: User, @Body() dto: BulkDeleteDevicesDto) {
    return this.devicesService.bulkDelete(dto, user);
  }

  @Patch('bulk')
  @Roles(UserRole.TENANT_ADMIN, UserRole.SUPER_ADMIN)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Bulk update devices (max 100 per request)',
    description:
      'Applies the same narrow patch to every listed device and returns one ' +
      'outcome per id. Only `status`, `customerId` and `assetId` are ' +
      'bulk-updatable; everything else (deviceKey, protocol, manufacturer, ' +
      'model, metadata, deviceProfileId, tenantId, userId) is rejected by ' +
      'validation, because rewriting device identity or codec resolution across ' +
      'a fleet behind one request is not reviewable. Send `null` for ' +
      '`customerId` or `assetId` to unassign/unlink; omit a field to leave it ' +
      'alone.\n\n' +
      'Every id is re-resolved against the caller\'s tenant: a foreign id comes ' +
      'back as `not_found` and is not touched. The target `customerId` / ' +
      '`assetId` is one value shared by the whole batch, so a foreign or unknown ' +
      'target is a 404 for the whole request rather than 100 identical per-item ' +
      'failures. A device already in the requested state is reported as ' +
      '`skipped` and counts as a success. One transaction per id. Max 100 ids.',
  })
  @ApiResponse({ status: 200, description: 'Per-id outcomes', type: BulkResultDto })
  @ApiResponse({
    status: 400,
    description: 'More than 100 ids, a malformed id, or no updatable field supplied',
  })
  @ApiResponse({ status: 404, description: 'Target customer or asset not in your tenant' })
  bulkUpdate(@CurrentUser() user: User, @Body() dto: BulkUpdateDevicesDto) {
    return this.devicesService.bulkUpdate(dto, user);
  }

  @Patch(':id')
  @ApiOperation({ summary: 'Update device' })
  update(
    @CurrentUser() user: User,
    @Param('id', ParseIdPipe) id: string,
    @Body() updateDeviceDto: UpdateDeviceDto,
  ) {
    return this.devicesService.update(id, user, updateDeviceDto);
  }

  @Post(':id/activate')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Activate device' })
  activate(@CurrentUser() user: User, @Param('id', ParseIdPipe) id: string) {
    return this.devicesService.activate(id, user);
  }

  @Post(':id/deactivate')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Deactivate device' })
  deactivate(@CurrentUser() user: User, @Param('id', ParseIdPipe) id: string) {
    return this.devicesService.deactivate(id, user);
  }

  @Get(':id/credentials')
  @ApiOperation({
    summary: 'Get device credentials (masked)',
    description:
      'Returns credential metadata with the secret masked to its first 8 ' +
      'characters. The full secret is shown only when the device is created ' +
      'and when credentials are rotated.',
  })
  @ApiResponse({ status: 200, type: DeviceCredentialsSummaryDto })
  @ApiResponse({ status: 404, description: 'Device or credentials not found' })
  getCredentials(@CurrentUser() user: User, @Param('id', ParseIdPipe) id: string) {
    return this.devicesService.getCredentialsSummary(id, user);
  }

  @Get(':id/connectivity')
  @ApiOperation({
    summary: 'How to connect this device',
    description:
      'Endpoints, topics and ready-to-paste client commands for every transport ' +
      'this platform actually serves. Generated from the live adapters, not from ' +
      'the profile\'s stored transportConfiguration — the HTTP default in that ' +
      'config is ThingsBoard\'s /api/v1/{token}/telemetry, which this platform ' +
      'does not route. No secrets are included; credentials have their own endpoint.',
  })
  @ApiResponse({ status: 200, description: 'Connectivity details' })
  @ApiResponse({ status: 404, description: 'Device not found' })
  getConnectivity(
    @CurrentUser() user: User,
    @Param('id', ParseIdPipe) id: string,
  ) {
    return this.deviceConnectivityService.getConnectivity(id, user.tenantId);
  }

  @Post(':id/credentials/regenerate')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Rotate device credentials',
    description:
      'Issues a new secret and revokes the old one. This response is the only ' +
      'place the new secret is returned in full — store it now. The device ' +
      'must be reconfigured before it can reconnect.',
  })
  @ApiResponse({ status: 200, description: 'New credentials — shown once' })
  regenerateCredentials(@CurrentUser() user: User, @Param('id', ParseIdPipe) id: string) {
    return this.devicesService.regenerateCredentials(id, user);
  }

  /** @deprecated Use POST /devices/:id/credentials/regenerate. */
  @Post(':id/regenerate-credentials')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: '[Deprecated] Regenerate device credentials',
    deprecated: true,
    description: 'Kept for existing clients. Use /credentials/regenerate.',
  })
  regenerateCredentialsLegacy(
    @CurrentUser() user: User,
    @Param('id', ParseIdPipe) id: string,
  ) {
    return this.devicesService.regenerateCredentials(id, user);
  }

  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Delete device' })
  async remove(@CurrentUser() user: User, @Param('id', ParseIdPipe) id: string) {
    await this.devicesService.remove(id, user);
  }

  // ── Bulk operations ───────────────────────────────────────────────────────

  @Post('bulk/status')
  @Roles(UserRole.TENANT_ADMIN, UserRole.SUPER_ADMIN)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Bulk update device status (Professional plan required)' })
  @ApiResponse({ status: 403, description: 'Feature not available in your plan' })
  async bulkUpdateStatus(
    @CurrentUser() user: User,
    @Body() body: { deviceIds: string[]; status: DeviceStatus },
  ) {
    const hasFeature = await this.subscriptionsService.hasFeature(user.id, 'bulkOperations');
    if (!hasFeature) {
      throw new ForbiddenException('Bulk operations require Professional plan or higher');
    }
    const result = await this.devicesService.bulkUpdateStatus(body.deviceIds, user.id, body.status);
    return { message: 'Devices updated successfully', data: result };
  }

  // ── Customer endpoints ────────────────────────────────────────────────────

  @Get('customer/:customerId')
  @UseGuards(CustomerAccessGuard)
  @ApiOperation({ summary: 'Get all devices for a specific customer' })
  async getDevicesByCustomer(
    @CurrentUser() user: User,
    @Param('customerId') customerId: string,
  ) {
    const devices = await this.devicesService.findByCustomer(customerId, user);
    return { message: 'Devices retrieved successfully', data: devices };
  }

  @Post(':id/assign-customer')
  @Roles(UserRole.TENANT_ADMIN, UserRole.SUPER_ADMIN)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Assign device to a customer' })
  async assignToCustomer(
    @CurrentUser() user: User,
    @Param('id', ParseIdPipe) deviceId: string,
    @Body('customerId') customerId: string,
  ) {
    const device = await this.devicesService.assignToCustomer(deviceId, customerId, user);
    return { message: 'Device assigned to customer successfully', data: device };
  }

  @Post(':id/unassign-customer')
  @Roles(UserRole.TENANT_ADMIN, UserRole.SUPER_ADMIN)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Unassign device from customer' })
  async unassignFromCustomer(
    @CurrentUser() user: User,
    @Param('id', ParseIdPipe) deviceId: string,
  ) {
    const device = await this.devicesService.unassignFromCustomer(deviceId, user);
    return { message: 'Device unassigned from customer successfully', data: device };
  }
}