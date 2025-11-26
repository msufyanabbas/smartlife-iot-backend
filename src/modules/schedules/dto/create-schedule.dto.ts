import {
  IsString,
  IsBoolean,
  IsOptional,
  IsObject,
  IsEnum,
} from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';
import { ScheduleType } from '../entities/schedule.entity';

export class CreateScheduleDto {
  @ApiProperty({ example: 'Daily Device Report' })
  @IsString()
  name: string;

  @ApiProperty({ example: 'Send daily device status report', required: false })
  @IsOptional()
  @IsString()
  description?: string;

  @ApiProperty({ enum: ScheduleType, example: ScheduleType.REPORT })
  @IsEnum(ScheduleType)
  type: ScheduleType;

  @ApiProperty({ example: '0 9 * * *', description: 'Cron expression' })
  @IsString()
  schedule: string;

  @ApiProperty({ example: true, default: true })
  @IsOptional()
  @IsBoolean()
  enabled?: boolean;

  @ApiProperty({
    example: {
      reportType: 'device_status',
      recipients: ['user@example.com'],
      format: 'pdf',
    },
  })
  @IsObject()
  configuration: {
    reportType?: string;
    recipients?: string[];
    format?: string;
    retention?: number;
  };
}
