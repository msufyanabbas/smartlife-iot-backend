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
  async create(@Body() createUserDto: CreateUserDto) {
    const user = await this.usersService.create(createUserDto);
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
  async updateProfile(@Request() req, @Body() updateUserDto: UpdateUserDto) {
    // Users can't change their own role or status
    delete updateUserDto.role;
    delete updateUserDto.status;

    const user = await this.usersService.update(req.user.sub, updateUserDto);
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
  async getStatistics() {
    const stats = await this.usersService.getStatistics();
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
  async search(@Query() queryDto: SearchUsersDto) {
    const users = await this.usersService.search(
      queryDto.q,
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
  async inviteUser(@Body() inviteUserDto: InviteUserDto) {
    const user = await this.usersService.inviteUser(inviteUserDto);
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
  async findByTenant(@Param('tenantId') tenantId: string) {
    const users = await this.usersService.findByTenant(tenantId);
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
  @ApiOperation({ summary: 'Bulk assign role to users' })
  @ApiResponse({ status: 200, description: 'Role assigned successfully' })
  async bulkAssignRole(@Body() dto: BulkAssignRoleDto) {
    const result = await this.usersService.bulkAssignRole(dto);
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
  @ApiOperation({ summary: 'Bulk remove role from users' })
  @ApiResponse({ status: 200, description: 'Role removed successfully' })
  async bulkRemoveRole(@Body() dto: BulkRemoveRoleDto) {
    const result = await this.usersService.bulkRemoveRole(dto);
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
  @ApiOperation({ summary: 'Bulk update direct permissions on users' })
  @ApiResponse({ status: 200, description: 'Permissions updated successfully' })
  async bulkUpdatePermissions(@Body() dto: BulkUpdatePermissionsDto) {
    const result = await this.usersService.bulkUpdatePermissions(dto);
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
  async bulkSendEmail(@Body() dto: BulkSendEmailDto) {
    const result = await this.usersService.bulkSendEmail(dto);
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
  async remove(@Param('id') id: string) {
    await this.usersService.remove(id);
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
  async update(@Param('id') id: string, @Body() updateUserDto: UpdateUserDto) {
    const user = await this.usersService.update(id, updateUserDto);
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
    @Param('id') id: string,
    @Body() updateStatusDto: UpdateStatusDto,
  ) {
    const user = await this.usersService.updateStatus(
      id,
      updateStatusDto.status,
    );
    return {
      message: 'Status updated successfully',
      data: user,
    };
  }
}
