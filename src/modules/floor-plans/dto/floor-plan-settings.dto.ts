import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsEnum,
  IsBoolean,
  IsNumber,
  IsString,
  IsOptional,
  Min,
  ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';

export enum MeasurementUnit {
  METRIC = 'metric',
  IMPERIAL = 'imperial',
}

export class GridSettingsDto {
  @ApiProperty({ description: 'Enable or disable grid display' })
  @IsBoolean()
  showGrid: boolean;

  @ApiProperty({ description: 'Enable or disable snap to grid' })
  @IsBoolean()
  snapToGrid: boolean;

  @ApiProperty({ description: 'Grid size in pixels', minimum: 1 })
  @IsNumber()
  @Min(1)
  gridSize: number;
}

export class DefaultColorsDto {
  @ApiProperty({ description: 'Default color for gateways (hex color)' })
  @IsString()
  gateways: string;

  @ApiProperty({ description: 'Default color for sensors to gateway (hex color)' })
  @IsString()
  sensorsToGateway: string;

  @ApiProperty({ description: 'Default color for zones (hex color)' })
  @IsString()
  zones: string;

  @ApiProperty({ description: 'Default color for sensors to grid (hex color)' })
  @IsString()
  sensorsToGrid: string;
}

export class FloorPlanSettingsDto {
  @ApiProperty({
    enum: MeasurementUnit,
    description: 'Measurement unit for floor plan',
  })
  @IsEnum(MeasurementUnit)
  measurementUnit: MeasurementUnit;

  @ApiProperty({ description: 'Auto-save configuration enabled' })
  @IsBoolean()
  autoSave: boolean;

  @ApiProperty({ type: GridSettingsDto })
  @ValidateNested()
  @Type(() => GridSettingsDto)
  gridSettings: GridSettingsDto;

  @ApiProperty({ type: DefaultColorsDto })
  @ValidateNested()
  @Type(() => DefaultColorsDto)
  defaultColors: DefaultColorsDto;
}

export class UpdateFloorPlanSettingsDto {
  @ApiPropertyOptional({
    enum: MeasurementUnit,
    description: 'Measurement unit for floor plan',
  })
  @IsOptional()
  @IsEnum(MeasurementUnit)
  measurementUnit?: MeasurementUnit;

  @ApiPropertyOptional({ description: 'Auto-save configuration enabled' })
  @IsOptional()
  @IsBoolean()
  autoSave?: boolean;

  @ApiPropertyOptional({ type: GridSettingsDto })
  @IsOptional()
  @ValidateNested()
  @Type(() => GridSettingsDto)
  gridSettings?: GridSettingsDto;

  @ApiPropertyOptional({ type: DefaultColorsDto })
  @IsOptional()
  @ValidateNested()
  @Type(() => DefaultColorsDto)
  defaultColors?: DefaultColorsDto;
}