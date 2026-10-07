import { IsOptional, IsIn, IsUUID, IsBooleanString } from 'class-validator';
import { ApiPropertyOptional } from '@nestjs/swagger';
import { PaginationDto } from '@common/dto/pagination.dto';

/**
 * Columns a firmware list may be ordered by.
 *
 * This allowlist is a SQL-injection fix, not tidiness. PaginationDto validates
 * `sortBy` with `@IsString()` only, and FirmwareService interpolated it straight
 * into the query:
 *
 *     qb.orderBy(`fw.${sortBy}`, sortOrder)
 *
 * TypeORM does not parameterise `orderBy` — the string lands in the SQL text
 * verbatim. The global ValidationPipe's `whitelist: true` strips UNKNOWN
 * properties; it does not constrain the value of a known one, so
 * `?sortBy=createdAt` and `?sortBy=(SELECT …)` were equally acceptable.
 */
export const FIRMWARE_SORT_FIELDS = [
  'createdAt',
  'updatedAt',
  'version',
  'title',
  'size',
  'isActive',
] as const;

export type FirmwareSortField = (typeof FIRMWARE_SORT_FIELDS)[number];

export class QueryFirmwareDto extends PaginationDto {
  @ApiPropertyOptional({
    enum: FIRMWARE_SORT_FIELDS,
    default: 'createdAt',
    description: 'Column to order by (allowlisted — see FIRMWARE_SORT_FIELDS)',
  })
  @IsOptional()
  @IsIn(FIRMWARE_SORT_FIELDS, {
    message: `sortBy must be one of: ${FIRMWARE_SORT_FIELDS.join(', ')}`,
  })
  declare sortBy?: FirmwareSortField;

  @ApiPropertyOptional({ description: 'Only packages targeting this device profile' })
  @IsOptional()
  @IsUUID()
  deviceProfileId?: string;

  @ApiPropertyOptional({
    description: 'Filter by active state. Omit for both.',
    enum: ['true', 'false'],
  })
  @IsOptional()
  @IsBooleanString()
  isActive?: string;
}
