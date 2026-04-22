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
  ) {}

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
  @ApiOperation({ summary: 'Get device MQTT credentials' })
  getCredentials(@CurrentUser() user: User, @Param('id', ParseIdPipe) id: string) {
    return this.devicesService.getCredentials(id, user);
  }

  @Post(':id/regenerate-credentials')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Regenerate device credentials' })
  regenerateCredentials(@CurrentUser() user: User, @Param('id', ParseIdPipe) id: string) {
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