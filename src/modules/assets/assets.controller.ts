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
  HttpCode,
  HttpStatus,
} from '@nestjs/common';
import {
  ApiTags,
  ApiOperation,
  ApiResponse,
  ApiBearerAuth,
  ApiQuery,
} from '@nestjs/swagger';
import { AssetsService } from './assets.service';
import {
  CreateAssetDto,
  UpdateAssetDto,
  QueryAssetsDto,
  AssignDeviceDto,
  BulkAssignDevicesDto,
  UpdateAttributesDto,
  AssetHierarchyDto,
} from './dto/assets.dto';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { RolesGuard } from '../../common/guards/roles.guard';
import { Roles } from '../../common/decorators/roles.decorator';
import { User, UserRole } from '../users/entities/user.entity';
import { AssetType } from './entities/asset.entity';
import { CurrentUser } from '@/common/decorators/current-user.decorator';
import { CustomerAccessGuard } from '@/common/guards/customer-access.guard';

@ApiTags('Assets')
@Controller('assets')
@UseGuards(JwtAuthGuard)
@ApiBearerAuth()
export class AssetsController {
  constructor(private readonly assetsService: AssetsService) {}

  @Post()
  @UseGuards(RolesGuard)
  @Roles(UserRole.SUPER_ADMIN, UserRole.TENANT_ADMIN)
  @ApiOperation({ summary: 'Create a new asset' })
  @ApiResponse({ status: 201, description: 'Asset created successfully' })
  async create(@CurrentUser() user: User, @Body() createAssetDto: CreateAssetDto) {
    const asset = await this.assetsService.create(createAssetDto, user);
    return {
      message: 'Asset created successfully',
      data: asset,
    };
  }

  @Get()
  @ApiOperation({ summary: 'Get all assets with filters' })
  @ApiQuery({ name: 'search', required: false })
  @ApiQuery({ name: 'type', required: false, enum: AssetType })
  @ApiQuery({ name: 'tenantId', required: false })
  @ApiQuery({ name: 'customerId', required: false })
  @ApiQuery({ name: 'tenantId', required: false })
  @ApiQuery({ name: 'assetProfileId', required: false })
  @ApiQuery({ name: 'parentAssetId', required: false })
  @ApiQuery({ name: 'active', required: false, type: Boolean })
  @ApiQuery({ name: 'page', required: false, type: Number })
  @ApiQuery({ name: 'limit', required: false, type: Number })
  @ApiResponse({ status: 200, description: 'Assets retrieved successfully' })
  async findAll(@CurrentUser() user: User, @Query() queryDto: QueryAssetsDto) {
    const result = await this.assetsService.findAll(queryDto, user);
    return {
      message: 'Assets retrieved successfully',
      data: result.assets,
      meta: {
        total: result.total,
        page: result.page,
        limit: result.limit,
        totalPages: result.totalPages,
      },
    };
  }

  @Get('statistics')
  @ApiOperation({ summary: 'Get asset statistics' })
  @ApiResponse({
    status: 200,
    description: 'Statistics retrieved successfully',
  })
  async getStatistics(@CurrentUser() user: User) {
    const stats = await this.assetsService.getStatistics(user);
    return {
      message: 'Statistics retrieved successfully',
      data: stats,
    };
  }

  @Get('roots')
  @ApiOperation({ summary: 'Get root assets (no parent)' })
  @ApiResponse({ status: 200, description: 'Root assets retrieved' })
  async getRootAssets(@CurrentUser() user: User) {
    const assets = await this.assetsService.getRootAssets(user);
    return {
      message: 'Root assets retrieved successfully',
      data: assets,
    };
  }

  @Get('search/location')
  @ApiOperation({ summary: 'Search assets by location' })
  @ApiQuery({ name: 'latitude', type: Number })
  @ApiQuery({ name: 'longitude', type: Number })
  @ApiQuery({
    name: 'radius',
    type: Number,
    description: 'Radius in kilometers',
  })
  @ApiResponse({ status: 200, description: 'Assets found' })
  async searchByLocation(
    @CurrentUser() user: User,
    @Query('latitude') latitude: number,
    @Query('longitude') longitude: number,
    @Query('radius') radius: number,
  ) {
    const assets = await this.assetsService.searchByLocation(
      +latitude,
      +longitude,
      +radius,
      user
    );
    return {
      message: 'Assets found',
      data: assets,
    };
  }

  /**
   * ============================================
   * CUSTOMER-SPECIFIC ENDPOINTS
   * ============================================
   */

  /**
   * Get assets by customer ID
   * Customer users can only access their own customer
   */
  @Get('customer/:customerId')
  @UseGuards(CustomerAccessGuard) // Validates customer access
  @ApiOperation({ summary: 'Get all assets for a specific customer' })
  @ApiResponse({ status: 200, description: 'Assets retrieved' })
  @ApiResponse({ status: 403, description: 'Access denied to this customer' })
  async getAssetsByCustomer(
    @CurrentUser() user: User,
    @Param('customerId') customerId: string,
  ) {
    const assets = await this.assetsService.findByCustomer(customerId, user);
    return {
      message: 'Customer assets retrieved successfully',
      data: assets,
    };
  }

  /**
   * Assign asset to customer (Admins only)
   */
  @Post(':id/assign-customer')
  @UseGuards(RolesGuard)
  @Roles(UserRole.TENANT_ADMIN, UserRole.SUPER_ADMIN)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ 
    summary: 'Assign asset to a customer',
    description: 'Only admins can assign assets to customers'
  })
  @ApiResponse({ status: 200, description: 'Asset assigned to customer' })
  @ApiResponse({ status: 403, description: 'Permission denied' })
  async assignToCustomer(
    @CurrentUser() user: User,
    @Param('id') assetId: string,
    @Body('customerId') customerId: string,
  ) {
    const asset = await this.assetsService.assignToCustomer(
      assetId,
      customerId,
      user,
    );
    return {
      message: 'Asset assigned to customer successfully',
      data: asset,
    };
  }

  /**
   * Unassign asset from customer (Admins only)
   */
  @Post(':id/unassign-customer')
  @UseGuards(RolesGuard)
  @Roles(UserRole.TENANT_ADMIN, UserRole.SUPER_ADMIN)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Unassign asset from customer' })
  @ApiResponse({ status: 200, description: 'Asset unassigned from customer' })
  async unassignFromCustomer(
    @CurrentUser() user: User,
    @Param('id') assetId: string,
  ) {
    const asset = await this.assetsService.unassignFromCustomer(assetId, user);
    return {
      message: 'Asset unassigned from customer successfully',
      data: asset,
    };
  }

  @Get(':id')
  @UseGuards(CustomerAccessGuard) // Validates customer access
  @ApiOperation({ summary: 'Get asset by ID' })
  @ApiResponse({ status: 200, description: 'Asset retrieved successfully' })
  @ApiResponse({ status: 404, description: 'Asset not found' })
  async findOne(@CurrentUser() user: User, @Param('id') id: string) {
    const asset = await this.assetsService.findOne(id, user);
    return {
      message: 'Asset retrieved successfully',
      data: asset,
    };
  }

  @Get(':id/hierarchy')
  @UseGuards(CustomerAccessGuard)
  @ApiOperation({ summary: 'Get asset hierarchy (children tree)' })
  @ApiQuery({ name: 'maxDepth', required: false, type: Number })
  @ApiQuery({ name: 'includeDevices', required: false, type: Boolean })
  @ApiResponse({ status: 200, description: 'Hierarchy retrieved' })
  async getHierarchy(@CurrentUser() user: User, @Param('id') id: string, @Query() dto: AssetHierarchyDto) {
    const hierarchy = await this.assetsService.getHierarchy(
      id,
      user,
      dto.maxDepth,
      dto.includeDevices,
    );
    return {
      message: 'Hierarchy retrieved successfully',
      data: hierarchy,
    };
  }

  @Get(':id/path')
  @UseGuards(CustomerAccessGuard)
  @ApiOperation({ summary: 'Get asset path (from root to asset)' })
  @ApiResponse({ status: 200, description: 'Path retrieved' })
  async getPath(@CurrentUser() user: User, @Param('id') id: string) {
    const path = await this.assetsService.getAssetPath(id, user);
    return {
      message: 'Asset path retrieved successfully',
      data: path,
    };
  }

  @Get(':id/children')
  @UseGuards(CustomerAccessGuard)
  @ApiOperation({ summary: 'Get direct child assets' })
  @ApiResponse({ status: 200, description: 'Children retrieved' })
  async getChildren(@CurrentUser() user: User, @Param('id') id: string) {
    const children = await this.assetsService.getChildren(id, user);
    return {
      message: 'Child assets retrieved successfully',
      data: children,
    };
  }

  @Get(':id/devices')
  @UseGuards(CustomerAccessGuard)
  @ApiOperation({ summary: 'Get devices assigned to asset' })
  @ApiResponse({ status: 200, description: 'Devices retrieved' })
  async getDevices(@CurrentUser() user: User, @Param('id') id: string) {
    const devices = await this.assetsService.getDevices(id, user);
    return {
      message: 'Devices retrieved successfully',
      data: devices,
    };
  }

  @Post(':id/devices')
  @UseGuards(RolesGuard)
  @Roles(UserRole.SUPER_ADMIN, UserRole.TENANT_ADMIN, UserRole.CUSTOMER_USER)
  @ApiOperation({ summary: 'Assign device to asset' })
  @ApiResponse({ status: 200, description: 'Device assigned successfully' })
  async assignDevice(
    @CurrentUser() user: User,
    @Param('id') id: string,
    @Body() assignDeviceDto: AssignDeviceDto,
  ) {
    await this.assetsService.assignDevice(id, assignDeviceDto.deviceId, user);
    return {
      message: 'Device assigned successfully',
    };
  }

  @Post(':id/devices/bulk')
  @UseGuards(RolesGuard)
  @Roles(UserRole.SUPER_ADMIN, UserRole.TENANT_ADMIN, UserRole.CUSTOMER_USER)
  @ApiOperation({ summary: 'Bulk assign devices to asset' })
  @ApiResponse({ status: 200, description: 'Devices assigned successfully' })
  async bulkAssignDevices(
    @CurrentUser() user: User,
    @Param('id') id: string,
    @Body() bulkAssignDto: BulkAssignDevicesDto,
  ) {
    await this.assetsService.bulkAssignDevices(id, bulkAssignDto.deviceIds, user);
    return {
      message: 'Devices assigned successfully',
    };
  }

  @Delete(':id/devices/:deviceId')
  @UseGuards(RolesGuard)
  @Roles(UserRole.SUPER_ADMIN, UserRole.TENANT_ADMIN, UserRole.CUSTOMER_USER)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Unassign device from asset' })
  @ApiResponse({ status: 200, description: 'Device unassigned successfully' })
  async unassignDevice(
    @CurrentUser() user: User,
    @Param('id') id: string,
    @Param('deviceId') deviceId: string,
  ) {
    await this.assetsService.unassignDevice(id, deviceId, user);
    return {
      message: 'Device unassigned successfully',
    };
  }

  @Patch(':id')
  @UseGuards(RolesGuard)
  @Roles(UserRole.SUPER_ADMIN, UserRole.TENANT_ADMIN, UserRole.CUSTOMER_USER)
  @ApiOperation({ summary: 'Update asset' })
  @ApiResponse({ status: 200, description: 'Asset updated successfully' })
  async update(
    @CurrentUser() user: User,
    @Param('id') id: string,
    @Body() updateAssetDto: UpdateAssetDto,
  ) {
    const asset = await this.assetsService.update(id, updateAssetDto, user);
    return {
      message: 'Asset updated successfully',
      data: asset,
    };
  }

  @Patch(':id/attributes')
  @UseGuards(RolesGuard)
  @Roles(UserRole.SUPER_ADMIN, UserRole.TENANT_ADMIN, UserRole.CUSTOMER_USER)
  @ApiOperation({ summary: 'Update asset attributes' })
  @ApiResponse({ status: 200, description: 'Attributes updated successfully' })
  async updateAttributes(
    @CurrentUser() user: User,
    @Param('id') id: string,
    @Body() updateAttributesDto: UpdateAttributesDto,
  ) {
    const asset = await this.assetsService.updateAttributes(
      id,
      updateAttributesDto,
      user
    );
    return {
      message: 'Attributes updated successfully',
      data: asset,
    };
  }

  @Delete(':id')
  @UseGuards(RolesGuard)
  @Roles(UserRole.SUPER_ADMIN, UserRole.TENANT_ADMIN)
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Delete asset' })
  @ApiResponse({ status: 204, description: 'Asset deleted successfully' })
  async remove(@Param('id') id: string, @CurrentUser() user: User) {
    await this.assetsService.remove(id, user);
  }
}
