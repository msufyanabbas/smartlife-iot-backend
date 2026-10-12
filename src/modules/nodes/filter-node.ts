import { Injectable } from '@nestjs/common';
import {
  INodeProcessor,
  NodeMessage,
  NodeProcessorResult,
} from './nodes-processor.interface';
import { ConditionOperator, evaluateCondition } from './condition.util';
import { runUserScript } from '@common/utils/script-sandbox';

interface ConditionRule {
  key: string;
  operator: ConditionOperator;
  value?: any;
  type?: 'AND' | 'OR';
}

interface ConditionGroup {
  operator?: 'AND' | 'OR';
  conditions: ConditionRule[];
}

@Injectable()
export class FilterNodeProcessor implements INodeProcessor {
  async process(input: NodeMessage, config: any): Promise<NodeProcessorResult> {
    try {
      // ── Message type filter ──────────────────────────────────────────────
      if (config.messageTypes?.length > 0) {
        if (!config.messageTypes.includes(input.type)) {
          return { success: false, route: 'false' };
        }
      }

      // ── Originator type filter ───────────────────────────────────────────
      if (config.originatorTypes?.length > 0) {
        if (!config.originatorTypes.includes(input.originator?.type)) {
          return { success: false, route: 'false' };
        }
      }

      // ── Condition-based filter ───────────────────────────────────────────
      if (config.filterType === 'condition' || config.condition) {
        const passed = this.evaluateConditionGroup(
          input.data ?? {},
          config.condition ?? config,
        );
        return {
          success: passed,
          output: input,
          route: passed ? 'true' : 'false',
        };
      }

      // ── Script filter ────────────────────────────────────────────────────
      if (config.script) {
        const result = this.executeScript(config.script, input);
        return {
          success: result,
          output: input,
          route: result ? 'true' : 'false',
        };
      }

      return {
        success: true,
        output: input,
        route: 'true',
      };
    } catch (error: any) {
      return {
        success: false,
        error: error.message,
        route: 'failure',
      };
    }
  }

  // ══════════════════════════════════════════════════════════════════════════
  // CONDITION EVALUATION
  // ══════════════════════════════════════════════════════════════════════════

  private evaluateConditionGroup(
    data: Record<string, any>,
    group: ConditionGroup | ConditionRule,
  ): boolean {
    // Single condition rule (no nested conditions array)
    if ('key' in group && 'operator' in group) {
      return this.evaluateCondition(data, group);
    }

    const conditionGroup = group;
    const combinator = conditionGroup.operator ?? 'AND';

    if (!conditionGroup.conditions?.length) return true;

    if (combinator === 'OR') {
      return conditionGroup.conditions.some((c) =>
        this.evaluateCondition(data, c),
      );
    }
    // AND (default)
    return conditionGroup.conditions.every((c) =>
      this.evaluateCondition(data, c),
    );
  }

  private evaluateCondition(
    data: Record<string, any>,
    rule: ConditionRule,
  ): boolean {
    // Delegates to the shared condition utility so FILTER and SWITCH stay in sync.
    return evaluateCondition(data, rule.key, rule.operator, rule.value);
  }

  /**
   * Run the node's filter script.
   *
   * This was `new Function('msg', 'metadata', script)`, which compiles into
   * the host realm — so a filter script saved on a rule node ran with this
   * process's globals in reach and `process.mainModule.require(...)` two hops
   * away. The script is tenant-authored (`node.configuration.script`), so
   * anyone who could edit a rule chain had arbitrary code execution on the
   * server. See `@common/utils/script-sandbox` for the full account.
   */
  private executeScript(script: string, msg: NodeMessage): boolean {
    const result = runUserScript(
      script,
      { msg: msg.data, metadata: msg.metadata },
      { label: 'filter node script' },
    );
    // A filter routes on true/false, so a script that returns a string or an
    // object is coerced rather than crashing the chain — but an explicit
    // boolean is what the node documentation asks for.
    return Boolean(result);
  }
}
