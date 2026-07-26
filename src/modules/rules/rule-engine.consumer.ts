import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { KafkaService } from '@/lib/kafka/kafka.service';
import { RuleEngineService } from './rule-engine.service';
import { NodeMessage } from '../nodes/nodes-processor.interface';

@Injectable()
export class RuleEngineConsumer implements OnModuleInit {
  private readonly logger = new Logger(RuleEngineConsumer.name);

  constructor(
    private readonly kafka: KafkaService,
    private readonly ruleEngineService: RuleEngineService,
  ) {}

  async onModuleInit(): Promise<void> {
    this.logger.log('Starting rule engine consumer...');

    try {
      await this.kafka.createConsumer(
        'rule-engine-processor-group',
        ['rules.input'],
        this.handleMessage.bind(this),
      );
      this.logger.log('RuleEngineConsumer subscribed to rules.input');
    } catch (error) {
      this.logger.error(
        `Failed to start rule engine consumer: ${(error as Error).message}`,
      );
    }
  }

  async handleMessage({ message }: any): Promise<void> {
    try {
      const payload = JSON.parse(message.value.toString());

      if (!payload.tenantId) {
        this.logger.warn(
          `rules.input message missing tenantId — entityId: ${payload.entityId ?? 'unknown'}. Skipping.`,
        );
        return;
      }

      const nodeMessage: NodeMessage = {
        type: payload.eventType || 'TELEMETRY',
        originator: {
          id: payload.entityId,
          type: payload.entityType || 'DEVICE',
        },
        data: payload.data ?? {},
        metadata: {
          tenantId: payload.tenantId,
          deviceKey: payload.deviceKey,
          entityType: payload.entityType,
        },
        timestamp: payload.timestamp ?? Date.now(),
      };

      const results = await this.ruleEngineService.execute(
        payload.tenantId,
        nodeMessage,
      );

      if (results.length > 0) {
        const totalNodes = results.reduce((sum, r) => sum + r.nodesExecuted, 0);
        const totalTime = results.reduce((sum, r) => sum + r.executionTime, 0);
        const failed = results.filter((r) => !r.success).length;

        this.logger.log(
          `Rule engine: ${results.length} chains, ${totalNodes} nodes, ${totalTime}ms` +
            (failed > 0 ? `, ${failed} failed` : '') +
            ` — entity: ${payload.entityId}`,
        );
      }
    } catch (error) {
      this.logger.error(
        `Rule engine message handling failed: ${(error as Error).message}`,
      );
    }
  }
}
