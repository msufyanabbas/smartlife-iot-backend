import { IsOptional, IsUUID } from 'class-validator';
import { ApiPropertyOptional } from '@nestjs/swagger';
import { PaginationDto } from '../../../common/dto/pagination.dto';

/**
 * Query params for GET /floor-plans.
 *
 * `assetId` must be declared here: the global ValidationPipe runs with
 * `whitelist: true, forbidNonWhitelisted: true`, so any query param not present
 * on the DTO is rejected with 400 "property assetId should not exist".
 */
export class FloorPlanQueryDto extends PaginationDto {
  @ApiPropertyOptional({
    format: 'uuid',
    description: 'Filter floor plans by asset',
  })
  @IsOptional()
  @IsUUID()
  assetId?: string;
}
