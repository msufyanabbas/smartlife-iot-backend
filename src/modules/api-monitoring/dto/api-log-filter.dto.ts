import {
  IsOptional,
  IsString,
  IsInt,
  IsDateString,
  IsBoolean,
  IsIn,
  Min,
  Max,
} from 'class-validator';
import { Type, Transform } from 'class-transformer';
import { toQueryBoolean } from '@common/transformers/query-boolean.transformer';
import { ApiPropertyOptional } from '@nestjs/swagger';
import { PaginationDto } from '@common/dto/pagination.dto';

/**
 * Relative windows accepted by every api-monitoring endpoint.
 * A plain string union rather than a TS enum — SWC emits `design:type` as the
 * enum object for enum-typed params, which Swagger reports as a circular
 * dependency.
 */
export const API_LOG_TIME_RANGES = ['1h', '24h', '7d', '30d'] as const;
export type ApiLogTimeRange = (typeof API_LOG_TIME_RANGES)[number];

export const TIME_RANGE_HOURS: Record<ApiLogTimeRange, number> = {
  '1h': 1,
  '24h': 24,
  '7d': 168,
  '30d': 720,
};

export function resolveTimeRangeHours(range?: string): number {
  return TIME_RANGE_HOURS[(range as ApiLogTimeRange)] ?? TIME_RANGE_HOURS['24h'];
}

// `?isError=false` arrives as the string "false", which is truthy.
//
// This had its own copy of the helper, and that copy read `value` rather than
// `obj[key]` — so the implicit conversion had already turned "false" into true
// before it ran, and `?isError=false` resolved to TRUE. One shared
// implementation now; see the file it lives in for why `obj[key]` is the only
// reliable source.
const toBoolean = toQueryBoolean;

/**
 * Filters for GET /api-monitoring/logs, /errors, /slow-requests and /export.
 *
 * Extends PaginationDto so `limit` is capped at 100 and page/limit are coerced
 * to numbers — the previous standalone DTO had neither, so `?limit=1000000`
 * would try to materialise the whole table.
 */
export class APILogFilterDto extends PaginationDto {
  @ApiPropertyOptional({ description: 'HTTP method', example: 'GET' })
  @IsOptional()
  @IsString()
  @Transform(({ value }) => (typeof value === 'string' ? value.toUpperCase() : value))
  method?: string;

  @ApiPropertyOptional({ description: 'Partial route match', example: '/devices' })
  @IsOptional()
  @IsString()
  endpoint?: string;

  @ApiPropertyOptional({ description: 'Exact status code', example: 404 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(100)
  @Max(599)
  statusCode?: number;

  @ApiPropertyOptional({ description: 'Only errors (true) or only successes (false)' })
  @IsOptional()
  @Transform(toBoolean)
  @IsBoolean()
  isError?: boolean;

  @ApiPropertyOptional({ description: 'Filter by user id' })
  @IsOptional()
  @IsString()
  userId?: string;

  @ApiPropertyOptional({ description: 'Slower than N milliseconds' })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  minResponseTime?: number;

  @ApiPropertyOptional({
    description: 'Relative window; overrides startDate/endDate when present',
    enum: API_LOG_TIME_RANGES,
    enumName: 'ApiLogTimeRange',
  })
  @IsOptional()
  @IsIn(API_LOG_TIME_RANGES)
  timeRange?: ApiLogTimeRange;

  @ApiPropertyOptional({ description: 'ISO start date' })
  @IsOptional()
  @IsDateString()
  startDate?: string;

  @ApiPropertyOptional({ description: 'ISO end date' })
  @IsOptional()
  @IsDateString()
  endDate?: string;
}

/** Query for GET /api-monitoring/stats. */
export class ApiMonitoringStatsQueryDto {
  @ApiPropertyOptional({
    enum: API_LOG_TIME_RANGES,
    enumName: 'ApiLogTimeRange',
    default: '24h',
  })
  @IsOptional()
  @IsIn(API_LOG_TIME_RANGES)
  timeRange?: ApiLogTimeRange;

  @ApiPropertyOptional({ description: 'Restrict to endpoints matching this substring' })
  @IsOptional()
  @IsString()
  endpoint?: string;
}
