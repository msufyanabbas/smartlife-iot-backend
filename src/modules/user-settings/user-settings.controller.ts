import {
  Controller,
  Get,
  Put,
  Post,
  Body,
  UseGuards,
  HttpCode,
  HttpStatus,
} from '@nestjs/common';
import {
  ApiTags,
  ApiOperation,
  ApiResponse,
  ApiBearerAuth,
} from '@nestjs/swagger';
import { UserSettingsService } from './user-settings.service';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { User } from '../users/entities/user.entity';
import {
  UpdateGeneralSettingsDto,
  UpdateNotificationSettingsDto,
  UpdateDisplaySettingsDto,
  UpdateUserSettingsDto,
  UserSettingsResponseDto,
  UpdateDashboardLayoutDto,
  UpdateWidgetPreferencesDto,
  SettingsMessageResponseDto,
} from './dto/user-settings.dto';
import { RequirePermissions } from '@common/decorators/permission.decorator';
import { Audit } from '@common/decorators/audit.decorator';
import { AuditAction, AuditEntityType, AuditSeverity } from '@common/enums/index.enum';

@ApiTags('User Settings')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller('settings')
export class UserSettingsController {
  constructor(private readonly userSettingsService: UserSettingsService) {}

  // ==================== GET SETTINGS ====================

  @Get()
  @RequirePermissions('settings:read')
  @ApiOperation({ summary: 'Get user settings' })
  @ApiResponse({
    status: 200,
    description: 'User settings retrieved successfully',
    type: UserSettingsResponseDto,
  })
  async getSettings(@CurrentUser() user: User): Promise<UserSettingsResponseDto> {
    return this.userSettingsService.getSettings(user.id);
  }

  // ==================== UPDATE GENERAL SETTINGS ====================

  @Put('general')
  @Audit({
    action: AuditAction.UPDATE,
    entityType: AuditEntityType.SETTINGS,
    description: 'update user setting',
  })
  @RequirePermissions('settings:update')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ 
    summary: 'Update general settings',
    description: 'Update language, theme, auto-refresh, and compact mode settings'
  })
  @ApiResponse({
    status: 200,
    description: 'General settings updated successfully',
    type: UserSettingsResponseDto,
  })
  async updateGeneralSettings(
    @CurrentUser() user: User,
    @Body() updateDto: UpdateGeneralSettingsDto,
  ): Promise<UserSettingsResponseDto> {
    return this.userSettingsService.updateGeneralSettings(user.id, updateDto);
  }

  // ==================== UPDATE NOTIFICATION SETTINGS ====================

  @Put('notifications')
  @Audit({
    action: AuditAction.UPDATE,
    entityType: AuditEntityType.SETTINGS,
    description: 'update user setting',
  })
  @RequirePermissions('settings:update')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ 
    summary: 'Update notification preferences',
    description: 'Configure email, alarm, device status, and weekly report notifications'
  })
  @ApiResponse({
    status: 200,
    description: 'Notification settings updated successfully',
    type: UserSettingsResponseDto,
  })
  async updateNotificationSettings(
    @CurrentUser() user: User,
    @Body() updateDto: UpdateNotificationSettingsDto,
  ): Promise<UserSettingsResponseDto> {
    return this.userSettingsService.updateNotificationSettings(user.id, updateDto);
  }

  // ==================== UPDATE DISPLAY SETTINGS ====================

  @Put('display')
  @Audit({
    action: AuditAction.UPDATE,
    entityType: AuditEntityType.SETTINGS,
    description: 'update user setting',
  })
  @RequirePermissions('settings:update')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ 
    summary: 'Update display settings',
    description: 'Configure time format, date format, and timezone'
  })
  @ApiResponse({
    status: 200,
    description: 'Display settings updated successfully',
    type: UserSettingsResponseDto,
  })
  async updateDisplaySettings(
    @CurrentUser() user: User,
    @Body() updateDto: UpdateDisplaySettingsDto,
  ): Promise<UserSettingsResponseDto> {
    return this.userSettingsService.updateDisplaySettings(user.id, updateDto);
  }

  // ==================== UPDATE ALL SETTINGS ====================

  @Put()
  @Audit({
    action: AuditAction.UPDATE,
    entityType: AuditEntityType.SETTINGS,
    description: 'update user setting',
  })
  @RequirePermissions('settings:update')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ 
    summary: 'Update all settings at once',
    description: 'Update general, notification, and display settings in one request'
  })
  @ApiResponse({
    status: 200,
    description: 'All settings updated successfully',
    type: UserSettingsResponseDto,
  })
  async updateAllSettings(
    @CurrentUser() user: User,
    @Body() updateDto: UpdateUserSettingsDto,
  ): Promise<UserSettingsResponseDto> {
    return this.userSettingsService.updateSettings(user.id, updateDto);
  }

  // ==================== RESET TO DEFAULT ====================

  @Post('reset')
  @Audit({
    action: AuditAction.CREATE,
    entityType: AuditEntityType.SETTINGS,
    description: 'create user setting',
  })
  @RequirePermissions('settings:create')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ 
    summary: 'Reset all settings to default',
    description: 'Restore all settings to their default values'
  })
  @ApiResponse({
    status: 200,
    description: 'Settings reset to default successfully',
    type: UserSettingsResponseDto,
  })
  async resetToDefault(@CurrentUser() user: User): Promise<UserSettingsResponseDto> {
    return this.userSettingsService.resetToDefault(user.id);
  }

  // ==================== DASHBOARD LAYOUT ====================

  @Put('dashboard-layout')
  @Audit({
    action: AuditAction.UPDATE,
    entityType: AuditEntityType.SETTINGS,
    description: 'update user setting',
  })
  @RequirePermissions('settings:update')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ 
    summary: 'Save custom dashboard layout',
    description: 'Store user\'s custom dashboard widget arrangement'
  })
  @ApiResponse({
    status: 200,
    description: 'Dashboard layout saved successfully',
  })
  async updateDashboardLayout(
    @CurrentUser() user: User,
    @Body() updateDto: UpdateDashboardLayoutDto,
  ): Promise<SettingsMessageResponseDto> {
    await this.userSettingsService.updateDashboardLayout(user.id, updateDto.layout);
    return { message: 'Dashboard layout saved successfully' };
  }

  // ==================== WIDGET PREFERENCES ====================

  @Put('widget-preferences')
  @Audit({
    action: AuditAction.UPDATE,
    entityType: AuditEntityType.SETTINGS,
    description: 'update user setting',
  })
  @RequirePermissions('settings:update')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ 
    summary: 'Save widget preferences',
    description: 'Store user preferences for individual widgets'
  })
  @ApiResponse({
    status: 200,
    description: 'Widget preferences saved successfully',
  })
  async updateWidgetPreferences(
    @CurrentUser() user: User,
    @Body() updateDto: UpdateWidgetPreferencesDto,
  ): Promise<SettingsMessageResponseDto> {
    await this.userSettingsService.updateWidgetPreferences(user.id, updateDto.preferences);
    return { message: 'Widget preferences saved successfully' };
  }
}