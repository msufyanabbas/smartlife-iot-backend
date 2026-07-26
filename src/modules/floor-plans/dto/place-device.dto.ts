import {
  IsString,
  IsOptional,
  IsObject,
  IsEnum,
  IsNumber,
  IsUUID,
  ValidateNested,
} from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { DeviceAnimationType } from '@common/enums/index.enum';

export class Vector3Dto {
  @ApiProperty({ example: 0 })
  @IsNumber()
  x: number;

  @ApiProperty({ example: 0 })
  @IsNumber()
  y: number;

  @ApiProperty({ example: 0 })
  @IsNumber()
  z: number;
}

/**
 * Place a device on a floor plan.
 *
 * Accepts BOTH shapes so the previous API contract keeps working:
 *   new    → { deviceId, x, y, z?, rotation?, metadata? }
 *   legacy → { deviceId, name, type, position: {x,y,z}, animationType, ... }
 *
 * `position` wins if supplied; otherwise flat x/y/z are used.
 */
export class PlaceDeviceDto {
  @ApiProperty({ format: 'uuid' })
  @IsUUID()
  deviceId: string;

  // ── New flat coordinates ────────────────────────────────────────────────
  @ApiPropertyOptional({ example: 100 })
  @IsOptional()
  @IsNumber()
  x?: number;

  @ApiPropertyOptional({ example: 200 })
  @IsOptional()
  @IsNumber()
  y?: number;

  @ApiPropertyOptional({ example: 0 })
  @IsOptional()
  @IsNumber()
  z?: number;

  // ── Legacy nested position (takes precedence when present) ──────────────
  @ApiPropertyOptional({
    type: Vector3Dto,
    description: 'Legacy shape; overrides x/y/z',
  })
  @IsOptional()
  @ValidateNested()
  @Type(() => Vector3Dto)
  position?: Vector3Dto;

  @ApiPropertyOptional({ type: Vector3Dto })
  @IsOptional()
  @ValidateNested()
  @Type(() => Vector3Dto)
  rotation?: Vector3Dto;

  @ApiPropertyOptional({ type: Vector3Dto })
  @IsOptional()
  @ValidateNested()
  @Type(() => Vector3Dto)
  scale?: Vector3Dto;

  @ApiPropertyOptional()
  @IsOptional()
  @IsObject()
  metadata?: Record<string, any>;

  // ── Legacy presentation fields (preserved in responses) ─────────────────
  @ApiPropertyOptional({ description: 'Legacy display name' })
  @IsOptional()
  @IsString()
  name?: string;

  @ApiPropertyOptional({ description: 'Legacy device type label' })
  @IsOptional()
  @IsString()
  type?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  model3DUrl?: string;

  @ApiPropertyOptional({
    type: String, enum: DeviceAnimationType, enumName: 'DeviceAnimationType',
  })
  @IsOptional()
  @IsEnum(DeviceAnimationType)
  animationType?: DeviceAnimationType;

  @ApiPropertyOptional()
  @IsOptional()
  @IsObject()
  animationConfig?: Record<string, any>;

  @ApiPropertyOptional()
  @IsOptional()
  @IsObject()
  telemetryBindings?: Record<string, any>;
}

/**
 * Move / update an existing placement. Only provided fields are changed.
 */
export class UpdatePlacementDto {
  @ApiPropertyOptional({ example: 150 })
  @IsOptional()
  @IsNumber()
  x?: number;

  @ApiPropertyOptional({ example: 250 })
  @IsOptional()
  @IsNumber()
  y?: number;

  @ApiPropertyOptional({ example: 0 })
  @IsOptional()
  @IsNumber()
  z?: number;

  @ApiPropertyOptional({
    type: Vector3Dto,
    description: 'Legacy shape; overrides x/y/z',
  })
  @IsOptional()
  @ValidateNested()
  @Type(() => Vector3Dto)
  position?: Vector3Dto;

  @ApiPropertyOptional({ type: Vector3Dto })
  @IsOptional()
  @ValidateNested()
  @Type(() => Vector3Dto)
  rotation?: Vector3Dto;

  @ApiPropertyOptional({ type: Vector3Dto })
  @IsOptional()
  @ValidateNested()
  @Type(() => Vector3Dto)
  scale?: Vector3Dto;

  @ApiPropertyOptional()
  @IsOptional()
  @IsObject()
  metadata?: Record<string, any>;

  @ApiPropertyOptional({
    type: String, enum: DeviceAnimationType, enumName: 'DeviceAnimationType',
  })
  @IsOptional()
  @IsEnum(DeviceAnimationType)
  animationType?: DeviceAnimationType;

  @ApiPropertyOptional()
  @IsOptional()
  @IsObject()
  animationConfig?: Record<string, any>;

  @ApiPropertyOptional()
  @IsOptional()
  @IsObject()
  telemetryBindings?: Record<string, any>;
}
