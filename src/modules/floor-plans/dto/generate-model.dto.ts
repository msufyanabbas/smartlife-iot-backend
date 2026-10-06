// src/modules/floor-plans/dto/generate-model.dto.ts
import { ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsBoolean, IsEnum, IsNumber, IsOptional, Max, Min } from 'class-validator';

export enum ModelFormat {
  GLB = 'glb',
  GLTF = 'gltf',
  OBJ = 'obj',
  STL = 'stl',
}

export enum ModelUpAxis {
  /** glTF / three.js convention — correct for web viewers. */
  Y_UP = 'y-up',
  /** CAD convention — matches the source drawing. */
  Z_UP = 'z-up',
}

/**
 * Options for building a 3D model from already-parsed floor plan geometry.
 *
 * Every dimension is in metres, matching the parser's output. The defaults are
 * ordinary commercial-interior values and produce a usable model from a drawing
 * carrying no height information at all — which is most DXF files, since height
 * is not a 2D plan's job to record.
 */
export class GenerateModelDto {
  @ApiPropertyOptional({ enum: ModelFormat, default: ModelFormat.GLB })
  @IsOptional()
  @IsEnum(ModelFormat)
  format?: ModelFormat = ModelFormat.GLB;

  @ApiPropertyOptional({
    enum: ModelUpAxis,
    default: ModelUpAxis.Y_UP,
    description:
      'Ignored for STL, which has no axis convention and is written in the source Z-up frame.',
  })
  @IsOptional()
  @IsEnum(ModelUpAxis)
  upAxis?: ModelUpAxis = ModelUpAxis.Y_UP;

  @ApiPropertyOptional({
    default: 3,
    description: 'Wall height (m). Used only when the drawing carries no floor height.',
  })
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(0.5)
  @Max(50)
  wallHeight?: number;

  @ApiPropertyOptional({ default: 0.2, description: 'Fallback wall thickness (m)' })
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(0.01)
  @Max(5)
  defaultWallThickness?: number;

  @ApiPropertyOptional({ default: 0.15, description: 'Floor slab thickness (m)' })
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(0)
  @Max(2)
  slabThickness?: number;

  @ApiPropertyOptional({ default: 0.9, description: 'Window sill height (m)' })
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(0)
  @Max(10)
  windowSillHeight?: number;

  @ApiPropertyOptional({ default: 2.2, description: 'Window head height (m)' })
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(0.1)
  @Max(20)
  windowHeadHeight?: number;

  @ApiPropertyOptional({ default: 2.1, description: 'Door head height (m)' })
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(0.1)
  @Max(20)
  doorHeight?: number;

  @ApiPropertyOptional({
    default: true,
    description:
      'Cut door and window openings out of walls. Off gives a faster solid-wall massing model.',
  })
  @IsOptional()
  @Type(() => Boolean)
  @IsBoolean()
  cutOpenings?: boolean;

  @ApiPropertyOptional({
    default: true,
    description:
      'Translate the model so its centre sits on the origin. CAD drawings are often placed on ' +
      'survey coordinates hundreds of kilometres away, which makes viewers open on an apparently ' +
      'empty scene and costs float precision.',
  })
  @IsOptional()
  @Type(() => Boolean)
  @IsBoolean()
  centerOnOrigin?: boolean;

  @ApiPropertyOptional({ default: true })
  @IsOptional()
  @Type(() => Boolean)
  @IsBoolean()
  includeWalls?: boolean;

  @ApiPropertyOptional({ default: true })
  @IsOptional()
  @Type(() => Boolean)
  @IsBoolean()
  includeFloors?: boolean;

  @ApiPropertyOptional({ default: true })
  @IsOptional()
  @Type(() => Boolean)
  @IsBoolean()
  includeColumns?: boolean;

  @ApiPropertyOptional({ default: true })
  @IsOptional()
  @Type(() => Boolean)
  @IsBoolean()
  includeDoors?: boolean;

  @ApiPropertyOptional({ default: true })
  @IsOptional()
  @Type(() => Boolean)
  @IsBoolean()
  includeWindows?: boolean;

  @ApiPropertyOptional({ default: true })
  @IsOptional()
  @Type(() => Boolean)
  @IsBoolean()
  includeStairs?: boolean;

  @ApiPropertyOptional({
    default: false,
    description:
      'Off by default: furniture blocks in a CAD file are frequently mis-classified, and including ' +
      'them tends to add noise rather than detail.',
  })
  @IsOptional()
  @Type(() => Boolean)
  @IsBoolean()
  includeFurniture?: boolean;
}
