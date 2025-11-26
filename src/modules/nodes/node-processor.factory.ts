import { Injectable } from '@nestjs/common';
import { FilterNodeProcessor } from './filter-node';
import { TransformationNodeProcessor } from './transformation-node';
import { EnrichmentNodeProcessor } from './enrichment-node';
import { ActionNodeProcessor } from './action-node';
import { INodeProcessor } from './nodes-processor.interface';
import { NodeType } from './entities/node.entity';

@Injectable()
export class NodeProcessorFactory {
  constructor(
    private readonly filterProcessor: FilterNodeProcessor,
    private readonly transformationProcessor: TransformationNodeProcessor,
    private readonly enrichmentProcessor: EnrichmentNodeProcessor,
    private readonly actionProcessor: ActionNodeProcessor,
  ) {}

  getProcessor(nodeType: NodeType): INodeProcessor {
    switch (nodeType) {
      case NodeType.FILTER:
        return this.filterProcessor;
      case NodeType.TRANSFORMATION:
        return this.transformationProcessor;
      case NodeType.ENRICHMENT:
        return this.enrichmentProcessor;
      case NodeType.ACTION:
        return this.actionProcessor;
      default:
        throw new Error(`No processor found for node type: ${nodeType}`);
    }
  }
}
