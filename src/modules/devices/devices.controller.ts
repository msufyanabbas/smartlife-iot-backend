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
import { DevicesService } from './devices.service';
import { CreateDeviceDto } from './dto/create-device.dto';
import { UpdateDeviceDto } from './dto/update-device.dto';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { User, UserRole } from '../users/entities/user.entity';
import { PaginationDto } from '../../common/dto/pagination.dto';
import { ParseIdPipe } from '../../common/pipes/parse-id.pipe';
import { DeviceStatus } from './entities/device.entity';
import { Roles } from '@/common/decorators/roles.decorator';
import { RequireSubscription } from '@/common/decorators/subscription.decorator';
import { SubscriptionPlan } from '../subscriptions/entities/subscription.entity';
import { RolesGuard } from '@/common/guards';
import { SubscriptionGuard } from '@/common/guards/subscription.guard';
import { FeatureLimitGuard } from '@/common/guards/feature-limit.guard';
import { AccessControl } from '@/common/decorators/access-control.decorator';
import { SubscriptionsService } from '../subscriptions/subscriptions.service';
import { CustomerAccessGuard } from '@/common/guards/customer-access.guard';
import { RequireSubscriptionLimit, ResourceType, SubscriptionLimitGuard } from '@/common/guards/subscription-limit.guard';

@ApiTags('devices')
@Controller('devices')
@UseGuards(JwtAuthGuard, RolesGuard, SubscriptionLimitGuard)
@ApiBearerAuth()
export class DevicesController {
  constructor(private readonly devicesService: DevicesService, private readonly subscriptionsService: SubscriptionsService) {}

  @Post()
  // @UseGuards(JwtAuthGuard, RolesGuard, SubscriptionGuard, FeatureLimitGuard)
  // @UseGuards(JwtAuthGuard, RolesGuard, SubscriptionLimitGuard)
  @Roles(UserRole.USER, UserRole.TENANT_ADMIN)
  @RequireSubscriptionLimit({
    resource: ResourceType.DEVICE,
    operation: 'create',
  }) // ✅ Check device limit
  // @RequireSubscription(SubscriptionPlan.STARTER, SubscriptionPlan.PROFESSIONAL, SubscriptionPlan.ENTERPRISE)
  @ApiOperation({ summary: 'Create a new device' })
  @ApiResponse({ status: 201, description: 'Device created successfully' })
  @ApiResponse({ status: 409, description: 'Device already exists' })
  create(@CurrentUser() user: User, @Body() createDeviceDto: CreateDeviceDto) {
    return this.devicesService.create(user, createDeviceDto);
  }

  @Get()
  @Roles(UserRole.USER, UserRole.TENANT_ADMIN, UserRole.SUPER_ADMIN)
  @ApiOperation({ summary: 'Get all devices with pagination' })
  @ApiResponse({ status: 200, description: 'List of devices' })
  findAll(@CurrentUser() user: User, @Query() paginationDto: PaginationDto) {
    return this.devicesService.findAll(user, paginationDto);
  }

  @Get('statistics')
  @ApiOperation({ summary: 'Get device statistics' })
  @ApiResponse({ status: 200, description: 'Device statistics' })
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
  @ApiResponse({ status: 200, description: 'Device updated' })
  @ApiResponse({ status: 404, description: 'Device not found' })
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
  @ApiResponse({ status: 200, description: 'Device activated' })
  @ApiResponse({ status: 400, description: 'Device already active' })
  activate(@CurrentUser() user: User, @Param('id', ParseIdPipe) id: string) {
    return this.devicesService.activate(id, user);
  }

  @Post(':id/deactivate')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Deactivate device' })
  @ApiResponse({ status: 200, description: 'Device deactivated' })
  deactivate(@CurrentUser() user: User, @Param('id', ParseIdPipe) id: string) {
    return this.devicesService.deactivate(id, user);
  }

  @Get(':id/credentials')
  @ApiOperation({ summary: 'Get device MQTT credentials' })
  @ApiResponse({
    status: 200,
    description:
      'Device credentials retrieved (includes MQTT broker config for gateways)',
  })
  @ApiResponse({ status: 404, description: 'Device not found' })
  getCredentials(
    @CurrentUser() user: User,
    @Param('id', ParseIdPipe) id: string,
  ) {
    return this.devicesService.getCredentials(id,user);
  }

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

  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Delete device' })
  @ApiResponse({ status: 204, description: 'Device deleted' })
  @ApiResponse({ status: 404, description: 'Device not found' })
  async remove(@CurrentUser() user: User, @Param('id', ParseIdPipe) id: string) {
    const result = await this.devicesService.remove(id, user);
     await this.subscriptionsService.decrementUsage(user.id, 'devices', 1);
     return result;
  }

  @Post('bulk/status')
  @AccessControl(
    [UserRole.TENANT_ADMIN, UserRole.SUPER_ADMIN],
    [SubscriptionPlan.PROFESSIONAL, SubscriptionPlan.ENTERPRISE]
  )
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Bulk update device status' })
  @ApiResponse({ status: 200, description: 'Devices updated' })
  bulkUpdateStatus(
    @CurrentUser() user: User,
    @Body() body: { deviceIds: string[]; status: DeviceStatus },
  ) {
    return this.devicesService.bulkUpdateStatus(
      body.deviceIds,
      user.id,
      body.status,
    );
  }

   /**
   * ============================================
   * Customer-specific endpoints
   * ============================================
   */

    /**
   * Get devices by customer ID
   * Customer users can only access their own customer
   * Admins can access any customer
   */
  @Get('customer/:customerId')
  @UseGuards(CustomerAccessGuard) // Validates customer access
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
  @UseGuards(RolesGuard)
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
  @UseGuards(RolesGuard)
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
