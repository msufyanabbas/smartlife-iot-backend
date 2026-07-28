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
import { Transform, Type } from 'class-transformer';
import { FloorPlanStatus, DeviceAnimationType } from '@common/enums/index.enum';

/**
 * multipart/form-data carries every field as a string, so an object-valued field
 * arrives as its JSON text. Parse it back; on malformed JSON hand the original
 * string through so @IsObject() produces the error instead of a 500.
 */
const parseJsonField = ({ value }: { value: unknown }): unknown => {
  if (typeof value !== 'string') return value;
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
};

/**
 * Only `name` and `assetId` are required — everything else is filled in from the
 * asset / sensible defaults by FloorPlansService.create(). Keeping the payload
 * minimal lets the UI create a floor before its geometry is known.
 */
export class CreateFloorPlanDto {
  @ApiProperty({ example: 'Factory Floor - Production Area' })
  @IsString()
  name: string;

  @ApiPropertyOptional({
    example: 'Manufacturing Plant A',
    description: "Building label. Defaults to the asset's name.",
  })
  @IsOptional()
  @IsString()
  building?: string;

  @ApiPropertyOptional({
    example: 'Ground Floor',
    description:
      "Legacy free-text floor label. Defaults to floorName, else 'Floor <floorNumber>'.",
  })
  @IsOptional()
  @IsString()
  floor?: string;

  @ApiPropertyOptional({
    example: 1,
    default: 1,
    description:
      'Which floor of the asset this plan represents. Unique per asset. ' +
      'REQUIRED when the asset is multi-floor (configuration.totalFloors > 1); ' +
      'defaults to 1 for single-floor assets.',
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(-10)
  floorNumber?: number;

  @ApiPropertyOptional({
    example: 'Ground Floor',
    description: "Display name for the floor — 'Ground Floor', 'Basement', 'Rooftop'",
  })
  @IsOptional()
  @IsString()
  floorName?: string;

  @ApiProperty({
    example: 'asset-uuid-123',
    description: 'Associated asset ID',
  })
  @IsString()
  assetId: string;

  @ApiPropertyOptional({ example: 'Industrial' })
  @IsOptional()
  @IsString()
  category?: string;

  @ApiPropertyOptional({ example: 'Main production hall, east wing' })
  @IsOptional()
  @IsString()
  description?: string;

  @ApiPropertyOptional({
    example: { width: 100, height: 80, unit: 'meters' },
    description:
      'Plan extents. Defaults to { width: 100, height: 100, unit: "meters" } and is ' +
      'overwritten when a DXF/DWG is uploaded and parsed. Over multipart/form-data ' +
      'send it as a JSON string.',
  })
  @IsOptional()
  @Transform(parseJsonField)
  @IsObject()
  dimensions?: {
    width: number;
    height: number;
    unit?: 'meters' | 'feet';
  };

  @ApiPropertyOptional({ example: '1:100' })
  @IsOptional()
  @IsString()
  scale?: string;

  @ApiPropertyOptional({ type: String, enum: FloorPlanStatus, enumName: 'FloorPlanStatus' })
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

  @ApiProperty({
    type: String, enum: DeviceAnimationType, enumName: 'DeviceAnimationType',
    example: DeviceAnimationType.SMOKE,
  })
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

  @ApiProperty({ type: String, enum: FloorPlanStatus, enumName: 'FloorPlanStatus' })
  status: FloorPlanStatus;

  @ApiProperty()
  message: string;
}
