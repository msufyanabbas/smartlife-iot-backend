// src/modules/schedules/dto/create-schedule.dto.ts
import {
  IsString,
  IsBoolean,
  IsOptional,
  IsObject,
  IsEnum,
  IsNotEmpty,
  IsInt,
  IsDate,
  Min,
} from 'class-validator';
import { Type } from 'class-transformer';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  ScheduleActionType,
  ScheduleTriggerType,
} from '@common/enums/index.enum';
import {
  ValidateScheduleActionConfig,
  ValidateScheduleTiming,
} from '../validators/schedule-configuration.validator';
import type { ScheduleActionConfig } from '../interfaces/schedule-action.interface';
import { DEFAULT_SCHEDULE_TIMEZONE } from '../entities/schedule.entity';

export class CreateScheduleDto {
  @ApiProperty({ example: 'Nightly Lighting Shutdown' })
  @IsString()
  @IsNotEmpty()
  name: string;

  @ApiPropertyOptional({ example: 'Turn off all lighting relays at 11 PM' })
  @IsOptional()
  @IsString()
  description?: string;

  // ── Timing ────────────────────────────────────────────────────────────────

  @ApiProperty({
    type: String,
    enum: ScheduleTriggerType,
    enumName: 'ScheduleTriggerType',
    example: ScheduleTriggerType.CRON,
    description:
      'CRON requires cronExpression · INTERVAL requires intervalMs · ONE_TIME requires startTime',
  })
  @IsEnum(ScheduleTriggerType)
  // Cross-field timing check hangs off `type` so the message surfaces even when
  // the dependent field is absent entirely.
  @ValidateScheduleTiming()
  type: ScheduleTriggerType;

  @ApiPropertyOptional({
    example: '0 23 * * *',
    description: 'Standard 5-field cron expression. Required when type=CRON.',
  })
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  cronExpression?: string;

  @ApiPropertyOptional({
    example: 300000,
    description:
      'Fire every N milliseconds (min 1000). Required when type=INTERVAL.',
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1000)
  intervalMs?: number;

  @ApiPropertyOptional({
    example: '2026-09-01T20:00:00.000Z',
    description:
      'ONE_TIME: the moment to fire. CRON/INTERVAL: schedule stays dormant until this instant.',
  })
  @IsOptional()
  @Type(() => Date)
  @IsDate()
  startTime?: Date;

  @ApiPropertyOptional({
    example: '2026-12-31T20:00:00.000Z',
    description:
      'After this instant the schedule stops firing and is auto-disabled.',
  })
  @IsOptional()
  @Type(() => Date)
  @IsDate()
  endTime?: Date;

  @ApiPropertyOptional({
    example: DEFAULT_SCHEDULE_TIMEZONE,
    default: DEFAULT_SCHEDULE_TIMEZONE,
    description:
      'IANA timezone the cron expression is evaluated in. Offset strings such as "UTC+3" are rejected — use "Asia/Riyadh".',
  })
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  timezone?: string;

  @ApiPropertyOptional({ example: true, default: true })
  @IsOptional()
  @IsBoolean()
  enabled?: boolean;

  // ── Action ────────────────────────────────────────────────────────────────

  @ApiProperty({
    type: String,
    enum: ScheduleActionType,
    enumName: 'ScheduleActionType',
    example: ScheduleActionType.DEVICE_COMMAND,
    description: 'Determines which actionConfig sub-object is required',
  })
  @IsEnum(ScheduleActionType)
  actionType: ScheduleActionType;

  @ApiProperty({
    description: [
      'Action parameters. Exactly one sub-object, matching actionType:',
      '  DEVICE_COMMAND     → deviceCommand   { targetType, command:{method,params}, … }',
      '  ATTRIBUTE_UPDATE   → attributeUpdate { targetType, scope, attributes[] }',
      '  RULE_CHAIN_TRIGGER → ruleChainTrigger{ ruleChainId, messageType?, payload? }',
      '  SEND_NOTIFICATION  → notification    { targetType, title, message, channels[] }',
      '  DATA_MAINTENANCE   → maintenance     { taskType, olderThanDays? }',
      '  GENERATE_REPORT    → report          { reportType, timeRange, deliveryChannels[] }',
    ].join('\n'),
    examples: {
      DEVICE_COMMAND: {
        value: {
          deviceCommand: {
            targetType: 'DEVICE_TYPE',
            deviceType: 'actuator',
            command: { method: 'setState', params: { relay: 1, state: false } },
            timeout: 30000,
          },
        },
      },
      ATTRIBUTE_UPDATE: {
        value: {
          attributeUpdate: {
            targetType: 'DEVICE',
            deviceId: 'device-uuid',
            scope: 'SHARED_SCOPE',
            attributes: [{ key: 'reportingInterval', value: 600 }],
          },
        },
      },
      GENERATE_REPORT: {
        value: {
          report: {
            reportType: 'DEVICE_SUMMARY',
            timeRange: '24h',
            deliveryChannels: ['IN_APP'],
          },
        },
      },
    },
  })
  @IsObject()
  @ValidateScheduleActionConfig()
  actionConfig: ScheduleActionConfig;
}
