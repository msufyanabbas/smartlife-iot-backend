import {
  IsString,
  IsOptional,
  IsObject,
  IsEnum,
  IsArray,
  IsNumber,
  ValidateNested,
  IsInt,
  Min,
} from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { FloorPlanStatus, DeviceAnimationType } from '../entities/floor-plan.entity';

export class CreateFloorPlanDto {
  @ApiProperty({ example: 'Factory Floor - Production Area' })
  @IsString()
  name: string;

  @ApiProperty({ example: 'Manufacturing Plant A' })
  @IsString()
  building: string;

  @ApiProperty({ example: 'Ground Floor' })
  @IsString()
  floor: string;

  @ApiPropertyOptional({ example: 0, description: 'Numeric floor order (0=ground, 1=first floor, etc.)' })
  @IsOptional()
  @IsInt()
  floorNumber?: number;

  @ApiProperty({ example: 'asset-uuid-123', description: 'Associated asset ID' })
  @IsString()
  assetId: string;

  @ApiProperty({ example: 'Industrial' })
  @IsString()
  category: string;

  @ApiProperty({ example: { width: 100, height: 80, unit: 'meters' } })
  @IsObject()
  dimensions: {
    width: number;
    height: number;
    unit?: 'meters' | 'feet';
  };

  @ApiPropertyOptional({ example: '1:100' })
  @IsOptional()
  @IsString()
  scale?: string;

  @ApiPropertyOptional({ enum: FloorPlanStatus })
  @IsOptional()
  @IsEnum(FloorPlanStatus)
  status?: FloorPlanStatus;
}

export class AnimationConfigDto {
  @ApiPropertyOptional({ example: 0.8 })
  @IsOptional()
  @IsNumber()
  intensity?: number;

  @ApiPropertyOptional({ example: 1.0 })
  @IsOptional()
  @IsNumber()
  speed?: number;

  @ApiPropertyOptional({ example: '#FF5733' })
  @IsOptional()
  @IsString()
  color?: string;

  @ApiPropertyOptional({ example: 100 })
  @IsOptional()
  @IsInt()
  particleCount?: number;

  @ApiPropertyOptional({ example: 5.0 })
  @IsOptional()
  @IsNumber()
  radius?: number;
}

export class TelemetryBindingDto {
  @ApiProperty({ example: 'intensity' })
  @IsString()
  animationProperty: string;

  @ApiProperty({ example: 0 })
  @IsNumber()
  min: number;

  @ApiProperty({ example: 100 })
  @IsNumber()
  max: number;
}

export class AddDeviceToFloorPlanDto {
  @ApiProperty()
  @IsString()
  deviceId: string;

  @ApiProperty()
  @IsString()
  name: string;

  @ApiProperty()
  @IsString()
  type: string;

  @ApiProperty({ example: { x: 50, y: 50, z: 0 } })
  @IsObject()
  position: { x: number; y: number; z: number };

  @ApiPropertyOptional({ example: { x: 0, y: 0, z: 0 } })
  @IsOptional()
  @IsObject()
  rotation?: { x: number; y: number; z: number };

  @ApiPropertyOptional({ example: { x: 1, y: 1, z: 1 } })
  @IsOptional()
  @IsObject()
  scale?: { x: number; y: number; z: number };

  @ApiPropertyOptional({ example: 'https://cdn.example.com/models/sensor.glb' })
  @IsOptional()
  @IsString()
  model3DUrl?: string;

  @ApiProperty({ enum: DeviceAnimationType, example: DeviceAnimationType.SMOKE })
  @IsEnum(DeviceAnimationType)
  animationType: DeviceAnimationType;

  @ApiPropertyOptional({ type: AnimationConfigDto })
  @IsOptional()
  @ValidateNested()
  @Type(() => AnimationConfigDto)
  animationConfig?: AnimationConfigDto;

  @ApiPropertyOptional({
    example: {
      temperature: { animationProperty: 'intensity', min: 0, max: 100 },
    },
  })
  @IsOptional()
  @IsObject()
  telemetryBindings?: {
    [telemetryKey: string]: TelemetryBindingDto;
  };
}

export class AddZoneDto {
  @ApiProperty()
  @IsString()
  name: string;

  @ApiProperty()
  @IsString()
  color: string;

  @ApiProperty()
  @IsArray()
  boundaries: Array<{ x: number; y: number }>;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  floor?: string;

  @ApiPropertyOptional({ type: [String] })
  @IsOptional()
  @IsArray()
  deviceIds?: string[];
}

export class Building3DMetadataDto {
  @ApiProperty()
  @IsString()
  buildingName: string;

  @ApiProperty({ example: 5 })
  @IsInt()
  @Min(1)
  totalFloors: number;

  @ApiProperty({ example: 3.5, description: 'Height of each floor in meters' })
  @IsNumber()
  floorHeight: number;

  @ApiProperty({ example: { width: 50, length: 30, height: 17.5 } })
  @IsObject()
  buildingDimensions: {
    width: number;
    length: number;
    height: number;
  };

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  exteriorModel?: string;

  @ApiProperty({ type: [String], example: ['ground', 'first', 'second'] })
  @IsArray()
  floorOrder: string[];
}

export class UploadDWGResponseDto {
  @ApiProperty()
  floorPlanId: string;

  @ApiProperty()
  dwgFileUrl: string;

  @ApiProperty()
  status: FloorPlanStatus;

  @ApiProperty()
  message: string;
}