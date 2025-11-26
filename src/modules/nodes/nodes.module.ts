import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { NodesService } from './nodes.service';
import { NodesController } from './nodes.controller';
import { Node } from './entities/node.entity';
import { FilterNodeProcessor } from './filter-node';
import { TransformationNodeProcessor } from './transformation-node';
import { EnrichmentNodeProcessor } from './enrichment-node';
import { ActionNodeProcessor } from './action-node';
import { NodeProcessorFactory } from './node-processor.factory';

@Module({
  imports: [TypeOrmModule.forFeature([Node])],
  controllers: [NodesController],
  providers: [
    NodesService,
    FilterNodeProcessor,
    TransformationNodeProcessor,
    EnrichmentNodeProcessor,
    ActionNodeProcessor,
    NodeProcessorFactory,
  ],
  exports: [NodesService, NodeProcessorFactory],
})
export class NodesModule {}
