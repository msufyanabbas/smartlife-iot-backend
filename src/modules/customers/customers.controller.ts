import {
  Controller,
  Get,
  Post,
  Body,
  Patch,
  Param,
  Delete,
  Query,
  UseGuards,
  Request,
  HttpCode,
  HttpStatus,
} from '@nestjs/common';
import {
  ApiTags,
  ApiOperation,
  ApiResponse,
  ApiBearerAuth,
  ApiQuery,
  ApiParam,
} from '@nestjs/swagger';
import { CustomersService } from './customers.service';
import {
  CreateCustomerDto,
  UpdateCustomerDto,
  BulkUpdateCustomerStatusDto,
  SetCustomerPasswordDto,
} from './dto/customers.dto';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { RolesGuard } from '../../common/guards/roles.guard';
import { Roles } from '../../common/decorators/roles.decorator';
import { UserRole, CustomerStatus, AuditAction, AuditEntityType, NotificationType, NotificationChannel, NotificationPriority} from '@common/enums/index.enum';
import { CurrentUser } from '@/common/decorators/current-user.decorator';
import { User } from '../index.entities';
import { Public } from '@/common/decorators/public.decorator';
import { Audit } from '@/common/decorators/audit.decorator';
import { Notify } from '@/common/decorators/notify.decorator';
import { RequireSubscriptionLimit } from '@/common/decorators/subscription.decorator';
import { ResourceType } from '@/common/guards/subscription-limit.guard';

@ApiTags('Customers')
@Controller('customers')
export class CustomersController {
  constructor(private readonly customersService: CustomersService) {}
  /**
   * Create a new customer
   */
  @Post()
  @Roles(UserRole.TENANT_ADMIN)
  @Audit({ action: AuditAction.CREATE, entityType: AuditEntityType.CUSTOMER })
  @Notify({
      type: NotificationType.USER,
      channels: [NotificationChannel.IN_APP, NotificationChannel.EMAIL],
      priority: NotificationPriority.NORMAL,
      title: 'Customer Created',
      message: 'Customer "{entityName}" has been created successfully',
      recipients: 'self',
      entityType: 'customer',
      action: {
        label: 'View Customer',
        urlTemplate: '/customers/{entityId}',
      },
    })
  @RequireSubscriptionLimit({ resource: ResourceType.CUSTOMER })
  @ApiOperation({ summary: 'Create a new customer' })
  @ApiResponse({ status: 201, description: 'Customer created successfully' })
  @ApiResponse({ status: 403, description: 'Customer limit reached' })
  @ApiResponse({ status: 409, description: 'Customer already exists' })
  async create(@CurrentUser() user: User, @Body() createCustomerDto: CreateCustomerDto) {
    const customer = await this.customersService.create(createCustomerDto, user);
    return {
      message: 'Customer created successfully',
      data: customer,
    };
  }

  @Post(':id/resend-invitation')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(UserRole.TENANT_ADMIN, UserRole.SUPER_ADMIN)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Resend set-password invitation to customer' })
  @ApiParam({ name: 'id', description: 'Customer ID' })
  @ApiResponse({ status: 200, description: 'Invitation resent' })
  async resendInvitation(
    @CurrentUser() currentUser: User,
    @Param('id') id: string,
  ) {
    return this.customersService.resendCustomerInvitation(id, currentUser);
  }

  /**
   * Get all customers with pagination and filters
   */
  @Get()
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @Roles(UserRole.TENANT_ADMIN)
  @ApiOperation({ summary: 'Get all customers' })
  @ApiQuery({ name: 'page', required: false, type: Number })
  @ApiQuery({ name: 'limit', required: false, type: Number })
  @ApiQuery({ name: 'search', required: false, type: String })
  @ApiQuery({ name: 'status', required: false, enum: CustomerStatus })
  @ApiQuery({ name: 'tenantId', required: false, type: String })
  @ApiQuery({ name: 'isPublic', required: false, type: Boolean })
  @ApiResponse({ status: 200, description: 'Customers retrieved successfully' })
  async findAll(
    @CurrentUser() user: User,
    @Query('page') page?: number,
    @Query('limit') limit?: number,
    @Query('search') search?: string,
    @Query('status') status?: CustomerStatus,
    @Query('tenantId') tenantId?: string,
    @Query('isPublic') isPublic?: boolean,
  ) {
    const result = await this.customersService.findAll({
      page: page ? +page : undefined,
      limit: limit ? +limit : undefined,
      search,
      status,
      isPublic: isPublic !== undefined ? isPublic === true : undefined,
    }, user.tenantId);

    return {
      message: 'Customers retrieved successfully',
      data: result.customers,
      meta: {
        total: result.total,
        page: result.page,
        limit: result.limit,
        totalPages: result.totalPages,
      },
    };
  }

  /**
   * Get customer statistics
   */
  @Get('statistics')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(UserRole.SUPER_ADMIN, UserRole.TENANT_ADMIN)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Get customer statistics' })
  @ApiQuery({ name: 'tenantId', required: false, type: String })
  @ApiResponse({
    status: 200,
    description: 'Statistics retrieved successfully',
  })
  async getStatistics(@Query('tenantId') tenantId?: string) {
    const stats = await this.customersService.getStatistics(tenantId);
    return {
      message: 'Statistics retrieved successfully',
      data: stats,
    };
  }

  /**
   * Search customers
   */
  @Get('search')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Search customers' })
  @ApiQuery({ name: 'q', required: true, type: String })
  @ApiQuery({ name: 'tenantId', required: false, type: String })
  @ApiQuery({ name: 'limit', required: false, type: Number })
  @ApiResponse({ status: 200, description: 'Search results' })
  async search(
    @Query('q') term: string,
    @Query('tenantId') tenantId?: string,
    @Query('limit') limit?: number,
  ) {
    const customers = await this.customersService.search(
      term,
      tenantId,
      limit ? +limit : 10,
    );
    return {
      message: 'Search completed successfully',
      data: customers,
    };
  }

  /**
   * Get public customers
   */
  @Get('public/:tenantId')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Get public customers for a tenant' })
  @ApiResponse({ status: 200, description: 'Public customers retrieved' })
  async getPublicCustomers(@Param('tenantId') tenantId: string) {
    const customers = await this.customersService.getPublicCustomers(tenantId);
    return {
      message: 'Public customers retrieved successfully',
      data: customers,
    };
  }

  /**
   * Bulk update customer status
   */
  @Patch('bulk/status')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(UserRole.SUPER_ADMIN, UserRole.TENANT_ADMIN)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Bulk update customer status' })
  @ApiResponse({ status: 200, description: 'Status updated successfully' })
  async bulkUpdateStatus(@Body() bulkUpdateDto: BulkUpdateCustomerStatusDto) {
    await this.customersService.bulkUpdateStatus(bulkUpdateDto);
    return {
      message: 'Status updated successfully',
    };
  }

  /**
   * Get customers by tenant
   */
  @Get('tenant/:tenantId')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(UserRole.SUPER_ADMIN, UserRole.TENANT_ADMIN)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Get customers by tenant' })
  @ApiResponse({ status: 200, description: 'Customers retrieved successfully' })
  async findByTenant(@Param('tenantId') tenantId: string) {
    const customers = await this.customersService.findByTenant(tenantId);
    return {
      message: 'Customers retrieved successfully',
      data: customers,
    };
  }

  /**
   * Get customers by tenant
   */
  @Get('tenant')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(UserRole.SUPER_ADMIN, UserRole.TENANT_ADMIN)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Get customers by tenant' })
  @ApiResponse({ status: 200, description: 'Customers retrieved successfully' })
  async findByTenantCustomers(@CurrentUser() user: User) {
    const customers = await this.customersService.findByTenant(user.tenantId);
    return {
      message: 'Customers retrieved successfully',
      data: customers,
    };
  }

  /**
   * Get customers by status
   */
  @Get('status/:status')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(UserRole.SUPER_ADMIN, UserRole.TENANT_ADMIN)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Get customers by status' })
  @ApiQuery({ name: 'tenantId', required: false, type: String })
  @ApiResponse({ status: 200, description: 'Customers retrieved successfully' })
  async findByStatus(
    @Param('status') status: CustomerStatus,
    @Query('tenantId') tenantId?: string,
  ) {
    const customers = await this.customersService.findByStatus(
      status,
      tenantId,
    );
    return {
      message: 'Customers retrieved successfully',
      data: customers,
    };
  }

  /**
   * Get customer by ID
   */
  @Get(':id')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Get customer by ID' })
  @ApiResponse({ status: 200, description: 'Customer retrieved successfully' })
  @ApiResponse({ status: 404, description: 'Customer not found' })
  async findOne(@CurrentUser() user: User, @Param('id') id: string) {
    const customer = await this.customersService.findOne(user.tenantId, id);
    return {
      message: 'Customer retrieved successfully',
      data: customer,
    };
  }

  /**
   * Update customer by ID
   */
  @Patch(':id')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(UserRole.SUPER_ADMIN, UserRole.TENANT_ADMIN)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Update customer by ID' })
  @ApiResponse({ status: 200, description: 'Customer updated successfully' })
  @ApiResponse({ status: 404, description: 'Customer not found' })
  async update(
    @CurrentUser() user: User,
    @Param('id') id: string,
    @Body() updateCustomerDto: UpdateCustomerDto,
  ) {
    const customer = await this.customersService.update(user, id, updateCustomerDto);
    return {
      message: 'Customer updated successfully',
      data: customer,
    };
  }

  /**
   * Update customer status
   */
  @Patch(':id/status')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(UserRole.SUPER_ADMIN, UserRole.TENANT_ADMIN)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Update customer status' })
  @ApiResponse({ status: 200, description: 'Status updated successfully' })
  async updateStatus(
    @CurrentUser() user: User,
    @Param('id') id: string,
    @Body('status') status: CustomerStatus,
  ) {
    const customer = await this.customersService.updateStatus(id, status, user);
    return {
      message: 'Status updated successfully',
      data: customer,
    };
  }

  /**
   * Delete customer
   */
  @Delete(':id')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(UserRole.SUPER_ADMIN, UserRole.TENANT_ADMIN)
  @ApiBearerAuth()
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Delete customer' })
  @ApiResponse({ status: 204, description: 'Customer deleted successfully' })
  @ApiResponse({ status: 404, description: 'Customer not found' })
  async remove(@CurrentUser() user: User, @Param('id') id: string) {
    await this.customersService.remove(user, id);
  }
}