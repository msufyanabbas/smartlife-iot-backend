import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { HttpModule } from '@nestjs/axios';
import { NodesService } from './nodes.service';
import { NodesController } from './nodes.controller';
import { Node } from './entities/node.entity';
import { FilterNodeProcessor } from './filter-node';
import { TransformationNodeProcessor } from './transformation-node';
import { EnrichmentNodeProcessor } from './enrichment-node';
import { ActionNodeProcessor } from './action-node';
import { SwitchNodeProcessor } from './processors/switch-node';
import { ScriptNodeProcessor } from './processors/script-node';
import { ExternalNodeProcessor } from './processors/external-node';
import { FlowNodeProcessor } from './processors/flow-node';
import { NodeProcessorFactory } from './node-processor.factory';
import { Telemetry } from '../telemetry/entities/telemetry.entity';
import { Alarm } from '../alarms/entities/alarm.entity';
import { Attribute } from '../attributes/entities/attribute.entity';
import { MailModule } from '../mail/mail.module';
import { AttributesModule } from '../attributes/attributes.module';
import { ScriptsModule } from '../scripts/scripts.module';

@Module({
  imports: [
    TypeOrmModule.forFeature([Node, Telemetry, Alarm, Attribute]),
    MailModule,
    AttributesModule,
    // SCRIPT node executes stored scripts through ScriptsService. ScriptsModule
    // imports nothing but its own repository, so this introduces no cycle.
    ScriptsModule,
    // EXTERNAL node uses HttpService for outbound calls.
    HttpModule,
    // NOTE: FlowNodeProcessor needs RuleEngineService (in RulesModule), but it is
    // resolved lazily via ModuleRef to avoid a circular module dependency, so
    // RulesModule is intentionally NOT imported here.
  ],
  controllers: [NodesController],
  providers: [
    NodesService,
    FilterNodeProcessor,
    TransformationNodeProcessor,
    EnrichmentNodeProcessor,
    ActionNodeProcessor,
    SwitchNodeProcessor,
    ScriptNodeProcessor,
    ExternalNodeProcessor,
    FlowNodeProcessor,
    NodeProcessorFactory,
  ],
  exports: [NodesService, NodeProcessorFactory],
})
export class NodesModule {}
