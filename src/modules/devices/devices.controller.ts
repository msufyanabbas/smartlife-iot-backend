// src/modules/devices/devices.controller.ts
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
import { CurrentUser } from '@common/decorators/current-user.decorator';
import { User } from '@modules/users/entities/user.entity';
import { AuditAction, AuditEntityType, UserRole } from '@common/enums/index.enum';
import { PaginationDto } from '@common/dto/pagination.dto';
import { ParseIdPipe } from '@common/pipes/parse-id.pipe';
import { DeviceStatus } from '@common/enums/index.enum'
import { Roles } from '@common/decorators/roles.decorator';
import { RolesGuard, SubscriptionLimitGuard } from '@common/guards/index.guards';
import { RequireSubscriptionLimit } from '@common/decorators/subscription.decorator';
import { ResourceType } from '@common/guards/subscription-limit.guard';
import { SubscriptionsService } from '@modules/subscriptions/subscriptions.service';
import { CustomerAccessGuard } from '@common/guards/customer-access.guard';
import { Notify } from '@common/decorators/notify.decorator';
import { NotificationChannel, NotificationPriority, NotificationType } from '@common/enums/index.enum';
import { Audit } from '@common/decorators/audit.decorator';
import { MQTTAdapter } from '@modules/protocols/adapters/mqtt.adapter';

// ══════════════════════════════════════════════════════════════════════════
// DEVICE COMMAND DTO (moved from gateway)
// ══════════════════════════════════════════════════════════════════════════

export interface DeviceCommand {
  method: string;
  params?: Record<string, any>;
}

// ══════════════════════════════════════════════════════════════════════════
// DEVICES CONTROLLER
// ══════════════════════════════════════════════════════════════════════════

@ApiTags('devices')
@Controller('devices')
@UseGuards(JwtAuthGuard, RolesGuard, SubscriptionLimitGuard)
@ApiBearerAuth()
export class DevicesController {
  constructor(
    private readonly devicesService: DevicesService,
    private readonly subscriptionsService: SubscriptionsService,
    private readonly mqttAdapter: MQTTAdapter,  // ← Inject MQTT adapter
  ) {}

  // ══════════════════════════════════════════════════════════════════════════
  // DEVICE MANAGEMENT
  // ══════════════════════════════════════════════════════════════════════════

  /**
   * Create new device
   */
  @Post()
  @Roles(UserRole.USER, UserRole.TENANT_ADMIN, UserRole.CUSTOMER_USER, UserRole.CUSTOMER_ADMIN)
  @Audit({ action: AuditAction.CREATE, entityType: AuditEntityType.DEVICE })
  @Notify({
    type: NotificationType.DEVICE,
    channels: [NotificationChannel.IN_APP, NotificationChannel.EMAIL],
    priority: NotificationPriority.NORMAL,
    title: 'Device Created',
    message: 'Device "{entityName}" has been created successfully',
    recipients: 'self',
    entityType: 'device',
    action: {
      label: 'View Device',
      urlTemplate: '/devices/{entityId}',
    },
  })
  @RequireSubscriptionLimit({ resource: ResourceType.DEVICE })
  @ApiOperation({ summary: 'Create a new device' })
  @ApiResponse({ status: 201, description: 'Device created successfully' })
  @ApiResponse({ status: 403, description: 'Device limit reached' })
  @ApiResponse({ status: 409, description: 'Device already exists' })
  async create(
    @CurrentUser() user: User,
    @Body() createDeviceDto: CreateDeviceDto,
  ) {
    const device = await this.devicesService.create(user, createDeviceDto);
    return {
      message: 'Device created successfully',
      data: device,
    };
  }

  /**
   * Get all devices
   */
  @Get()
  @Roles(UserRole.USER, UserRole.TENANT_ADMIN, UserRole.SUPER_ADMIN, UserRole.CUSTOMER_USER, UserRole.CUSTOMER_ADMIN)
  @ApiOperation({ summary: 'Get all devices with pagination' })
  @ApiResponse({ status: 200, description: 'List of devices' })
  findAll(@CurrentUser() user: User, @Query() paginationDto: PaginationDto) {
    return this.devicesService.findAll(user, paginationDto);
  }

  /**
   * Get device statistics
   */
  @Get('statistics')
  @ApiOperation({ summary: 'Get device statistics' })
  @ApiResponse({ status: 200, description: 'Device statistics' })
  getStatistics(@CurrentUser() user: User) {
    return this.devicesService.getStatistics(user);
  }

  /**
   * Get device by ID
   */
  @Get(':id')
  @ApiOperation({ summary: 'Get device by ID' })
  @ApiResponse({ status: 200, description: 'Device found' })
  @ApiResponse({ status: 404, description: 'Device not found' })
  findOne(@CurrentUser() user: User, @Param('id', ParseIdPipe) id: string) {
    return this.devicesService.findOne(id, user);
  }

  /**
   * Update device
   */
  @Patch(':id')
  @ApiOperation({ summary: 'Update device' })
  @ApiResponse({ status: 200, description: 'Device updated' })
  @ApiResponse({ status: 404, description: 'Device not found' })
  update(
    @CurrentUser() user: User,
    @Param('id', ParseIdPipe) id: string,
    @Body() updateDeviceDto: UpdateDeviceDto,
  ) {
    return this.devicesService.update(id, user, updateDeviceDto);
  }

  /**
   * Activate device
   */
  @Post(':id/activate')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Activate device' })
  @ApiResponse({ status: 200, description: 'Device activated' })
  @ApiResponse({ status: 400, description: 'Device already active' })
  activate(@CurrentUser() user: User, @Param('id', ParseIdPipe) id: string) {
    return this.devicesService.activate(id, user);
  }

  /**
   * Deactivate device
   */
  @Post(':id/deactivate')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Deactivate device' })
  @ApiResponse({ status: 200, description: 'Device deactivated' })
  deactivate(@CurrentUser() user: User, @Param('id', ParseIdPipe) id: string) {
    return this.devicesService.deactivate(id, user);
  }

  /**
   * Get device credentials
   */
  @Get(':id/credentials')
  @ApiOperation({ summary: 'Get device MQTT credentials' })
  @ApiResponse({ status: 200, description: 'Device credentials retrieved' })
  @ApiResponse({ status: 404, description: 'Device not found' })
  getCredentials(
    @CurrentUser() user: User,
    @Param('id', ParseIdPipe) id: string,
  ) {
    return this.devicesService.getCredentials(id, user);
  }

  /**
   * Regenerate credentials
   */
  @Post(':id/regenerate-credentials')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Regenerate device credentials' })
  @ApiResponse({ status: 200, description: 'Credentials regenerated' })
  regenerateCredentials(
    @CurrentUser() user: User,
    @Param('id', ParseIdPipe) id: string,
  ) {
    return this.devicesService.regenerateCredentials(id, user);
  }

  /**
   * Delete device
   */
  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Delete device' })
  @ApiResponse({ status: 204, description: 'Device deleted' })
  @ApiResponse({ status: 404, description: 'Device not found' })
  async remove(@CurrentUser() user: User, @Param('id', ParseIdPipe) id: string) {
    await this.devicesService.remove(id, user);
    return;
  }

  // ══════════════════════════════════════════════════════════════════════════
  // BULK OPERATIONS
  // ══════════════════════════════════════════════════════════════════════════

  /**
   * Bulk update device status (Professional plan required)
   */
  @Post('bulk/status')
  @Roles(UserRole.TENANT_ADMIN, UserRole.SUPER_ADMIN)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ 
    summary: 'Bulk update device status (Professional plan required)',
    description: 'Requires Professional or Enterprise plan'
  })
  @ApiResponse({ status: 200, description: 'Devices updated' })
  @ApiResponse({ status: 403, description: 'Feature not available in your plan' })
  async bulkUpdateStatus(
    @CurrentUser() user: User,
    @Body() body: { deviceIds: string[]; status: DeviceStatus },
  ) {
    const hasFeature = await this.subscriptionsService.hasFeature(
      user.id,
      'bulkOperations',
    );

    if (!hasFeature) {
      throw new ForbiddenException(
        'Bulk operations require Professional plan or higher'
      );
    }

    const result = await this.devicesService.bulkUpdateStatus(
      body.deviceIds,
      user.id,
      body.status,
    );

    return {
      message: 'Devices updated successfully',
      data: result,
    };
  }

  // ══════════════════════════════════════════════════════════════════════════
  // CUSTOMER-SPECIFIC ENDPOINTS
  // ══════════════════════════════════════════════════════════════════════════

  /**
   * Get devices by customer ID
   */
  @Get('customer/:customerId')
  @UseGuards(CustomerAccessGuard)
  @ApiOperation({ summary: 'Get all devices for a specific customer' })
  @ApiResponse({ status: 200, description: 'Devices retrieved' })
  @ApiResponse({ status: 403, description: 'Access denied' })
  async getDevicesByCustomer(
    @CurrentUser() user: User,
    @Param('customerId') customerId: string,
  ) {
    const devices = await this.devicesService.findByCustomer(customerId, user);
    return {
      message: 'Devices retrieved successfully',
      data: devices,
    };
  }

  /**
   * Assign device to customer (Admins only)
   */
  @Post(':id/assign-customer')
  @Roles(UserRole.TENANT_ADMIN, UserRole.SUPER_ADMIN)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Assign device to a customer (Admins only)' })
  @ApiResponse({ status: 200, description: 'Device assigned to customer' })
  async assignToCustomer(
    @CurrentUser() user: User,
    @Param('id', ParseIdPipe) deviceId: string,
    @Body('customerId') customerId: string,
  ) {
    const device = await this.devicesService.assignToCustomer(
      deviceId,
      customerId,
      user,
    );
    return {
      message: 'Device assigned to customer successfully',
      data: device,
    };
  }

  /**
   * Unassign device from customer (Admins only)
   */
  @Post(':id/unassign-customer')
  @Roles(UserRole.TENANT_ADMIN, UserRole.SUPER_ADMIN)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Unassign device from customer (Admins only)' })
  @ApiResponse({ status: 200, description: 'Device unassigned from customer' })
  async unassignFromCustomer(
    @CurrentUser() user: User,
    @Param('id', ParseIdPipe) deviceId: string,
  ) {
    const device = await this.devicesService.unassignFromCustomer(deviceId, user);
    return {
      message: 'Device unassigned from customer successfully',
      data: device,
    };
  }

  // ══════════════════════════════════════════════════════════════════════════
  // DEVICE CONTROL (Migrated from Gateway Module)
  // ══════════════════════════════════════════════════════════════════════════

  /**
   * Send command to device via MQTT
   */
  @Post(':deviceKey/command')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ 
    summary: 'Send command to device',
    description: 'Send a command to a device via MQTT'
  })
  @ApiResponse({ status: 200, description: 'Command sent successfully' })
  @ApiResponse({ status: 400, description: 'Invalid command' })
  @ApiResponse({ status: 404, description: 'Device not found' })
  async sendCommand(
    @CurrentUser() user: User,
    @Param('deviceKey') deviceKey: string,
    @Body() command: DeviceCommand,
  ) {
    // Verify user has access to this device
    await this.devicesService.findByDeviceKey(deviceKey, user);

    // Send command via MQTT adapter
    await this.mqttAdapter.sendCommand(deviceKey, command);

    return {
      success: true,
      message: 'Command sent to device',
      deviceKey,
      command: command.method,
    };
  }

  /**
   * Send RPC request to device
   */
  @Post(':deviceKey/rpc')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ 
    summary: 'Send RPC request to device',
    description: 'Send a remote procedure call to a device'
  })
  @ApiResponse({ status: 200, description: 'RPC request sent' })
  @ApiResponse({ status: 404, description: 'Device not found' })
  async sendRpcRequest(
    @CurrentUser() user: User,
    @Param('deviceKey') deviceKey: string,
    @Body() body: { method: string; params?: Record<string, any> },
  ) {
    // Verify user has access to this device
    await this.devicesService.findByDeviceKey(deviceKey, user);

    // Send RPC via MQTT adapter
    await this.mqttAdapter.sendCommand(deviceKey, {
      method: body.method,
      params: body.params,
    });

    return {
      success: true,
      message: 'RPC request sent',
      deviceKey,
      method: body.method,
    };
  }

  /**
   * Update device attributes via MQTT
   */
  @Post(':deviceKey/attributes')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ 
    summary: 'Update device attributes',
    description: 'Update device attributes via MQTT'
  })
  @ApiResponse({ status: 200, description: 'Attributes updated' })
  @ApiResponse({ status: 404, description: 'Device not found' })
  async updateAttributes(
    @CurrentUser() user: User,
    @Param('deviceKey') deviceKey: string,
    @Body() attributes: Record<string, any>,
  ) {
    // Verify user has access to this device
    await this.devicesService.findByDeviceKey(deviceKey, user);

    // Update via device service (stores in DB)
    const device = await this.devicesService.findByDeviceKey(deviceKey, user);
    await this.devicesService.update(device.id, user, {
      metadata: {
        ...device.metadata,
        ...attributes,
      },
    });

    return {
      success: true,
      message: 'Attributes updated',
      deviceKey,
    };
  }

  /**
   * Publish test telemetry (for testing/debugging)
   */
  @Post(':deviceKey/telemetry')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ 
    summary: 'Publish telemetry (for testing)',
    description: 'Manually publish telemetry data for a device (testing only)'
  })
  @ApiResponse({ status: 200, description: 'Telemetry published' })
  @ApiResponse({ status: 404, description: 'Device not found' })
  async publishTelemetry(
    @CurrentUser() user: User,
    @Param('deviceKey') deviceKey: string,
    @Body() telemetry: Record<string, any>,
  ) {
    // Verify user has access to this device
    await this.devicesService.findByDeviceKey(deviceKey, user);

    // Publish via MQTT adapter
    await this.mqttAdapter.sendCommand(deviceKey, {
      method: 'test_telemetry',
      params: telemetry,
    });

    return {
      success: true,
      message: 'Telemetry published',
      deviceKey,
    };
  }
}