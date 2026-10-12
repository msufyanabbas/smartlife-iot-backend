import { ApiProperty, ApiPropertyOptional, PartialType } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  IsBoolean,
  IsEnum,
  IsInt,
  IsObject,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  Max,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';
import { PaginationDto } from '@common/dto/pagination.dto';
import { QueueProcessingStrategy, QueueSubmitStrategy } from '../queue.enum';

/**
 * The global ValidationPipe is `{whitelist, forbidNonWhitelisted, transform}`,
 * so anything the client sends that is not declared here is a 400. The
 * frontend's `queues.api.ts` posts `Partial<Queue>`, which can include `id`,
 * `tenantId`, `createdAt` and `updatedAt` straight from a row it is editing —
 * those are declared and ignored rather than rejected, because a 400 on a
 * round-tripped row is indistinguishable to the user from "save is broken".
 */
class RoundTrippedServerFields {
  @ApiPropertyOptional({ description: 'Ignored. Accepted so an edited row can be posted back verbatim.' })
  @IsOptional()
  @IsString()
  id?: string;

  @ApiPropertyOptional({ description: 'Ignored — the tenant comes from the JWT, never the body.' })
  @IsOptional()
  @IsString()
  tenantId?: string;

  @ApiPropertyOptional({ description: 'Ignored.' })
  @IsOptional()
  @IsString()
  createdAt?: string;

  @ApiPropertyOptional({ description: 'Ignored.' })
  @IsOptional()
  @IsString()
  updatedAt?: string;
}

export class CreateQueueDto extends RoundTrippedServerFields {
  @ApiProperty({ example: 'HighPriority' })
  @IsString()
  @MinLength(1)
  @MaxLength(120)
  @Matches(/^[A-Za-z0-9._\- ]+$/, {
    message:
      'name may contain letters, digits, spaces, dot, underscore and hyphen only — it is referenced by rule chains as a plain string',
  })
  name: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  description?: string;

  @ApiPropertyOptional({
    description:
      'Kafka topic this lane would consume. STORED ONLY — nothing reads it today.',
  })
  @IsOptional()
  @IsString()
  @MaxLength(255)
  topic?: string;

  @ApiPropertyOptional({ default: 10, description: 'STORED ONLY.' })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(1000)
  partitions?: number;

  @ApiPropertyOptional({ default: false, description: 'STORED ONLY.' })
  @IsOptional()
  @IsBoolean()
  consumerPerPartition?: boolean;

  @ApiPropertyOptional({ default: 25, description: 'STORED ONLY.' })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(600000)
  pollInterval?: number;

  @ApiPropertyOptional({ default: 1000, description: 'STORED ONLY.' })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  maxPollRecords?: number;

  @ApiPropertyOptional({ default: 300000, description: 'STORED ONLY.' })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  maxPollInterval?: number;

  @ApiPropertyOptional({ default: 1048576, description: 'STORED ONLY.' })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  maxRequestSize?: number;

  @ApiPropertyOptional({ default: 10000, description: 'STORED ONLY.' })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  maxPendingMessages?: number;

  @ApiPropertyOptional({
    enum: QueueSubmitStrategy,
    default: QueueSubmitStrategy.BURST,
    description:
      'HONOURED for BURST, SEQUENTIAL_BY_ORIGINATOR and SEQUENTIAL_BY_TENANT. BATCH and SEQUENTIAL are stored and behave as BURST.',
  })
  @IsOptional()
  @IsEnum(QueueSubmitStrategy)
  submitStrategy?: QueueSubmitStrategy;

  @ApiPropertyOptional({
    enum: QueueProcessingStrategy,
    default: QueueProcessingStrategy.SKIP_ALL_FAILURES,
    description: 'HONOURED.',
  })
  @IsOptional()
  @IsEnum(QueueProcessingStrategy)
  processingStrategy?: QueueProcessingStrategy;

  @ApiPropertyOptional({
    default: 2000,
    description: 'HONOURED — milliseconds before a chain execution is abandoned.',
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(600000)
  packProcessingTimeout?: number;

  @ApiPropertyOptional({ default: 0, description: 'HONOURED.' })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(10)
  retries?: number;

  @ApiPropertyOptional({ default: 100, description: 'HONOURED.' })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(60000)
  retryFailedBackoff?: number;

  @ApiPropertyOptional({ default: 100, description: 'HONOURED.' })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(60000)
  retryTimedOutBackoff?: number;

  @ApiPropertyOptional({ default: true, description: 'HONOURED — a disabled queue imposes no semantics.' })
  @IsOptional()
  @IsBoolean()
  enabled?: boolean;

  @ApiPropertyOptional({ default: false, description: 'STORED ONLY.' })
  @IsOptional()
  @IsBoolean()
  isDefault?: boolean;

  @ApiPropertyOptional()
  @IsOptional()
  @IsObject()
  additionalInfo?: Record<string, any>;
}

export class UpdateQueueDto extends PartialType(CreateQueueDto) {}

export class QueueQueryDto extends PaginationDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  @Type(() => Boolean)
  enabled?: boolean;
}

export class AssignRuleChainDto {
  @ApiProperty({ description: 'A rule chain belonging to the caller’s tenant.' })
  @IsUUID()
  ruleChainId: string;
}
