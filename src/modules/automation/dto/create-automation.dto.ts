// src/modules/automations/dto/create-automation.dto.ts
import {
  IsString,
  IsBoolean,
  IsOptional,
  IsObject,
  ValidateNested,
  IsEnum,
  IsNumber,
  IsArray,
  IsUUID
} from 'class-validator';
import { Type } from 'class-transformer';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { TriggerType, ActionType } from '@common/enums/index.enum';


// ══════════════════════════════════════════════════════════════════════════
// TRIGGER DTO
// ══════════════════════════════════════════════════════════════════════════
class TriggerDto {
  @ApiProperty({
    enum: TriggerType,
    example: TriggerType.THRESHOLD,
    description: 'Type of trigger',
  })
  @IsEnum(TriggerType)
  type: TriggerType;

  @ApiPropertyOptional({
    example: 'device-uuid-123',
    description: 'Device ID to monitor (required for threshold/state triggers)',
  })
  @IsOptional()
  @IsUUID()
  deviceId?: string;

  @ApiPropertyOptional({
    example: 'temperature',
    description: 'Telemetry key to monitor (e.g., temperature, humidity)',
  })
  @IsOptional()
  @IsString()
  telemetryKey?: string;

  @ApiPropertyOptional({
    example: 'doorOpen',
    description: 'Attribute key to monitor (for state-based triggers)',
  })
  @IsOptional()
  @IsString()
  attributeKey?: string;

  @ApiPropertyOptional({
    enum: ['eq', 'ne', 'gt', 'gte', 'lt', 'lte', 'between'],
    example: 'gte',
    description: 'Comparison operator',
  })
  @IsOptional()
  @IsString()
  operator?: 'eq' | 'ne' | 'gt' | 'gte' | 'lt' | 'lte' | 'between';

  @ApiPropertyOptional({
    example: 30,
    description: 'Value to compare against',
  })
  @IsOptional()
  value?: any;

  @ApiPropertyOptional({
    example: 35,
    description: 'Second value (for "between" operator)',
  })
  @IsOptional()
  value2?: any;

  @ApiPropertyOptional({
    example: '0 8 * * *',
    description: 'Cron expression for scheduled triggers (e.g., "0 8 * * *" = 8 AM daily)',
  })
  @IsOptional()
  @IsString()
  schedule?: string;

  @ApiPropertyOptional({
    example: 60,
    description: 'Debounce time in seconds (wait before triggering)',
  })
  @IsOptional()
  @IsNumber()
  debounce?: number;
}

// ══════════════════════════════════════════════════════════════════════════
// ACTION DTO
// ══════════════════════════════════════════════════════════════════════════

class ActionDto {
  @ApiProperty({
    enum: ActionType,
    example: ActionType.CONTROL,
    description: 'Type of action to perform',
  })
  @IsEnum(ActionType)
  type: ActionType;

  @ApiPropertyOptional({
    example: 'motor-uuid-456',
    description: 'Target device ID (for control/setValue actions)',
  })
  @IsOptional()
  @IsUUID()
  deviceId?: string;

  @ApiPropertyOptional({
    example: 'setPower',
    description: 'Command to send to device',
  })
  @IsOptional()
  @IsString()
  command?: string;

  @ApiPropertyOptional({
    example: true,
    description: 'Value to send with command',
  })
  @IsOptional()
  value?: any;

  @ApiPropertyOptional({
    example: 'Temperature is too high! Current: 31°C',
    description: 'Notification message (supports {{variable}} placeholders)',
  })
  @IsOptional()
  @IsString()
  message?: string;

  @ApiPropertyOptional({
    example: ['user-uuid-1', 'user-uuid-2'],
    description: 'User IDs to notify',
  })
  @IsOptional()
  @IsArray()
  @IsUUID('4', { each: true })
  recipients?: string[];

  @ApiPropertyOptional({
    example: 'https://api.example.com/webhook',
    description: 'Webhook URL to call',
  })
  @IsOptional()
  @IsString()
  webhookUrl?: string;

  @ApiPropertyOptional({
    enum: ['GET', 'POST', 'PUT'],
    example: 'POST',
    description: 'HTTP method for webhook',
  })
  @IsOptional()
  @IsString()
  webhookMethod?: 'GET' | 'POST' | 'PUT';

  @ApiPropertyOptional({
    example: { 'Content-Type': 'application/json' },
    description: 'Headers for webhook request',
  })
  @IsOptional()
  @IsObject()
  webhookHeaders?: Record<string, string>;

  @ApiPropertyOptional({
    example: { alert: 'high_temperature', value: '{{temperature}}' },
    description: 'Body for webhook request (supports {{variable}} placeholders)',
  })
  @IsOptional()
  @IsObject()
  webhookBody?: Record<string, any>;
}

// ══════════════════════════════════════════════════════════════════════════
// SETTINGS DTO
// ══════════════════════════════════════════════════════════════════════════

class SettingsDto {
  @ApiPropertyOptional({
    example: 300,
    description: 'Cooldown in seconds between executions',
  })
  @IsOptional()
  @IsNumber()
  cooldown?: number;

  @ApiPropertyOptional({
    example: 10,
    description: 'Maximum executions per day',
  })
  @IsOptional()
  @IsNumber()
  maxExecutionsPerDay?: number;

  @ApiPropertyOptional({
    example: { start: '08:00', end: '18:00' },
    description: 'Active hours (only run during this time)',
  })
  @IsOptional()
  @IsObject()
  activeHours?: {
    start: string;
    end: string;
  };

  @ApiPropertyOptional({
    example: [1, 2, 3, 4, 5],
    description: 'Active days (0=Sunday, 6=Saturday)',
  })
  @IsOptional()
  @IsArray()
  @IsNumber({}, { each: true })
  activeDays?: number[];

  @ApiPropertyOptional({
    example: true,
    description: 'Retry on failure',
  })
  @IsOptional()
  @IsBoolean()
  retryOnFailure?: boolean;

  @ApiPropertyOptional({
    example: 3,
    description: 'Maximum retry attempts',
  })
  @IsOptional()
  @IsNumber()
  maxRetries?: number;
}

// ══════════════════════════════════════════════════════════════════════════
// CREATE AUTOMATION DTO
// ══════════════════════════════════════════════════════════════════════════

export class CreateAutomationDto {
  @ApiProperty({
    example: 'Auto Motor Control',
    description: 'Automation name',
  })
  @IsString()
  name: string;

  @ApiPropertyOptional({
    example: 'Turn ON motor when temperature >= 30°C',
    description: 'Automation description',
  })
  @IsOptional()
  @IsString()
  description?: string;

  @ApiPropertyOptional({
    example: true,
    default: true,
    description: 'Enable automation on creation',
  })
  @IsOptional()
  @IsBoolean()
  enabled?: boolean;

  @ApiProperty({
    description: 'Trigger configuration',
    type: TriggerDto,
  })
  @ValidateNested()
  @Type(() => TriggerDto)
  trigger: TriggerDto;

  @ApiProperty({
    description: 'Action configuration',
    type: ActionDto,
  })
  @ValidateNested()
  @Type(() => ActionDto)
  action: ActionDto;

  @ApiPropertyOptional({
    description: 'Advanced settings',
    type: SettingsDto,
  })
  @IsOptional()
  @ValidateNested()
  @Type(() => SettingsDto)
  settings?: SettingsDto;

  @ApiPropertyOptional({
    example: ['hvac', 'cooling', 'critical'],
    description: 'Tags for categorization',
  })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  tags?: string[];
}
