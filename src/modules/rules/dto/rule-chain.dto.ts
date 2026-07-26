import {
  IsString,
  IsBoolean,
  IsOptional,
  IsObject,
  IsArray,
  IsNumber,
} from 'class-validator';
import { PartialType } from '@nestjs/swagger';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { RuleChainStatus } from '@common/enums/index.enum';

class RuleChainConfigurationDto {
  @ApiPropertyOptional({ example: ['TELEMETRY', 'ALARM'] })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  messageTypes?: string[];

  @ApiPropertyOptional({ example: ['sensor', 'gateway'] })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  deviceTypes?: string[];

  @ApiPropertyOptional({ example: ['building', 'vehicle'] })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  assetTypes?: string[];

  @ApiPropertyOptional({
    example: 5000,
    description: 'Max execution time in ms',
  })
  @IsOptional()
  @IsNumber()
  maxExecutionTime?: number;

  @ApiPropertyOptional({ example: true })
  @IsOptional()
  @IsBoolean()
  retryOnFailure?: boolean;

  @ApiPropertyOptional({ example: 3 })
  @IsOptional()
  @IsNumber()
  maxRetries?: number;
}

export class CreateRuleChainDto {
  @ApiProperty({ example: 'Device Telemetry Processing' })
  @IsString()
  name: string;

  @ApiPropertyOptional({
    example: 'Root chain for processing incoming telemetry',
  })
  @IsOptional()
  @IsString()
  description?: string;

  @ApiPropertyOptional({ type: RuleChainConfigurationDto, default: {} })
  @IsOptional()
  @IsObject()
  configuration?: RuleChainConfigurationDto;

  @ApiPropertyOptional({ example: false, default: false })
  @IsOptional()
  @IsBoolean()
  isRoot?: boolean;

  @ApiPropertyOptional({ example: true, default: true })
  @IsOptional()
  @IsBoolean()
  enabled?: boolean;

  @ApiPropertyOptional({ example: false, default: false })
  @IsOptional()
  @IsBoolean()
  debugMode?: boolean;

  @ApiPropertyOptional({ example: ['telemetry', 'critical'] })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  tags?: string[];
}

export class UpdateRuleChainDto extends PartialType(CreateRuleChainDto) {}

export class RuleChainResponseDto {
  @ApiProperty()
  id: string;

  @ApiProperty()
  tenantId: string;

  @ApiPropertyOptional()
  customerId?: string;

  @ApiProperty()
  userId: string;

  @ApiProperty()
  name: string;

  @ApiPropertyOptional()
  description?: string;

  @ApiProperty({ type: String, enum: RuleChainStatus, enumName: 'RuleChainStatus' })
  status: RuleChainStatus;

  @ApiProperty()
  isRoot: boolean;

  @ApiProperty()
  enabled: boolean;

  @ApiProperty()
  debugMode: boolean;

  @ApiPropertyOptional()
  rootNodeId?: string;

  @ApiPropertyOptional()
  configuration?: Record<string, any>;

  @ApiProperty()
  executionCount: number;

  @ApiProperty()
  successCount: number;

  @ApiProperty()
  failureCount: number;

  @ApiPropertyOptional()
  lastExecuted?: Date;

  @ApiProperty()
  averageExecutionTime: number;

  @ApiPropertyOptional()
  lastError?: string;

  @ApiPropertyOptional()
  tags?: string[];

  @ApiProperty()
  createdAt: Date;

  @ApiProperty()
  updatedAt: Date;
}

export class RuleChainQueryDto {
  @ApiPropertyOptional({ default: 1 })
  @IsOptional()
  page?: number;

  @ApiPropertyOptional({ default: 20 })
  @IsOptional()
  limit?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  search?: string;

  @ApiPropertyOptional({ description: 'Filter by active status' })
  @IsOptional()
  @IsBoolean()
  isActive?: boolean;
}
