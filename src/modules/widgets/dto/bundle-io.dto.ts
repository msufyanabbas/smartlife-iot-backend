// src/modules/widgets/dto/bundle-io.dto.ts
//
// Import/export payloads for widget bundles.
//
// Widget *types* already had import/export; bundles did not, so a bundle could
// only be rebuilt by hand. ThingsBoard treats the bundle-with-its-widgets as the
// unit people actually share, which is what this adds.

import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  IsArray,
  IsBoolean,
  IsNotEmpty,
  IsNumber,
  IsObject,
  IsOptional,
  IsString,
  ValidateNested,
} from 'class-validator';

export class ExportedWidgetTypeDto {
  @ApiProperty()
  @IsString()
  @IsNotEmpty()
  name: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  description?: string;

  @ApiProperty()
  @IsString()
  category: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  image?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  iconUrl?: string;

  @ApiPropertyOptional({ type: Object })
  @IsOptional()
  @IsObject()
  descriptor?: Record<string, any>;

  @ApiPropertyOptional({ type: Object })
  @IsOptional()
  @IsObject()
  settingsTemplate?: Record<string, any>;

  @ApiPropertyOptional({ type: [String] })
  @IsOptional()
  @IsArray()
  tags?: string[];
}

export class ImportWidgetBundleDto {
  @ApiProperty({ description: 'Bundle title' })
  @IsString()
  @IsNotEmpty()
  title: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  description?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  image?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsNumber()
  order?: number;

  @ApiPropertyOptional({ type: Object })
  @IsOptional()
  @IsObject()
  additionalInfo?: Record<string, any>;

  @ApiPropertyOptional({
    type: [ExportedWidgetTypeDto],
    description:
      'Widget types to create alongside the bundle. Omit to import an empty bundle.',
  })
  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => ExportedWidgetTypeDto)
  widgets?: ExportedWidgetTypeDto[];

  @ApiPropertyOptional({
    default: false,
    description:
      'When a bundle with this title already exists: false rejects the import, ' +
      'true imports under a suffixed title instead. Overwriting is never offered — ' +
      'silently replacing a bundle other dashboards reference is not recoverable.',
  })
  @IsOptional()
  @IsBoolean()
  allowDuplicateTitle?: boolean;
}
