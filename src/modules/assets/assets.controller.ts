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
import { UserRole } from '../users/entities/user.entity';
import { AssetType } from './entities/asset.entity';

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
  async create(@Body() createAssetDto: CreateAssetDto) {
    const asset = await this.assetsService.create(createAssetDto);
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
  @ApiQuery({ name: 'assetProfileId', required: false })
  @ApiQuery({ name: 'parentAssetId', required: false })
  @ApiQuery({ name: 'active', required: false, type: Boolean })
  @ApiQuery({ name: 'page', required: false, type: Number })
  @ApiQuery({ name: 'limit', required: false, type: Number })
  @ApiResponse({ status: 200, description: 'Assets retrieved successfully' })
  async findAll(@Query() queryDto: QueryAssetsDto) {
    const result = await this.assetsService.findAll(queryDto);
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
  async getStatistics() {
    const stats = await this.assetsService.getStatistics();
    return {
      message: 'Statistics retrieved successfully',
      data: stats,
    };
  }

  @Get('roots')
  @ApiOperation({ summary: 'Get root assets (no parent)' })
  @ApiResponse({ status: 200, description: 'Root assets retrieved' })
  async getRootAssets() {
    const assets = await this.assetsService.getRootAssets();
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
    @Query('latitude') latitude: number,
    @Query('longitude') longitude: number,
    @Query('radius') radius: number,
  ) {
    const assets = await this.assetsService.searchByLocation(
      +latitude,
      +longitude,
      +radius,
    );
    return {
      message: 'Assets found',
      data: assets,
    };
  }

  @Get(':id')
  @ApiOperation({ summary: 'Get asset by ID' })
  @ApiResponse({ status: 200, description: 'Asset retrieved successfully' })
  @ApiResponse({ status: 404, description: 'Asset not found' })
  async findOne(@Param('id') id: string) {
    const asset = await this.assetsService.findOne(id);
    return {
      message: 'Asset retrieved successfully',
      data: asset,
    };
  }

  @Get(':id/hierarchy')
  @ApiOperation({ summary: 'Get asset hierarchy (children tree)' })
  @ApiQuery({ name: 'maxDepth', required: false, type: Number })
  @ApiQuery({ name: 'includeDevices', required: false, type: Boolean })
  @ApiResponse({ status: 200, description: 'Hierarchy retrieved' })
  async getHierarchy(@Param('id') id: string, @Query() dto: AssetHierarchyDto) {
    const hierarchy = await this.assetsService.getHierarchy(
      id,
      dto.maxDepth,
      dto.includeDevices,
    );
    return {
      message: 'Hierarchy retrieved successfully',
      data: hierarchy,
    };
  }

  @Get(':id/path')
  @ApiOperation({ summary: 'Get asset path (from root to asset)' })
  @ApiResponse({ status: 200, description: 'Path retrieved' })
  async getPath(@Param('id') id: string) {
    const path = await this.assetsService.getAssetPath(id);
    return {
      message: 'Asset path retrieved successfully',
      data: path,
    };
  }

  @Get(':id/children')
  @ApiOperation({ summary: 'Get direct child assets' })
  @ApiResponse({ status: 200, description: 'Children retrieved' })
  async getChildren(@Param('id') id: string) {
    const children = await this.assetsService.getChildren(id);
    return {
      message: 'Child assets retrieved successfully',
      data: children,
    };
  }

  @Get(':id/devices')
  @ApiOperation({ summary: 'Get devices assigned to asset' })
  @ApiResponse({ status: 200, description: 'Devices retrieved' })
  async getDevices(@Param('id') id: string) {
    const devices = await this.assetsService.getDevices(id);
    return {
      message: 'Devices retrieved successfully',
      data: devices,
    };
  }

  @Post(':id/devices')
  @UseGuards(RolesGuard)
  @Roles(UserRole.SUPER_ADMIN, UserRole.TENANT_ADMIN)
  @ApiOperation({ summary: 'Assign device to asset' })
  @ApiResponse({ status: 200, description: 'Device assigned successfully' })
  async assignDevice(
    @Param('id') id: string,
    @Body() assignDeviceDto: AssignDeviceDto,
  ) {
    await this.assetsService.assignDevice(id, assignDeviceDto.deviceId);
    return {
      message: 'Device assigned successfully',
    };
  }

  @Post(':id/devices/bulk')
  @UseGuards(RolesGuard)
  @Roles(UserRole.SUPER_ADMIN, UserRole.TENANT_ADMIN)
  @ApiOperation({ summary: 'Bulk assign devices to asset' })
  @ApiResponse({ status: 200, description: 'Devices assigned successfully' })
  async bulkAssignDevices(
    @Param('id') id: string,
    @Body() bulkAssignDto: BulkAssignDevicesDto,
  ) {
    await this.assetsService.bulkAssignDevices(id, bulkAssignDto.deviceIds);
    return {
      message: 'Devices assigned successfully',
    };
  }

  @Delete(':id/devices/:deviceId')
  @UseGuards(RolesGuard)
  @Roles(UserRole.SUPER_ADMIN, UserRole.TENANT_ADMIN)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Unassign device from asset' })
  @ApiResponse({ status: 200, description: 'Device unassigned successfully' })
  async unassignDevice(
    @Param('id') id: string,
    @Param('deviceId') deviceId: string,
  ) {
    await this.assetsService.unassignDevice(id, deviceId);
    return {
      message: 'Device unassigned successfully',
    };
  }

  @Patch(':id')
  @UseGuards(RolesGuard)
  @Roles(UserRole.SUPER_ADMIN, UserRole.TENANT_ADMIN)
  @ApiOperation({ summary: 'Update asset' })
  @ApiResponse({ status: 200, description: 'Asset updated successfully' })
  async update(
    @Param('id') id: string,
    @Body() updateAssetDto: UpdateAssetDto,
  ) {
    const asset = await this.assetsService.update(id, updateAssetDto);
    return {
      message: 'Asset updated successfully',
      data: asset,
    };
  }

  @Patch(':id/attributes')
  @UseGuards(RolesGuard)
  @Roles(UserRole.SUPER_ADMIN, UserRole.TENANT_ADMIN)
  @ApiOperation({ summary: 'Update asset attributes' })
  @ApiResponse({ status: 200, description: 'Attributes updated successfully' })
  async updateAttributes(
    @Param('id') id: string,
    @Body() updateAttributesDto: UpdateAttributesDto,
  ) {
    const asset = await this.assetsService.updateAttributes(
      id,
      updateAttributesDto,
    );
    return {
      message: 'Attributes updated successfully',
      data: asset,
    };
  }

  @Delete(':id')
  @UseGuards(RolesGuard)
  @Roles(UserRole.SUPER_ADMIN)
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Delete asset' })
  @ApiResponse({ status: 204, description: 'Asset deleted successfully' })
  async remove(@Param('id') id: string) {
    await this.assetsService.remove(id);
  }
}
