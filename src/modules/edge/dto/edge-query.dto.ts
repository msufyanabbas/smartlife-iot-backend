// src/modules/edge/dto/edge-query.dto.ts
import { IsIn, IsOptional, IsString } from 'class-validator';
import { ApiPropertyOptional } from '@nestjs/swagger';
import { PaginationDto } from '../../../common/dto/pagination.dto';
import { EDGE_TYPES } from './create-edge.dto';

export class EdgeQueryDto extends PaginationDto {
  @ApiPropertyOptional({
    type: String,
    enum: ['active', 'inactive', 'offline', 'error'],
    enumName: 'EdgeStatusValue',
  })
  @IsOptional()
  @IsIn(['active', 'inactive', 'offline', 'error'])
  status?: string;

  @ApiPropertyOptional({ type: String, enum: EDGE_TYPES, enumName: 'EdgeTypeQuery' })
  @IsOptional()
  @IsIn(EDGE_TYPES as unknown as string[])
  type?: string;
}
