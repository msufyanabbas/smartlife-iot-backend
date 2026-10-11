import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { RulesController } from './rules.controller';
import { RulesService } from './rules.service';
import { RuleEngineService } from './rule-engine.service';
import { RuleEngineConsumer } from './rule-engine.consumer';
import { RuleChainTemplatesController } from './rule-chain-templates.controller';
import { RuleChainTemplatesService } from './rule-chain-templates.service';
import { RuleChainTemplate } from './entities/rule-chain-template.entity';
import { RuleChain } from '@modules/index.entities';
import { Node } from '../nodes/entities/node.entity';
import { NodesModule } from '../nodes/nodes.module';
import { KafkaModule } from '@/lib/kafka/kafka.module';

@Module({
  imports: [
    TypeOrmModule.forFeature([RuleChain, Node, RuleChainTemplate]),
    NodesModule,
    KafkaModule,
  ],
  controllers: [RulesController, RuleChainTemplatesController],
  providers: [
    RulesService,
    RuleEngineService,
    RuleEngineConsumer,
    RuleChainTemplatesService,
  ],
  exports: [RulesService, RuleEngineService, RuleChainTemplatesService],
})
export class RulesModule {}
