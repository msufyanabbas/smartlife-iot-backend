import {
  IsString,
  IsNumber,
  IsOptional,
  IsBoolean,
  IsArray,
  IsUUID,
  MaxLength,
  ValidateNested,
} from 'class-validator';
import { Transform, Type, plainToInstance } from 'class-transformer';
import { ApiPropertyOptional } from '@nestjs/swagger';

// ─────────────────────────────────────────────────────────────────────────────
// multipart/form-data delivers every field as a string, which the global
// ValidationPipe then mangles: `enableImplicitConversion` runs BEFORE any
// @Transform, and its boolean rule is `!!value` — so the string "false"
// reaches the transform already flipped to `true`.
//
// Every helper below therefore reads the untouched value off `obj[key]` (the
// source payload) rather than the pre-converted `value`.
// ─────────────────────────────────────────────────────────────────────────────

type TransformArgs = { obj: Record<string, unknown>; key: string };

const toBoolean = ({ obj, key }: TransformArgs) => {
  const raw = obj?.[key];
  if (raw === undefined || raw === null || raw === '') return undefined;
  if (typeof raw === 'boolean') return raw;
  return raw === 'true' || raw === '1' || raw === 1;
};

const toStringArray = ({ obj, key }: TransformArgs) => {
  const raw = obj?.[key];
  if (raw === undefined || raw === null || raw === '') return undefined;
  if (Array.isArray(raw)) return raw;
  if (typeof raw === 'string') {
    return raw
      .split(',')
      .map((entry) => entry.trim())
      .filter(Boolean);
  }
  return raw;
};

export class ImageDimensionsDto {
  @ApiPropertyOptional({ example: 1920 })
  @Type(() => Number)
  @IsNumber()
  width: number;

  @ApiPropertyOptional({ example: 1080 })
  @Type(() => Number)
  @IsNumber()
  height: number;

  @ApiPropertyOptional({ example: 1.78 })
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  aspectRatio?: number;
}

// Multipart sends `dimensions` as a JSON string. @Type() cannot instantiate a
// class from a string, so the instance is built here — @ValidateNested only
// inspects a real ImageDimensionsDto, and silently passes a plain object.
const toDimensions = ({ obj, key }: TransformArgs) => {
  const raw = obj?.[key];
  if (raw === undefined || raw === null || raw === '') return undefined;

  let parsed: unknown = raw;
  if (typeof raw === 'string') {
    try {
      parsed = JSON.parse(raw);
    } catch {
      return raw; // not JSON — let @ValidateNested produce the 400
    }
  }

  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return parsed;
  }

  return plainToInstance(ImageDimensionsDto, parsed, {
    enableImplicitConversion: true,
  });
};

/**
 * Client-supplied metadata only.
 *
 * `originalName`, `mimeType`, `size`, `url` and `path` used to live here and are
 * deliberately gone: they are derived from the uploaded file by
 * `ImagesService.create()`. Accepting them from the body let a caller point a
 * row at an arbitrary path, and made the multipart request fail validation
 * because the browser never sends them.
 */
export class CreateImageDto {
  @ApiPropertyOptional({
    example: 'riyadh-hq-lobby.jpg',
    description: 'Display name. Defaults to the uploaded file name.',
  })
  @IsOptional()
  @IsString()
  @MaxLength(255)
  name?: string;

  @ApiPropertyOptional({ example: 'Lobby camera still, morning shift' })
  @IsOptional()
  @IsString()
  description?: string;

  @ApiPropertyOptional({ example: 'Main lobby seen from the entrance' })
  @IsOptional()
  @IsString()
  @MaxLength(255)
  alt?: string;

  @ApiPropertyOptional({ example: 'Lobby' })
  @IsOptional()
  @IsString()
  @MaxLength(255)
  title?: string;

  @ApiPropertyOptional({
    example: 'device',
    description: 'Entity this image belongs to: user, device, asset, dashboard…',
  })
  @IsOptional()
  @IsString()
  @MaxLength(64)
  entityType?: string;

  @ApiPropertyOptional({ example: '9f1b6c62-4b0e-4c1e-9f7a-2a1f0d3b5c88' })
  @IsOptional()
  @IsUUID()
  entityId?: string;

  @ApiPropertyOptional({
    example: 'thumbnail',
    description: 'Field on the associated entity this image fills',
  })
  @IsOptional()
  @IsString()
  @MaxLength(64)
  fieldName?: string;

  @ApiPropertyOptional({ example: false, default: false })
  @IsOptional()
  @Transform(toBoolean)
  @IsBoolean()
  isPublic?: boolean;

  @ApiPropertyOptional({
    example: ['lobby', 'camera'],
    description: 'Array, or a comma-separated string in multipart requests',
  })
  @IsOptional()
  @Transform(toStringArray)
  @IsArray()
  @IsString({ each: true })
  tags?: string[];

  @ApiPropertyOptional({
    type: ImageDimensionsDto,
    description: 'JSON object, or a JSON string in multipart requests',
  })
  @IsOptional()
  @Transform(toDimensions)
  @ValidateNested()
  @Type(() => ImageDimensionsDto)
  dimensions?: ImageDimensionsDto;
}
