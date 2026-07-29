// src/modules/dashboards/dto/dashboard-widget.dto.ts
import {
  IsString,
  IsOptional,
  IsObject,
  IsNumber,
  IsArray,
  IsUUID,
  IsEnum,
  IsInt,
  Min,
  ValidateNested,
  ArrayMinSize,
} from 'class-validator';
import { Type } from 'class-transformer';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export enum WidgetEntityType {
  DEVICE = 'DEVICE',
  ASSET = 'ASSET',
}

export class WidgetDatasourceDto {
  @ApiPropertyOptional({ example: 'e4c1a0f2-…', description: 'Device to bind this widget to' })
  @IsOptional()
  @IsUUID()
  deviceId?: string;

  @ApiPropertyOptional({
    type: String,
    enum: WidgetEntityType,
    enumName: 'WidgetEntityType',
    default: WidgetEntityType.DEVICE,
  })
  @IsOptional()
  @IsEnum(WidgetEntityType)
  entityType?: WidgetEntityType;

  @ApiPropertyOptional({ example: ['temperature', 'humidity'] })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  telemetryKeys?: string[];

  @ApiPropertyOptional({ example: '1h' })
  @IsOptional()
  @IsString()
  timeWindow?: string;

  @ApiPropertyOptional({ example: 'AVG' })
  @IsOptional()
  @IsString()
  aggregation?: string;

  // deviceName is intentionally absent — it is denormalised server-side from
  // the devices table so it can never drift from a caller-supplied value.
}

export class AddWidgetDto {
  @ApiProperty({ description: 'WidgetType.id to instantiate' })
  @IsUUID()
  widgetTypeId: string;

  @ApiProperty({ example: 'Temperature' })
  @IsString()
  title: string;

  @ApiPropertyOptional({ example: 0, default: 0 })
  @IsOptional()
  @IsInt()
  @Min(0)
  row?: number;

  @ApiPropertyOptional({ example: 0, default: 0 })
  @IsOptional()
  @IsInt()
  @Min(0)
  col?: number;

  @ApiPropertyOptional({ example: 3, description: 'Defaults to the widget type sizeX' })
  @IsOptional()
  @IsInt()
  @Min(1)
  width?: number;

  @ApiPropertyOptional({ example: 3, description: 'Defaults to the widget type sizeY' })
  @IsOptional()
  @IsInt()
  @Min(1)
  height?: number;

  @ApiPropertyOptional({ type: WidgetDatasourceDto })
  @IsOptional()
  @ValidateNested()
  @Type(() => WidgetDatasourceDto)
  datasource?: WidgetDatasourceDto;

  @ApiPropertyOptional({
    example: { minValue: 0, maxValue: 50, unit: '°C' },
    description: 'Merged over the widget type defaultConfig',
  })
  @IsOptional()
  @IsObject()
  config?: Record<string, any>;
}

export class UpdateWidgetDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  title?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsInt()
  @Min(0)
  row?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsInt()
  @Min(0)
  col?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsInt()
  @Min(1)
  width?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsInt()
  @Min(1)
  height?: number;

  @ApiPropertyOptional({ type: WidgetDatasourceDto })
  @IsOptional()
  @ValidateNested()
  @Type(() => WidgetDatasourceDto)
  datasource?: WidgetDatasourceDto;

  @ApiPropertyOptional()
  @IsOptional()
  @IsObject()
  config?: Record<string, any>;
}

export class WidgetPositionDto {
  @ApiProperty()
  @IsUUID()
  id: string;

  @ApiProperty({ example: 1 })
  @IsInt()
  @Min(0)
  row: number;

  @ApiProperty({ example: 0 })
  @IsInt()
  @Min(0)
  col: number;

  @ApiProperty({ example: 4 })
  @IsInt()
  @Min(1)
  width: number;

  @ApiProperty({ example: 3 })
  @IsInt()
  @Min(1)
  height: number;
}

export class UpdateLayoutDto {
  @ApiProperty({ type: [WidgetPositionDto] })
  @IsArray()
  @ArrayMinSize(1)
  @ValidateNested({ each: true })
  @Type(() => WidgetPositionDto)
  widgets: WidgetPositionDto[];
}
