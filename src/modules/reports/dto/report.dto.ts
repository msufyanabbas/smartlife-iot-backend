import { ApiProperty, ApiPropertyOptional, PartialType } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsEmail,
  IsEnum,
  IsInt,
  IsISO8601,
  IsObject,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  MaxLength,
  Min,
  MinLength,
  ValidateNested,
} from 'class-validator';
import { PaginationDto } from '@common/dto/pagination.dto';
import {
  ReportDateRangeMode,
  ReportEntityKind,
  ReportFormat,
  ReportGroupingInterval,
} from '../report.enum';

/**
 * Every property the client may send has to be declared: the global
 * ValidationPipe is `{whitelist, forbidNonWhitelisted, transform}`, so an
 * undeclared key is a flat 400. The nested objects use
 * `@ValidateNested` + `@Type` so whitelisting reaches inside them too — an
 * `@IsObject()` alone would let an arbitrary blob into a jsonb column.
 */
export class ReportDateRangeDto {
  @ApiProperty({ enum: ReportDateRangeMode })
  @IsEnum(ReportDateRangeMode)
  mode: ReportDateRangeMode;

  @ApiPropertyOptional({
    example: 24,
    description: 'RELATIVE only — hours back from the moment of generation.',
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(24 * 365)
  lastHours?: number;

  @ApiPropertyOptional({ description: 'ABSOLUTE only — ISO 8601 instant.' })
  @IsOptional()
  @IsISO8601()
  from?: string;

  @ApiPropertyOptional({ description: 'ABSOLUTE only — ISO 8601 instant.' })
  @IsOptional()
  @IsISO8601()
  to?: string;
}

export class ReportFiltersDto {
  @ApiPropertyOptional({ type: [String] })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(500)
  @IsUUID('4', { each: true })
  deviceIds?: string[];

  @ApiPropertyOptional({ type: [String], example: ['active', 'offline'] })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(20)
  @IsString({ each: true })
  deviceStatus?: string[];

  @ApiPropertyOptional({ type: [String], example: ['sensor'] })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(50)
  @IsString({ each: true })
  deviceType?: string[];

  @ApiPropertyOptional({ type: [String] })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(500)
  @IsUUID('4', { each: true })
  assetIds?: string[];

  @ApiPropertyOptional()
  @IsOptional()
  @IsUUID()
  customerId?: string;

  @ApiPropertyOptional({
    type: [String],
    example: ['temperature', 'humidity'],
    description: 'Required by DEVICE_TELEMETRY — one series per (device, key).',
  })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(50)
  @IsString({ each: true })
  telemetryKeys?: string[];

  @ApiPropertyOptional({ type: [String], example: ['critical', 'warning'] })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(20)
  @IsString({ each: true })
  alarmSeverity?: string[];

  @ApiPropertyOptional({ type: [String], example: ['active', 'cleared'] })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(20)
  @IsString({ each: true })
  alarmStatus?: string[];

  @ApiPropertyOptional({ example: 'update' })
  @IsOptional()
  @IsString()
  @MaxLength(80)
  auditAction?: string;

  @ApiPropertyOptional({ example: 'device' })
  @IsOptional()
  @IsString()
  @MaxLength(80)
  auditEntityType?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  auditSuccess?: boolean;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(200)
  search?: string;
}

export class ReportGroupingDto {
  @ApiProperty({ enum: ReportGroupingInterval })
  @IsEnum(ReportGroupingInterval)
  interval: ReportGroupingInterval;
}

export class ReportDefinitionDto {
  @ApiProperty({
    enum: ReportEntityKind,
    description:
      'Which row source answers this report. GET /reports/sources lists the ' +
      'columns and filters each one supports.',
  })
  @IsEnum(ReportEntityKind)
  entity: ReportEntityKind;

  @ApiProperty({ type: ReportDateRangeDto })
  @ValidateNested()
  @Type(() => ReportDateRangeDto)
  dateRange: ReportDateRangeDto;

  @ApiPropertyOptional({
    type: [String],
    description:
      'Column keys, in output order. Omit for the source’s default columns. ' +
      'A key the source does not produce is a 400 listing the valid keys.',
  })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(60)
  @IsString({ each: true })
  columns?: string[];

  @ApiPropertyOptional({ type: ReportFiltersDto })
  @IsOptional()
  @ValidateNested()
  @Type(() => ReportFiltersDto)
  filters?: ReportFiltersDto;

  @ApiPropertyOptional({ type: ReportGroupingDto })
  @IsOptional()
  @ValidateNested()
  @Type(() => ReportGroupingDto)
  grouping?: ReportGroupingDto;

  @ApiPropertyOptional({ default: 50000, description: 'Hard row cap.' })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(200000)
  limit?: number;
}

export class ReportScheduleDto {
  @ApiProperty()
  @IsBoolean()
  enabled: boolean;

  @ApiProperty({
    example: '0 7 * * 1',
    description:
      'Standard 5-field cron, parsed by cron-parser — the same library ' +
      'SchedulesModule uses. An unparseable expression is a 400, not a template ' +
      'that silently never fires.',
  })
  @IsString()
  @MinLength(5)
  @MaxLength(120)
  cron: string;

  @ApiPropertyOptional({ example: 'Asia/Riyadh', default: 'UTC' })
  @IsOptional()
  @IsString()
  @MaxLength(64)
  timezone?: string;

  @ApiProperty({
    type: [String],
    description:
      'An enabled schedule with no recipients is refused — it would generate ' +
      'reports nobody is told about.',
  })
  @IsArray()
  @ArrayMaxSize(50)
  @IsEmail({}, { each: true })
  recipients: string[];

  @ApiPropertyOptional({ enum: ReportFormat })
  @IsOptional()
  @IsEnum(ReportFormat)
  format?: ReportFormat;
}

export class CreateReportTemplateDto {
  @ApiProperty({ example: 'Weekly device status' })
  @IsString()
  @MinLength(1)
  @MaxLength(160)
  name: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  description?: string;

  @ApiPropertyOptional({ default: 'General', description: 'Free-text gallery grouping.' })
  @IsOptional()
  @IsString()
  @MaxLength(80)
  type?: string;

  @ApiProperty({ type: ReportDefinitionDto })
  @ValidateNested()
  @Type(() => ReportDefinitionDto)
  definition: ReportDefinitionDto;

  @ApiPropertyOptional({ enum: ReportFormat, default: ReportFormat.CSV })
  @IsOptional()
  @IsEnum(ReportFormat)
  format?: ReportFormat;

  @ApiPropertyOptional({ type: ReportScheduleDto })
  @IsOptional()
  @ValidateNested()
  @Type(() => ReportScheduleDto)
  schedule?: ReportScheduleDto;

  @ApiPropertyOptional({ default: true })
  @IsOptional()
  @IsBoolean()
  enabled?: boolean;

  @ApiPropertyOptional()
  @IsOptional()
  @IsObject()
  additionalInfo?: Record<string, any>;
}

export class UpdateReportTemplateDto extends PartialType(
  CreateReportTemplateDto,
) {}

export class ReportTemplateQueryDto extends PaginationDto {
  @ApiPropertyOptional({ description: 'Free-text gallery grouping.' })
  @IsOptional()
  @IsString()
  @MaxLength(80)
  type?: string;

  @ApiPropertyOptional({ enum: ReportEntityKind })
  @IsOptional()
  @IsEnum(ReportEntityKind)
  entity?: ReportEntityKind;

  @ApiPropertyOptional({ description: 'Only templates with an enabled schedule.' })
  @IsOptional()
  @Type(() => Boolean)
  @IsBoolean()
  scheduled?: boolean;
}

export class GenerateReportDto {
  @ApiPropertyOptional({
    enum: ReportFormat,
    description: 'Overrides the template’s format for this run only.',
  })
  @IsOptional()
  @IsEnum(ReportFormat)
  format?: ReportFormat;

  @ApiPropertyOptional({
    default: false,
    description:
      'A preview is not stored: no file is written and no execution row is ' +
      'recorded, so trying a definition does not clutter the export history. ' +
      'Rows are capped at 100.',
  })
  @IsOptional()
  @IsBoolean()
  preview?: boolean;

  @ApiPropertyOptional({
    default: true,
    description:
      'Include the rendered content in the response. Set false for a large ' +
      'report and fetch it from the returned download path instead.',
  })
  @IsOptional()
  @IsBoolean()
  includeContent?: boolean;

  @ApiPropertyOptional({
    type: ReportDateRangeDto,
    description: 'Override the saved window for this run only.',
  })
  @IsOptional()
  @ValidateNested()
  @Type(() => ReportDateRangeDto)
  dateRange?: ReportDateRangeDto;
}

export class ReportExecutionQueryDto extends PaginationDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsUUID()
  reportTemplateId?: string;
}
