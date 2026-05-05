// src/modules/schedules/dto/create-schedule.dto.ts
import {
  IsString,
  IsBoolean,
  IsOptional,
  IsObject,
  IsEnum,
  IsNotEmpty,
} from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';
import { ScheduleType } from '@common/enums/index.enum';
import { ValidateScheduleConfiguration } from '../validators/schedule-configuration.validator';

// ─── Per-type configuration shapes (for Swagger documentation) ───────────────

export interface ReportConfiguration {
  reportType: string;
  recipients: string[];
  format?: 'pdf' | 'csv' | 'xlsx';
  retention?: number;
}

export interface BackupConfiguration {
  retention?: number;
  destination?: string;
  [key: string]: any;
}

export interface CleanupConfiguration {
  olderThanDays?: number;
  targets?: string[];
  [key: string]: any;
}

export interface ExportConfiguration {
  format: string;
  destination?: string;
  filters?: Record<string, any>;
  [key: string]: any;
}

export interface DeviceCommandConfiguration {
  deviceId: string;
  command: string;
  params?: Record<string, any>;
  [key: string]: any;
}

export type ScheduleConfiguration =
  | ReportConfiguration
  | BackupConfiguration
  | CleanupConfiguration
  | ExportConfiguration
  | DeviceCommandConfiguration;

// ─── DTO ─────────────────────────────────────────────────────────────────────

export class CreateScheduleDto {
  @ApiProperty({ example: 'Daily Device Report' })
  @IsString()
  @IsNotEmpty()
  name: string;

  @ApiProperty({
    example: 'Send daily device status report',
    required: false,
  })
  @IsOptional()
  @IsString()
  description?: string;

  @ApiProperty({
    enum: ScheduleType,
    example: ScheduleType.REPORT,
    description: 'Determines which configuration fields are required',
  })
  @IsEnum(ScheduleType)
  type: ScheduleType;

  @ApiProperty({
    example: '0 9 * * *',
    description: 'Standard 5-field cron expression',
  })
  @IsString()
  @IsNotEmpty()
  schedule: string;

  @ApiProperty({ example: true, default: true, required: false })
  @IsOptional()
  @IsBoolean()
  enabled?: boolean;

  @ApiProperty({
    description: [
      'Configuration object — required fields depend on "type":',
      '  REPORT        → reportType (string), recipients (string[])',
      '  EXPORT        → format (string)',
      '  DEVICE_COMMAND → deviceId (string), command (string)',
      '  BACKUP / CLEANUP → no required fields',
    ].join('\n'),
    examples: {
      REPORT: {
        value: {
          reportType: 'device_status',
          recipients: ['ops@example.com'],
          format: 'pdf',
        },
      },
      DEVICE_COMMAND: {
        value: {
          deviceId: 'dev-uuid-123',
          command: 'reboot',
          params: { force: true },
        },
      },
    },
  })
  @IsObject()
  @ValidateScheduleConfiguration({
    message: 'configuration does not satisfy the requirements for the chosen type',
  })
  configuration: ScheduleConfiguration;
}