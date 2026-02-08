import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsOptional, IsDateString } from 'class-validator';

// ==================== STATISTICS QUERY DTO ====================

export class StatisticsQueryDto {
  @ApiPropertyOptional({
    example: '2024-10-01T00:00:00Z',
    description: 'Start date for statistics',
  })
  @IsDateString()
  @IsOptional()
  startDate?: string;

  @ApiPropertyOptional({
    example: '2024-10-23T23:59:59Z',
    description: 'End date for statistics',
  })
  @IsDateString()
  @IsOptional()
  endDate?: string;
}

// ==================== EXPORT QUERY DTO ====================

export class ExportQueryDto {
  @ApiPropertyOptional({
    example: '2024-10-01T00:00:00Z',
    description: 'Start date for export',
  })
  @IsDateString()
  @IsOptional()
  startDate?: string;

  @ApiPropertyOptional({
    example: '2024-10-23T23:59:59Z',
    description: 'End date for export',
  })
  @IsDateString()
  @IsOptional()
  endDate?: string;
}