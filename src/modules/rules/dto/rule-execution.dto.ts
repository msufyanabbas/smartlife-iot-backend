import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { NodeType } from '@common/enums/index.enum';

export class NodeTraceEntryDto {
  @ApiProperty()
  nodeId: string;

  @ApiProperty({ enum: NodeType })
  nodeType: NodeType;

  @ApiProperty()
  nodeName: string;

  @ApiProperty()
  success: boolean;

  @ApiProperty({
    example: 'success',
    description: 'Output route taken: success | failure | true | false',
  })
  route: string;

  @ApiProperty({ description: 'Execution time in milliseconds' })
  executionTime: number;

  @ApiPropertyOptional({ description: 'Error message if node failed' })
  error?: string;
}

export class RuleExecutionResultDto {
  @ApiProperty()
  chainId: string;

  @ApiProperty()
  chainName: string;

  @ApiProperty()
  success: boolean;

  @ApiProperty({ description: 'Total execution time in milliseconds' })
  executionTime: number;

  @ApiProperty({ description: 'Number of nodes executed' })
  nodesExecuted: number;

  @ApiPropertyOptional({ description: 'Error message if chain failed' })
  error?: string;

  @ApiProperty({
    type: [NodeTraceEntryDto],
    description: 'Per-node execution trace',
  })
  trace: NodeTraceEntryDto[];
}
