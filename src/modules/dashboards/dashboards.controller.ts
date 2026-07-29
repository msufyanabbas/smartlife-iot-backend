import { Controller, Get, Post, Body, Patch, Param, Delete, UseGuards, Query, HttpCode, HttpStatus } from '@nestjs/common';
import {
  ApiTags,
  ApiOperation,
  ApiResponse,
  ApiBearerAuth,
} from '@nestjs/swagger';
import { DashboardsService } from './dashboards.service';
import {
  CreateDashboardDto,
  UpdateDashboardDto,
  DashboardQueryDto,
  ShareDashboardDto,
  CloneDashboardDto,
} from './dto/dashboard.dto';
import {
  AddWidgetDto,
  UpdateWidgetDto,
  UpdateLayoutDto,
} from './dto/dashboard-widget.dto';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { User } from '../users/entities/user.entity';
import { UserRole } from '@common/enums/index.enum';
import { ParseIdPipe } from '../../common/pipes/parse-id.pipe';
import { CustomerAccessGuard } from '@/common/guards/customer-access.guard';
import { RolesGuard } from '@common/guards/index.guards';
import { Roles } from '@/common/decorators/roles.decorator';

@ApiTags('dashboards')
@Controller('dashboards')
@UseGuards(JwtAuthGuard)
@ApiBearerAuth()
export class DashboardsController {
  constructor(private readonly dashboardsService: DashboardsService) {}

  @Post()
  @ApiOperation({ summary: 'Create new dashboard' })
  @ApiResponse({ status: 201, description: 'Dashboard created successfully' })
  create(@CurrentUser() user: User, @Body() createDto: CreateDashboardDto) {
    return this.dashboardsService.create(user, createDto);
  }

  @Get()
  @ApiOperation({ summary: 'Get all dashboards' })
  @ApiResponse({ status: 200, description: 'List of dashboards' })
  findAll(@CurrentUser() user: User, @Query() query: DashboardQueryDto) {
    return this.dashboardsService.findAll(user, query);
  }

  @Get('default')
  @ApiOperation({ summary: 'Get default dashboard' })
  @ApiResponse({ status: 200, description: 'Default dashboard' })
  getDefault(@CurrentUser() user: User) {
    return this.dashboardsService.getDefault(user);
  }

  @Get('shared')
  @ApiOperation({ summary: 'Get dashboards shared with me' })
  @ApiResponse({ status: 200, description: 'List of shared dashboards' })
  getShared(@CurrentUser() user: User) {
    return this.dashboardsService.getShared(user);
  }

  @Get('statistics')
  @ApiOperation({ summary: 'Get dashboard statistics' })
  @ApiResponse({ status: 200, description: 'Dashboard statistics' })
  getStatistics(@CurrentUser() user: User) {
    return this.dashboardsService.getStatistics(user);
  }

  @Get(':id')
  @ApiOperation({ summary: 'Get dashboard by ID' })
  @ApiResponse({ status: 200, description: 'Dashboard found' })
  @ApiResponse({ status: 404, description: 'Dashboard not found' })
  findOne(@Param('id', ParseIdPipe) id: string, @CurrentUser() user: User) {
    return this.dashboardsService.findOne(id, user);
  }

  @Patch(':id')
  @ApiOperation({ summary: 'Update dashboard' })
  @ApiResponse({ status: 200, description: 'Dashboard updated' })
  update(
    @Param('id', ParseIdPipe) id: string,
    @CurrentUser() user: User,
    @Body() updateDto: UpdateDashboardDto,
  ) {
    return this.dashboardsService.update(id, user, updateDto);
  }

  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Delete dashboard' })
  @ApiResponse({ status: 204, description: 'Dashboard deleted' })
  remove(@Param('id', ParseIdPipe) id: string, @CurrentUser() user: User) {
    return this.dashboardsService.remove(id, user);
  }

  @Get(':id/widgets')
  @ApiOperation({
    summary: 'Get dashboard widgets enriched with widget type and device',
  })
  @ApiResponse({ status: 200, description: 'Enriched widget list' })
  @ApiResponse({ status: 404, description: 'Dashboard not found' })
  getWidgets(
    @Param('id', ParseIdPipe) id: string,
    @CurrentUser() user: User,
  ) {
    return this.dashboardsService.getWidgets(id, user);
  }

  @Post(':id/widgets')
  @ApiOperation({ summary: 'Add widget to dashboard' })
  @ApiResponse({ status: 201, description: 'Widget added' })
  @ApiResponse({ status: 400, description: 'Device not found in this tenant' })
  @ApiResponse({ status: 404, description: 'Dashboard or widget type not found' })
  addWidget(
    @Param('id', ParseIdPipe) id: string,
    @CurrentUser() user: User,
    @Body() dto: AddWidgetDto,
  ) {
    return this.dashboardsService.addWidget(id, user, dto);
  }

  // Declared before ':id/widgets/:widgetId' so 'layout' is never parsed as a
  // widgetId — Nest matches routes in declaration order.
  @Patch(':id/layout')
  @ApiOperation({ summary: 'Batch update widget positions (drag and drop)' })
  @ApiResponse({ status: 200, description: 'Updated widget list' })
  @ApiResponse({ status: 404, description: 'Dashboard or widget not found' })
  updateLayout(
    @Param('id', ParseIdPipe) id: string,
    @CurrentUser() user: User,
    @Body() dto: UpdateLayoutDto,
  ) {
    return this.dashboardsService.updateLayout(id, user, dto);
  }

  @Patch(':id/widgets/:widgetId')
  @ApiOperation({ summary: 'Update widget' })
  @ApiResponse({ status: 200, description: 'Widget updated' })
  @ApiResponse({ status: 404, description: 'Dashboard or widget not found' })
  updateWidget(
    @Param('id', ParseIdPipe) id: string,
    @Param('widgetId', ParseIdPipe) widgetId: string,
    @CurrentUser() user: User,
    @Body() dto: UpdateWidgetDto,
  ) {
    return this.dashboardsService.updateWidget(id, widgetId, user, dto);
  }

  @Delete(':id/widgets/:widgetId')
  @ApiOperation({ summary: 'Remove widget from dashboard' })
  @ApiResponse({ status: 200, description: 'Widget removed' })
  @ApiResponse({ status: 404, description: 'Dashboard or widget not found' })
  removeWidget(
    @Param('id', ParseIdPipe) id: string,
    @Param('widgetId', ParseIdPipe) widgetId: string,
    @CurrentUser() user: User,
  ) {
    return this.dashboardsService.removeWidget(id, widgetId, user);
  }

  @Post(':id/share')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Share dashboard with users' })
  @ApiResponse({ status: 200, description: 'Dashboard shared' })
  share(
    @Param('id', ParseIdPipe) id: string,
    @CurrentUser() user: User,
    @Body() shareDto: ShareDashboardDto,
  ) {
    return this.dashboardsService.share(id, user, shareDto);
  }

  @Delete(':id/share/:userId')
  @ApiOperation({ summary: 'Unshare dashboard with user' })
  @ApiResponse({ status: 200, description: 'Dashboard unshared' })
  unshare(
    @Param('id', ParseIdPipe) id: string,
    @Param('userId', ParseIdPipe) targetUserId: string,
    @CurrentUser() user: User,
  ) {
    return this.dashboardsService.unshare(id, user, targetUserId);
  }

  @Post(':id/clone')
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({ summary: 'Clone dashboard' })
  @ApiResponse({ status: 201, description: 'Dashboard cloned' })
  clone(
    @Param('id', ParseIdPipe) id: string,
    @CurrentUser() user: User,
    @Body() cloneDto: CloneDashboardDto,
  ) {
    return this.dashboardsService.clone(id, user, cloneDto);
  }

  @Post(':id/favorite')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Toggle dashboard favorite' })
  @ApiResponse({ status: 200, description: 'Favorite toggled' })
  toggleFavorite(
    @Param('id', ParseIdPipe) id: string,
    @CurrentUser() user: User,
  ) {
    return this.dashboardsService.toggleFavorite(id, user);
  }

   /**
   * ============================================
   * CUSTOMER-SPECIFIC ENDPOINTS
   * ============================================
   */

  /**
   * Get dashboards by customer ID
   * Customer users can only access their own customer
   */
  @Get('customer/:customerId')
  @UseGuards(CustomerAccessGuard) // Validates customer access
  @ApiOperation({ summary: 'Get all dashboards for a specific customer' })
  @ApiResponse({ status: 200, description: 'Dashboards retrieved' })
  @ApiResponse({ status: 403, description: 'Access denied to this customer' })
  async getDashboardsByCustomer(
    @CurrentUser() user: User,
    @Param('customerId') customerId: string,
  ) {
    const dashboards = await this.dashboardsService.findByCustomer(
      customerId,
      user,
    );
    return {
      message: 'Customer dashboards retrieved successfully',
      data: dashboards,
    };
  }

   /**
   * Assign dashboard to customer (Owner or Admins only)
   */
  @Post(':id/assign-customer')
  @UseGuards(RolesGuard)
  @Roles(UserRole.TENANT_ADMIN, UserRole.SUPER_ADMIN)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ 
    summary: 'Assign dashboard to a customer',
    description: 'Only dashboard owner or admins can assign'
  })
  @ApiResponse({ status: 200, description: 'Dashboard assigned to customer' })
  @ApiResponse({ status: 403, description: 'Permission denied' })
  async assignToCustomer(
    @CurrentUser() user: User,
    @Param('id', ParseIdPipe) dashboardId: string,
    @Body('customerId') customerId: string,
  ) {
    const dashboard = await this.dashboardsService.assignToCustomer(
      dashboardId,
      customerId,
      user,
    );
    return {
      message: 'Dashboard assigned to customer successfully',
      data: dashboard,
    };
  }

  /**
   * Unassign dashboard from customer (Owner or Admins only)
   */
  @Post(':id/unassign-customer')
  @UseGuards(RolesGuard)
  @Roles(UserRole.TENANT_ADMIN, UserRole.SUPER_ADMIN)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Unassign dashboard from customer' })
  @ApiResponse({ status: 200, description: 'Dashboard unassigned from customer' })
  async unassignFromCustomer(
    @CurrentUser() user: User,
    @Param('id', ParseIdPipe) dashboardId: string,
  ) {
    const dashboard = await this.dashboardsService.unassignFromCustomer(
      dashboardId,
      user,
    );
    return {
      message: 'Dashboard unassigned from customer successfully',
      data: dashboard,
    };
  }
}
