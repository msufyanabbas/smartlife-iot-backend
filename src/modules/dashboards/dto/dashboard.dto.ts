import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsString,
  IsOptional,
  IsEnum,
  IsArray,
  IsBoolean,
  IsObject,
  ValidateNested,
  IsNumber,
  Min,
  Max,
} from 'class-validator';
import { Type } from 'class-transformer';
import {
  DashboardVisibility,
  WidgetConfig,
} from '../entities/dashboard.entity';

export class WidgetPositionDto {
  @ApiProperty()
  @IsNumber()
  @Min(0)
  x: number;

  @ApiProperty()
  @IsNumber()
  @Min(0)
  y: number;

  @ApiProperty()
  @IsNumber()
  @Min(1)
  @Max(12)
  w: number;

  @ApiProperty()
  @IsNumber()
  @Min(1)
  h: number;
}

export class CreateWidgetDto {
  @ApiProperty({
    example: 'chart',
    enum: ['chart', 'gauge', 'map', 'table', 'stat', 'timeseries', 'heatmap'],
  })
  @IsString()
  type: string;

  @ApiProperty({ example: 'Temperature Overview' })
  @IsString()
  title: string;

  @ApiProperty({ type: WidgetPositionDto })
  @ValidateNested()
  @Type(() => WidgetPositionDto)
  position: WidgetPositionDto;

  @ApiProperty({
    example: {
      deviceIds: ['device-uuid'],
      telemetryKeys: ['temperature'],
      timeRange: '24h',
    },
  })
  @IsObject()
  dataSource: any;

  @ApiProperty({
    example: {
      chartType: 'line',
      colors: ['#3b82f6'],
      showLegend: true,
    },
  })
  @IsObject()
  visualization: any;

  @ApiPropertyOptional()
  @IsOptional()
  @IsObject()
  filters?: Record<string, any>;
}

export class CreateDashboardDto {
  @ApiProperty({ example: 'Main Dashboard' })
  @IsString()
  name: string;

  @ApiPropertyOptional({ example: 'Overview of all devices' })
  @IsOptional()
  @IsString()
  description?: string;

  @ApiPropertyOptional({
    enum: DashboardVisibility,
    default: DashboardVisibility.PRIVATE,
  })
  @IsOptional()
  @IsEnum(DashboardVisibility)
  visibility?: DashboardVisibility;

  @ApiPropertyOptional({ type: [CreateWidgetDto] })
  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => CreateWidgetDto)
  widgets?: CreateWidgetDto[];

  @ApiPropertyOptional({ example: { cols: 12, rowHeight: 100 } })
  @IsOptional()
  @IsObject()
  layout?: {
    cols: number;
    rowHeight: number;
    compactType?: 'vertical' | 'horizontal';
  };

  @ApiPropertyOptional({ example: { autoRefresh: true, refreshInterval: 30 } })
  @IsOptional()
  @IsObject()
  settings?: {
    autoRefresh?: boolean;
    refreshInterval?: number;
    theme?: 'light' | 'dark' | 'auto';
    timezone?: string;
  };

  @ApiPropertyOptional({ example: false })
  @IsOptional()
  @IsBoolean()
  isDefault?: boolean;

  @ApiPropertyOptional({ example: ['monitoring', 'production'] })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  tags?: string[];
}

export class UpdateDashboardDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  name?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  description?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsEnum(DashboardVisibility)
  visibility?: DashboardVisibility;

  @ApiPropertyOptional()
  @IsOptional()
  @IsArray()
  widgets?: WidgetConfig[];

  @ApiPropertyOptional()
  @IsOptional()
  @IsObject()
  layout?: any;

  @ApiPropertyOptional()
  @IsOptional()
  @IsObject()
  settings?: any;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  isDefault?: boolean;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  isFavorite?: boolean;

  @ApiPropertyOptional()
  @IsOptional()
  @IsArray()
  tags?: string[];
}

export class DashboardQueryDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  search?: string;

  @ApiPropertyOptional({ enum: DashboardVisibility })
  @IsOptional()
  @IsEnum(DashboardVisibility)
  visibility?: DashboardVisibility;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  @Type(() => Boolean)
  isFavorite?: boolean;

  @ApiPropertyOptional()
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  tags?: string[];

  @ApiPropertyOptional({ default: 1 })
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(1)
  page?: number = 1;

  @ApiPropertyOptional({ default: 10 })
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(1)
  @Max(100)
  limit?: number = 10;
}

export class ShareDashboardDto {
  @ApiProperty({ example: ['user-uuid-1', 'user-uuid-2'] })
  @IsArray()
  @IsString({ each: true })
  userIds: string[];
}

export class CloneDashboardDto {
  @ApiProperty({ example: 'Cloned Dashboard' })
  @IsString()
  name: string;

  @ApiPropertyOptional({ example: 'Cloned from original dashboard' })
  @IsOptional()
  @IsString()
  description?: string;
}
