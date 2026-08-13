// src/modules/edge/dto/edge-event-query.dto.ts
import { IsIn, IsOptional } from 'class-validator';
import { ApiPropertyOptional } from '@nestjs/swagger';
import { PaginationDto } from '../../../common/dto/pagination.dto';

export class EdgeEventQueryDto extends PaginationDto {
  @ApiPropertyOptional({ type: String, example: 'CONNECTED' })
  @IsOptional()
  type?: string;

  @ApiPropertyOptional({
    type: String,
    enum: ['info', 'warning', 'error', 'success'],
    enumName: 'EdgeEventSeverityQuery',
  })
  @IsOptional()
  @IsIn(['info', 'warning', 'error', 'success'])
  severity?: string;
}
