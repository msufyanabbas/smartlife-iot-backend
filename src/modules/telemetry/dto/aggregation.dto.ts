import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsEnum, IsNotEmpty, IsDateString, IsOptional, IsString, IsNumber } from 'class-validator';

export enum AggregationInterval {
  HOUR = 'hour',
  DAY = 'day',
  MONTH = 'month',
}

export class AggregationQueryDto {
  @ApiProperty({
    enum: AggregationInterval,
    example: AggregationInterval.HOUR,
    description: 'Aggregation interval',
  })
  @IsEnum(AggregationInterval)
  @IsNotEmpty()
  interval: AggregationInterval;

  @ApiProperty({
    example: '2024-10-01T00:00:00Z',
    description: 'Start date',
  })
  @IsDateString()
  @IsNotEmpty()
  startDate: string;

  @ApiProperty({
    example: '2024-10-23T23:59:59Z',
    description: 'End date',
  })
  @IsDateString()
  @IsNotEmpty()
  endDate: string;
}

export class TimeSeriesQueryDto {
  @ApiProperty({
    example: 'temperature',
    description: 'Data key to extract',
  })
  @IsNotEmpty()
  @IsString() // Add this
  key: string;

  @ApiProperty({
    example: '2024-10-01T00:00:00Z',
    description: 'Start date',
  })
  @IsDateString()
  @IsNotEmpty()
  startDate: string;

  @ApiProperty({
    example: '2024-10-23T23:59:59Z',
    description: 'End date',
  })
  @IsDateString()
  @IsNotEmpty()
  endDate: string;

  @ApiPropertyOptional({
    example: 1000,
    description: 'Maximum number of records',
    default: 1000,
  })
  @Type(() => Number) // Add this
  @IsNumber() // Add this
  @IsOptional()
  limit?: number;
}
