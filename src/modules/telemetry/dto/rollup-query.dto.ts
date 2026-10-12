import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import {
  IsArray,
  IsDateString,
  IsEnum,
  IsNotEmpty,
  IsOptional,
  IsString,
} from 'class-validator';

/**
 * Granularities a rollup read can ask for. Mirrors
 * `TelemetryRollupGranularity`; declared as its own enum because Swagger and
 * `@IsEnum` need a runtime value and the entity's is a type alias.
 *
 * `week` and `month` only exist once `calculate-statistics` has run — the
 * aggregation job builds `hour` and `day` only.
 */
export enum RollupGranularity {
  HOUR = 'hour',
  DAY = 'day',
  WEEK = 'week',
  MONTH = 'month',
}

export class RollupQueryDto {
  @ApiProperty({
    type: String,
    enum: RollupGranularity,
    enumName: 'RollupGranularity',
    example: RollupGranularity.DAY,
    description: 'Bucket size to read',
  })
  @IsEnum(RollupGranularity)
  @IsNotEmpty()
  granularity: RollupGranularity;

  @ApiProperty({ example: '2026-01-01T00:00:00Z' })
  @IsDateString()
  @IsNotEmpty()
  startDate: string;

  @ApiProperty({ example: '2026-10-01T00:00:00Z' })
  @IsDateString()
  @IsNotEmpty()
  endDate: string;

  /**
   * Comma-separated or repeated. The global ValidationPipe runs with
   * `whitelist` + `forbidNonWhitelisted`, so a query parameter this DTO does
   * not declare is a 400 — hence both spellings are handled here rather than
   * left to the caller to guess.
   */
  @ApiPropertyOptional({
    example: 'temperature,co2',
    description:
      'Restrict to these telemetry keys. Comma-separated, or repeat the parameter. Omit for every key.',
  })
  @IsOptional()
  @Transform(({ value }) => {
    if (value === undefined || value === null || value === '') return undefined;
    const list = Array.isArray(value) ? value : String(value).split(',');
    const cleaned = list.map((v) => String(v).trim()).filter(Boolean);
    return cleaned.length > 0 ? cleaned : undefined;
  })
  @IsArray()
  @IsString({ each: true })
  keys?: string[];
}
