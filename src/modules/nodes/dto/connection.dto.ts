import { IsOptional, IsString, IsUUID } from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

/**
 * A single outgoing edge from a node to another node.
 *
 * Mirrors the `connections` JSONB column on the Node entity:
 *   Array<{ targetNodeId: string; connectionType: string; label?: string }>
 *
 * `connectionType` is the route label the rule engine matches when deciding the
 * next node. Binary nodes use 'success' | 'failure' | 'default' | 'custom';
 * SWITCH nodes may use any named output route (e.g. 'A', 'B', 'high', 'low'),
 * so it is validated as a free-form string rather than a fixed enum.
 */
export class ConnectionDto {
  @ApiProperty({
    example: '5bd40c91-b22e-434f-95a7-c8486b2fba37',
    description: 'ID of the node this edge points to',
  })
  @IsUUID()
  targetNodeId: string;

  @ApiProperty({
    example: 'success',
    description:
      "Route label the engine follows: 'success' | 'failure' | 'default' | 'custom', or a named SWITCH route (e.g. 'A')",
  })
  @IsString()
  connectionType: string;

  @ApiPropertyOptional({
    example: 'Temperature > 30°C',
    description: 'Optional human-readable label for the edge',
  })
  @IsOptional()
  @IsString()
  label?: string;
}
