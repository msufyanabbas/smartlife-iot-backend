// src/modules/edge/dto/create-edge.dto.ts
import {
  IsArray,
  IsIn,
  IsNotEmpty,
  IsNumber,
  IsObject,
  IsOptional,
  IsString,
  IsUUID,
} from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import type { EdgeType } from '../entities/edge.entity';

export const EDGE_TYPES = [
  'GATEWAY',
  'INDUSTRIAL',
  'RETAIL',
  'AGRICULTURE',
  'SMART_HOME',
  'CUSTOM',
] as const;

export class CreateEdgeDto {
  @ApiProperty({ example: 'Riyadh Factory Gateway' })
  @IsString()
  @IsNotEmpty()
  name: string;

  @ApiPropertyOptional({ example: 'Industrial edge gateway for plant A' })
  @IsOptional()
  @IsString()
  description?: string;

  @ApiPropertyOptional({ type: String, enum: EDGE_TYPES, enumName: 'EdgeType' })
  @IsOptional()
  @IsIn(EDGE_TYPES as unknown as string[])
  type?: EdgeType;

  @ApiPropertyOptional({ example: 'Riyadh Industrial City, Building A' })
  @IsOptional()
  @IsString()
  location?: string;

  @ApiPropertyOptional({ example: 24.7136 })
  @IsOptional()
  @IsNumber()
  latitude?: number;

  @ApiPropertyOptional({ example: 46.6753 })
  @IsOptional()
  @IsNumber()
  longitude?: number;

  @ApiPropertyOptional({
    type: Object,
    example: {
      syncRules: true,
      syncDashboards: true,
      syncDevices: true,
      syncInterval: 300,
      offlineBufferHours: 24,
    },
  })
  @IsOptional()
  @IsObject()
  syncConfig?: {
    syncRules?: boolean;
    syncDashboards?: boolean;
    syncDevices?: boolean;
    syncInterval?: number;
    offlineBufferHours?: number;
  };

  @ApiPropertyOptional({ type: [String], example: ['factory', 'riyadh'] })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  tags?: string[];

  @ApiPropertyOptional({ type: Object })
  @IsOptional()
  @IsObject()
  additionalInfo?: Record<string, any>;

  @ApiPropertyOptional({ description: 'Optional customer scoping' })
  @IsOptional()
  @IsUUID()
  customerId?: string;
}
