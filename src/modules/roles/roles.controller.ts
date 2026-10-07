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
  UseGuards,
} from '@nestjs/common';
import {
  ApiTags,
  ApiOperation,
  ApiResponse,
  ApiParam,
  ApiQuery,
  ApiBearerAuth,
} from '@nestjs/swagger';
import { RolesService } from './roles.service';
import { CreateRoleDto } from './dto/create-role.dto';
import { UpdateRoleDto } from './dto/update-role.dto';
import { QueryRoleDto } from './dto/query-role.dto';
import { AssignPermissionsDto } from './dto/assign-permissions.dto';
import { User } from '../index.entities';
import { CurrentUser } from '@/common/decorators/current-user.decorator';
import { JwtAuthGuard } from '@common/guards/jwt-auth.guard';
import { RolesGuard } from '@common/guards/roles.guard';
import { Roles } from '@common/decorators/roles.decorator';
import { RequirePermissions } from '@common/decorators/permission.decorator';
import { UserRole } from '@common/enums/index.enum';

/**
 * ─────────────────────────────────────────────────────────────────────────────
 * Roles — RBAC administration.
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * SECURITY: this controller previously had NO authorization whatsoever — no
 * `@UseGuards`, no `@Roles`, no `@RequirePermissions`, on the class or on any
 * handler. Because `RolesGuard.canActivate()` returns true when no `ROLES_KEY`
 * metadata is present, and `PermissionGuard` has nothing to enforce without
 * `@RequirePermissions`, the only check left was "is there a valid JWT".
 *
 * That made this a privilege-escalation route: any authenticated user —
 * including a CUSTOMER_USER — could
 *
 *     PATCH /roles/<id of a role they hold>  { "permissionIds": [ ...every id... ] }
 *
 * and grant themselves the whole permission catalogue. `GET /roles` is scoped by
 * tenant so the ids were not simply listed, but `GET /roles/system` returned
 * system roles with their ids, and `update()` never checked tenant either (fixed
 * in RolesService).
 *
 * Writes are therefore restricted to SUPER_ADMIN and TENANT_ADMIN. A CUSTOMER may
 * read roles — the Users & Roles screens need the list — but cannot alter them.
 *
 * On `@RequirePermissions` here: PermissionGuard bypasses SUPER_ADMIN and
 * TENANT_ADMIN entirely, so on the write routes it adds nothing today and is
 * declarative only. It does bite on the read routes for CUSTOMER and
 * CUSTOMER_USER, which is the intent.
 */
@ApiTags('Roles')
@ApiBearerAuth()
@Controller('roles')
@UseGuards(JwtAuthGuard, RolesGuard)
export class RolesController {
  constructor(private readonly rolesService: RolesService) {}

  @Post()
  @Roles(UserRole.SUPER_ADMIN, UserRole.TENANT_ADMIN)
  @RequirePermissions('roles:create')
  @ApiOperation({ summary: 'Create a new role' })
  @ApiResponse({ status: 201, description: 'Role created successfully' })
  @ApiResponse({ status: 400, description: 'Bad request' })
  @ApiResponse({ status: 409, description: 'Role already exists' })
  create(@CurrentUser() user: User, @Body() createRoleDto: CreateRoleDto) {
    return this.rolesService.create(createRoleDto, user);
  }

  @Get()
  @Roles(
    UserRole.SUPER_ADMIN,
    UserRole.TENANT_ADMIN,
    UserRole.CUSTOMER,
    UserRole.CUSTOMER_USER,
    UserRole.USER,
  )
  @RequirePermissions('roles:list')
  @ApiOperation({ summary: 'Get all roles with filtering and pagination' })
  @ApiResponse({ status: 200, description: 'Roles retrieved successfully' })
  findAll(@CurrentUser() user: User, @Query() queryDto: QueryRoleDto) {
    return this.rolesService.findAll(queryDto, user);
  }

  @Get('system')
  @Roles(
    UserRole.SUPER_ADMIN,
    UserRole.TENANT_ADMIN,
    UserRole.CUSTOMER,
    UserRole.CUSTOMER_USER,
    UserRole.USER,
  )
  @RequirePermissions('roles:read')
  @ApiOperation({ summary: 'Get all system roles' })
  @ApiResponse({ status: 200, description: 'System roles retrieved successfully' })
  getSystemRoles() {
    return this.rolesService.getSystemRoles();
  }

  @Get('tenant/:tenantId')
  @Roles(
    UserRole.SUPER_ADMIN,
    UserRole.TENANT_ADMIN,
    UserRole.CUSTOMER,
    UserRole.CUSTOMER_USER,
    UserRole.USER,
  )
  @RequirePermissions('roles:read')
  @ApiOperation({ summary: 'Get all roles for a specific tenant' })
  @ApiParam({ name: 'tenantId', type: 'string', format: 'uuid' })
  @ApiResponse({ status: 200, description: 'Tenant roles retrieved successfully' })
  @ApiResponse({ status: 404, description: 'Tenant not found' })
  getTenantRoles(@Param('tenantId', ParseUUIDPipe) tenantId: string) {
    return this.rolesService.getTenantRoles(tenantId);
  }

  @Get(':id')
  @Roles(
    UserRole.SUPER_ADMIN,
    UserRole.TENANT_ADMIN,
    UserRole.CUSTOMER,
    UserRole.CUSTOMER_USER,
    UserRole.USER,
  )
  @RequirePermissions('roles:read')
  @ApiOperation({ summary: 'Get a role by ID' })
  @ApiParam({ name: 'id', type: 'string', format: 'uuid' })
  @ApiResponse({ status: 200, description: 'Role retrieved successfully' })
  @ApiResponse({ status: 404, description: 'Role not found' })
  findOne(@CurrentUser() user: User, @Param('id', ParseUUIDPipe) id: string) {
    return this.rolesService.findOne(id, user);
  }

  @Get(':id/users')
  @Roles(
    UserRole.SUPER_ADMIN,
    UserRole.TENANT_ADMIN,
    UserRole.CUSTOMER,
    UserRole.CUSTOMER_USER,
    UserRole.USER,
  )
  @RequirePermissions('roles:read')
  @ApiOperation({ summary: 'Get users assigned to this role and their count' })
  @ApiParam({ name: 'id', type: 'string', format: 'uuid' })
  @ApiResponse({ status: 200, description: 'Users retrieved successfully' })
  @ApiResponse({ status: 404, description: 'Role not found' })
  getUsersCount(
    @CurrentUser() user: User,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.rolesService.getUsersCount(id, user);
  }

  @Patch(':id')
  @Roles(UserRole.SUPER_ADMIN, UserRole.TENANT_ADMIN)
  @RequirePermissions('roles:update')
  @ApiOperation({ summary: 'Update a role' })
  @ApiParam({ name: 'id', type: 'string', format: 'uuid' })
  @ApiResponse({ status: 200, description: 'Role updated successfully' })
  @ApiResponse({ status: 400, description: 'Bad request' })
  @ApiResponse({ status: 404, description: 'Role not found' })
  @ApiResponse({ status: 409, description: 'Role name already exists' })
  update(
    @CurrentUser() user: User,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() updateRoleDto: UpdateRoleDto,
  ) {
    return this.rolesService.update(id, updateRoleDto, user);
  }

  @Delete(':id')
  @Roles(UserRole.SUPER_ADMIN, UserRole.TENANT_ADMIN)
  @RequirePermissions('roles:delete')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Delete a role' })
  @ApiParam({ name: 'id', type: 'string', format: 'uuid' })
  @ApiResponse({ status: 204, description: 'Role deleted successfully' })
  @ApiResponse({ status: 400, description: 'Cannot delete system role or role with users' })
  @ApiResponse({ status: 404, description: 'Role not found' })
  remove(@CurrentUser() user: User, @Param('id', ParseUUIDPipe) id: string) {
    return this.rolesService.remove(id, user);
  }

  @Post(':id/permissions')
  @Roles(UserRole.SUPER_ADMIN, UserRole.TENANT_ADMIN)
  @RequirePermissions('roles:update')
  @ApiOperation({ summary: 'Assign permissions to a role' })
  @ApiParam({ name: 'id', type: 'string', format: 'uuid' })
  @ApiResponse({ status: 200, description: 'Permissions assigned successfully' })
  @ApiResponse({ status: 400, description: 'Invalid permission IDs' })
  @ApiResponse({ status: 404, description: 'Role not found' })
  assignPermissions(
    @CurrentUser() user: User,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() assignPermissionsDto: AssignPermissionsDto,
  ) {
    return this.rolesService.assignPermissions(id, assignPermissionsDto, user);
  }

  @Delete(':id/permissions')
  @Roles(UserRole.SUPER_ADMIN, UserRole.TENANT_ADMIN)
  @RequirePermissions('roles:update')
  @ApiOperation({ summary: 'Remove permissions from a role' })
  @ApiParam({ name: 'id', type: 'string', format: 'uuid' })
  @ApiQuery({ name: 'permissionIds', type: 'string', isArray: true })
  @ApiResponse({ status: 200, description: 'Permissions removed successfully' })
  @ApiResponse({ status: 404, description: 'Role not found' })
  removePermissions(
    @CurrentUser() user: User,
    @Param('id', ParseUUIDPipe) id: string,
    @Query('permissionIds') permissionIds: string | string[],
  ) {
    const ids = Array.isArray(permissionIds) ? permissionIds : [permissionIds];
    return this.rolesService.removePermissions(id, ids, user);
  }
}