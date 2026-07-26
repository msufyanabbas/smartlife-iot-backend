import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsBoolean,
  IsEnum,
  IsNumber,
  IsOptional,
  IsString,
  Min,
  Max,
  IsObject,
  ValidateNested,
} from 'class-validator';
import {
  Language,
  Theme,
  TimeFormat,
  DateFormat,
} from '../entities/user-settings.entity';
import { Type } from 'class-transformer';

// ==================== UPDATE GENERAL SETTINGS ====================

export class UpdateGeneralSettingsDto {
  @ApiPropertyOptional({ type: String, enum: Language, enumName: 'Language', example: Language.EN })
  @IsOptional()
  @IsEnum(Language)
  language?: Language;

  @ApiPropertyOptional({ type: String, enum: Theme, enumName: 'Theme', example: Theme.LIGHT })
  @IsOptional()
  @IsEnum(Theme)
  theme?: Theme;

  @ApiPropertyOptional({ example: true })
  @IsOptional()
  @IsBoolean()
  autoRefreshDashboard?: boolean;

  @ApiPropertyOptional({ example: 30, minimum: 10, maximum: 300 })
  @IsOptional()
  @IsNumber()
  @Min(10)
  @Max(300)
  dashboardRefreshInterval?: number;

  @ApiPropertyOptional({ example: false })
  @IsOptional()
  @IsBoolean()
  compactMode?: boolean;
}

// ==================== UPDATE NOTIFICATION SETTINGS ====================

export class UpdateNotificationSettingsDto {
  @ApiPropertyOptional({ example: true })
  @IsOptional()
  @IsBoolean()
  emailNotifications?: boolean;

  @ApiPropertyOptional({ example: true })
  @IsOptional()
  @IsBoolean()
  alarmNotifications?: boolean;

  @ApiPropertyOptional({ example: true })
  @IsOptional()
  @IsBoolean()
  deviceStatusNotifications?: boolean;

  @ApiPropertyOptional({ example: false })
  @IsOptional()
  @IsBoolean()
  weeklyReports?: boolean;

  @ApiPropertyOptional({ example: false })
  @IsOptional()
  @IsBoolean()
  pushNotifications?: boolean;
}

// ==================== UPDATE DISPLAY SETTINGS ====================

export class UpdateDisplaySettingsDto {
  @ApiPropertyOptional({ type: String, enum: TimeFormat, enumName: 'TimeFormat', example: TimeFormat.TWELVE_HOUR })
  @IsOptional()
  @IsEnum(TimeFormat)
  timeFormat?: TimeFormat;

  @ApiPropertyOptional({ type: String, enum: DateFormat, enumName: 'DateFormat', example: DateFormat.DD_MM_YYYY })
  @IsOptional()
  @IsEnum(DateFormat)
  dateFormat?: DateFormat;

  @ApiPropertyOptional({ example: 'Asia/Riyadh' })
  @IsOptional()
  @IsString()
  timezone?: string;
}

// ==================== UPDATE ALL SETTINGS ====================

export class UpdateUserSettingsDto {
  @ApiPropertyOptional({ type: UpdateGeneralSettingsDto })
  @IsOptional()
  @ValidateNested()
  @Type(() => UpdateGeneralSettingsDto)
  general?: UpdateGeneralSettingsDto;

  @ApiPropertyOptional()
  @IsOptional()
  notifications?: UpdateNotificationSettingsDto;

  @ApiPropertyOptional()
  @IsOptional()
  display?: UpdateDisplaySettingsDto;
}

// ==================== RESPONSE DTO ====================

export class UserSettingsResponseDto {
  @ApiProperty()
  id: string;

  @ApiProperty()
  userId: string;

  // General
  @ApiProperty({ type: String, enum: Language, enumName: 'Language' })
  language: Language;

  @ApiProperty({ type: String, enum: Theme, enumName: 'Theme' })
  theme: Theme;

  @ApiProperty()
  autoRefreshDashboard: boolean;

  @ApiProperty()
  dashboardRefreshInterval: number;

  @ApiProperty()
  compactMode: boolean;

  // Notifications
  @ApiProperty()
  emailNotifications: boolean;

  @ApiProperty()
  alarmNotifications: boolean;

  @ApiProperty()
  deviceStatusNotifications: boolean;

  @ApiProperty()
  weeklyReports: boolean;

  @ApiProperty()
  pushNotifications: boolean;

  // Display
  @ApiProperty({ type: String, enum: TimeFormat, enumName: 'TimeFormat' })
  timeFormat: TimeFormat;

  @ApiProperty({ type: String, enum: DateFormat, enumName: 'DateFormat' })
  dateFormat: DateFormat;

  @ApiProperty()
  timezone: string;

  @ApiProperty()
  createdAt: Date;

  @ApiProperty()
  updatedAt: Date;
}

export class UpdateDashboardLayoutDto {
  @ApiProperty({ 
    description: 'Dashboard layout configuration',
    example: {
      widgets: [
        { id: 'widget-1', position: { x: 0, y: 0, w: 6, h: 4 } },
        { id: 'widget-2', position: { x: 6, y: 0, w: 6, h: 4 } }
      ]
    }
  })
  @IsObject()
  layout: Record<string, any>;
}

// ==================== WIDGET PREFERENCES DTO ====================

export class UpdateWidgetPreferencesDto {
  @ApiProperty({ 
    description: 'Widget-specific preferences and configurations',
    example: {
      'widget-1': { refreshInterval: 30, showLegend: true },
      'widget-2': { chartType: 'line', dataPoints: 50 }
    }
  })
  @IsObject()
  preferences: Record<string, any>;
}

export class SettingsMessageResponseDto {
  @ApiProperty({ example: 'Settings updated successfully' })
  message: string;
}