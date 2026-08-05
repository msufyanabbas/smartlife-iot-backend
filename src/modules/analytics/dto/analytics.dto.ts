// src/modules/analytics/dto/analytics.dto.ts
import {
  IsEnum, IsOptional, IsDateString, IsString,
  IsInt, Min, Max,
} from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { AnalyticsType, AnalyticsPeriod } from '@common/enums/analytics.enum';
import { Type } from 'class-transformer';

/**
 * Rolling window every analytics read accepts.
 *
 * Declared as a real enum (rather than a bare string union) so `ValidationPipe`
 * rejects anything else — `forbidNonWhitelisted` is on globally, and an
 * unvalidated `timeRange` would otherwise reach the SQL bucket selection.
 */
export enum AnalyticsTimeRange {
  ONE_HOUR    = '1h',
  ONE_DAY     = '24h',
  SEVEN_DAYS  = '7d',
  THIRTY_DAYS = '30d',
  NINETY_DAYS = '90d',
}

/** Shared `?timeRange=` query. */
export class TimeRangeQueryDto {
  @ApiPropertyOptional({
    type: String,
    enum: AnalyticsTimeRange,
    enumName: 'AnalyticsTimeRange',
    default: AnalyticsTimeRange.ONE_DAY,
  })
  @IsOptional()
  @IsEnum(AnalyticsTimeRange)
  timeRange?: AnalyticsTimeRange;

  // Retained from the previous DTOs — the global ValidationPipe runs with
  // forbidNonWhitelisted, so dropping this property would turn every existing
  // `?format=csv` client call into a 400.
  @ApiPropertyOptional({ enum: ['json', 'csv'], default: 'json' })
  @IsOptional()
  @IsEnum(['json', 'csv'])
  format?: 'json' | 'csv';
}

export class DeviceAnalyticsQueryDto extends TimeRangeQueryDto {
  @ApiPropertyOptional({ default: 1 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number;

  @ApiPropertyOptional({ default: 20, maximum: 100 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit?: number;

  @ApiPropertyOptional({ description: 'DeviceType value, e.g. "sensor"' })
  @IsOptional()
  @IsString()
  type?: string;

  @ApiPropertyOptional({ description: 'DeviceStatus value, e.g. "active"' })
  @IsOptional()
  @IsString()
  status?: string;

  @ApiPropertyOptional({
    description: 'Sort field',
    enum: ['messageCount', 'errorCount', 'name', 'lastSeenAt', 'activeAlarms'],
  })
  @IsOptional()
  @IsEnum(['messageCount', 'errorCount', 'name', 'lastSeenAt', 'activeAlarms'])
  sortBy?: 'messageCount' | 'errorCount' | 'name' | 'lastSeenAt' | 'activeAlarms';

  @ApiPropertyOptional({ enum: ['ASC', 'DESC'], default: 'DESC' })
  @IsOptional()
  @IsEnum(['ASC', 'DESC'])
  sortOrder?: 'ASC' | 'DESC';
}

export class DeviceDetailQueryDto extends TimeRangeQueryDto {
  @ApiPropertyOptional({
    description: 'Comma-separated telemetry keys to restrict the trend to, e.g. "temperature,humidity"',
  })
  @IsOptional()
  @IsString()
  keys?: string;
}

export class GeoAnalyticsQueryDto extends TimeRangeQueryDto {
  @ApiPropertyOptional({ description: 'Substring match on device.location' })
  @IsOptional()
  @IsString()
  region?: string;
}

/** `GET /analytics` — paginated read of the stored rollup table. */
export class QueryAnalyticsDto {
  @ApiPropertyOptional({ type: String, enum: AnalyticsType, enumName: 'AnalyticsType' })
  @IsOptional()
  @IsEnum(AnalyticsType)
  type?: AnalyticsType;

  @ApiPropertyOptional({ type: String, enum: AnalyticsPeriod, enumName: 'AnalyticsPeriod' })
  @IsOptional()
  @IsEnum(AnalyticsPeriod)
  period?: AnalyticsPeriod;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  entityId?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  entityType?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsDateString()
  startDate?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsDateString()
  endDate?: string;

  @ApiPropertyOptional({ default: 1 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number;

  @ApiPropertyOptional({ default: 50, maximum: 200 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(200)
  limit?: number;
}

export class CreateAnalyticsDto {
  @ApiProperty({ type: String, enum: AnalyticsType, enumName: 'AnalyticsType' })
  @IsEnum(AnalyticsType)
  type: AnalyticsType;

  @ApiProperty({ type: String, enum: AnalyticsPeriod, enumName: 'AnalyticsPeriod' })
  @IsEnum(AnalyticsPeriod)
  period: AnalyticsPeriod;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  entityId?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  entityType?: string;

  @ApiProperty({ description: 'Free-form metric payload stored as jsonb' })
  metrics: Record<string, any>;

  @ApiProperty()
  @IsDateString()
  timestamp: string;
}

/** Legacy `GET /analytics/telemetry` and `GET /analytics/users`. */
export class DateRangeQueryDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsDateString()
  startDate?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsDateString()
  endDate?: string;
}

export class RecordDashboardViewDto {
  @ApiProperty({ description: 'Widget load time in milliseconds' })
  @Type(() => Number)
  @IsInt()
  @Min(0)
  loadTimeMs: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  widgetId?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @Type(() => Boolean)
  errorOccurred?: boolean;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  errorMessage?: string;
}
