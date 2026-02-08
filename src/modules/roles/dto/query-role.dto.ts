import { IsOptional, IsString, IsBoolean, IsUUID, IsInt, Min } from 'class-validator';
import { Type } from 'class-transformer';
import { ApiPropertyOptional } from '@nestjs/swagger';

export class QueryRoleDto {
  @ApiPropertyOptional({ example: 'Device' })
  @IsString()
  @IsOptional()
  search?: string;

  @ApiPropertyOptional({ example: '123e4567-e89b-12d3-a456-426614174000' })
  @IsUUID()
  @IsOptional()
  tenantId?: string;

  @ApiPropertyOptional({ example: true })
  @IsBoolean()
  @Type(() => Boolean)
  @IsOptional()
  isSystem?: boolean;

  @ApiPropertyOptional({ example: 1, default: 1 })
  @IsInt()
  @Min(1)
  @Type(() => Number)
  @IsOptional()
  page?: number = 1;

  @ApiPropertyOptional({ example: 10, default: 10 })
  @IsInt()
  @Min(1)
  @Type(() => Number)
  @IsOptional()
  limit?: number = 10;

  @ApiPropertyOptional({ example: 'createdAt', default: 'createdAt' })
  @IsString()
  @IsOptional()
  sortBy?: string = 'createdAt';

  @ApiPropertyOptional({ example: 'DESC', default: 'DESC', enum: ['ASC', 'DESC'] })
  @IsString()
  @IsOptional()
  sortOrder?: 'ASC' | 'DESC' = 'DESC';
}