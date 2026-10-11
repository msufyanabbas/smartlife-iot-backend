import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  IsArray,
  IsBoolean,
  IsEnum,
  IsNumber,
  IsObject,
  IsOptional,
  IsString,
  MaxLength,
  ValidateNested,
} from 'class-validator';
import { NodeType } from '@common/enums/index.enum';

/**
 * ─────────────────────────────────────────────────────────────────────────────
 * The whole graph, in one request.
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * The editor needs this shape for a reason worth stating: a rule chain is only
 * meaningful as a complete graph. Saving it node-by-node over the existing
 * `POST /nodes` + `PATCH /nodes/:id` routes means a dozen requests where any
 * one can fail, and a half-applied save leaves edges pointing at nodes that
 * were never created — a chain that passes validation and then dead-ends at
 * runtime. `PUT /rule-chains/:id/metadata` applies the lot in one transaction
 * or none of it.
 *
 * It also lets the editor use its own node ids. A new node has no server id
 * until it is saved, but its edges have to reference it NOW, while the user is
 * drawing. So `id` here may be a client-generated temporary id; the server maps
 * temporary ids to real ones after insert and rewrites the connections. Without
 * that, the frontend would have to save nodes first, read back their ids, and
 * only then save edges — three round trips and a window where the graph is
 * wrong.
 */

export class NodePositionDto {
  @ApiProperty({ example: 250 })
  @IsNumber()
  x: number;

  @ApiProperty({ example: 150 })
  @IsNumber()
  y: number;
}

export class NodeConnectionDto {
  @ApiProperty({
    description:
      'Target node id. May be a temporary client id present in this same payload.',
  })
  @IsString()
  targetNodeId: string;

  @ApiProperty({
    example: 'success',
    description:
      'The route label the engine follows out of this node. Free-form because SWITCH nodes name their own routes.',
  })
  @IsString()
  @MaxLength(64)
  connectionType: string;

  @ApiPropertyOptional({ description: 'Edge caption shown in the editor.' })
  @IsOptional()
  @IsString()
  @MaxLength(120)
  label?: string;
}

export class RuleChainNodeDto {
  @ApiPropertyOptional({
    description:
      'Existing node id, or a temporary id for a node being created. Omit for a new node.',
  })
  @IsOptional()
  @IsString()
  id?: string;

  @ApiProperty({ example: 'Temperature over 30' })
  @IsString()
  @MaxLength(255)
  name: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  description?: string;

  @ApiProperty({ enum: NodeType, enumName: 'NodeType' })
  @IsEnum(NodeType)
  type: NodeType;

  @ApiPropertyOptional({ default: true })
  @IsOptional()
  @IsBoolean()
  enabled?: boolean;

  @ApiPropertyOptional({ default: false })
  @IsOptional()
  @IsBoolean()
  debugMode?: boolean;

  @ApiProperty({ type: Object, description: 'Per-type settings; see GET /rule-chains/catalogue.' })
  @IsObject()
  configuration: Record<string, any>;

  @ApiProperty({ type: NodePositionDto })
  @ValidateNested()
  @Type(() => NodePositionDto)
  position: NodePositionDto;

  @ApiProperty({ type: [NodeConnectionDto] })
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => NodeConnectionDto)
  connections: NodeConnectionDto[];
}

export class SaveRuleChainMetadataDto {
  @ApiProperty({
    type: [RuleChainNodeDto],
    description:
      'The complete node set. Nodes of this chain that are absent here are DELETED.',
  })
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => RuleChainNodeDto)
  nodes: RuleChainNodeDto[];

  @ApiPropertyOptional({
    description:
      'Entry node. May be a temporary id from this payload. Omit to let the engine fall back to the node nothing points at.',
  })
  @IsOptional()
  @IsString()
  rootNodeId?: string;
}

// ── Response shapes ─────────────────────────────────────────────────────────

export class RuleChainMetadataResponseDto {
  @ApiProperty({ description: 'The chain itself, including execution counters.' })
  ruleChain: Record<string, any>;

  @ApiProperty({
    type: [Object],
    description: 'Nodes with their canvas position and outgoing connections.',
  })
  nodes: Record<string, any>[];

  @ApiProperty({
    description:
      'Resolved entry node. Either the stored rootNodeId or, when that is unset, the node no edge targets — which is what the engine does at runtime.',
    nullable: true,
  })
  resolvedRootNodeId: string | null;

  @ApiProperty({
    type: [Object],
    description:
      'Problems that would stop this chain working: unreachable nodes, edges to nowhere, routes no node can emit, missing required config.',
  })
  issues: Array<{
    level: 'error' | 'warning';
    nodeId?: string;
    message: string;
  }>;
}

export class TestRuleChainDto {
  @ApiPropertyOptional({
    example: 'TELEMETRY',
    default: 'TELEMETRY',
    description: 'Message type, matched against the chain\'s messageTypes filter.',
  })
  @IsOptional()
  @IsString()
  type?: string;

  @ApiProperty({
    type: Object,
    example: { temperature: 34.5, humidity: 61 },
    description: 'The message body the chain will run against.',
  })
  @IsObject()
  data: Record<string, any>;

  @ApiPropertyOptional({
    type: Object,
    example: { deviceType: 'sensor' },
    description: 'Message metadata. deviceType is used by the chain-level filter.',
  })
  @IsOptional()
  @IsObject()
  metadata?: Record<string, any>;

  @ApiPropertyOptional({
    type: Object,
    example: { id: 'device-uuid', type: 'DEVICE' },
  })
  @IsOptional()
  @IsObject()
  originator?: Record<string, any>;
}
