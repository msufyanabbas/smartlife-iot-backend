import {
  Injectable,
  NotFoundException,
  Logger,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { UserSettings } from './entities/user-settings.entity';
import {
  UpdateGeneralSettingsDto,
  UpdateNotificationSettingsDto,
  UpdateDisplaySettingsDto,
  UpdateUserSettingsDto,
  UserSettingsResponseDto,
} from './dto/user-settings.dto';

@Injectable()
export class UserSettingsService {
  private readonly logger = new Logger(UserSettingsService.name);

  constructor(
    @InjectRepository(UserSettings)
    private userSettingsRepository: Repository<UserSettings>,
  ) {}

  /**
   * Get or create user settings
   */
  async getOrCreate(userId: string): Promise<UserSettings> {
    let settings = await this.userSettingsRepository.findOne({
      where: { userId },
    });

    if (!settings) {
      settings = this.userSettingsRepository.create({ userId });
      await this.userSettingsRepository.save(settings);
      this.logger.log(`Default settings created for user: ${userId}`);
    }

    return settings;
  }

  /**
   * Get user settings
   */
  async getSettings(userId: string): Promise<UserSettingsResponseDto> {
    const settings = await this.getOrCreate(userId);
    return this.toResponseDto(settings);
  }

  /**
   * Update general settings
   */
  async updateGeneralSettings(
    userId: string,
    updateDto: UpdateGeneralSettingsDto,
  ): Promise<UserSettingsResponseDto> {
    const settings = await this.getOrCreate(userId);

    Object.assign(settings, updateDto);

    const updated = await this.userSettingsRepository.save(settings);

    this.logger.log(`General settings updated for user: ${userId}`);

    return this.toResponseDto(updated);
  }

  /**
   * Update notification settings
   */
  async updateNotificationSettings(
    userId: string,
    updateDto: UpdateNotificationSettingsDto,
  ): Promise<UserSettingsResponseDto> {
    const settings = await this.getOrCreate(userId);

    Object.assign(settings, updateDto);

    const updated = await this.userSettingsRepository.save(settings);

    this.logger.log(`Notification settings updated for user: ${userId}`);

    return this.toResponseDto(updated);
  }

  /**
   * Update display settings
   */
  async updateDisplaySettings(
    userId: string,
    updateDto: UpdateDisplaySettingsDto,
  ): Promise<UserSettingsResponseDto> {
    const settings = await this.getOrCreate(userId);

    Object.assign(settings, updateDto);

    const updated = await this.userSettingsRepository.save(settings);

    this.logger.log(`Display settings updated for user: ${userId}`);

    return this.toResponseDto(updated);
  }

  /**
   * Update all settings at once
   */
  async updateSettings(
    userId: string,
    updateDto: UpdateUserSettingsDto,
  ): Promise<UserSettingsResponseDto> {
    const settings = await this.getOrCreate(userId);

    // Update general settings
    if (updateDto.general) {
      Object.assign(settings, updateDto.general);
    }

    // Update notification settings
    if (updateDto.notifications) {
      Object.assign(settings, updateDto.notifications);
    }

    // Update display settings
    if (updateDto.display) {
      Object.assign(settings, updateDto.display);
    }

    const updated = await this.userSettingsRepository.save(settings);

    this.logger.log(`All settings updated for user: ${userId}`);

    return this.toResponseDto(updated);
  }

  /**
   * Reset settings to default
   */
  async resetToDefault(userId: string): Promise<UserSettingsResponseDto> {
    let settings = await this.userSettingsRepository.findOne({
      where: { userId },
    });

    if (settings) {
      await this.userSettingsRepository.remove(settings);
    }

    // Create new with defaults
    settings = await this.getOrCreate(userId);

    this.logger.log(`Settings reset to default for user: ${userId}`);

    return this.toResponseDto(settings);
  }

  /**
   * Update custom dashboard layout
   */
  async updateDashboardLayout(
    userId: string,
    layout: Record<string, any>,
  ): Promise<void> {
    const settings = await this.getOrCreate(userId);
    settings.dashboardLayout = layout;
    await this.userSettingsRepository.save(settings);
    this.logger.log(`Dashboard layout updated for user: ${userId}`);
  }

  /**
   * Update widget preferences
   */
  async updateWidgetPreferences(
    userId: string,
    preferences: Record<string, any>,
  ): Promise<void> {
    const settings = await this.getOrCreate(userId);
    settings.widgetPreferences = preferences;
    await this.userSettingsRepository.save(settings);
    this.logger.log(`Widget preferences updated for user: ${userId}`);
  }

  /**
   * Update custom preferences
   */
  async updateCustomPreferences(
    userId: string,
    preferences: Record<string, any>,
  ): Promise<void> {
    const settings = await this.getOrCreate(userId);
    settings.customPreferences = {
      ...settings.customPreferences,
      ...preferences,
    };
    await this.userSettingsRepository.save(settings);
    this.logger.log(`Custom preferences updated for user: ${userId}`);
  }

  /**
   * Convert entity to response DTO
   */
  private toResponseDto(settings: UserSettings): UserSettingsResponseDto {
    return {
      id: settings.id,
      userId: settings.userId,
      language: settings.language,
      theme: settings.theme,
      autoRefreshDashboard: settings.autoRefreshDashboard,
      dashboardRefreshInterval: settings.dashboardRefreshInterval,
      compactMode: settings.compactMode,
      emailNotifications: settings.emailNotifications,
      alarmNotifications: settings.alarmNotifications,
      deviceStatusNotifications: settings.deviceStatusNotifications,
      weeklyReports: settings.weeklyReports,
      pushNotifications: settings.pushNotifications,
      timeFormat: settings.timeFormat,
      dateFormat: settings.dateFormat,
      timezone: settings.timezone,
      createdAt: settings.createdAt,
      updatedAt: settings.updatedAt,
    };
  }
}