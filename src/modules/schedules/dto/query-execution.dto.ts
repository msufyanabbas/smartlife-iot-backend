// src/modules/schedules/dto/query-execution.dto.ts
import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsEnum, IsInt, IsOptional, Max, Min } from 'class-validator';
import { Type } from 'class-transformer';
import { ScheduleExecutionStatus } from '@common/enums/index.enum';

export class QueryScheduleExecutionDto {
  @ApiPropertyOptional({ default: 1 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number = 1;

  @ApiPropertyOptional({ default: 20, maximum: 100 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit?: number = 20;

  @ApiPropertyOptional({
    type: String,
    enum: ScheduleExecutionStatus,
    enumName: 'ScheduleExecutionStatus',
  })
  @IsOptional()
  @IsEnum(ScheduleExecutionStatus)
  status?: ScheduleExecutionStatus;
}
