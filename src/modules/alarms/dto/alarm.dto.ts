import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsString,
  IsOptional,
  IsEnum,
  IsBoolean,
  IsObject,
  IsNumber,
  IsArray,
  ValidateNested,
  Min,
} from 'class-validator';
import { Type } from 'class-transformer';
import { AlarmCondition, AlarmSeverity, AlarmStatus} from '@common/enums/index.enum'
import type { AlarmRule } from '@common/interfaces/index.interface';

export class AlarmRuleDto implements AlarmRule {
  @ApiProperty({ example: 'temperature' })
  @IsString()
  telemetryKey: string;

  @ApiProperty({ enum: AlarmCondition, example: AlarmCondition.GREATER_THAN })
  @IsEnum(AlarmCondition)
  condition: AlarmCondition;

  @ApiProperty({ example: 30 })
  @IsNumber()
  value: number;

  @ApiPropertyOptional({ example: 40 })
  @IsOptional()
  @IsNumber()
  value2?: number;

  @ApiPropertyOptional({ example: 300, description: 'Duration in seconds' })
  @IsOptional()
  @IsNumber()
  @Min(0)
  duration?: number;
}

export class CreateAlarmDto {
  @ApiProperty({ example: 'High Temperature Alert' })
  @IsString()
  name: string;

  @ApiPropertyOptional({ example: 'Alert when temperature exceeds 30°C' })
  @IsOptional()
  @IsString()
  description?: string;

  @ApiProperty({ enum: AlarmSeverity, default: AlarmSeverity.WARNING })
  @IsEnum(AlarmSeverity)
  severity: AlarmSeverity;

  @ApiProperty({ example: 'device-uuid' })
  @IsString()
  deviceId: string;

  @ApiProperty({ type: AlarmRuleDto })
  @ValidateNested()
  @Type(() => AlarmRuleDto)
  rule: AlarmRuleDto;

  @ApiPropertyOptional({ example: true })
  @IsOptional()
  @IsBoolean()
  isEnabled?: boolean;

  @ApiPropertyOptional({ example: true })
  @IsOptional()
  @IsBoolean()
  autoClear?: boolean;

  @ApiPropertyOptional({
    example: {
      email: true,
      push: true,
      webhook: 'https://example.com/webhook',
    },
  })
  @IsOptional()
  @IsObject()
  notifications?: {
    email?: boolean;
    sms?: boolean;
    push?: boolean;
    webhook?: string;
  };

  @ApiPropertyOptional({
    example: { userIds: ['user-uuid'], emails: ['admin@example.com'] },
  })
  @IsOptional()
  @IsObject()
  recipients?: {
    userIds?: string[];
    emails?: string[];
    phones?: string[];
  };

  @ApiPropertyOptional({ example: ['critical', 'production'] })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  tags?: string[];
}

export class UpdateAlarmDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  name?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  description?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsEnum(AlarmSeverity)
  severity?: AlarmSeverity;

  @ApiPropertyOptional()
  @IsOptional()
  @ValidateNested()
  @Type(() => AlarmRuleDto)
  rule?: AlarmRuleDto;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  isEnabled?: boolean;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  autoClear?: boolean;

  @ApiPropertyOptional()
  @IsOptional()
  @IsObject()
  notifications?: any;

  @ApiPropertyOptional()
  @IsOptional()
  @IsObject()
  recipients?: any;

  @ApiPropertyOptional()
  @IsOptional()
  @IsArray()
  tags?: string[];
}

export class AlarmQueryDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  deviceId?: string;

  @ApiPropertyOptional({ enum: AlarmSeverity })
  @IsOptional()
  @IsEnum(AlarmSeverity)
  severity?: AlarmSeverity;

  @ApiPropertyOptional({ enum: AlarmStatus })
  @IsOptional()
  @IsEnum(AlarmStatus)
  status?: AlarmStatus;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  search?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  tags?: string[];

  @ApiPropertyOptional({ default: 1 })
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(1)
  page?: number = 1;

  @ApiPropertyOptional({ default: 20 })
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(1)
  limit?: number = 20;
}

export class AcknowledgeAlarmDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  note?: string;
}

export class ResolveAlarmDto {
  @ApiProperty({ example: 'Issue resolved, temperature back to normal' })
  @IsString()
  note: string;
}
