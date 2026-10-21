// src/modules/analytics/dto/analytics.dto.ts
import {
  IsEnum, IsOptional, IsDateString, IsString, IsObject,
  IsInt, Min, Max, IsArray, ArrayNotEmpty, ArrayMaxSize, ValidateNested,
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

  // @IsObject() is load-bearing, not decoration: the global ValidationPipe runs
  // with whitelist + forbidNonWhitelisted, so a property with no class-validator
  // decorator is rejected outright — POST /analytics answered
  // "property metrics should not exist" for every request without it.
  @ApiProperty({ description: 'Free-form metric payload stored as jsonb' })
  @IsObject()
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

// ───────────────────────────────────────────────────────────────────────────
// Entity time series / aggregate / export
//
// These three DTOs exist because `src/services/api/analytics.api.ts` has
// declared `POST /analytics/timeseries`, `GET /analytics/aggregate` and
// `POST /analytics/export` since it was written and `AnalyticsController` had
// none of them — every call 404'd. The shapes below are the client's, not
// invented ones: `AnalyticsQuery` there is
// `{entityId, entityType, keys[], startTime, endTime, interval?, aggregation?, limit?}`
// with the window in EPOCH MILLISECONDS, which is why these take numbers where
// every other analytics DTO takes an ISO `startDate`. Changing the client to
// ISO would have been a second breaking change on top of the 404.
// ───────────────────────────────────────────────────────────────────────────

/** How a bucketed read combines the samples inside one bucket. */
export enum AnalyticsAggregation {
  AVG = 'AVG',
  MIN = 'MIN',
  MAX = 'MAX',
  SUM = 'SUM',
  COUNT = 'COUNT',
  /** No bucketing: raw samples, in order. The default. */
  NONE = 'NONE',
}

export enum AnalyticsEntityType {
  DEVICE = 'DEVICE',
  ASSET = 'ASSET',
}

/** Output formats `POST /analytics/export` can render. */
export enum AnalyticsExportFormat {
  CSV = 'CSV',
  JSON = 'JSON',
  /**
   * A real workbook. The frontend offered `'EXCEL'` for a route that did not
   * exist and a format no backend surface has ever produced; `XLSX` is the
   * spelling `ReportFormat` uses, and using one name for one thing is worth
   * the client-side rename.
   */
  XLSX = 'XLSX',
}

/** Hard ceiling per request — see AnalyticsService.getEntityTimeSeries(). */
export const ANALYTICS_MAX_SERIES_KEYS = 20;

export class EntityTimeSeriesDto {
  @ApiProperty({ description: 'Device or asset UUID' })
  @IsString()
  entityId: string;

  @ApiProperty({
    type: String,
    enum: AnalyticsEntityType,
    enumName: 'AnalyticsEntityType',
    default: AnalyticsEntityType.DEVICE,
  })
  @IsEnum(AnalyticsEntityType)
  entityType: AnalyticsEntityType;

  @ApiProperty({
    type: [String],
    description:
      'Telemetry keys to read, e.g. ["temperature","humidity"]. Capped at ' +
      `${ANALYTICS_MAX_SERIES_KEYS} per request.`,
  })
  @IsArray()
  @ArrayNotEmpty()
  @ArrayMaxSize(ANALYTICS_MAX_SERIES_KEYS)
  @IsString({ each: true })
  keys: string[];

  @ApiProperty({ description: 'Window start, epoch milliseconds' })
  @Type(() => Number)
  @IsInt()
  @Min(0)
  startTime: number;

  @ApiProperty({ description: 'Window end, epoch milliseconds' })
  @Type(() => Number)
  @IsInt()
  @Min(0)
  endTime: number;

  @ApiPropertyOptional({
    description:
      'Bucket width in MILLISECONDS. Omitted (or 0) returns raw samples. ' +
      'Minimum 1000; a bucket smaller than the reporting interval returns one ' +
      'sample per bucket and nothing else.',
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  interval?: number;

  @ApiPropertyOptional({
    type: String,
    enum: AnalyticsAggregation,
    enumName: 'AnalyticsAggregation',
    default: AnalyticsAggregation.NONE,
    description:
      'Ignored without an `interval` — there is nothing to combine inside a ' +
      'bucket that does not exist.',
  })
  @IsOptional()
  @IsEnum(AnalyticsAggregation)
  aggregation?: AnalyticsAggregation;

  @ApiPropertyOptional({
    default: 1000,
    maximum: 50000,
    description: 'Maximum points per key.',
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(50_000)
  limit?: number;
}

/**
 * `GET /analytics/aggregate` — the same read, as a query string.
 *
 * `keys` arrives comma-separated because the client builds it with
 * `keys.join(',')`; a repeated `?keys=` parameter would have been the more
 * conventional choice and is not what is on the wire.
 */
export class EntityAggregateQueryDto {
  @ApiProperty({ description: 'Device or asset UUID' })
  @IsString()
  entityId: string;

  @ApiPropertyOptional({
    type: String,
    enum: AnalyticsEntityType,
    enumName: 'AnalyticsEntityType',
    default: AnalyticsEntityType.DEVICE,
  })
  @IsOptional()
  @IsEnum(AnalyticsEntityType)
  entityType?: AnalyticsEntityType;

  @ApiProperty({ description: 'Comma-separated telemetry keys' })
  @IsString()
  keys: string;

  @ApiProperty({ description: 'Window start, epoch milliseconds' })
  @Type(() => Number)
  @IsInt()
  @Min(0)
  startTime: number;

  @ApiProperty({ description: 'Window end, epoch milliseconds' })
  @Type(() => Number)
  @IsInt()
  @Min(0)
  endTime: number;

  @ApiPropertyOptional({
    type: String,
    enum: AnalyticsAggregation,
    enumName: 'AnalyticsAggregation',
    default: AnalyticsAggregation.AVG,
  })
  @IsOptional()
  @IsEnum(AnalyticsAggregation)
  aggregation?: AnalyticsAggregation;

  @ApiPropertyOptional({
    description: 'Bucket width in milliseconds. Default one hour.',
    default: 3_600_000,
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  interval?: number;

  @ApiPropertyOptional({ default: 1000, maximum: 50000 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(50_000)
  limit?: number;
}

/** `POST /analytics/export` — a time-series read rendered to a file. */
export class ExportAnalyticsDto {
  @ApiProperty({ type: EntityTimeSeriesDto })
  @ValidateNested()
  @Type(() => EntityTimeSeriesDto)
  query: EntityTimeSeriesDto;

  @ApiPropertyOptional({
    type: String,
    enum: AnalyticsExportFormat,
    enumName: 'AnalyticsExportFormat',
    default: AnalyticsExportFormat.CSV,
  })
  @IsOptional()
  @IsEnum(AnalyticsExportFormat)
  format?: AnalyticsExportFormat;
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
