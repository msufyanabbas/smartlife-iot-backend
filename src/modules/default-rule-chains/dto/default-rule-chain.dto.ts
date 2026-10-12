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
} from 'class-validator';
import { PaginationDto } from '@common/dto/pagination.dto';
import { DefaultRuleChainOriginatorType } from '../default-rule-chain.enum';

/**
 * The global ValidationPipe is `{whitelist, forbidNonWhitelisted}`, so every
 * property the client sends must be declared or the request is a 400. The
 * shipped `default-rule-chains.api.ts` posts `Partial<DefaultRuleChain>` —
 * which can carry `id`, `tenantId`, `createdAt` and `updatedAt` straight off a
 * row being edited — so those are declared and ignored rather than rejected.
 * It also calls the field `type` rather than `originatorType`; both are
 * accepted and `originatorType` wins when both are present.
 */
export class CreateDefaultRuleChainDto {
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

  @ApiProperty({ example: 'Telemetry → threshold alarms' })
  @IsString()
  @MaxLength(160)
  name: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  description?: string;

  @ApiPropertyOptional({
    enum: DefaultRuleChainOriginatorType,
    default: DefaultRuleChainOriginatorType.DEVICE,
    description: '`*` matches any originator.',
  })
  @IsOptional()
  @IsEnum(DefaultRuleChainOriginatorType)
  originatorType?: DefaultRuleChainOriginatorType;

  @ApiPropertyOptional({
    enum: DefaultRuleChainOriginatorType,
    description:
      'Alias of `originatorType`, for the shipped frontend client which calls it `type`.',
  })
  @IsOptional()
  @IsEnum(DefaultRuleChainOriginatorType)
  type?: DefaultRuleChainOriginatorType;

  @ApiPropertyOptional({
    example: 'TELEMETRY',
    description:
      'Free text — the consumer forwards `eventType` verbatim. Omit or send `*` for "any message type".',
  })
  @IsOptional()
  @IsString()
  @MaxLength(80)
  @Matches(/^[^\s]+$/, { message: 'messageType must not contain whitespace' })
  messageType?: string;

  @ApiPropertyOptional({ description: 'Omit for "any device profile".' })
  @IsOptional()
  @IsUUID()
  deviceProfileId?: string;

  @ApiProperty({ description: 'A rule chain belonging to the caller’s tenant.' })
  @IsUUID()
  ruleChainId: string;

  @ApiPropertyOptional({ default: 0, description: 'Higher wins between rules of equal specificity.' })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(-1000)
  @Max(1000)
  priority?: number;

  @ApiPropertyOptional({ default: true })
  @IsOptional()
  @IsBoolean()
  enabled?: boolean;

  @ApiPropertyOptional()
  @IsOptional()
  @IsObject()
  additionalInfo?: Record<string, any>;
}

export class UpdateDefaultRuleChainDto extends PartialType(
  CreateDefaultRuleChainDto,
) {}

export class DefaultRuleChainQueryDto extends PaginationDto {
  @ApiPropertyOptional({ enum: DefaultRuleChainOriginatorType })
  @IsOptional()
  @IsEnum(DefaultRuleChainOriginatorType)
  originatorType?: DefaultRuleChainOriginatorType;

  @ApiPropertyOptional({
    enum: DefaultRuleChainOriginatorType,
    description: 'Alias of `originatorType` for the shipped frontend client.',
  })
  @IsOptional()
  @IsEnum(DefaultRuleChainOriginatorType)
  type?: DefaultRuleChainOriginatorType;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(80)
  messageType?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @Type(() => Boolean)
  @IsBoolean()
  enabled?: boolean;
}

/** Body of `POST /default-rule-chains/type/:type`, the "set default" shortcut. */
export class SetDefaultRuleChainDto {
  @ApiProperty()
  @IsUUID()
  ruleChainId: string;

  @ApiPropertyOptional({ description: 'Label for the rule this creates or updates.' })
  @IsOptional()
  @IsString()
  @MaxLength(160)
  name?: string;
}

/** Query of `GET /default-rule-chains/resolve` — the diagnostic route. */
export class ResolveDefaultRuleChainDto {
  @ApiPropertyOptional({ example: 'TELEMETRY', default: 'TELEMETRY' })
  @IsOptional()
  @IsString()
  @MaxLength(80)
  messageType?: string;

  @ApiPropertyOptional({ enum: DefaultRuleChainOriginatorType, default: DefaultRuleChainOriginatorType.DEVICE })
  @IsOptional()
  @IsEnum(DefaultRuleChainOriginatorType)
  originatorType?: DefaultRuleChainOriginatorType;

  @ApiPropertyOptional({ description: 'Resolve as if the originator were this device.' })
  @IsOptional()
  @IsUUID()
  deviceId?: string;

  @ApiPropertyOptional({ description: 'Resolve as if the originator carried this profile.' })
  @IsOptional()
  @IsUUID()
  deviceProfileId?: string;
}
