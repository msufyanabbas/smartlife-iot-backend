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
import { DeviceProfilesService } from './device-profiles.service';
import { AssetProfilesService } from './asset-profiles.service';
import {
  CreateDeviceProfileDto,
  UpdateDeviceProfileDto,
  QueryProfilesDto,
} from './dto/device-profiles.dto';
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
}
