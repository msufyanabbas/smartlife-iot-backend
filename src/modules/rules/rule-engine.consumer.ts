import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { KafkaService } from '@/lib/kafka/kafka.service';
import { RuleEngineService } from './rule-engine.service';
import { RulesService } from './rules.service';
import { NodeMessage } from '../nodes/nodes-processor.interface';
import { DefaultRuleChainResolverService } from '@modules/default-rule-chains/default-rule-chain-resolver.service';
import { QueueExecutionService } from '@modules/queues/queue-execution.service';

@Injectable()
export class RuleEngineConsumer implements OnModuleInit {
  private readonly logger = new Logger(RuleEngineConsumer.name);

  constructor(
    private readonly kafka: KafkaService,
    private readonly ruleEngineService: RuleEngineService,
    private readonly rulesService: RulesService,
    // DefaultRuleChainsModule and QueuesModule import repositories only, so
    // neither can import this module back — there is no cycle here.
    private readonly defaultRuleChains: DefaultRuleChainResolverService,
    private readonly queues: QueueExecutionService,
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

      await this.dispatch(payload, nodeMessage);
    } catch (error) {
      this.logger.error(
        `Rule engine message handling failed: ${(error as Error).message}`,
      );
    }
  }

  /**
   * Pick the chain, then run it.
   *
   * ── Step 1: the default-rule-chain mapping gets first refusal ────────────
   * `DefaultRuleChainResolverService.resolve()` answers "which chain handles a
   * message of this type, from this originator type, from a device with this
   * profile?" from the tenant's `default_rule_chains` rows. It is cached in
   * process for 30 seconds and invalidated on every write, because this runs
   * once per message on `rules.input`.
   *
   * ── Step 2: fall back to exactly what this consumer did before ──────────
   * No mapping ⇒ `RuleEngineService.execute()`, unchanged. Note that this is
   * NOT a root-chain fallback whatever CLAUDE.md §4f says: `loadMatchingChains`
   * fans the message out to EVERY active chain whose
   * `configuration.messageTypes` accepts it. That behaviour is deliberately
   * preserved rather than narrowed, since narrowing it would silently stop
   * chains firing for every tenant that has configured no mappings.
   *
   * ── Step 3: the chain's queue decides how the execution is run ──────────
   * On the mapped path, the chain's `configuration.queueName` is looked up and
   * `QueueExecutionService` applies that queue's submit strategy, pack
   * processing timeout, processing strategy and retries. A chain that names no
   * queue, or names one that does not exist or is disabled, runs exactly as it
   * would without QueuesModule.
   *
   * Queue semantics are therefore applied to the SINGLE-CHAIN path only. The
   * fan-out path runs several chains inside one `execute()` call, and wrapping
   * each of those would mean changing `RuleEngineService` itself.
   */
  private async dispatch(payload: any, nodeMessage: NodeMessage): Promise<void> {
    const tenantId: string = payload.tenantId;

    const resolved = await this.defaultRuleChains.resolve(tenantId, {
      messageType: nodeMessage.type,
      originatorType: nodeMessage.originator.type,
      originatorId: nodeMessage.originator.id,
    });

    if (!resolved) {
      const results = await this.ruleEngineService.execute(tenantId, nodeMessage);
      this.logResults(results, payload, 'fan-out');
      return;
    }

    // A second read of the chain row: `executeChainById` loads it again inside
    // the engine. The queue name has to be known BEFORE the execution starts,
    // and the alternative is a new method on RuleEngineService — a wider edit
    // to a file another agent is working in, for one cached row read on the
    // mapped path only.
    let queueName: string | undefined;
    try {
      const chain = await this.rulesService.findOne(
        tenantId,
        resolved.ruleChainId,
      );
      queueName = chain.configuration?.queueName;
    } catch (err) {
      this.logger.error(
        `Default rule chain mapping "${resolved.ruleName}" points at chain ` +
          `${resolved.ruleChainId}, which could not be loaded: ${(err as Error).message}. ` +
          'Falling back to the normal chain selection.',
      );
      const results = await this.ruleEngineService.execute(tenantId, nodeMessage);
      this.logResults(results, payload, 'fan-out (mapping target missing)');
      return;
    }

    const run = await this.queues.run(
      tenantId,
      queueName,
      nodeMessage.originator.id,
      () =>
        this.ruleEngineService.executeChainById(
          tenantId,
          resolved.ruleChainId,
          nodeMessage,
        ),
    );

    const via =
      `mapping:${resolved.matchedBy}` +
      (run.applied ? ` queue:${run.queueName}` : '') +
      (run.attempts > 1 ? ` attempts:${run.attempts}` : '');

    if (run.outcome !== 'ok') {
      this.logger.warn(
        `Rule engine: chain ${resolved.ruleChainId} ${run.outcome} after ` +
          `${run.attempts} attempt(s) [${via}] — entity: ${payload.entityId}: ` +
          (run.error ?? 'no detail'),
      );
      return;
    }

    this.logResults(run.value ? [run.value] : [], payload, via);
  }

  private logResults(
    results: Array<{
      nodesExecuted: number;
      executionTime: number;
      success: boolean;
    }>,
    payload: any,
    via: string,
  ): void {
    if (results.length === 0) return;

    const totalNodes = results.reduce((sum, r) => sum + r.nodesExecuted, 0);
    const totalTime = results.reduce((sum, r) => sum + r.executionTime, 0);
    const failed = results.filter((r) => !r.success).length;

    this.logger.log(
      `Rule engine: ${results.length} chains, ${totalNodes} nodes, ${totalTime}ms` +
        (failed > 0 ? `, ${failed} failed` : '') +
        ` [${via}] — entity: ${payload.entityId}`,
    );
  }
}
