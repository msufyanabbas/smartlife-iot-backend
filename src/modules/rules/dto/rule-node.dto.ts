import {
  IsString,
  IsEnum,
  IsOptional,
  IsBoolean,
  IsObject,
  IsUUID,
  IsNumber,
  IsArray,
  ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';
import { PartialType } from '@nestjs/swagger';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { NodeType } from '@common/enums/index.enum';
import { ConnectionDto } from '../../nodes/dto/connection.dto';

class NodePositionDto {
  @ApiProperty({ example: 100 })
  @IsNumber()
  x: number;

  @ApiProperty({ example: 200 })
  @IsNumber()
  y: number;
}

export class CreateRuleNodeDto {
  @ApiProperty({ example: 'Temperature Filter' })
  @IsString()
  name: string;

  @ApiPropertyOptional({
    example: 'Filter messages above temperature threshold',
  })
  @IsOptional()
  @IsString()
  description?: string;

  @ApiProperty({ enum: NodeType, example: NodeType.FILTER })
  @IsEnum(NodeType)
  type: NodeType;

  @ApiProperty({
    example: {
      messageTypes: ['TELEMETRY'],
      condition: { key: 'temperature', operator: 'gt', value: 30 },
    },
    description: 'Node-type-specific configuration',
  })
  @IsObject()
  configuration: Record<string, any>;

  @ApiPropertyOptional({ example: 'rule-chain-uuid' })
  @IsOptional()
  @IsUUID()
  ruleChainId?: string;

  @ApiPropertyOptional({
    type: [ConnectionDto],
    description: 'Outgoing edges to other nodes (the node graph wiring)',
    example: [
      {
        targetNodeId: '5bd40c91-b22e-434f-95a7-c8486b2fba37',
        connectionType: 'success',
        label: 'on pass',
      },
      {
        targetNodeId: '6141d2e0-db10-49fb-b160-83b6b02c3fb9',
        connectionType: 'failure',
        label: 'on fail',
      },
    ],
  })
  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => ConnectionDto)
  connections?: ConnectionDto[];

  @ApiPropertyOptional({ type: NodePositionDto, example: { x: 100, y: 200 } })
  @IsOptional()
  @IsObject()
  position?: NodePositionDto;

  @ApiPropertyOptional({ example: true, default: true })
  @IsOptional()
  @IsBoolean()
  enabled?: boolean;

  @ApiPropertyOptional({ example: false, default: false })
  @IsOptional()
  @IsBoolean()
  debugMode?: boolean;
}

export class UpdateRuleNodeDto extends PartialType(CreateRuleNodeDto) {}
