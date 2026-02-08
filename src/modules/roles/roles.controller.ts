import {
  Controller,
  Get,
  Post,
  Body,
  Patch,
  Param,
  Delete,
  Query,
  HttpCode,
  HttpStatus,
  ParseUUIDPipe,
} from '@nestjs/common';
import { ApiTags, ApiOperation, ApiResponse, ApiParam, ApiQuery } from '@nestjs/swagger';
import { RolesService } from './roles.service';
import { CreateRoleDto } from './dto/create-role.dto';
import { UpdateRoleDto } from './dto/update-role.dto';
import { QueryRoleDto } from './dto/query-role.dto';
import { AssignPermissionsDto } from './dto/assign-permissions.dto';

@ApiTags('Roles')
@Controller('roles')
export class RolesController {
  constructor(private readonly rolesService: RolesService) {}

  @Post()
  @ApiOperation({ summary: 'Create a new role' })
  @ApiResponse({ status: 201, description: 'Role created successfully' })
  @ApiResponse({ status: 400, description: 'Bad request' })
  @ApiResponse({ status: 409, description: 'Role already exists' })
  create(@Body() createRoleDto: CreateRoleDto) {
    return this.rolesService.create(createRoleDto);
  }

  @Get()
  @ApiOperation({ summary: 'Get all roles with filtering and pagination' })
  @ApiResponse({ status: 200, description: 'Roles retrieved successfully' })
  findAll(@Query() queryDto: QueryRoleDto) {
    return this.rolesService.findAll(queryDto);
  }

  @Get('system')
  @ApiOperation({ summary: 'Get all system roles' })
  @ApiResponse({ status: 200, description: 'System roles retrieved successfully' })
  getSystemRoles() {
    return this.rolesService.getSystemRoles();
  }

  @Get('tenant/:tenantId')
  @ApiOperation({ summary: 'Get all roles for a specific tenant' })
  @ApiParam({ name: 'tenantId', type: 'string', format: 'uuid' })
  @ApiResponse({ status: 200, description: 'Tenant roles retrieved successfully' })
  @ApiResponse({ status: 404, description: 'Tenant not found' })
  getTenantRoles(@Param('tenantId', ParseUUIDPipe) tenantId: string) {
    return this.rolesService.getTenantRoles(tenantId);
  }

  @Get(':id')
  @ApiOperation({ summary: 'Get a role by ID' })
  @ApiParam({ name: 'id', type: 'string', format: 'uuid' })
  @ApiResponse({ status: 200, description: 'Role retrieved successfully' })
  @ApiResponse({ status: 404, description: 'Role not found' })
  findOne(@Param('id', ParseUUIDPipe) id: string) {
    return this.rolesService.findOne(id);
  }

  @Get(':id/users-count')
  @ApiOperation({ summary: 'Get the number of users assigned to this role' })
  @ApiParam({ name: 'id', type: 'string', format: 'uuid' })
  @ApiResponse({ status: 200, description: 'User count retrieved successfully' })
  @ApiResponse({ status: 404, description: 'Role not found' })
  getUsersCount(@Param('id', ParseUUIDPipe) id: string) {
    return this.rolesService.getUsersCount(id);
  }

  @Patch(':id')
  @ApiOperation({ summary: 'Update a role' })
  @ApiParam({ name: 'id', type: 'string', format: 'uuid' })
  @ApiResponse({ status: 200, description: 'Role updated successfully' })
  @ApiResponse({ status: 400, description: 'Bad request' })
  @ApiResponse({ status: 404, description: 'Role not found' })
  @ApiResponse({ status: 409, description: 'Role name already exists' })
  update(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() updateRoleDto: UpdateRoleDto,
  ) {
    return this.rolesService.update(id, updateRoleDto);
  }

  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Delete a role' })
  @ApiParam({ name: 'id', type: 'string', format: 'uuid' })
  @ApiResponse({ status: 204, description: 'Role deleted successfully' })
  @ApiResponse({ status: 400, description: 'Cannot delete system role or role with users' })
  @ApiResponse({ status: 404, description: 'Role not found' })
  remove(@Param('id', ParseUUIDPipe) id: string) {
    return this.rolesService.remove(id);
  }

  @Post(':id/permissions')
  @ApiOperation({ summary: 'Assign permissions to a role' })
  @ApiParam({ name: 'id', type: 'string', format: 'uuid' })
  @ApiResponse({ status: 200, description: 'Permissions assigned successfully' })
  @ApiResponse({ status: 400, description: 'Invalid permission IDs' })
  @ApiResponse({ status: 404, description: 'Role not found' })
  assignPermissions(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() assignPermissionsDto: AssignPermissionsDto,
  ) {
    return this.rolesService.assignPermissions(id, assignPermissionsDto);
  }

  @Delete(':id/permissions')
  @ApiOperation({ summary: 'Remove permissions from a role' })
  @ApiParam({ name: 'id', type: 'string', format: 'uuid' })
  @ApiQuery({ name: 'permissionIds', type: 'string', isArray: true })
  @ApiResponse({ status: 200, description: 'Permissions removed successfully' })
  @ApiResponse({ status: 404, description: 'Role not found' })
  removePermissions(
    @Param('id', ParseUUIDPipe) id: string,
    @Query('permissionIds') permissionIds: string | string[],
  ) {
    const ids = Array.isArray(permissionIds) ? permissionIds : [permissionIds];
    return this.rolesService.removePermissions(id, ids);
  }
}