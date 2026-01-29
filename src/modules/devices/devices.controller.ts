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
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { User } from '../users/entities/user.entity';
import { UserRole } from '@common/enums/index.enum';
import { PaginationDto } from '../../common/dto/pagination.dto';
import { ParseIdPipe } from '../../common/pipes/parse-id.pipe';
import { DeviceStatus } from './entities/device.entity';
import { Roles } from '@/common/decorators/roles.decorator';
import { RolesGuard, RequireSubscriptionLimit, ResourceType, SubscriptionLimitGuard } from '@common/guards/index.guards';
import { SubscriptionsService } from '../subscriptions/subscriptions.service';
import { CustomerAccessGuard } from '@/common/guards/customer-access.guard';
import { Notify } from '@/common/decorators/notify.decorator';
import { NotificationChannel, NotificationPriority, NotificationType } from '@common/enums/index.enum';

@ApiTags('devices')
@Controller('devices')
@UseGuards(JwtAuthGuard, RolesGuard, SubscriptionLimitGuard) // ✅ Global guards
@ApiBearerAuth()
export class DevicesController {
  constructor(
    private readonly devicesService: DevicesService,
    private readonly subscriptionsService: SubscriptionsService, // ✅ Inject service
  ) {}

  /**
   * ============================================
   * CREATE DEVICE - With Limit Check
   * ============================================
   */
  @Post()
  @Roles(UserRole.USER, UserRole.TENANT_ADMIN, UserRole.CUSTOMER_USER, UserRole.CUSTOMER_ADMIN)
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
  @RequireSubscriptionLimit({
    resource: ResourceType.DEVICE,
    operation: 'create',
  }) // ✅ Guard checks limit BEFORE creation
  @ApiOperation({ summary: 'Create a new device' })
  @ApiResponse({ status: 201, description: 'Device created successfully' })
  @ApiResponse({ status: 403, description: 'Device limit reached' })
  @ApiResponse({ status: 409, description: 'Device already exists' })
  async create(
    @CurrentUser() user: User,
    @Body() createDeviceDto: CreateDeviceDto,
  ) {
    // ✅ Guard already checked limit - safe to create
    const device = await this.devicesService.create(user, createDeviceDto);

    return {
      message: 'Device created successfully',
      data: device,
    };
  }

  /**
   * ============================================
   * GET ALL DEVICES
   * ============================================
   */
  @Get()
  @Roles(UserRole.USER, UserRole.TENANT_ADMIN, UserRole.SUPER_ADMIN, UserRole.CUSTOMER_USER, UserRole.CUSTOMER_ADMIN)
  @ApiOperation({ summary: 'Get all devices with pagination' })
  @ApiResponse({ status: 200, description: 'List of devices' })
  findAll(@CurrentUser() user: User, @Query() paginationDto: PaginationDto) {
    return this.devicesService.findAll(user, paginationDto);
  }

  /**
   * ============================================
   * GET DEVICE STATISTICS
   * ============================================
   */
  @Get('statistics')
  @ApiOperation({ summary: 'Get device statistics' })
  @ApiResponse({ status: 200, description: 'Device statistics' })
  getStatistics(@CurrentUser() user: User) {
    return this.devicesService.getStatistics(user);
  }

  /**
   * ============================================
   * GET DEVICE BY ID
   * ============================================
   */
  @Get(':id')
  @ApiOperation({ summary: 'Get device by ID' })
  @ApiResponse({ status: 200, description: 'Device found' })
  @ApiResponse({ status: 404, description: 'Device not found' })
  findOne(@CurrentUser() user: User, @Param('id', ParseIdPipe) id: string) {
    return this.devicesService.findOne(id, user);
  }

  /**
   * ============================================
   * UPDATE DEVICE
   * ============================================
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
   * ============================================
   * ACTIVATE DEVICE
   * ============================================
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
   * ============================================
   * DEACTIVATE DEVICE
   * ============================================
   */
  @Post(':id/deactivate')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Deactivate device' })
  @ApiResponse({ status: 200, description: 'Device deactivated' })
  deactivate(@CurrentUser() user: User, @Param('id', ParseIdPipe) id: string) {
    return this.devicesService.deactivate(id, user);
  }

  /**
   * ============================================
   * GET DEVICE CREDENTIALS
   * ============================================
   */
  @Get(':id/credentials')
  @ApiOperation({ summary: 'Get device MQTT credentials' })
  @ApiResponse({
    status: 200,
    description: 'Device credentials retrieved',
  })
  @ApiResponse({ status: 404, description: 'Device not found' })
  getCredentials(
    @CurrentUser() user: User,
    @Param('id', ParseIdPipe) id: string,
  ) {
    return this.devicesService.getCredentials(id, user);
  }

  /**
   * ============================================
   * REGENERATE CREDENTIALS
   * ============================================
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
   * ============================================
   * DELETE DEVICE - With Usage Decrement
   * ============================================
   */
  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Delete device' })
  @ApiResponse({ status: 204, description: 'Device deleted' })
  @ApiResponse({ status: 404, description: 'Device not found' })
  async remove(@CurrentUser() user: User, @Param('id', ParseIdPipe) id: string) {
    // ✅ Delete device first
    await this.devicesService.remove(id, user);
    // No content response
    return;
  }

  /**
   * ============================================
   * BULK UPDATE STATUS
   * Only Professional+ plans
   * ============================================
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
    // ✅ Check if user has bulk operations feature (Professional+)
    const hasFeature = await this.subscriptionsService.hasFeature(
      user.id,
      'bulkOperations', // You'd need to add this to your features
    );

    if (!hasFeature) {
      if (!hasFeature) { throw new ForbiddenException('Bulk operations require Professional plan or higher');}
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

  /**
   * ============================================
   * CUSTOMER-SPECIFIC ENDPOINTS
   * ============================================
   */

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
    @Param('id') deviceId: string,
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
    @Param('id') deviceId: string,
  ) {
    const device = await this.devicesService.unassignFromCustomer(
      deviceId,
      user,
    );
    return {
      message: 'Device unassigned from customer successfully',
      data: device,
    };
  }
}