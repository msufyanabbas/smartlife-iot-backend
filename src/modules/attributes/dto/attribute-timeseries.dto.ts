import { ApiPropertyOptional, ApiProperty } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  IsEnum,
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsString,
  Max,
  Min,
} from 'class-validator';

/**
 * Aggregation applied to each interval bucket.
 *
 * NONE returns the raw stored points. Everything else requires the values to
 * be numeric — non-numeric readings for that key are excluded from the bucket
 * rather than blowing up the ::numeric cast.
 */
export enum TimeseriesAggregation {
  NONE = 'NONE',
  AVG = 'AVG',
  MIN = 'MIN',
  MAX = 'MAX',
  SUM = 'SUM',
  COUNT = 'COUNT',
}

export class AttributeTimeseriesQueryDto {
  @ApiProperty({
    example: 'temperature,humidity',
    description: 'Comma-separated telemetry keys. At least one is required.',
  })
  @IsString()
  @IsNotEmpty()
  keys: string;

  @ApiPropertyOptional({
    example: 1785500000000,
    description: 'Window start, epoch milliseconds (inclusive).',
  })
  @Type(() => Number)
  @IsInt()
  @Min(0)
  @IsOptional()
  startTs?: number;

  @ApiPropertyOptional({
    example: 1785600000000,
    description: 'Window end, epoch milliseconds (inclusive).',
  })
  @Type(() => Number)
  @IsInt()
  @Min(0)
  @IsOptional()
  endTs?: number;

  @ApiPropertyOptional({
    example: 3600000,
    description:
      'Bucket width in milliseconds. Only used when agg is not NONE; ' +
      'defaults to one hour.',
  })
  @Type(() => Number)
  @IsInt()
  @Min(1000)
  @IsOptional()
  interval?: number;

  @ApiPropertyOptional({
    default: 100,
    description: 'Maximum points returned per key (not across all keys).',
  })
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(10000)
  @IsOptional()
  limit?: number = 100;

  @ApiPropertyOptional({
    type: String,
    enum: TimeseriesAggregation,
    enumName: 'TimeseriesAggregation',
    default: TimeseriesAggregation.NONE,
  })
  @IsEnum(TimeseriesAggregation)
  @IsOptional()
  agg?: TimeseriesAggregation = TimeseriesAggregation.NONE;

  /** Parsed, de-duplicated, empty-stripped key list. */
  get keyList(): string[] {
    return [...new Set(this.keys.split(',').map((k) => k.trim()).filter(Boolean))];
  }
}
