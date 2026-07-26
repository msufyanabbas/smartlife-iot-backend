import { Injectable } from '@nestjs/common';
import { FilterNodeProcessor } from './filter-node';
import { TransformationNodeProcessor } from './transformation-node';
import { EnrichmentNodeProcessor } from './enrichment-node';
import { ActionNodeProcessor } from './action-node';
import { SwitchNodeProcessor } from './processors/switch-node';
import { ScriptNodeProcessor } from './processors/script-node';
import { ExternalNodeProcessor } from './processors/external-node';
import { FlowNodeProcessor } from './processors/flow-node';
import { INodeProcessor } from './nodes-processor.interface';
import { NodeType } from '@common/enums/index.enum';

@Injectable()
export class NodeProcessorFactory {
  constructor(
    private readonly filterProcessor: FilterNodeProcessor,
    private readonly transformationProcessor: TransformationNodeProcessor,
    private readonly enrichmentProcessor: EnrichmentNodeProcessor,
    private readonly actionProcessor: ActionNodeProcessor,
    private readonly switchProcessor: SwitchNodeProcessor,
    private readonly scriptProcessor: ScriptNodeProcessor,
    private readonly externalProcessor: ExternalNodeProcessor,
    private readonly flowProcessor: FlowNodeProcessor,
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
      case NodeType.SWITCH:
        return this.switchProcessor;
      case NodeType.SCRIPT:
        return this.scriptProcessor;
      case NodeType.EXTERNAL:
        return this.externalProcessor;
      case NodeType.FLOW:
        return this.flowProcessor;
      default:
        throw new Error(`No processor found for node type: ${nodeType}`);
    }
  }
}
