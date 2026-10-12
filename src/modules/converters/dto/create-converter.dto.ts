import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsArray,
  IsBoolean,
  IsEnum,
  IsObject,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
  MinLength,
} from 'class-validator';
import {
  ConverterDirection,
  ConverterProtocol,
  ConverterType,
} from '../converter.enums';

/**
 * The global ValidationPipe is `{whitelist, forbidNonWhitelisted, transform}`,
 * so any property the frontend sends that is not declared here is a guaranteed
 * 400 — not a silently dropped field. Everything the converter pages submit is
 * therefore declared, `protocol` and `tags` included.
 *
 * `configuration` is `@IsObject()` and nothing more on purpose: its real shape
 * depends on `type`, and that check lives in
 * `validateConverterConfig()` (converter-catalogue.ts), which reports every
 * problem at once through `BadRequestException({message, errors})`.
 */
export class CreateConverterDto {
  @ApiProperty({ example: 'TTN uplink → telemetry' })
  @IsString()
  @MinLength(1)
  @MaxLength(255)
  name: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  description?: string;

  @ApiProperty({ enum: ConverterDirection, default: ConverterDirection.UPLINK })
  @IsEnum(ConverterDirection)
  direction: ConverterDirection;

  @ApiProperty({ enum: ConverterType, default: ConverterType.JSON })
  @IsEnum(ConverterType)
  type: ConverterType;

  @ApiPropertyOptional({
    enum: ConverterProtocol,
    description: 'Filtering/presentation only — nothing in execution reads it.',
  })
  @IsOptional()
  @IsEnum(ConverterProtocol)
  protocol?: ConverterProtocol;

  @ApiPropertyOptional({
    description:
      'Type-specific settings. GET /converters/catalogue declares the keys.',
    example: {
      mappings: [
        { source: 'object.temperature', target: 'temperature', unit: '°C' },
      ],
    },
  })
  @IsOptional()
  @IsObject()
  configuration?: Record<string, any>;

  @ApiPropertyOptional({ default: true })
  @IsOptional()
  @IsBoolean()
  enabled?: boolean;

  @ApiPropertyOptional({
    default: false,
    description: 'When on, convert() returns the per-step trace to its caller.',
  })
  @IsOptional()
  @IsBoolean()
  debugMode?: boolean;

  @ApiPropertyOptional({ description: 'Optional customer scoping.' })
  @IsOptional()
  @IsUUID()
  customerId?: string;

  @ApiPropertyOptional({ type: [String] })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  tags?: string[];

  @ApiPropertyOptional()
  @IsOptional()
  @IsObject()
  additionalInfo?: Record<string, any>;
}
