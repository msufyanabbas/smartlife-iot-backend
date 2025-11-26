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
import { DeviceProfilesService } from '../profiles/device-profiles.service';
import { AssetProfilesService } from '../profiles/asset-profiles.service';
import {
  CreateDeviceProfileDto,
  UpdateDeviceProfileDto,
  CreateAssetProfileDto,
  UpdateAssetProfileDto,
  QueryProfilesDto,
} from './dto/profiles.dto';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { RolesGuard } from '../../common/guards/roles.guard';
import { Roles } from '../../common/decorators/roles.decorator';
import { UserRole } from '../users/entities/user.entity';

@ApiTags('Profiles')
@Controller('profiles')
@UseGuards(JwtAuthGuard)
@ApiBearerAuth()
export class ProfilesController {
  constructor(
    private readonly deviceProfilesService: DeviceProfilesService,
    private readonly assetProfilesService: AssetProfilesService,
  ) {}

  // ==================== DEVICE PROFILES ====================

  @Post('device')
  @UseGuards(RolesGuard)
  @Roles(UserRole.SUPER_ADMIN, UserRole.TENANT_ADMIN)
  @ApiOperation({ summary: 'Create device profile' })
  @ApiResponse({ status: 201, description: 'Device profile created' })
  async createDeviceProfile(@Body() createDto: CreateDeviceProfileDto) {
    const profile = await this.deviceProfilesService.create(createDto);
    return {
      message: 'Device profile created successfully',
      data: profile,
    };
  }

  @Get('device')
  @ApiOperation({ summary: 'Get all device profiles' })
  @ApiResponse({ status: 200, description: 'Device profiles retrieved' })
  async findAllDeviceProfiles(@Query() queryDto: QueryProfilesDto) {
    const result = await this.deviceProfilesService.findAll(queryDto);
    return {
      message: 'Device profiles retrieved successfully',
      data: result.profiles,
      meta: {
        total: result.total,
        page: result.page,
        limit: result.limit,
        totalPages: result.totalPages,
      },
    };
  }

  @Get('device/statistics')
  @ApiOperation({ summary: 'Get device profile statistics' })
  @ApiResponse({ status: 200, description: 'Statistics retrieved' })
  async getDeviceProfileStatistics() {
    const stats = await this.deviceProfilesService.getStatistics();
    return {
      message: 'Statistics retrieved successfully',
      data: stats,
    };
  }

  @Get('device/default')
  @ApiOperation({ summary: 'Get default device profile' })
  @ApiQuery({ name: 'tenantId', required: false })
  @ApiResponse({ status: 200, description: 'Default profile retrieved' })
  async getDefaultDeviceProfile(@Query('tenantId') tenantId?: string) {
    const profile = await this.deviceProfilesService.getDefault(tenantId);
    return {
      message: 'Default profile retrieved successfully',
      data: profile,
    };
  }

  @Get('device/:id')
  @ApiOperation({ summary: 'Get device profile by ID' })
  @ApiResponse({ status: 200, description: 'Device profile retrieved' })
  async findOneDeviceProfile(@Param('id') id: string) {
    const profile = await this.deviceProfilesService.findOne(id);
    return {
      message: 'Device profile retrieved successfully',
      data: profile,
    };
  }

  @Get('device/:id/devices')
  @ApiOperation({ summary: 'Get devices using this profile' })
  @ApiResponse({ status: 200, description: 'Devices retrieved' })
  async getDevicesUsingProfile(@Param('id') id: string) {
    const devices = await this.deviceProfilesService.getDevicesUsingProfile(id);
    return {
      message: 'Devices retrieved successfully',
      data: devices,
    };
  }

  @Post('device/:id/validate')
  @ApiOperation({ summary: 'Validate telemetry data against profile' })
  @ApiResponse({ status: 200, description: 'Validation completed' })
  async validateTelemetry(
    @Param('id') id: string,
    @Body() telemetryData: Record<string, any>,
  ) {
    const result = await this.deviceProfilesService.validateTelemetry(
      id,
      telemetryData,
    );
    return {
      message: 'Validation completed',
      data: result,
    };
  }

  @Post('device/:id/clone')
  @UseGuards(RolesGuard)
  @Roles(UserRole.SUPER_ADMIN, UserRole.TENANT_ADMIN)
  @ApiOperation({ summary: 'Clone device profile' })
  @ApiResponse({ status: 201, description: 'Profile cloned' })
  async cloneDeviceProfile(
    @Param('id') id: string,
    @Body('name') name: string,
  ) {
    const profile = await this.deviceProfilesService.clone(id, name);
    return {
      message: 'Device profile cloned successfully',
      data: profile,
    };
  }

  @Patch('device/:id')
  @UseGuards(RolesGuard)
  @Roles(UserRole.SUPER_ADMIN, UserRole.TENANT_ADMIN)
  @ApiOperation({ summary: 'Update device profile' })
  @ApiResponse({ status: 200, description: 'Device profile updated' })
  async updateDeviceProfile(
    @Param('id') id: string,
    @Body() updateDto: UpdateDeviceProfileDto,
  ) {
    const profile = await this.deviceProfilesService.update(id, updateDto);
    return {
      message: 'Device profile updated successfully',
      data: profile,
    };
  }

  @Patch('device/:id/default')
  @UseGuards(RolesGuard)
  @Roles(UserRole.SUPER_ADMIN, UserRole.TENANT_ADMIN)
  @ApiOperation({ summary: 'Set as default device profile' })
  @ApiResponse({ status: 200, description: 'Set as default' })
  async setDefaultDeviceProfile(@Param('id') id: string) {
    const profile = await this.deviceProfilesService.setDefault(id);
    return {
      message: 'Set as default successfully',
      data: profile,
    };
  }

  @Delete('device/:id')
  @UseGuards(RolesGuard)
  @Roles(UserRole.SUPER_ADMIN)
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Delete device profile' })
  @ApiResponse({ status: 204, description: 'Device profile deleted' })
  async removeDeviceProfile(@Param('id') id: string) {
    await this.deviceProfilesService.remove(id);
  }

  // ==================== ASSET PROFILES ====================

  @Post('asset')
  @UseGuards(RolesGuard)
  @Roles(UserRole.SUPER_ADMIN, UserRole.TENANT_ADMIN)
  @ApiOperation({ summary: 'Create asset profile' })
  @ApiResponse({ status: 201, description: 'Asset profile created' })
  async createAssetProfile(@Body() createDto: CreateAssetProfileDto) {
    const profile = await this.assetProfilesService.create(createDto);
    return {
      message: 'Asset profile created successfully',
      data: profile,
    };
  }

  @Get('asset')
  @ApiOperation({ summary: 'Get all asset profiles' })
  @ApiResponse({ status: 200, description: 'Asset profiles retrieved' })
  async findAllAssetProfiles(@Query() queryDto: QueryProfilesDto) {
    const result = await this.assetProfilesService.findAll(queryDto);
    return {
      message: 'Asset profiles retrieved successfully',
      data: result.profiles,
      meta: {
        total: result.total,
        page: result.page,
        limit: result.limit,
        totalPages: result.totalPages,
      },
    };
  }

  @Get('asset/statistics')
  @ApiOperation({ summary: 'Get asset profile statistics' })
  @ApiResponse({ status: 200, description: 'Statistics retrieved' })
  async getAssetProfileStatistics() {
    const stats = await this.assetProfilesService.getStatistics();
    return {
      message: 'Statistics retrieved successfully',
      data: stats,
    };
  }

  @Get('asset/default')
  @ApiOperation({ summary: 'Get default asset profile' })
  @ApiQuery({ name: 'tenantId', required: false })
  @ApiResponse({ status: 200, description: 'Default profile retrieved' })
  async getDefaultAssetProfile(@Query('tenantId') tenantId?: string) {
    const profile = await this.assetProfilesService.getDefault(tenantId);
    return {
      message: 'Default profile retrieved successfully',
      data: profile,
    };
  }

  @Get('asset/:id')
  @ApiOperation({ summary: 'Get asset profile by ID' })
  @ApiResponse({ status: 200, description: 'Asset profile retrieved' })
  async findOneAssetProfile(@Param('id') id: string) {
    const profile = await this.assetProfilesService.findOne(id);
    return {
      message: 'Asset profile retrieved successfully',
      data: profile,
    };
  }

  @Get('asset/:id/assets')
  @ApiOperation({ summary: 'Get assets using this profile' })
  @ApiResponse({ status: 200, description: 'Assets retrieved' })
  async getAssetsUsingProfile(@Param('id') id: string) {
    const assets = await this.assetProfilesService.getAssetsUsingProfile(id);
    return {
      message: 'Assets retrieved successfully',
      data: assets,
    };
  }

  @Post('asset/:id/validate')
  @ApiOperation({ summary: 'Validate asset data against profile' })
  @ApiResponse({ status: 200, description: 'Validation completed' })
  async validateAssetData(
    @Param('id') id: string,
    @Body() assetData: Record<string, any>,
  ) {
    const result = await this.assetProfilesService.validateAssetData(
      id,
      assetData,
    );
    return {
      message: 'Validation completed',
      data: result,
    };
  }

  @Post('asset/:id/clone')
  @UseGuards(RolesGuard)
  @Roles(UserRole.SUPER_ADMIN, UserRole.TENANT_ADMIN)
  @ApiOperation({ summary: 'Clone asset profile' })
  @ApiResponse({ status: 201, description: 'Profile cloned' })
  async cloneAssetProfile(@Param('id') id: string, @Body('name') name: string) {
    const profile = await this.assetProfilesService.clone(id, name);
    return {
      message: 'Asset profile cloned successfully',
      data: profile,
    };
  }

  @Patch('asset/:id')
  @UseGuards(RolesGuard)
  @Roles(UserRole.SUPER_ADMIN, UserRole.TENANT_ADMIN)
  @ApiOperation({ summary: 'Update asset profile' })
  @ApiResponse({ status: 200, description: 'Asset profile updated' })
  async updateAssetProfile(
    @Param('id') id: string,
    @Body() updateDto: UpdateAssetProfileDto,
  ) {
    const profile = await this.assetProfilesService.update(id, updateDto);
    return {
      message: 'Asset profile updated successfully',
      data: profile,
    };
  }

  @Patch('asset/:id/default')
  @UseGuards(RolesGuard)
  @Roles(UserRole.SUPER_ADMIN, UserRole.TENANT_ADMIN)
  @ApiOperation({ summary: 'Set as default asset profile' })
  @ApiResponse({ status: 200, description: 'Set as default' })
  async setDefaultAssetProfile(@Param('id') id: string) {
    const profile = await this.assetProfilesService.setDefault(id);
    return {
      message: 'Set as default successfully',
      data: profile,
    };
  }

  @Delete('asset/:id')
  @UseGuards(RolesGuard)
  @Roles(UserRole.SUPER_ADMIN)
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Delete asset profile' })
  @ApiResponse({ status: 204, description: 'Asset profile deleted' })
  async removeAssetProfile(@Param('id') id: string) {
    await this.assetProfilesService.remove(id);
  }
}
