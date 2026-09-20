import {
  IsString,
  IsBoolean,
  IsOptional,
  IsObject,
  ValidateNested,
  IsEnum,
  IsNumber,
  IsArray,
  IsUUID,
  MinLength,
  Min,
  ArrayMinSize,
} from 'class-validator';
import { Type } from 'class-transformer';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  AutomationTriggerType,
  AutomationConditionOperator,
  AutomationConditionSource,
  AutomationActionType,
} from '@common/enums/index.enum';

// ============================================================================
// TRIGGER
// ============================================================================

export class AutomationTriggerDto {
  @ApiProperty({
    type: String,
    enum: AutomationTriggerType,
    enumName: 'AutomationTriggerType',
    example: AutomationTriggerType.TELEMETRY,
    description: 'What makes this automation run',
  })
  @IsEnum(AutomationTriggerType)
  type: AutomationTriggerType;

  @ApiPropertyOptional({
    example: 'device-uuid',
    description: 'Watch one device. Omit to watch every device in the tenant.',
  })
  @IsOptional()
  @IsUUID()
  deviceId?: string;

  @ApiPropertyOptional({ example: 'sensor', description: 'Filter by device type' })
  @IsOptional()
  @IsString()
  deviceType?: string;

  @ApiPropertyOptional({ example: 'asset-uuid', description: 'Filter by asset' })
  @IsOptional()
  @IsUUID()
  assetId?: string;

  @ApiPropertyOptional({
    example: 'temperature',
    description: 'Only run when this telemetry key is present in the frame',
  })
  @IsOptional()
  @IsString()
  telemetryKey?: string;

  @ApiPropertyOptional({ example: 'doorOpen', description: 'Attribute key (ATTRIBUTE trigger)' })
  @IsOptional()
  @IsString()
  attributeKey?: string;

  @ApiPropertyOptional({ example: 'critical', description: 'ALARM trigger: severity filter' })
  @IsOptional()
  @IsString()
  alarmSeverity?: string;

  @ApiPropertyOptional({ example: 'active', description: 'ALARM trigger: status filter' })
  @IsOptional()
  @IsString()
  alarmStatus?: string;

  @ApiPropertyOptional({
    example: 'offline',
    description: 'DEVICE_STATUS trigger: which transition to react to',
  })
  @IsOptional()
  @IsString()
  targetStatus?: string;

  @ApiPropertyOptional({
    example: '0 8 * * *',
    description: 'SCHEDULE trigger: 5-field cron (minute hour dom month dow)',
  })
  @IsOptional()
  @IsString()
  cronExpression?: string;
}

// ============================================================================
// CONDITION
// ============================================================================

export class AutomationConditionDto {
  @ApiProperty({ example: 'temperature', description: 'Telemetry / attribute / device field key' })
  @IsString()
  key: string;

  @ApiProperty({
    type: String,
    enum: AutomationConditionOperator,
    enumName: 'AutomationConditionOperator',
    example: AutomationConditionOperator.GT,
  })
  @IsEnum(AutomationConditionOperator)
  operator: AutomationConditionOperator;

  @ApiPropertyOptional({ example: 40, description: 'Value to compare against' })
  @IsOptional()
  value?: any;

  @ApiPropertyOptional({ example: 60, description: 'Upper bound for BETWEEN' })
  @IsOptional()
  value2?: any;

  @ApiPropertyOptional({
    type: String,
    enum: AutomationConditionSource,
    enumName: 'AutomationConditionSource',
    default: AutomationConditionSource.TELEMETRY,
  })
  @IsOptional()
  @IsEnum(AutomationConditionSource)
  type?: AutomationConditionSource;

  @ApiPropertyOptional({
    enum: ['AND', 'OR'],
    default: 'AND',
    description: 'How this condition combines with the NEXT one',
  })
  @IsOptional()
  @IsEnum(['AND', 'OR'])
  logic?: 'AND' | 'OR';
}

// ============================================================================
// ACTION
// ============================================================================

/** One key/value pair for the UPDATE_ATTRIBUTE action. */
export class AutomationAttributeDto {
  @ApiProperty({ example: 'mode' })
  @IsString()
  key: string;

  @ApiPropertyOptional({ example: 'cooling', description: 'Any JSON-serialisable value' })
  @IsOptional()
  value?: any;
}

export class AutomationActionConfigDto {
  @ApiPropertyOptional({ example: 'High Temperature Alert' })
  @IsOptional()
  @IsString()
  title?: string;

  @ApiPropertyOptional({
    example: 'Reading {{telemetry.temperature}} exceeded 40',
    description: 'Supports {{path.to.value}} interpolation against the trigger context',
  })
  @IsOptional()
  @IsString()
  message?: string;

  @ApiPropertyOptional({ example: ['in_app', 'email'], description: 'NotificationChannel values' })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  channels?: string[];

  @ApiPropertyOptional({ description: 'User ids. Defaults to the automation owner.' })
  @IsOptional()
  @IsArray()
  @IsUUID('4', { each: true })
  recipients?: string[];

  @ApiPropertyOptional({ example: { method: 'turnOn', params: { level: 100 } } })
  @IsOptional()
  @IsObject()
  command?: Record<string, any>;

  @ApiPropertyOptional({ example: 'turnOn' })
  @IsOptional()
  @IsString()
  commandType?: string;

  @ApiPropertyOptional({ description: 'Overrides the triggering device as the action target' })
  @IsOptional()
  @IsUUID()
  targetDeviceId?: string;

  @ApiPropertyOptional({ enum: ['server', 'shared', 'client'], default: 'shared' })
  @IsOptional()
  @IsString()
  scope?: string;

  @ApiPropertyOptional({ type: [AutomationAttributeDto], example: [{ key: 'mode', value: 'cooling' }] })
  @IsOptional()
  @IsArray()
  // @ValidateNested + @Type are REQUIRED here, not decoration: the global
  // ValidationPipe runs with whitelist:true, and without a declared element
  // type it strips every property off each element, turning
  // [{key,value}] into [[]] and silently writing nothing.
  @ValidateNested({ each: true })
  @Type(() => AutomationAttributeDto)
  attributes?: AutomationAttributeDto[];

  @ApiPropertyOptional({ example: 'High Temperature' })
  @IsOptional()
  @IsString()
  alarmName?: string;

  @ApiPropertyOptional({ enum: ['info', 'warning', 'error', 'critical'] })
  @IsOptional()
  @IsString()
  severity?: string;

  @ApiPropertyOptional({ description: 'Rule chain to execute' })
  @IsOptional()
  @IsUUID()
  ruleChainId?: string;

  @ApiPropertyOptional({ example: 'https://example.com/hook' })
  @IsOptional()
  @IsString()
  url?: string;

  @ApiPropertyOptional({ enum: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'], default: 'POST' })
  @IsOptional()
  @IsString()
  method?: string;

  @ApiPropertyOptional({ example: { Authorization: 'Bearer x' } })
  @IsOptional()
  @IsObject()
  headers?: Record<string, any>;

  @ApiPropertyOptional({ example: { deviceId: '{{deviceId}}' } })
  @IsOptional()
  @IsObject()
  body?: Record<string, any>;

  @ApiPropertyOptional({ enum: ['active', 'inactive', 'offline', 'maintenance', 'error'] })
  @IsOptional()
  @IsString()
  status?: string;
}

export class AutomationActionDto {
  @ApiProperty({
    type: String,
    enum: AutomationActionType,
    enumName: 'AutomationActionType',
    example: AutomationActionType.SEND_NOTIFICATION,
  })
  @IsEnum(AutomationActionType)
  type: AutomationActionType;

  @ApiProperty({ example: 1, description: 'Ascending execution order' })
  @IsNumber()
  @Min(0)
  order: number;

  @ApiPropertyOptional({ example: 30, description: 'Seconds to wait before running' })
  @IsOptional()
  @IsNumber()
  @Min(0)
  delay?: number;

  @ApiProperty({ type: AutomationActionConfigDto })
  @ValidateNested()
  @Type(() => AutomationActionConfigDto)
  config: AutomationActionConfigDto;
}

// ============================================================================
// SETTINGS
// ============================================================================

export class AutomationActiveHoursDto {
  @ApiProperty({ example: '08:00' })
  @IsString()
  start: string;

  @ApiProperty({ example: '18:00' })
  @IsString()
  end: string;
}

export class AutomationSettingsDto {
  @ApiPropertyOptional({ example: 300, description: 'Seconds to suppress re-execution' })
  @IsOptional()
  @IsNumber()
  @Min(0)
  cooldown?: number;

  @ApiPropertyOptional({ example: 10, description: 'Hard cap on runs per calendar day' })
  @IsOptional()
  @IsNumber()
  @Min(1)
  maxExecutionsPerDay?: number;

  @ApiPropertyOptional({
    type: AutomationActiveHoursDto,
    description: 'Local-time window. start > end wraps midnight.',
  })
  @IsOptional()
  @ValidateNested()
  @Type(() => AutomationActiveHoursDto)
  activeHours?: AutomationActiveHoursDto;

  @ApiPropertyOptional({ example: [1, 2, 3, 4, 5], description: '0 = Sunday ... 6 = Saturday' })
  @IsOptional()
  @IsArray()
  @IsNumber({}, { each: true })
  activeDays?: number[];

  @ApiPropertyOptional({ example: true })
  @IsOptional()
  @IsBoolean()
  retryOnFailure?: boolean;

  @ApiPropertyOptional({ example: 3 })
  @IsOptional()
  @IsNumber()
  @Min(0)
  maxRetries?: number;
}

// ============================================================================
// CREATE AUTOMATION
// ============================================================================

export class CreateAutomationDto {
  @ApiProperty({ example: 'High Temperature Alert' })
  @IsString()
  @MinLength(1)
  name: string;

  @ApiPropertyOptional({ example: 'Notify and raise an alarm above 40 C' })
  @IsOptional()
  @IsString()
  description?: string;

  @ApiPropertyOptional({ example: true, default: true })
  @IsOptional()
  @IsBoolean()
  enabled?: boolean;

  @ApiProperty({ type: AutomationTriggerDto })
  @ValidateNested()
  @Type(() => AutomationTriggerDto)
  trigger: AutomationTriggerDto;

  @ApiPropertyOptional({
    type: [AutomationConditionDto],
    description: 'Evaluated left to right; an empty list always passes',
  })
  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => AutomationConditionDto)
  conditions?: AutomationConditionDto[];

  @ApiProperty({ type: [AutomationActionDto] })
  @IsArray()
  @ArrayMinSize(1)
  @ValidateNested({ each: true })
  @Type(() => AutomationActionDto)
  actions: AutomationActionDto[];

  @ApiPropertyOptional({ type: AutomationSettingsDto })
  @IsOptional()
  @ValidateNested()
  @Type(() => AutomationSettingsDto)
  settings?: AutomationSettingsDto;

  @ApiPropertyOptional({ example: ['hvac', 'critical'] })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  tags?: string[];
}
