import {
  ApiProperty,
  ApiPropertyOptional,
  OmitType,
  PartialType,
} from '@nestjs/swagger';
import {
  IsString,
  IsNotEmpty,
  IsOptional,
  IsEnum,
  IsBoolean,
  IsObject,
  IsNumber,
  IsArray,
  ValidateIf,
  IsUUID,
  Min,
} from 'class-validator';
import { Type } from 'class-transformer';
import { AlarmCondition, AlarmSeverity, AlarmStatus} from '@common/enums/index.enum'
import type { AlarmRule } from '@common/interfaces/index.interface';

export class AlarmRuleDto implements AlarmRule {
  @ApiProperty({ example: 'temperature' })
  @IsString()
  telemetryKey: string;

  @ApiProperty({ type: String, enum: AlarmCondition, enumName: 'AlarmCondition', example: AlarmCondition.GREATER_THAN })
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

/**
 * Rule as accepted on the wire. Two shapes are in circulation and both are
 * accepted:
 *
 *   flat (this platform)   { telemetryKey, condition, value, value2?, duration? }
 *   ThingsBoard-style      { alarmType, createCondition: { key, operation, value }, … }
 *
 * `AlarmsService.normaliseRule()` collapses either into the flat `AlarmRule`
 * that the `alarms.rule` column and the evaluator expect; anything ThingsBoard
 * -specific that does not fit is preserved under `metadata.ruleSpec`.
 *
 * Typed as an interface rather than a nested `@ValidateNested()` class because
 * a single class cannot describe both shapes without rejecting one of them —
 * the property is validated as a plain object and normalised in the service.
 */
export interface AlarmRuleInput {
  id?: string;
  alarmType?: string;
  severity?: string;

  // Flat shape
  telemetryKey?: string;
  condition?: string;
  value?: number;
  value2?: number;
  duration?: number;

  // ThingsBoard shape
  createCondition?: Record<string, any>;
  clearCondition?: Record<string, any>;
  propagateToParent?: boolean;
  propagateToChildren?: boolean;
  schedule?: Record<string, any>;
  alarmDetails?: string;
  dashboardId?: string;
}

export class CreateAlarmDto {
  @ApiProperty({ example: 'High Temperature Alert' })
  @IsString()
  @IsNotEmpty()
  name: string;

  @ApiPropertyOptional({ example: 'Alert when temperature exceeds 30°C' })
  @IsOptional()
  @IsString()
  description?: string;

  // Optional: the column carries a WARNING default, so an omitted severity is
  // not an error.
  @ApiPropertyOptional({
    type: String,
    enum: AlarmSeverity,
    enumName: 'AlarmSeverity',
    default: AlarmSeverity.WARNING,
  })
  @IsOptional()
  @IsEnum(AlarmSeverity)
  severity?: AlarmSeverity;

  @ApiPropertyOptional({ example: '0e387c70-0d03-43e3-a116-401abbad1382' })
  @IsOptional()
  @IsUUID()
  deviceId?: string;

  @ApiPropertyOptional({ example: '0e387c70-0d03-43e3-a116-401abbad1382' })
  @IsOptional()
  @IsUUID()
  assetId?: string;

  @ApiPropertyOptional({
    type: Object,
    example: {
      alarmType: 'High Temperature',
      severity: 'critical',
      createCondition: { key: 'temperature', operation: 'GREATER', value: 30 },
      propagateToParent: true,
    },
  })
  @IsOptional()
  @IsObject()
  rule?: AlarmRuleInput;

  @ApiPropertyOptional({ example: true })
  @IsOptional()
  @IsBoolean()
  isEnabled?: boolean;

  @ApiPropertyOptional({ example: true })
  @IsOptional()
  @IsBoolean()
  autoClear?: boolean;

  // ── Notification channels ────────────────────────────────────────────────
  // Sent flat by the clients; folded into the `notifications` jsonb column by
  // the service. The nested `notifications` object is still accepted for
  // callers that already send it.

  @ApiPropertyOptional({ example: true })
  @IsOptional()
  @IsBoolean()
  email?: boolean;

  @ApiPropertyOptional({ example: false })
  @IsOptional()
  @IsBoolean()
  sms?: boolean;

  @ApiPropertyOptional({ example: true })
  @IsOptional()
  @IsBoolean()
  push?: boolean;

  @ApiPropertyOptional({ example: 'https://example.com/webhook' })
  @IsOptional()
  @IsString()
  webhook?: string;

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

  // ── Recipients ───────────────────────────────────────────────────────────
  // Same story: flat arrays are folded into the `recipients` jsonb column.

  @ApiPropertyOptional({ example: ['0e387c70-0d03-43e3-a116-401abbad1382'] })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  userIds?: string[];

  @ApiPropertyOptional({ example: ['admin@example.com'] })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  emails?: string[];

  @ApiPropertyOptional({ example: ['+966500000000'] })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  phones?: string[];

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

  @ApiPropertyOptional({
    example: 'Escalate to the facilities team if it persists past 15 minutes.',
    description: 'Free-text operator notes shown alongside the alarm.',
  })
  @IsOptional()
  @IsString()
  details?: string;

  // An alarm *rule* that has never fired is INACTIVE; a caller may still
  // create a row in another state (e.g. importing an already-raised alarm).
  @ApiPropertyOptional({
    type: String,
    enum: AlarmStatus,
    enumName: 'AlarmStatus',
    default: AlarmStatus.INACTIVE,
  })
  @IsOptional()
  @IsEnum(AlarmStatus)
  status?: AlarmStatus;
}

export class TestAlarmDto {
  @ApiProperty({ example: 25 })
  @IsNumber()
  value: number;
}

/**
 * PATCH accepts the same vocabulary as POST so a client can round-trip the
 * payload it created the alarm with. Every field is optional; only the ones
 * present are written (see AlarmsService.update()).
 */
export class UpdateAlarmDto extends PartialType(
  OmitType(CreateAlarmDto, ['deviceId', 'assetId'] as const),
) {}

export class AlarmQueryDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  deviceId?: string;

  @ApiPropertyOptional({ type: String, enum: AlarmSeverity, enumName: 'AlarmSeverity' })
  @IsOptional()
  @IsEnum(AlarmSeverity)
  severity?: AlarmSeverity;

  @ApiPropertyOptional({ type: String, enum: AlarmStatus, enumName: 'AlarmStatus' })
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

export class BulkAcknowledgeAlarmDto {
  @ApiPropertyOptional()
  alarmIds: string[];
}
export class BulkResolveAlarmDto { 
  @ApiPropertyOptional()
  alarmIds: string[]; 
  note: string 
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

export class AssignAlarmDto {
  @ApiProperty({
    example: '0e387c70-0d03-43e3-a116-401abbad1382',
    nullable: true,
    description: 'User to assign the alarm to. Pass null to unassign.',
  })
  @ValidateIf((_, value) => value !== null)
  @IsUUID()
  userId: string | null;
}
