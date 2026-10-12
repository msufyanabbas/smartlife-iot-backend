import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsBoolean, IsEnum, IsOptional } from 'class-validator';
import { Transform } from 'class-transformer';
import { PaginationDto } from '@common/dto/pagination.dto';
import { ConverterDirection, ConverterType } from '../converter.enums';

/**
 * Extends PaginationDto (page/limit/search/sortBy/sortOrder) with the filters
 * the converters list page draws as toolbar buttons: the "All types" dropdown
 * and the uplink/downlink split.
 *
 * `enabled` arrives as the string "true"/"false" on a query string, which
 * `@IsBoolean()` alone rejects — hence the explicit @Transform. The global
 * ValidationPipe's `transform: true` coerces the numeric fields through
 * PaginationDto's own @Type decorators, but it does not turn a string into a
 * boolean on its own.
 */
export class QueryConvertersDto extends PaginationDto {
  @ApiPropertyOptional({ enum: ConverterDirection, enumName: 'ConverterDirection' })
  @IsOptional()
  @IsEnum(ConverterDirection)
  direction?: ConverterDirection;

  @ApiPropertyOptional({ enum: ConverterType, enumName: 'ConverterType' })
  @IsOptional()
  @IsEnum(ConverterType)
  type?: ConverterType;

  @ApiPropertyOptional({ description: 'Filter by enabled flag.' })
  @IsOptional()
  @Transform(({ value }) =>
    value === undefined || value === null || value === ''
      ? undefined
      : value === true || value === 'true' || value === '1',
  )
  @IsBoolean()
  enabled?: boolean;
}
