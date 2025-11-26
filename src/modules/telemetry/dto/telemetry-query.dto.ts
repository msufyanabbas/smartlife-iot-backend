import { ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  IsOptional,
  IsDateString,
  IsString,
  IsInt,
  Min,
  Max,
} from 'class-validator';

export class QueryTelemetryDto {
  @ApiPropertyOptional({
    example: '2024-10-01T00:00:00Z',
    description: 'Start date for filtering',
  })
  @IsDateString()
  @IsOptional()
  startDate?: string;

  @ApiPropertyOptional({
    example: '2024-10-23T23:59:59Z',
    description: 'End date for filtering',
  })
  @IsDateString()
  @IsOptional()
  endDate?: string;

  @ApiPropertyOptional({
    minimum: 1,
    maximum: 1000,
    default: 100,
    description: 'Number of records to return',
  })
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(1000)
  @IsOptional()
  limit?: number = 100;

  @ApiPropertyOptional({
    minimum: 0,
    default: 0,
    description: 'Number of records to skip',
  })
  @Type(() => Number)
  @IsInt()
  @Min(0)
  @IsOptional()
  skip?: number = 0;

  @ApiPropertyOptional({
    example: 'temperature',
    description: 'Filter by data key',
  })
  @IsString()
  @IsOptional()
  key?: string;

  @ApiPropertyOptional({
    enum: ['asc', 'desc'],
    default: 'desc',
    description: 'Sort order',
  })
  @IsString()
  @IsOptional()
  order?: 'asc' | 'desc' = 'desc';
}
