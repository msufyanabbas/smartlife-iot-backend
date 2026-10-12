import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Queue } from './entities/queue.entity';
import { RuleChain } from '@modules/rules/entities/rule-chain.entity';
import { QueuesController } from './queues.controller';
import { QueuesService } from './queues.service';
import { QueueExecutionService } from './queue-execution.service';

/**
 * Repositories only — no sibling feature module is imported, so this module can
 * never take part in a dependency cycle. That matters here specifically:
 * `RulesModule` imports THIS module (the rule-engine consumer asks
 * `QueueExecutionService` to run each chain under its queue's semantics), so
 * importing `RulesModule` back would close the loop. The `RuleChain` repository
 * is registered directly for the same reason.
 */
@Module({
  imports: [TypeOrmModule.forFeature([Queue, RuleChain])],
  controllers: [QueuesController],
  providers: [QueuesService, QueueExecutionService],
  exports: [QueuesService, QueueExecutionService],
})
export class QueuesModule {}
