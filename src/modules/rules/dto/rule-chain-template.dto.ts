import {
  IsString,
  IsOptional,
  IsObject,
  IsArray,
  IsBoolean,
  IsUUID,
  MaxLength,
  ValidateNested,
  IsInt,
  Min,
} from 'class-validator';
import { Type } from 'class-transformer';
import { ApiProperty, ApiPropertyOptional, PartialType } from '@nestjs/swagger';
import { PaginationDto } from '@common/dto/pagination.dto';

/**
 * One node of a template definition.
 *
 * `targetNodeIndex` rather than an id, matching the export format — see the
 * entity for why.
 */
export class TemplateNodeConnectionDto {
  @ApiProperty({ example: 1 })
  @IsInt()
  @Min(0)
  targetNodeIndex: number;

  @ApiProperty({
    example: 'true',
    description:
      'The route this edge follows. A filter emits true/false; a switch emits its own case routes; everything else success/failure.',
  })
  @IsString()
  connectionType: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  label?: string;
}

export class TemplateNodeDto {
  @ApiProperty({ example: 'Over threshold?' })
  @IsString()
  @MaxLength(200)
  name: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  description?: string;

  @ApiProperty({ example: 'filter' })
  @IsString()
  type: string;

  @ApiPropertyOptional({ default: true })
  @IsOptional()
  @IsBoolean()
  enabled?: boolean;

  @ApiPropertyOptional({ default: false })
  @IsOptional()
  @IsBoolean()
  debugMode?: boolean;

  @ApiPropertyOptional({ type: Object, default: {} })
  @IsOptional()
  @IsObject()
  configuration?: Record<string, any>;

  @ApiPropertyOptional({ type: Object, example: { x: 120, y: 160 } })
  @IsOptional()
  @IsObject()
  position?: { x: number; y: number };

  @ApiPropertyOptional({ type: [TemplateNodeConnectionDto] })
  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => TemplateNodeConnectionDto)
  connections?: TemplateNodeConnectionDto[];
}

export class TemplateDefinitionDto {
  @ApiPropertyOptional({ default: 1 })
  @IsOptional()
  @IsInt()
  formatVersion?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  name?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  description?: string;

  @ApiPropertyOptional({ type: Object, default: {} })
  @IsOptional()
  @IsObject()
  configuration?: Record<string, any>;

  @ApiPropertyOptional({ type: [String] })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  tags?: string[];

  @ApiPropertyOptional({ nullable: true })
  @IsOptional()
  @IsInt()
  @Min(0)
  rootNodeIndex?: number | null;

  @ApiPropertyOptional({
    type: [String],
    description: 'What a user must fill in before enabling a chain built here.',
  })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  setupNotes?: string[];

  @ApiProperty({ type: [TemplateNodeDto] })
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => TemplateNodeDto)
  nodes: TemplateNodeDto[];
}

/**
 * Create a template.
 *
 * Supply either `definition` (authored directly, or pasted from an export) or
 * `fromRuleChainId` (capture an existing chain). Exactly one — supplying both
 * is a 400 rather than a silent preference, because the two express different
 * intents and guessing one would quietly discard the other.
 */
export class CreateRuleChainTemplateDto {
  @ApiProperty({ example: 'Threshold alarm' })
  @IsString()
  @MaxLength(200)
  name: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  description?: string;

  @ApiPropertyOptional({ example: 'Alarms', default: 'General' })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  category?: string;

  @ApiPropertyOptional({ example: 'Thermometer' })
  @IsOptional()
  @IsString()
  @MaxLength(60)
  icon?: string;

  @ApiPropertyOptional({ type: TemplateDefinitionDto })
  @IsOptional()
  @ValidateNested()
  @Type(() => TemplateDefinitionDto)
  definition?: TemplateDefinitionDto;

  @ApiPropertyOptional({
    description: 'Capture this existing rule chain as the template definition.',
  })
  @IsOptional()
  @IsUUID()
  fromRuleChainId?: string;
}

/**
 * Update a template. `fromRuleChainId` is accepted here too — it is how
 * "re-capture this template from the chain as it is now" works.
 */
export class UpdateRuleChainTemplateDto extends PartialType(
  CreateRuleChainTemplateDto,
) {}

export class InstantiateRuleChainTemplateDto {
  @ApiPropertyOptional({
    description:
      'Name for the new chain. Defaults to the template name, de-duplicated.',
  })
  @IsOptional()
  @IsString()
  @MaxLength(200)
  name?: string;

  @ApiPropertyOptional({
    default: false,
    description:
      'Enable the new chain immediately. Off by default: a template may carry placeholder endpoints and ids, so going live should be a decision.',
  })
  @IsOptional()
  @IsBoolean()
  enabled?: boolean;
}

export class RuleChainTemplateQueryDto extends PaginationDto {
  @ApiPropertyOptional({ example: 'Alarms' })
  @IsOptional()
  @IsString()
  category?: string;

  @ApiPropertyOptional({
    description:
      'mine = this tenant’s own templates only; builtin = platform templates only; omitted = both.',
    enum: ['mine', 'builtin'],
  })
  @IsOptional()
  @IsString()
  scope?: 'mine' | 'builtin';
}
