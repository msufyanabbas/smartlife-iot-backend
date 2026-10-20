// src/modules/relations/dto/relation-query.dto.ts
//
// Query DTOs. The global ValidationPipe runs with `forbidNonWhitelisted: true`,
// so anything not declared here is a 400 — which is why each shape is its own
// class rather than one permissive bag.
//
// Every enum carries `enumName` (§4h). On a @Query() that is not optional
// politeness: without it the Swagger document fails to build under SWC and the
// container crash-loops with a stack trace that names an enum member.
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  IsEnum,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  MaxLength,
  Min,
} from 'class-validator';
import {
  RelationDirection,
  RelationEntityType,
  RelationTypeGroup,
} from '@common/enums/relation.enum';

/** `GET /relations/from` and `GET /relations/to`. */
export class EntityRelationQueryDto {
  @ApiProperty({ enum: RelationEntityType, enumName: 'RelationEntityType' })
  @IsEnum(RelationEntityType)
  entityType: RelationEntityType;

  @ApiProperty({ format: 'uuid' })
  @IsUUID()
  entityId: string;

  @ApiPropertyOptional({ example: 'Feeds' })
  @IsOptional()
  @IsString()
  @MaxLength(255)
  relationType?: string;

  @ApiPropertyOptional({
    enum: RelationTypeGroup,
    enumName: 'RelationTypeGroup',
  })
  @IsOptional()
  @IsEnum(RelationTypeGroup)
  relationGroup?: RelationTypeGroup;
}

/** `GET /relations/type` — every edge of one type in the tenant. */
export class RelationTypeQueryDto {
  @ApiProperty({ example: 'Contains' })
  @IsString()
  @MaxLength(255)
  relationType: string;

  @ApiPropertyOptional({
    enum: RelationTypeGroup,
    enumName: 'RelationTypeGroup',
  })
  @IsOptional()
  @IsEnum(RelationTypeGroup)
  relationGroup?: RelationTypeGroup;

  /** A tenant-wide edge list is unbounded; the cap is explicit, not implied. */
  @ApiPropertyOptional({ minimum: 1, maximum: 1000, default: 200 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(1000)
  limit?: number;
}

/** `DELETE /relations` — the 6-tuple that identifies exactly one edge. */
export class DeleteRelationQueryDto {
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

  @ApiProperty({ example: 'Feeds' })
  @IsString()
  @MaxLength(255)
  relationType: string;

  @ApiPropertyOptional({
    enum: RelationTypeGroup,
    enumName: 'RelationTypeGroup',
  })
  @IsOptional()
  @IsEnum(RelationTypeGroup)
  relationGroup?: RelationTypeGroup;
}

/** `DELETE /relations/entity` — every edge touching one entity. */
export class DeleteEntityRelationsQueryDto {
  @ApiProperty({ enum: RelationEntityType, enumName: 'RelationEntityType' })
  @IsEnum(RelationEntityType)
  entityType: RelationEntityType;

  @ApiProperty({ format: 'uuid' })
  @IsUUID()
  entityId: string;

  @ApiPropertyOptional({
    enum: RelationTypeGroup,
    enumName: 'RelationTypeGroup',
    description: 'Restrict the sweep to one group; omit to clear every group.',
  })
  @IsOptional()
  @IsEnum(RelationTypeGroup)
  relationGroup?: RelationTypeGroup;
}

/** `GET /relations/graph` — the recursive traversal. */
export class RelationGraphQueryDto {
  @ApiProperty({ enum: RelationEntityType, enumName: 'RelationEntityType' })
  @IsEnum(RelationEntityType)
  rootType: RelationEntityType;

  @ApiProperty({ format: 'uuid' })
  @IsUUID()
  rootId: string;

  @ApiPropertyOptional({
    enum: RelationDirection,
    enumName: 'RelationDirection',
    default: RelationDirection.FROM,
    description:
      'FROM walks downstream (what does this feed?), TO walks upstream.',
  })
  @IsOptional()
  @IsEnum(RelationDirection)
  direction?: RelationDirection;

  /**
   * Clamped server-side to `RELATION_GRAPH_MAX_DEPTH` (default 10) — the
   * request names a preference, not a ceiling. A client-supplied depth is the
   * easiest way to turn one GET into a query that walks a tenant's entire
   * graph.
   */
  @ApiPropertyOptional({ minimum: 1, maximum: 20, default: 5 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(20)
  maxDepth?: number;

  @ApiPropertyOptional({ example: 'Contains' })
  @IsOptional()
  @IsString()
  @MaxLength(255)
  relationType?: string;

  @ApiPropertyOptional({
    enum: RelationTypeGroup,
    enumName: 'RelationTypeGroup',
  })
  @IsOptional()
  @IsEnum(RelationTypeGroup)
  relationGroup?: RelationTypeGroup;
}
