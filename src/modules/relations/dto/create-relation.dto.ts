// src/modules/relations/dto/create-relation.dto.ts
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsEnum,
  IsObject,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  MaxLength,
  MinLength,
} from 'class-validator';
import {
  RelationEntityType,
  RelationTypeGroup,
} from '@common/enums/relation.enum';

export class CreateRelationDto {
  /**
   * Every enum that reaches Swagger gets `enumName` — see §4h. Without it
   * SWC's `design:type` metadata leaves the enum OBJECT in `param.type`,
   * Swagger walks its members as if they were DTO properties, and
   * `createDocument()` throws
   * `A circular dependency has been detected (property key: "DEVICE")` —
   * which only reproduces in the container, because tsc and SWC disagree.
   */
  @ApiProperty({ enum: RelationEntityType, enumName: 'RelationEntityType' })
  @IsEnum(RelationEntityType)
  fromEntityType: RelationEntityType;

  @ApiProperty({ format: 'uuid' })
  @IsUUID()
  fromEntityId: string;

  @ApiProperty({ enum: RelationEntityType, enumName: 'RelationEntityType' })
  @IsEnum(RelationEntityType)
  toEntityType: RelationEntityType;

  @ApiProperty({ format: 'uuid' })
  @IsUUID()
  toEntityId: string;

  /**
   * Free text, deliberately. Constrained only in shape: no leading or trailing
   * whitespace and no separator characters, so `"Feeds"` and `"Feeds "` cannot
   * both exist and defeat the unique index.
   */
  @ApiProperty({ example: 'Feeds', maxLength: 255 })
  @IsString()
  @MinLength(1)
  @MaxLength(255)
  @Matches(/^[^\s:][^:]*$|^[^\s:]$/, {
    message:
      'relationType must not start with whitespace or contain ":" (the node-key separator)',
  })
  @Matches(/\S$/, { message: 'relationType must not end with whitespace' })
  relationType: string;

  @ApiPropertyOptional({
    enum: RelationTypeGroup,
    enumName: 'RelationTypeGroup',
    default: RelationTypeGroup.COMMON,
  })
  @IsOptional()
  @IsEnum(RelationTypeGroup)
  relationGroup?: RelationTypeGroup;

  @ApiPropertyOptional({ type: 'object', additionalProperties: true })
  @IsOptional()
  @IsObject()
  additionalInfo?: Record<string, unknown>;
}
