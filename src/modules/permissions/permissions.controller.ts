import {
  Controller,
  Get,
  Post,
  Body,
  Patch,
  Param,
  Delete,
  HttpCode,
  HttpStatus,
  Query,
} from '@nestjs/common';
import {
  ApiTags,
  ApiOperation,
  ApiResponse,
  ApiParam,
  ApiQuery,
  ApiBearerAuth,
} from '@nestjs/swagger';
import { PermissionsService } from './permissions.service';
import {
  CreatePermissionDto,
  UpdatePermissionDto,
  PermissionResponseDto,
} from './dto';

@ApiTags('Permissions')
@ApiBearerAuth()
@Controller('permissions')
export class PermissionsController {
  constructor(private readonly permissionsService: PermissionsService) {}

  @Post()
  @ApiOperation({ summary: 'Create a new permission' })
  @ApiResponse({
    status: HttpStatus.CREATED,
    description: 'Permission created successfully',
    type: PermissionResponseDto,
  })
  @ApiResponse({
    status: HttpStatus.CONFLICT,
    description: 'Permission already exists',
  })
  @ApiResponse({
    status: HttpStatus.BAD_REQUEST,
    description: 'Invalid input data',
  })
  async create(@Body() createPermissionDto: CreatePermissionDto) {
    return await this.permissionsService.create(createPermissionDto);
  }

  @Post('bulk')
  @ApiOperation({ summary: 'Create multiple permissions at once' })
  @ApiResponse({
    status: HttpStatus.CREATED,
    description: 'Permissions created successfully',
    type: [PermissionResponseDto],
  })
  @ApiResponse({
    status: HttpStatus.CONFLICT,
    description: 'One or more permissions already exist',
  })
  async bulkCreate(@Body() createPermissionDtos: CreatePermissionDto[]) {
    return await this.permissionsService.bulkCreate(createPermissionDtos);
  }

  @Get()
  @ApiOperation({ summary: 'Get all permissions' })
  @ApiQuery({
    name: 'resource',
    required: false,
    description: 'Filter by resource name',
    example: 'devices',
  })
  @ApiResponse({
    status: HttpStatus.OK,
    description: 'List of permissions retrieved successfully',
    type: [PermissionResponseDto],
  })
  async findAll(@Query('resource') resource?: string) {
    if (resource) {
      return await this.permissionsService.findByResource(resource);
    }
    return await this.permissionsService.findAll();
  }

  @Get('resources')
  @ApiOperation({ summary: 'Get all unique resource names' })
  @ApiResponse({
    status: HttpStatus.OK,
    description: 'List of unique resources',
    schema: {
      type: 'array',
      items: { type: 'string' },
      example: ['devices', 'customers', 'dashboards'],
    },
  })
  async getUniqueResources() {
    return await this.permissionsService.getUniqueResources();
  }

  @Get(':id')
  @ApiOperation({ summary: 'Get a permission by ID' })
  @ApiParam({
    name: 'id',
    description: 'Permission ID',
    example: '123e4567-e89b-12d3-a456-426614174000',
  })
  @ApiResponse({
    status: HttpStatus.OK,
    description: 'Permission retrieved successfully',
    type: PermissionResponseDto,
  })
  @ApiResponse({
    status: HttpStatus.NOT_FOUND,
    description: 'Permission not found',
  })
  async findOne(@Param('id') id: string) {
    return await this.permissionsService.findOne(id);
  }

  @Get('search/:resource/:action')
  @ApiOperation({ summary: 'Find permission by resource and action' })
  @ApiParam({
    name: 'resource',
    description: 'Resource name',
    example: 'devices',
  })
  @ApiParam({
    name: 'action',
    description: 'Action name',
    example: 'create',
  })
  @ApiResponse({
    status: HttpStatus.OK,
    description: 'Permission found',
    type: PermissionResponseDto,
  })
  @ApiResponse({
    status: HttpStatus.NOT_FOUND,
    description: 'Permission not found',
  })
  async findByResourceAndAction(
    @Param('resource') resource: string,
    @Param('action') action: string,
  ) {
    return await this.permissionsService.findByResourceAndAction(
      resource,
      action,
    );
  }

  @Patch(':id')
  @ApiOperation({ summary: 'Update a permission' })
  @ApiParam({
    name: 'id',
    description: 'Permission ID',
    example: '123e4567-e89b-12d3-a456-426614174000',
  })
  @ApiResponse({
    status: HttpStatus.OK,
    description: 'Permission updated successfully',
    type: PermissionResponseDto,
  })
  @ApiResponse({
    status: HttpStatus.NOT_FOUND,
    description: 'Permission not found',
  })
  @ApiResponse({
    status: HttpStatus.CONFLICT,
    description: 'Permission with this resource and action already exists',
  })
  async update(
    @Param('id') id: string,
    @Body() updatePermissionDto: UpdatePermissionDto,
  ) {
    return await this.permissionsService.update(id, updatePermissionDto);
  }

  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Delete a permission' })
  @ApiParam({
    name: 'id',
    description: 'Permission ID',
    example: '123e4567-e89b-12d3-a456-426614174000',
  })
  @ApiResponse({
    status: HttpStatus.NO_CONTENT,
    description: 'Permission deleted successfully',
  })
  @ApiResponse({
    status: HttpStatus.NOT_FOUND,
    description: 'Permission not found',
  })
  @ApiResponse({
    status: HttpStatus.BAD_REQUEST,
    description: 'Cannot delete system permissions',
  })
  async remove(@Param('id') id: string) {
    return await this.permissionsService.remove(id);
  }
}