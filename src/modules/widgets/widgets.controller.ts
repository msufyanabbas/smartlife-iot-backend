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
import { WidgetTypesService } from './widget-types.service';
import { WidgetBundlesService } from './widget-bundles.service';
import {
  CreateWidgetTypeDto,
  UpdateWidgetTypeDto,
  QueryWidgetTypesDto,
  CreateWidgetBundleDto,
  UpdateWidgetBundleDto,
  QueryWidgetBundlesDto,
  CloneWidgetTypeDto,
  ImportWidgetTypeDto,
} from './dto/widgets.dto';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { RolesGuard } from '../../common/guards/roles.guard';
import { Roles } from '../../common/decorators/roles.decorator';
import { UserRole } from '@common/enums/index.enum'
import { WidgetTypeCategory } from './entities/widget-type.entity';

@ApiTags('Widgets')
@Controller('widgets')
@UseGuards(JwtAuthGuard)
@ApiBearerAuth()
export class WidgetsController {
  constructor(
    private readonly widgetTypesService: WidgetTypesService,
    private readonly widgetBundlesService: WidgetBundlesService,
  ) {}

  // ==================== WIDGET TYPES ====================

  @Post('types')
  @UseGuards(RolesGuard)
  @Roles(UserRole.SUPER_ADMIN, UserRole.TENANT_ADMIN)
  @ApiOperation({ summary: 'Create widget type' })
  @ApiResponse({ status: 201, description: 'Widget type created' })
  async createWidgetType(@Body() createDto: CreateWidgetTypeDto) {
    const widgetType = await this.widgetTypesService.create(createDto);
    return {
      message: 'Widget type created successfully',
      data: widgetType,
    };
  }

  @Get('types')
  @ApiOperation({ summary: 'Get all widget types' })
  @ApiResponse({ status: 200, description: 'Widget types retrieved' })
  async findAllWidgetTypes(@Query() queryDto: QueryWidgetTypesDto) {
    const result = await this.widgetTypesService.findAll(queryDto);
    return {
      message: 'Widget types retrieved successfully',
      data: result.widgetTypes,
      meta: {
        total: result.total,
        page: result.page,
        limit: result.limit,
        totalPages: result.totalPages,
      },
    };
  }

  @Get('types/statistics')
  @ApiOperation({ summary: 'Get widget type statistics' })
  @ApiResponse({ status: 200, description: 'Statistics retrieved' })
  async getWidgetTypeStatistics() {
    const stats = await this.widgetTypesService.getStatistics();
    return {
      message: 'Statistics retrieved successfully',
      data: stats,
    };
  }

  @Get('types/category/:category')
  @ApiOperation({ summary: 'Get widget types by category' })
  @ApiResponse({ status: 200, description: 'Widget types retrieved' })
  async findWidgetTypesByCategory(
    @Param('category') category: WidgetTypeCategory,
  ) {
    const widgetTypes = await this.widgetTypesService.findByCategory(category);
    return {
      message: 'Widget types retrieved successfully',
      data: widgetTypes,
    };
  }

  @Get('types/bundle/:bundleFqn')
  @ApiOperation({ summary: 'Get widget types by bundle' })
  @ApiResponse({ status: 200, description: 'Widget types retrieved' })
  async findWidgetTypesByBundle(@Param('bundleFqn') bundleFqn: string) {
    const widgetTypes = await this.widgetTypesService.findByBundle(bundleFqn);
    return {
      message: 'Widget types retrieved successfully',
      data: widgetTypes,
    };
  }

  @Get('types/:id')
  @ApiOperation({ summary: 'Get widget type by ID' })
  @ApiResponse({ status: 200, description: 'Widget type retrieved' })
  async findOneWidgetType(@Param('id') id: string) {
    const widgetType = await this.widgetTypesService.findOne(id);
    return {
      message: 'Widget type retrieved successfully',
      data: widgetType,
    };
  }

  @Get('types/:id/export')
  @ApiOperation({ summary: 'Export widget type to JSON' })
  @ApiResponse({ status: 200, description: 'Widget type exported' })
  async exportWidgetType(@Param('id') id: string) {
    const exportData = await this.widgetTypesService.exportWidget(id);
    return {
      message: 'Widget type exported successfully',
      data: exportData,
    };
  }

  @Post('types/import')
  @UseGuards(RolesGuard)
  @Roles(UserRole.SUPER_ADMIN, UserRole.TENANT_ADMIN)
  @ApiOperation({ summary: 'Import widget type from JSON' })
  @ApiResponse({ status: 201, description: 'Widget type imported' })
  async importWidgetType(@Body() importDto: ImportWidgetTypeDto) {
    const widgetType = await this.widgetTypesService.importWidget(importDto.widgetData);
    return {
      message: 'Widget type imported successfully',
      data: widgetType,
    };
  }

  @Post('types/:id/clone')
  @UseGuards(RolesGuard)
  @Roles(UserRole.SUPER_ADMIN, UserRole.TENANT_ADMIN)
  @ApiOperation({ summary: 'Clone widget type' })
  @ApiResponse({ status: 201, description: 'Widget type cloned' })
  async cloneWidgetType(@Param('id') id: string, @Body() cloneDto: CloneWidgetTypeDto) {
    const widgetType = await this.widgetTypesService.clone(id, cloneDto.name);
    return {
      message: 'Widget type cloned successfully',
      data: widgetType,
    };
  }

  @Patch('types/:id')
  @UseGuards(RolesGuard)
  @Roles(UserRole.SUPER_ADMIN, UserRole.TENANT_ADMIN)
  @ApiOperation({ summary: 'Update widget type' })
  @ApiResponse({ status: 200, description: 'Widget type updated' })
  async updateWidgetType(
    @Param('id') id: string,
    @Body() updateDto: UpdateWidgetTypeDto,
  ) {
    const widgetType = await this.widgetTypesService.update(id, updateDto);
    return {
      message: 'Widget type updated successfully',
      data: widgetType,
    };
  }

  @Delete('types/:id')
  @UseGuards(RolesGuard)
  @Roles(UserRole.SUPER_ADMIN)
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Delete widget type' })
  @ApiResponse({ status: 204, description: 'Widget type deleted' })
  async removeWidgetType(@Param('id') id: string) {
    await this.widgetTypesService.remove(id);
  }

  // ==================== WIDGET BUNDLES ====================

  @Post('bundles')
  @UseGuards(RolesGuard)
  @Roles(UserRole.SUPER_ADMIN, UserRole.TENANT_ADMIN)
  @ApiOperation({ summary: 'Create widget bundle' })
  @ApiResponse({ status: 201, description: 'Widget bundle created' })
  async createWidgetBundle(@Body() createDto: CreateWidgetBundleDto) {
    const bundle = await this.widgetBundlesService.create(createDto);
    return {
      message: 'Widget bundle created successfully',
      data: bundle,
    };
  }

  @Get('bundles')
  @ApiOperation({ summary: 'Get all widget bundles' })
  @ApiResponse({ status: 200, description: 'Widget bundles retrieved' })
  async findAllWidgetBundles(@Query() queryDto: QueryWidgetBundlesDto) {
    const result = await this.widgetBundlesService.findAll(queryDto);
    return {
      message: 'Widget bundles retrieved successfully',
      data: result.bundles,
      meta: {
        total: result.total,
        page: result.page,
        limit: result.limit,
        totalPages: result.totalPages,
      },
    };
  }

  @Get('bundles/statistics')
  @ApiOperation({ summary: 'Get widget bundle statistics' })
  @ApiResponse({ status: 200, description: 'Statistics retrieved' })
  async getWidgetBundleStatistics() {
    const stats = await this.widgetBundlesService.getStatistics();
    return {
      message: 'Statistics retrieved successfully',
      data: stats,
    };
  }

  @Get('bundles/:id')
  @ApiOperation({ summary: 'Get widget bundle by ID' })
  @ApiResponse({ status: 200, description: 'Widget bundle retrieved' })
  async findOneWidgetBundle(@Param('id') id: string) {
    const bundle = await this.widgetBundlesService.findOne(id);
    return {
      message: 'Widget bundle retrieved successfully',
      data: bundle,
    };
  }

  @Get('bundles/:id/widgets')
  @ApiOperation({ summary: 'Get widgets in bundle' })
  @ApiResponse({ status: 200, description: 'Widgets retrieved' })
  async getWidgetsInBundle(@Param('id') id: string) {
    const widgets = await this.widgetBundlesService.getWidgetsInBundle(id);
    return {
      message: 'Widgets retrieved successfully',
      data: widgets,
    };
  }

  @Post('bundles/:id/widgets/:widgetId')
  @UseGuards(RolesGuard)
  @Roles(UserRole.SUPER_ADMIN, UserRole.TENANT_ADMIN)
  @ApiOperation({ summary: 'Add widget to bundle' })
  @ApiResponse({ status: 200, description: 'Widget added to bundle' })
  async addWidgetToBundle(
    @Param('id') id: string,
    @Param('widgetId') widgetId: string,
  ) {
    await this.widgetBundlesService.addWidgetToBundle(id, widgetId);
    return {
      message: 'Widget added to bundle successfully',
    };
  }

  @Delete('bundles/:id/widgets/:widgetId')
  @UseGuards(RolesGuard)
  @Roles(UserRole.SUPER_ADMIN, UserRole.TENANT_ADMIN)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Remove widget from bundle' })
  @ApiResponse({ status: 200, description: 'Widget removed from bundle' })
  async removeWidgetFromBundle(
    @Param('id') id: string,
    @Param('widgetId') widgetId: string,
  ) {
    await this.widgetBundlesService.removeWidgetFromBundle(id, widgetId);
    return {
      message: 'Widget removed from bundle successfully',
    };
  }

  @Patch('bundles/:id')
  @UseGuards(RolesGuard)
  @Roles(UserRole.SUPER_ADMIN, UserRole.TENANT_ADMIN)
  @ApiOperation({ summary: 'Update widget bundle' })
  @ApiResponse({ status: 200, description: 'Widget bundle updated' })
  async updateWidgetBundle(
    @Param('id') id: string,
    @Body() updateDto: UpdateWidgetBundleDto,
  ) {
    const bundle = await this.widgetBundlesService.update(id, updateDto);
    return {
      message: 'Widget bundle updated successfully',
      data: bundle,
    };
  }

  @Delete('bundles/:id')
  @UseGuards(RolesGuard)
  @Roles(UserRole.SUPER_ADMIN)
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Delete widget bundle' })
  @ApiResponse({ status: 204, description: 'Widget bundle deleted' })
  async removeWidgetBundle(@Param('id') id: string) {
    await this.widgetBundlesService.remove(id);
  }
}
