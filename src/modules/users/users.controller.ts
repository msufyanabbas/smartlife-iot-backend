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
  ChangePasswordDto,
  ResetPasswordDto,
  ForgotPasswordDto,
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
import { JwtAuthGuard, RolesGuard, ResourceType, SubscriptionLimitGuard } from '@common/guards/index.guards';
import { CurrentUser, RequireSubscriptionLimit } from '@common/decorators/index.decorator';
import { Roles, Audit } from '@common/decorators/index.decorator';
import { UserRole, UserStatus, AuditAction, AuditEntityType, AuditSeverity } from '@common/enums/index.enum';
import { AuditInterceptor } from '@/common/interceptors/index.interceptor';
import { User } from '../index.entities';

@ApiTags('Users')
@Controller('users')
@UseGuards(JwtAuthGuard, RolesGuard, SubscriptionLimitGuard)
// @UseInterceptors(AuditInterceptor)
export class UsersController {
  constructor(private readonly usersService: UsersService) { }

  /**
   * Create a new user
   */
  @Post()
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
  @Audit({
    action: AuditAction.CREATE,
    entityType: AuditEntityType.USER,
    severity: AuditSeverity.INFO,
    description: 'User created',
  })
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
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Get all users' })
  @ApiResponse({ status: 200, description: 'Users retrieved successfully' })
  async findAll(
    @CurrentUser() user: User,
    @Query() queryDto: QueryUsersDto
  ) {
    const result = await this.usersService.findAll({
      page: queryDto.page,
      limit: queryDto.limit,
      search: queryDto.search,
      role: queryDto.role,
      status: queryDto.status,
      tenantId: user.tenantId,
    });
    return {
      message: 'Users retrieved successfully',
      data: result.users,
      meta: {
        total: result.total,
        page: result.page,
        limit: result.limit,
        totalPages: result.totalPages,
      },
    };
  }

  /**
   * Get current user profile
   */
  @Get('me')
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
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Change password' })
  @ApiResponse({ status: 200, description: 'Password changed successfully' })
  @ApiResponse({ status: 401, description: 'Current password is incorrect' })
  async changePassword(
    @Request() req,
    @Body() changePasswordDto: ChangePasswordDto,
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
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Request password reset' })
  @ApiResponse({ status: 200, description: 'Password reset email sent' })
  async forgotPassword(@Body() forgotPasswordDto: ForgotPasswordDto) {
    await this.usersService.forgotPassword(forgotPasswordDto);
    return {
      message: 'If the email exists, a password reset link has been sent',
    };
  }

  /**
   * Reset password
   */
  @Post('reset-password')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Reset password with token' })
  @ApiResponse({ status: 200, description: 'Password reset successfully' })
  @ApiResponse({ status: 400, description: 'Invalid or expired token' })
  async resetPassword(@Body() resetPasswordDto: ResetPasswordDto) {
    await this.usersService.resetPassword(resetPasswordDto);
    return {
      message: 'Password reset successfully',
    };
  }

  /**
   * Verify email
   */
  @Post('verify-email')
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
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Search users' })
  @ApiResponse({ status: 200, description: 'Search results' })
  async search(@Query() queryDto: SearchUsersDto) {
    const users = await this.usersService.search(queryDto.q, queryDto.limit ? +queryDto.limit : 10);
    return {
      message: 'Search completed successfully',
      data: users,
    };
  }

  /**
   * Invite user
   */
  @Post('invite')
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
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(UserRole.SUPER_ADMIN, UserRole.TENANT_ADMIN)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Bulk update user status' })
  @ApiResponse({ status: 200, description: 'Status updated successfully' })
  async bulkUpdateStatus(@Body() bulkUpdateDto: BulkUpdateStatusDto) {
    await this.usersService.bulkUpdateStatus(bulkUpdateDto);
    return {
      message: 'Status updated successfully',
    };
  }

  /**
   * Get users by tenant
   */
  @Get('tenant/:tenantId')
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

  /**
   * Get user by ID
   */
  @Get(':id')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Get user by ID' })
  @ApiResponse({ status: 200, description: 'User retrieved successfully' })
  @ApiResponse({ status: 404, description: 'User not found' })
  async findOne(@Param('id') id: string) {
    const user = await this.usersService.findOne(id);
    return {
      message: 'User retrieved successfully',
      data: user,
    };
  }

  /**
   * Update user by ID
   */
  @Patch(':id')
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
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(UserRole.SUPER_ADMIN, UserRole.TENANT_ADMIN)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Update user status' })
  @ApiResponse({ status: 200, description: 'Status updated successfully' })
  async updateStatus(
    @Param('id') id: string,
    @Body() updateStatusDto: UpdateStatusDto,
  ) {
    const user = await this.usersService.updateStatus(id, updateStatusDto.status);
    return {
      message: 'Status updated successfully',
      data: user,
    };
  }

  /**
   * Delete user
   */
  @Delete(':id')
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

  @Delete('bulk')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(UserRole.SUPER_ADMIN, UserRole.TENANT_ADMIN)
@ApiBearerAuth()
@HttpCode(HttpStatus.OK)
@ApiOperation({ summary: 'Bulk delete users' })
@ApiResponse({ status: 200, description: 'Users deleted successfully' })
async bulkDelete(@Body() dto: BulkDeleteUsersDto) {
  const result = await this.usersService.bulkDelete(dto);
  return { message: 'Users deleted successfully', data: result };
}

@Patch('bulk/assign-role')
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
}
