import { ApiProperty, ApiPropertyOptional, PartialType } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsEnum,
  IsObject,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  MaxLength,
  MinLength,
} from 'class-validator';
import { PaginationDto } from '@common/dto/pagination.dto';
import { GroupEntityType } from '../group.enum';

/**
 * The global ValidationPipe is `{whitelist, forbidNonWhitelisted, transform}`,
 * so every property a client sends has to be declared here or the request is a
 * flat 400 naming the property.
 */
export class CreateGroupDto {
  @ApiProperty({ example: 'Floor 2 sensors' })
  @IsString()
  @MinLength(1)
  @MaxLength(160)
  name: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  description?: string;

  @ApiProperty({
    enum: GroupEntityType,
    description:
      'The kind of entity this group holds. Immutable after creation — the ' +
      'members are ids in a different table per kind.',
  })
  @IsEnum(GroupEntityType)
  entityType: GroupEntityType;

  @ApiPropertyOptional({ example: 'thermometer', description: 'Lucide icon name.' })
  @IsOptional()
  @IsString()
  @MaxLength(60)
  icon?: string;

  @ApiPropertyOptional({ example: '#2563eb' })
  @IsOptional()
  @IsString()
  @Matches(/^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/, {
    message: 'color must be a hex colour such as #2563eb or #27e',
  })
  color?: string;

  @ApiPropertyOptional({
    description:
      'Scope the group to a customer. Must be a customer of the caller’s tenant.',
  })
  @IsOptional()
  @IsUUID()
  customerId?: string;

  /**
   * Members may be supplied at creation time — the create form has a picker,
   * and making it two requests means a window where the group exists empty and
   * a failure leaves a group nobody asked for. Every id is validated against
   * the caller's tenant exactly as `POST /groups/:id/members` validates them.
   */
  @ApiPropertyOptional({
    description:
      'Optional initial members. Validated against the caller’s tenant; a ' +
      'single foreign id fails the whole create with 400.',
    type: [String],
  })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(1000)
  @IsUUID('4', { each: true })
  entityIds?: string[];

  @ApiPropertyOptional()
  @IsOptional()
  @IsObject()
  additionalInfo?: Record<string, any>;
}

/**
 * The mutable half of a group, declared separately rather than derived from
 * `CreateGroupDto`.
 *
 * `entityType` is deliberately absent: it cannot change once members exist,
 * because the members are ids in a different table per kind — and
 * `PartialType(CreateGroupDto)` would have accepted it silently, leaving the
 * service to reject something the DTO had already let through. `entityIds` is
 * absent for the same sort of reason: membership is managed through
 * `/groups/:id/members`, so a PUT of the group's name cannot quietly replace
 * its contents.
 */
export class MutableGroupFieldsDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(160)
  name?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  description?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(60)
  icon?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @Matches(/^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/, {
    message: 'color must be a hex colour such as #2563eb or #27e',
  })
  color?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsUUID()
  customerId?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsObject()
  additionalInfo?: Record<string, any>;
}

export class UpdateGroupDto extends PartialType(MutableGroupFieldsDto) {}

export class GroupQueryDto extends PaginationDto {
  @ApiPropertyOptional({ enum: GroupEntityType })
  @IsOptional()
  @IsEnum(GroupEntityType)
  entityType?: GroupEntityType;

  @ApiPropertyOptional()
  @IsOptional()
  @IsUUID()
  customerId?: string;
}

export class GroupMemberQueryDto extends PaginationDto {
  @ApiPropertyOptional({
    description:
      'Include memberships whose entity row no longer exists. Default false — ' +
      'they are counted in `missingMembers` either way.',
  })
  @IsOptional()
  @Type(() => Boolean)
  includeMissing?: boolean;
}

export class GroupMembersDto {
  @ApiProperty({
    type: [String],
    description:
      'Entity ids to add or remove. Every id is checked against the caller’s ' +
      'tenant before anything is written; one foreign id fails the whole call.',
  })
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(1000)
  @IsUUID('4', { each: true })
  entityIds: string[];
}
