import { Injectable } from '@nestjs/common';
import {
  INodeProcessor,
  NodeMessage,
  NodeProcessorResult,
} from '../nodes-processor.interface';
import { evaluateCondition } from '../condition.util';

interface SwitchCase {
  key: string;
  operator: string;
  value: any;
  outputRoute: string;
}

/**
 * SWITCH node — routes a message to one of N named output routes.
 *
 * Unlike FILTER (binary success/failure), SWITCH evaluates each case in order
 * and returns the first matching case's `outputRoute` as the result route.
 *
 * configuration:
 * {
 *   switchType: 'value' | 'range' | 'multiple',
 *   cases: [{ key, operator, value, outputRoute }],
 *   defaultRoute?: string
 * }
 */
@Injectable()
export class SwitchNodeProcessor implements INodeProcessor {
  async process(input: NodeMessage, config: any): Promise<NodeProcessorResult> {
    try {
      const cases: SwitchCase[] = Array.isArray(config?.cases)
        ? config.cases
        : [];
      const data = input.data ?? {};

      for (const c of cases) {
        if (evaluateCondition(data, c.key, c.operator, c.value)) {
          return {
            success: true,
            output: input,
            route: c.outputRoute,
          };
        }
      }

      // No case matched — fall back to defaultRoute, else 'failure'.
      if (config?.defaultRoute) {
        return {
          success: true,
          output: input,
          route: config.defaultRoute,
        };
      }

      return {
        success: false,
        output: input,
        route: 'failure',
      };
    } catch (error: any) {
      return {
        success: false,
        error: error.message,
        route: 'failure',
      };
    }
  }
}
