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
import { AssetProfilesService } from './asset-profiles.service';
import {
  CreateAssetProfileDto,
  UpdateAssetProfileDto,
  QueryProfilesDto,
} from './dto/profiles.dto';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { RolesGuard } from '../../common/guards/roles.guard';
import { Roles } from '../../common/decorators/roles.decorator';
import { UserRole } from '../users/entities/user.entity';

@ApiTags('Asset Profiles')
@Controller('profiles/asset')
@UseGuards(JwtAuthGuard)
@ApiBearerAuth()
export class AssetProfilesController {
  constructor(private readonly assetProfilesService: AssetProfilesService) {}

  @Post()
  @UseGuards(RolesGuard)
  @Roles(UserRole.SUPER_ADMIN, UserRole.TENANT_ADMIN)
  @ApiOperation({ summary: 'Create asset profile' })
  @ApiResponse({ status: 201, description: 'Asset profile created' })
  async create(@Body() createDto: CreateAssetProfileDto) {
    const profile = await this.assetProfilesService.create(createDto);
    return {
      message: 'Asset profile created successfully',
      data: profile,
    };
  }

  @Get()
  @ApiOperation({ summary: 'Get all asset profiles' })
  @ApiResponse({ status: 200, description: 'Asset profiles retrieved' })
  async findAll(@Query() queryDto: QueryProfilesDto) {
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

  @Get('statistics')
  @ApiOperation({ summary: 'Get asset profile statistics' })
  @ApiResponse({ status: 200, description: 'Statistics retrieved' })
  async getStatistics() {
    const stats = await this.assetProfilesService.getStatistics();
    return {
      message: 'Statistics retrieved successfully',
      data: stats,
    };
  }

  @Get('default')
  @ApiOperation({ summary: 'Get default asset profile' })
  @ApiQuery({ name: 'tenantId', required: false })
  @ApiResponse({ status: 200, description: 'Default profile retrieved' })
  async getDefault(@Query('tenantId') tenantId?: string) {
    const profile = await this.assetProfilesService.getDefault(tenantId);
    return {
      message: 'Default profile retrieved successfully',
      data: profile,
    };
  }

  @Get(':id')
  @ApiOperation({ summary: 'Get asset profile by ID' })
  @ApiResponse({ status: 200, description: 'Asset profile retrieved' })
  async findOne(@Param('id') id: string) {
    const profile = await this.assetProfilesService.findOne(id);
    return {
      message: 'Asset profile retrieved successfully',
      data: profile,
    };
  }

  @Get(':id/assets')
  @ApiOperation({ summary: 'Get assets using this profile' })
  @ApiResponse({ status: 200, description: 'Assets retrieved' })
  async getAssetsUsingProfile(@Param('id') id: string) {
    const assets = await this.assetProfilesService.getAssetsUsingProfile(id);
    return {
      message: 'Assets retrieved successfully',
      data: assets,
    };
  }

  @Get(':id/usage')
  @ApiOperation({ summary: 'Get detailed profile usage information' })
  @ApiResponse({ status: 200, description: 'Usage information retrieved' })
  async getUsage(@Param('id') id: string) {
    const usage = await this.assetProfilesService.getProfileUsage(id);
    return {
      message: 'Profile usage retrieved successfully',
      data: usage,
    };
  }

  @Get(':id/export')
  @ApiOperation({ summary: 'Export asset profile configuration' })
  @ApiResponse({ status: 200, description: 'Profile exported' })
  async exportProfile(@Param('id') id: string) {
    const exported = await this.assetProfilesService.exportProfile(id);
    return {
      message: 'Profile exported successfully',
      data: exported,
    };
  }

  @Post('import')
  @UseGuards(RolesGuard)
  @Roles(UserRole.SUPER_ADMIN, UserRole.TENANT_ADMIN)
  @ApiOperation({ summary: 'Import asset profile configuration' })
  @ApiResponse({ status: 201, description: 'Profile imported' })
  async importProfile(
    @Body() profileData: any,
    @Query('tenantId') tenantId?: string,
  ) {
    const profile = await this.assetProfilesService.importProfile(
      profileData,
      tenantId,
    );
    return {
      message: 'Profile imported successfully',
      data: profile,
    };
  }

  @Post(':id/validate')
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

  @Post(':id/calculate')
  @ApiOperation({ summary: 'Calculate field values based on profile' })
  @ApiResponse({ status: 200, description: 'Calculation completed' })
  async calculateFields(
    @Param('id') id: string,
    @Body() attributes: Record<string, any>,
  ) {
    const calculated = await this.assetProfilesService.calculateFields(
      id,
      attributes,
    );
    return {
      message: 'Fields calculated successfully',
      data: calculated,
    };
  }

  @Post(':id/clone')
  @UseGuards(RolesGuard)
  @Roles(UserRole.SUPER_ADMIN, UserRole.TENANT_ADMIN)
  @ApiOperation({ summary: 'Clone asset profile' })
  @ApiResponse({ status: 201, description: 'Profile cloned' })
  async clone(@Param('id') id: string, @Body('name') name: string) {
    const profile = await this.assetProfilesService.clone(id, name);
    return {
      message: 'Asset profile cloned successfully',
      data: profile,
    };
  }

  @Patch(':id')
  @UseGuards(RolesGuard)
  @Roles(UserRole.SUPER_ADMIN, UserRole.TENANT_ADMIN)
  @ApiOperation({ summary: 'Update asset profile' })
  @ApiResponse({ status: 200, description: 'Asset profile updated' })
  async update(
    @Param('id') id: string,
    @Body() updateDto: UpdateAssetProfileDto,
  ) {
    const profile = await this.assetProfilesService.update(id, updateDto);
    return {
      message: 'Asset profile updated successfully',
      data: profile,
    };
  }

  @Patch(':id/default')
  @UseGuards(RolesGuard)
  @Roles(UserRole.SUPER_ADMIN, UserRole.TENANT_ADMIN)
  @ApiOperation({ summary: 'Set as default asset profile' })
  @ApiResponse({ status: 200, description: 'Set as default' })
  async setDefault(@Param('id') id: string) {
    const profile = await this.assetProfilesService.setDefault(id);
    return {
      message: 'Set as default successfully',
      data: profile,
    };
  }

  @Delete(':id')
  @UseGuards(RolesGuard)
  // @Roles(UserRole.SUPER_ADMIN)
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Delete asset profile' })
  @ApiResponse({ status: 204, description: 'Asset profile deleted' })
  async remove(@Param('id') id: string) {
    await this.assetProfilesService.remove(id);
  }


  
}