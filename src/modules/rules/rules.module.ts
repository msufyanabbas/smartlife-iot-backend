import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { RulesController } from './rules.controller';
import { RulesService } from './rules.service';
import { RuleEngineService } from './rule-engine.service';
import { RuleEngineConsumer } from './rule-engine.consumer';
import { RuleChain } from '@modules/index.entities';
import { Node } from '../nodes/entities/node.entity';
import { NodesModule } from '../nodes/nodes.module';
import { KafkaModule } from '@/lib/kafka/kafka.module';

@Module({
  imports: [
    TypeOrmModule.forFeature([RuleChain, Node]),
    NodesModule,
    KafkaModule,
  ],
  controllers: [RulesController],
  providers: [RulesService, RuleEngineService, RuleEngineConsumer],
  exports: [RulesService, RuleEngineService],
})
export class RulesModule {}
