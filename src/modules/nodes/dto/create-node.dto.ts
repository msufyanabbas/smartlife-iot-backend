import {
  IsString,
  IsEnum,
  IsOptional,
  IsBoolean,
  IsObject,
} from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';
import { NodeType } from '../entities/node.entity';

export class CreateNodeDto {
  @ApiProperty({ example: 'Message Type Filter' })
  @IsString()
  name: string;

  @ApiProperty({ example: 'Filters messages by type', required: false })
  @IsOptional()
  @IsString()
  description?: string;

  @ApiProperty({ enum: NodeType, example: NodeType.FILTER })
  @IsEnum(NodeType)
  type: NodeType;

  @ApiProperty({ example: 'rule-chain-uuid', required: false })
  @IsOptional()
  @IsString()
  ruleChainId?: string;

  @ApiProperty({
    example: {
      messageTypes: ['POST_TELEMETRY', 'POST_ATTRIBUTES'],
      script: 'return msg.type === "POST_TELEMETRY";',
    },
  })
  @IsObject()
  configuration: {
    script?: string;
    scriptLang?: string;
    successAction?: string;
    failureAction?: string;
    messageTypes?: string[];
    originatorTypes?: string[];
    relationTypes?: string[];
    dataKeys?: string[];
    metadata?: Record<string, any>;
  };

  @ApiProperty({ example: { x: 100, y: 200 }, required: false })
  @IsOptional()
  @IsObject()
  position?: {
    x: number;
    y: number;
  };

  @ApiProperty({ example: true, required: false })
  @IsOptional()
  @IsBoolean()
  enabled?: boolean;

  @ApiProperty({ example: false, required: false })
  @IsOptional()
  @IsBoolean()
  debugMode?: boolean;
}
