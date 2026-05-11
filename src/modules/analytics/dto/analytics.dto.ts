// src/modules/analytics/dto/analytics.dto.ts
import {
  IsEnum, IsOptional, IsDateString, IsString,
  IsNumber, IsBoolean, Min, Max,
} from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { AnalyticsType, AnalyticsPeriod } from '@common/enums/analytics.enum';
import { Type } from 'class-transformer';

export class CreateAnalyticsDto {
  @ApiProperty({ enum: AnalyticsType })
  @IsEnum(AnalyticsType)
  type: AnalyticsType;

  @ApiProperty({ enum: AnalyticsPeriod })
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

  @ApiProperty()
  metrics: Record<string, any>;

  @ApiProperty()
  @IsDateString()
  timestamp: string;
}

export class QueryAnalyticsDto {
  @ApiPropertyOptional({ enum: AnalyticsType })
  @IsOptional()
  @IsEnum(AnalyticsType)
  type?: AnalyticsType;

  @ApiPropertyOptional({ enum: AnalyticsPeriod })
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

  @ApiPropertyOptional()
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  page?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  limit?: number;
}

export class DeviceAnalyticsDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  deviceId?: string;

  @ApiPropertyOptional({ enum: AnalyticsPeriod, default: AnalyticsPeriod.DAILY })
  @IsOptional()
  @IsEnum(AnalyticsPeriod)
  period?: AnalyticsPeriod;

  @ApiPropertyOptional()
  @IsOptional()
  @IsDateString()
  startDate?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsDateString()
  endDate?: string;

  @ApiPropertyOptional({ description: 'Filter by device type' })
  @IsOptional()
  @IsString()
  deviceType?: string;

  @ApiPropertyOptional({ description: 'Filter by status' })
  @IsOptional()
  @IsString()
  status?: string;

  @ApiPropertyOptional({ description: 'Response format', enum: ['json', 'csv'] })
  @IsOptional()
  @IsString()
  format?: 'json' | 'csv';
}

export class TelemetryStatQueryDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsDateString()
  startDate?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsDateString()
  endDate?: string;

  @ApiPropertyOptional({ description: 'Response format', enum: ['json', 'csv'] })
  @IsOptional()
  @IsString()
  format?: 'json' | 'csv';
}

export class RecordDashboardViewDto {
  @ApiProperty({ description: 'Widget load time in milliseconds' })
  @IsNumber()
  @Min(0)
  loadTimeMs: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  widgetId?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  errorOccurred?: boolean;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  errorMessage?: string;
}

export class GeoAnalyticsQueryDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  region?: string;

  @ApiPropertyOptional({ description: 'Response format', enum: ['json', 'csv'] })
  @IsOptional()
  @IsString()
  format?: 'json' | 'csv';
}

export class EnergyAnalyticsQueryDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsDateString()
  startDate?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsDateString()
  endDate?: string;

  @ApiPropertyOptional({ description: 'Response format', enum: ['json', 'csv'] })
  @IsOptional()
  @IsString()
  format?: 'json' | 'csv';
}

export class DataConsumptionQueryDto {
  @ApiPropertyOptional({ default: 30 })
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(1)
  @Max(365)
  days?: number;

  @ApiPropertyOptional({ description: 'Response format', enum: ['json', 'csv'] })
  @IsOptional()
  @IsString()
  format?: 'json' | 'csv';
}

export class SystemPerformanceQueryDto {
  @ApiPropertyOptional({ default: 30 })
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  days?: number;

  @ApiPropertyOptional({ description: 'Response format', enum: ['json', 'csv'] })
  @IsOptional()
  @IsString()
  format?: 'json' | 'csv';
}