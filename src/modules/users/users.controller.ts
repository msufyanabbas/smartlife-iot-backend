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
  Request,
  HttpCode,
  HttpStatus,
  UseInterceptors,
} from '@nestjs/common';
import {
  ApiTags,
  ApiOperation,
  ApiResponse,
  ApiBearerAuth,
  ApiQuery,
} from '@nestjs/swagger';
import { UsersService } from '@modules/users/users.service';
import {
  CreateUserDto,
  UpdateUserDto,
  UserChangePasswordDto,
  UserResetPasswordDto,
  UserForgotPasswordDto,
  VerifyEmailDto,
  UpdatePreferencesDto,
  BulkUpdateStatusDto,
  InviteUserDto,
  QueryUsersDto,
  SearchUsersDto,
  UpdateStatusDto,
  BulkSendNotificationDto,
  BulkSendEmailDto,
  BulkUpdatePermissionsDto,
  BulkRemoveRoleDto,
  BulkAssignRoleDto,
  BulkDeleteUsersDto,
  AssignRoleDto,
} from './dto/users.dto';
import {
  BulkDeleteUsersByIdDto,
  BulkUpdateUsersDto,
} from './dto/bulk-user.dto';
import { BulkResultDto } from '@common/dto/bulk-operation.dto';
import {
  JwtAuthGuard,
  RolesGuard,
  ResourceType,
  SubscriptionLimitGuard,
} from '@common/guards/index.guards';
import {
  CurrentUser,
  RequireSubscriptionLimit,
} from '@common/decorators/index.decorator';
import { Roles, Audit } from '@common/decorators/index.decorator';
import {
  UserRole,
  UserStatus,
  AuditAction,
  AuditEntityType,
  AuditSeverity,
} from '@common/enums/index.enum';
import { AuditInterceptor } from '@/common/interceptors/index.interceptor';
import { User } from '../index.entities';
import { RequirePermissions } from '@common/decorators/permission.decorator';

@ApiTags('Users')
@Controller('users')
@UseGuards(JwtAuthGuard, RolesGuard, SubscriptionLimitGuard)
// @UseInterceptors(AuditInterceptor)
export class UsersController {
  constructor(private readonly usersService: UsersService) {}

  /**
   * Create a new user
   */
  @Post()
  @RequirePermissions('users:create')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(UserRole.SUPER_ADMIN, UserRole.TENANT_ADMIN)
  @RequireSubscriptionLimit({
    resource: 'users',
    // operation: 'create',
  })
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Create a new user' })
  @ApiResponse({ status: 201, description: 'User created successfully' })
  @ApiResponse({ status: 409, description: 'User already exists' })
  // No @Audit() here on purpose. `UsersService.create()` emits `user.created`,
  // which AuditEventsService turns into the row — and that event also fires
  // for the callers that never reach this controller. Decorating the route as
  // well produced two audit rows for one created user.
  async create(
    @CurrentUser() actor: User,
    @Body() createUserDto: CreateUserDto,
  ) {
    // The actor is the point. This handler took no @CurrentUser() at all and
    // the service trusted `role` and `tenantId` out of the body, so anyone
    // holding `users:create` could mint a `super_admin` or create an account
    // inside another tenant by putting it in the JSON. @Roles gates WHO may
    // call this; only the actor can gate WHAT they may create.
    const user = await this.usersService.create(createUserDto, actor);
    return {
      message: 'User created successfully',
      data: user,
    };
  }

  /**
   * Get all users with pagination and filters
   */
  @Get()
  @RequirePermissions('users:list')
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Get all users' })
  @ApiResponse({ status: 200, description: 'Users retrieved successfully' })
  async findAll(@CurrentUser() user: User, @Query() queryDto: QueryUsersDto) {
    // Returned as-is: the service already produces the standard
    // { data, meta } PaginatedResponseDto envelope.
    return this.usersService.findAll({
      page: queryDto.page,
      limit: queryDto.limit,
      search: queryDto.search,
      role: queryDto.role,
      status: queryDto.status,
      tenantId: user.tenantId,
    });
  }

  /**
   * Get current user profile
   */
  @Get('me')
  @RequirePermissions('users:list')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Get current user profile' })
  @ApiResponse({ status: 200, description: 'Profile retrieved successfully' })
  async getProfile(@Request() req) {
    const user = await this.usersService.findOne(req.user.sub);
    return {
      message: 'Profile retrieved successfully',
      data: user,
    };
  }

  /**
   * Update current user profile
   */
  @Patch('me')
  @Audit({
    action: AuditAction.UPDATE,
    entityType: AuditEntityType.USER,
  })
  @RequirePermissions('users:update')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Update current user profile' })
  @ApiResponse({ status: 200, description: 'Profile updated successfully' })
  async updateProfile(
    @Request() req,
    @CurrentUser() actor: User,
    @Body() updateUserDto: UpdateUserDto,
  ) {
    // Users can't change their own role, status or tenant. `update()` now
    // enforces the first two against the actor as well; stripping them here
    // keeps the self-service route honest about what it accepts.
    delete updateUserDto.role;
    delete updateUserDto.status;
    delete (updateUserDto as Partial<UpdateUserDto>).tenantId;

    const user = await this.usersService.update(
      req.user.sub,
      updateUserDto,
      actor,
    );
    return {
      message: 'Profile updated successfully',
      data: user,
    };
  }

  /**
   * Change password
   */
  @Post('change-password')
  @RequirePermissions('users:create')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Change password' })
  @ApiResponse({ status: 200, description: 'Password changed successfully' })
  @ApiResponse({ status: 401, description: 'Current password is incorrect' })
  async changePassword(
    @Request() req,
    @Body() changePasswordDto: UserChangePasswordDto,
  ) {
    await this.usersService.changePassword(req.user.sub, changePasswordDto);
    return {
      message: 'Password changed successfully',
    };
  }

  /**
   * Forgot password
   */
  @Post('forgot-password')
  @Audit({
    action: AuditAction.PASSWORD_RESET,
    entityType: AuditEntityType.USER,
    severity: AuditSeverity.WARNING,
  })
  @RequirePermissions('users:create')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Request password reset' })
  @ApiResponse({ status: 200, description: 'Password reset email sent' })
  async forgotPassword(@Body() forgotPasswordDto: UserForgotPasswordDto) {
    await this.usersService.forgotPassword(forgotPasswordDto);
    return {
      message: 'If the email exists, a password reset link has been sent',
    };
  }

  /**
   * Reset password
   */
  @Post('reset-password')
  @Audit({
    action: AuditAction.PASSWORD_RESET,
    entityType: AuditEntityType.USER,
    severity: AuditSeverity.WARNING,
  })
  @RequirePermissions('users:create')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Reset password with token' })
  @ApiResponse({ status: 200, description: 'Password reset successfully' })
  @ApiResponse({ status: 400, description: 'Invalid or expired token' })
  async resetPassword(@Body() resetPasswordDto: UserResetPasswordDto) {
    await this.usersService.resetPassword(resetPasswordDto);
    return {
      message: 'Password reset successfully',
    };
  }

  /**
   * Verify email
   */
  @Post('verify-email')
  @Audit({
    action: AuditAction.EMAIL_VERIFY,
    entityType: AuditEntityType.USER,
  })
  @RequirePermissions('users:create')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Verify email with token' })
  @ApiResponse({ status: 200, description: 'Email verified successfully' })
  @ApiResponse({ status: 400, description: 'Invalid verification token' })
  async verifyEmail(@Body() verifyEmailDto: VerifyEmailDto) {
    await this.usersService.verifyEmail(verifyEmailDto.token);
    return {
      message: 'Email verified successfully',
    };
  }

  /**
   * Resend verification email
   */
  @Post('resend-verification')
  @Audit({
    action: AuditAction.EMAIL_VERIFY,
    entityType: AuditEntityType.USER,
  })
  @RequirePermissions('users:create')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Resend verification email' })
  @ApiResponse({ status: 200, description: 'Verification email sent' })
  async resendVerification(@Request() req) {
    await this.usersService.resendVerificationEmail(req.user.sub);
    return {
      message: 'Verification email sent',
    };
  }

  /**
   * Update preferences
   */
  @Patch('me/preferences')
  @Audit({
    action: AuditAction.UPDATE,
    entityType: AuditEntityType.USER,
  })
  @RequirePermissions('users:update')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Update user preferences' })
  @ApiResponse({ status: 200, description: 'Preferences updated successfully' })
  async updatePreferences(
    @Request() req,
    @Body() updatePreferencesDto: UpdatePreferencesDto,
  ) {
    const user = await this.usersService.updatePreferences(
      req.user.sub,
      updatePreferencesDto,
    );
    return {
      message: 'Preferences updated successfully',
      data: user.preferences,
    };
  }

  /**
   * Get user statistics
   */
  @Get('statistics')
  @RequirePermissions('users:list')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(UserRole.SUPER_ADMIN, UserRole.TENANT_ADMIN)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Get user statistics' })
  @ApiResponse({
    status: 200,
    description: 'Statistics retrieved successfully',
  })
  async getStatistics(@CurrentUser() actor: User) {
    // Scoped: these counts were platform-wide, so a tenant admin's dashboard
    // reported every other tenant's user numbers.
    const stats = await this.usersService.getStatistics(actor);
    return {
      message: 'Statistics retrieved successfully',
      data: stats,
    };
  }

  /**
   * Search users
   */
  @Get('search')
  @RequirePermissions('users:list')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Search users' })
  @ApiResponse({ status: 200, description: 'Search results' })
  async search(@CurrentUser() actor: User, @Query() queryDto: SearchUsersDto) {
    // Scoped to the caller. This route had no @Roles and the service had no
    // tenant predicate, so any authenticated account could enumerate every
    // user on the platform.
    const users = await this.usersService.search(
      queryDto.q,
      actor,
      queryDto.limit ? +queryDto.limit : 10,
    );
    return {
      message: 'Search completed successfully',
      data: users,
    };
  }

  /**
   * Invite user
   */
  @Post('invite')
  @Audit({
    action: AuditAction.NOTIFICATION_SENT,
    entityType: AuditEntityType.USER,
  })
  @RequirePermissions('users:create')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(UserRole.SUPER_ADMIN, UserRole.TENANT_ADMIN)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Invite a new user' })
  @ApiResponse({ status: 201, description: 'User invited successfully' })
  async inviteUser(
    @CurrentUser() actor: User,
    @Body() inviteUserDto: InviteUserDto,
  ) {
    // Same hole as POST /users: InviteUserDto carries `role` and `tenantId`
    // and this goes through UsersService.create().
    const user = await this.usersService.inviteUser(inviteUserDto, actor);
    return {
      message: 'User invited successfully',
      data: user,
    };
  }

  /**
   * Bulk update status
   */
  @Patch('bulk/status')
  @Audit({
    action: AuditAction.STATUS_CHANGE,
    entityType: AuditEntityType.USER,
  })
  @RequirePermissions('users:update')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(UserRole.SUPER_ADMIN, UserRole.TENANT_ADMIN)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Bulk update user status' })
  @ApiResponse({ status: 200, description: 'Status updated successfully' })
  async bulkUpdateStatus(
    @CurrentUser() user: User,
    @Body() bulkUpdateDto: BulkUpdateStatusDto,
  ) {
    await this.usersService.bulkUpdateStatus(bulkUpdateDto, user);
    return {
      message: 'Status updated successfully',
    };
  }

  // ── Bulk operations (declared before ':id' so 'bulk' is not read as an id) ─

  @Post('bulk/delete')
  @Audit({
    action: AuditAction.DELETE,
    entityType: AuditEntityType.USER,
    severity: AuditSeverity.WARNING,
  })
  @RequirePermissions('users:delete')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(UserRole.SUPER_ADMIN, UserRole.TENANT_ADMIN)
  @ApiBearerAuth()
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Bulk soft-delete users (max 100 per request)',
    description:
      'Partial success is the normal outcome: always answers 200 with one entry ' +
      'per requested id in `outcomes`, so the caller sees exactly which ids ' +
      'failed and why. Every id is re-resolved against the caller\'s own ' +
      'tenantId server-side; an id belonging to another tenant comes back as ' +
      '`not_found` and is NOT deleted. At most 100 ids — more is a 400. ' +
      'Deletes are soft (`deleted_at` is set).\n\n' +
      'BLOCKS: your own account, any SUPER_ADMIN, and the tenant\'s last ' +
      'remaining TENANT_ADMIN (which would leave the tenant with no ' +
      'administrator).\n\n' +
      'COUNTERS: `subscriptions.usage.users` is decremented once per tenant for ' +
      'the number actually deleted — POST /users is gated on that counter, so ' +
      'skipping it would lock a tenant out of quota it owns.\n\n' +
      'CASCADES: a `user.deleted` event per deleted user, so a CUSTOMER-role ' +
      "user's paired Customer row is removed exactly as it is on the " +
      'single-user delete. Notifications addressed to the user are kept.\n\n' +
      'One transaction per id, so a blocked or failing id never rolls back the ' +
      'others.',
  })
  @ApiResponse({ status: 200, description: 'Per-id outcomes', type: BulkResultDto })
  @ApiResponse({ status: 400, description: 'More than 100 ids, or a malformed id' })
  async bulkDeleteByIds(
    @CurrentUser() user: User,
    @Body() dto: BulkDeleteUsersByIdDto,
  ) {
    return this.usersService.bulkDelete(dto, user);
  }

  @Patch('bulk')
  @Audit({
    action: AuditAction.UPDATE,
    entityType: AuditEntityType.USER,
  })
  @RequirePermissions('users:update')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(UserRole.SUPER_ADMIN, UserRole.TENANT_ADMIN)
  @ApiBearerAuth()
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Bulk update users (max 100 per request)',
    description:
      'Applies the same narrow patch to every listed user and returns one ' +
      'outcome per id. ONLY `status` and `customerId` are bulk-updatable. ' +
      '`role`, `password`, `tenantId` and `email` are rejected by validation ' +
      'on purpose: a bulk role write could promote 100 accounts to ' +
      'TENANT_ADMIN, a bulk password write is an account-takeover primitive, ' +
      '`tenantId` is the security boundary of the platform, and `email` is the ' +
      'unique login identifier and reset-token destination. Use ' +
      'PATCH /users/:id for those, one reviewable change at a time.\n\n' +
      'Send `null` for `customerId` to detach; omit a field to leave it alone. ' +
      'The target customer must belong to the caller\'s tenant (404 otherwise). ' +
      'Every id is re-resolved against the caller\'s tenant — a foreign id is ' +
      '`not_found` and untouched. A user already in the requested state is ' +
      '`skipped` and counts as a success.\n\n' +
      'BLOCKS when deactivating: your own account, and the tenant\'s last ' +
      'active TENANT_ADMIN. One transaction per id. Max 100 ids.',
  })
  @ApiResponse({ status: 200, description: 'Per-id outcomes', type: BulkResultDto })
  @ApiResponse({
    status: 400,
    description: 'More than 100 ids, a malformed id, or no updatable field supplied',
  })
  @ApiResponse({ status: 404, description: 'Target customer not in your tenant' })
  async bulkUpdate(
    @CurrentUser() user: User,
    @Body() dto: BulkUpdateUsersDto,
  ) {
    return this.usersService.bulkUpdate(dto, user);
  }

  /**
   * Get users by tenant
   */
  @Get('tenant/:tenantId')
  @RequirePermissions('users:read')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(UserRole.SUPER_ADMIN, UserRole.TENANT_ADMIN)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Get users by tenant' })
  @ApiResponse({ status: 200, description: 'Users retrieved successfully' })
  async findByTenant(
    @CurrentUser() actor: User,
    @Param('tenantId') tenantId: string,
  ) {
    // The tenant came from the URL unchecked, so a tenant admin could list
    // another tenant's users by editing the path. The service pins a
    // non-super-admin to their own tenant whatever is asked for.
    const users = await this.usersService.findByTenant(tenantId, actor);
    return {
      message: 'Users retrieved successfully',
      data: users,
    };
  }

  /**
   * Get admin users
   */
  @Get('admins/list')
  @RequirePermissions('users:list')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(UserRole.SUPER_ADMIN)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Get all admin users' })
  @ApiResponse({ status: 200, description: 'Admin users retrieved' })
  async findAdmins() {
    const admins = await this.usersService.findAdmins();
    return {
      message: 'Admin users retrieved successfully',
      data: admins,
    };
  }

  @Delete('bulk')
  @Audit({
    action: AuditAction.DELETE,
    entityType: AuditEntityType.USER,
    severity: AuditSeverity.WARNING,
  })
  @RequirePermissions('users:delete')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(UserRole.SUPER_ADMIN, UserRole.TENANT_ADMIN)
  @ApiBearerAuth()
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: '[Deprecated] Bulk delete users',
    deprecated: true,
    description:
      'Kept for existing clients. Use POST /users/bulk/delete, which reports ' +
      'per-id outcomes instead of a single count. This route now goes through ' +
      'the same tenant-scoped implementation — it previously deleted by ' +
      '`id IN (...)` with no tenant predicate at all.',
  })
  @ApiResponse({ status: 200, description: 'Users deleted successfully' })
  async bulkDelete(
    @CurrentUser() user: User,
    @Body() dto: BulkDeleteUsersDto,
  ) {
    const result = await this.usersService.bulkDeleteLegacy(dto, user);
    return { message: 'Users deleted successfully', data: result };
  }

  @Patch('bulk/assign-role')
  @Audit({
    action: AuditAction.ROLE_CHANGE,
    entityType: AuditEntityType.USER,
    severity: AuditSeverity.WARNING,
  })
  @RequirePermissions('users:update')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(UserRole.SUPER_ADMIN, UserRole.TENANT_ADMIN)
  @ApiBearerAuth()
  @ApiOperation({
    summary: 'Bulk assign a role to users',
    description:
      'Both the role and every user id are re-resolved against the caller\'s ' +
      'own tenant server-side. An id outside that scope REFUSES the whole ' +
      'request with 404 rather than being skipped — a skip reported ' +
      '`updated: n` and showed the administrator a success for a role change ' +
      'that never happened.\n\n' +
      'Assignable roles are the caller\'s own tenant\'s custom roles plus the ' +
      'platform system roles, EXCEPT any role carrying `tenants:*` or ' +
      '`billing:*`, which is 403: assigning such a role would hand the ' +
      'caller those permissions transitively via a throwaway account.\n\n' +
      'For one user use POST /users/:id/roles.',
  })
  @ApiResponse({ status: 200, description: 'Role assigned successfully' })
  @ApiResponse({ status: 403, description: 'The role grants platform-level permissions' })
  @ApiResponse({ status: 404, description: 'The role, or one of the users, is not in your scope' })
  async bulkAssignRole(
    @CurrentUser() actor: User,
    @Body() dto: BulkAssignRoleDto,
  ) {
    const result = await this.usersService.bulkAssignRole(dto, actor);
    return { message: 'Role assigned successfully', data: result };
  }

  @Patch('bulk/remove-role')
  @Audit({
    action: AuditAction.ROLE_CHANGE,
    entityType: AuditEntityType.USER,
    severity: AuditSeverity.WARNING,
  })
  @RequirePermissions('users:update')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(UserRole.SUPER_ADMIN, UserRole.TENANT_ADMIN)
  @ApiBearerAuth()
  @ApiOperation({
    summary: 'Bulk remove a role from users',
    description:
      'Same tenant scoping and same refuse-rather-than-skip behaviour as ' +
      'bulk/assign-role. The platform-resource ceiling is NOT applied here: ' +
      'removing a role only narrows what a user can do, and a de-escalation ' +
      'that cannot be performed would leave a bad grant permanent.\n\n' +
      'For one user use DELETE /users/:id/roles/:roleId.',
  })
  @ApiResponse({ status: 200, description: 'Role removed successfully' })
  @ApiResponse({ status: 404, description: 'The role, or one of the users, is not in your scope' })
  async bulkRemoveRole(
    @CurrentUser() actor: User,
    @Body() dto: BulkRemoveRoleDto,
  ) {
    const result = await this.usersService.bulkRemoveRole(dto, actor);
    return { message: 'Role removed successfully', data: result };
  }

  @Patch('bulk/permissions')
  @Audit({
    action: AuditAction.PERMISSION_CHANGE,
    entityType: AuditEntityType.USER,
    severity: AuditSeverity.WARNING,
  })
  @RequirePermissions('users:update')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(UserRole.SUPER_ADMIN, UserRole.TENANT_ADMIN)
  @ApiBearerAuth()
  @ApiOperation({
    summary: 'Bulk update direct permissions on users',
    description:
      'Both the permission ids and the user ids are re-resolved against the ' +
      'caller\'s own tenant, and an id outside that scope refuses the whole ' +
      'request rather than being skipped.\n\n' +
      '`add` and `replace` grant, so they are limited to system permissions ' +
      'and the caller\'s own tenant\'s custom ones, and reject `tenants:*` / ' +
      '`billing:*` with 403. `remove` only narrows, so it requires the ids to ' +
      'exist but applies neither limit — otherwise a grant made before this ' +
      'scoping existed could never be taken back.',
  })
  @ApiResponse({ status: 200, description: 'Permissions updated successfully' })
  @ApiResponse({ status: 400, description: 'A permission id is unknown or not available to your tenant' })
  @ApiResponse({ status: 403, description: 'A permission is platform-level' })
  @ApiResponse({ status: 404, description: 'One of the users is not in your scope' })
  async bulkUpdatePermissions(
    @CurrentUser() actor: User,
    @Body() dto: BulkUpdatePermissionsDto,
  ) {
    const result = await this.usersService.bulkUpdatePermissions(dto, actor);
    return { message: 'Permissions updated successfully', data: result };
  }

  @Post('bulk/send-email')
  @Audit({
    action: AuditAction.NOTIFICATION_SENT,
    entityType: AuditEntityType.USER,
  })
  @RequirePermissions('users:create')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(UserRole.SUPER_ADMIN, UserRole.TENANT_ADMIN)
  @ApiBearerAuth()
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Bulk send email to users' })
  @ApiResponse({ status: 200, description: 'Emails sent' })
  async bulkSendEmail(
    @CurrentUser() actor: User,
    @Body() dto: BulkSendEmailDto,
  ) {
    const result = await this.usersService.bulkSendEmail(dto, actor);
    return { message: 'Emails processed', data: result };
  }

  @Post('bulk/send-notification')
  @Audit({
    action: AuditAction.NOTIFICATION_SENT,
    entityType: AuditEntityType.USER,
  })
  @RequirePermissions('users:create')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(UserRole.SUPER_ADMIN, UserRole.TENANT_ADMIN)
  @ApiBearerAuth()
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Bulk send in-app notification to users' })
  @ApiResponse({ status: 200, description: 'Notifications sent' })
  async bulkSendNotification(@Body() dto: BulkSendNotificationDto) {
    const result = await this.usersService.bulkSendNotification(dto);
    return { message: 'Notifications sent', data: result };
  }

  /**
   * Delete user
   */
  @Delete(':id')
  @RequirePermissions('users:delete')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(UserRole.SUPER_ADMIN, UserRole.TENANT_ADMIN)
  @ApiBearerAuth()
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Delete user' })
  @ApiResponse({ status: 204, description: 'User deleted successfully' })
  @ApiResponse({ status: 404, description: 'User not found' })
  async remove(@CurrentUser() actor: User, @Param('id') id: string) {
    await this.usersService.remove(id, actor);
  }

  /**
   * Get user by ID
   */
  @Get(':id')
  @RequirePermissions('users:read')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @ApiBearerAuth()
  @ApiOperation({
    summary: 'Get user by ID',
    description:
      'Scoped to the caller: SUPER_ADMIN sees any user, everyone else only ' +
      'users in their own tenant (and customer, for customer-scoped roles). ' +
      'A user outside that scope answers 404, not 403, so the endpoint cannot ' +
      'be used to confirm that an id exists elsewhere.',
  })
  @ApiResponse({ status: 200, description: 'User retrieved successfully' })
  @ApiResponse({ status: 404, description: 'User not found' })
  async findOne(@Param('id') id: string, @CurrentUser() caller: User) {
    // Was `usersService.findOne(id)` with no @Roles on the handler, which
    // RolesGuard treats as "open to every authenticated user" — so any
    // CUSTOMER_USER could read any user row in any tenant by id.
    const user = await this.usersService.findOneScoped(id, caller);
    return {
      message: 'User retrieved successfully',
      data: user,
    };
  }

  /**
   * Update user by ID
   */
  @Patch(':id')
  @RequirePermissions('users:update')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(UserRole.SUPER_ADMIN, UserRole.TENANT_ADMIN)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Update user by ID' })
  @ApiResponse({ status: 200, description: 'User updated successfully' })
  @ApiResponse({ status: 404, description: 'User not found' })
  async update(
    @CurrentUser() actor: User,
    @Param('id') id: string,
    @Body() updateUserDto: UpdateUserDto,
  ) {
    const user = await this.usersService.update(id, updateUserDto, actor);
    return {
      message: 'User updated successfully',
      data: user,
    };
  }

  /**
   * Update user status
   */
  @Patch(':id/status')
  @Audit({
    action: AuditAction.STATUS_CHANGE,
    entityType: AuditEntityType.USER,
  })
  @RequirePermissions('users:update')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(UserRole.SUPER_ADMIN, UserRole.TENANT_ADMIN)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Update user status' })
  @ApiResponse({ status: 200, description: 'Status updated successfully' })
  async updateStatus(
    @CurrentUser() actor: User,
    @Param('id') id: string,
    @Body() updateStatusDto: UpdateStatusDto,
  ) {
    const user = await this.usersService.updateStatus(
      id,
      updateStatusDto.status,
      actor,
    );
    return {
      message: 'Status updated successfully',
      data: user,
    };
  }

  // ── Single-user role assignment ───────────────────────────────────────────
  //
  // ROUTE ORDER (§4o): both of these are declared LAST, after every literal
  // route on this controller. Nest matches in declaration order and `:id`
  // matches one segment, so `POST :id/roles` cannot capture `bulk/delete`,
  // `bulk/send-email` or `bulk/send-notification` (their second segment is
  // not `roles`) and cannot be captured by them either. Declaring it above
  // them would be the trap that made `POST /devices/batch` and
  // `GET /audit/modules/:module` dead code — a literal segment ALWAYS goes
  // first, whether or not a collision exists today, because the next literal
  // route someone adds is the one that collides.
  //
  // These two exist because the bulk routes were the only way to assign a
  // role: the frontend's only path to "give this user this role" was
  // tick-a-checkbox → Bulk edit → Role management, which users could not
  // find. The scoping and the cache invalidation are not reimplemented here —
  // both go through the same UsersService helpers and the same writer as the
  // bulk versions, so the two paths cannot drift apart.

  @Post(':id/roles')
  @Audit({
    action: AuditAction.ROLE_CHANGE,
    entityType: AuditEntityType.USER,
    severity: AuditSeverity.WARNING,
  })
  @RequirePermissions('users:update')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(UserRole.SUPER_ADMIN, UserRole.TENANT_ADMIN)
  @ApiBearerAuth()
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Assign a role to one user',
    description:
      'The single-user form of PATCH /users/bulk/assign-role, with identical ' +
      'scoping: the user and the role are both re-resolved against the ' +
      "caller's own tenant, assignable roles are the caller's tenant's own " +
      'plus the platform system roles, and a role carrying `tenants:*` or ' +
      '`billing:*` is 403 because assigning it would hand the caller those ' +
      'permissions through the account they assigned it to.\n\n' +
      'Idempotent: assigning a role the user already holds is a 200 and ' +
      'changes nothing. `users:update`, not `users:create` — this edits an ' +
      'existing user.',
  })
  @ApiResponse({ status: 200, description: 'Role assigned' })
  @ApiResponse({ status: 403, description: 'The role grants platform-level permissions' })
  @ApiResponse({ status: 404, description: 'The user or the role is not in your scope' })
  async assignRole(
    @CurrentUser() actor: User,
    @Param('id') id: string,
    @Body() dto: AssignRoleDto,
  ) {
    const result = await this.usersService.assignRole(id, dto.roleId, actor);
    return { message: 'Role assigned successfully', data: result };
  }

  @Delete(':id/roles/:roleId')
  @Audit({
    action: AuditAction.ROLE_CHANGE,
    entityType: AuditEntityType.USER,
    severity: AuditSeverity.WARNING,
  })
  @RequirePermissions('users:update')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(UserRole.SUPER_ADMIN, UserRole.TENANT_ADMIN)
  @ApiBearerAuth()
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Remove a role from one user',
    description:
      'The single-user form of PATCH /users/bulk/remove-role. Same tenant ' +
      'scoping; the platform-resource ceiling is not applied, because ' +
      'removing a role only narrows what the user can do and a de-escalation ' +
      'must never be refusable.\n\n' +
      'Idempotent: removing a role the user does not hold is a 200. ' +
      '`users:update`, not `users:delete` — this edits a user, it does not ' +
      'delete one (§4k).',
  })
  @ApiResponse({ status: 200, description: 'Role removed' })
  @ApiResponse({ status: 404, description: 'The user or the role is not in your scope' })
  async removeRole(
    @CurrentUser() actor: User,
    @Param('id') id: string,
    @Param('roleId') roleId: string,
  ) {
    const result = await this.usersService.removeRole(id, roleId, actor);
    return { message: 'Role removed successfully', data: result };
  }
}
