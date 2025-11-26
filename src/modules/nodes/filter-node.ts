import { Injectable } from '@nestjs/common';
import {
  INodeProcessor,
  NodeMessage,
  NodeProcessorResult,
} from './nodes-processor.interface';

@Injectable()
export class FilterNodeProcessor implements INodeProcessor {
  async process(input: NodeMessage, config: any): Promise<NodeProcessorResult> {
    try {
      // Message Type Filter
      if (config.messageTypes && config.messageTypes.length > 0) {
        if (!config.messageTypes.includes(input.type)) {
          return {
            success: false,
            route: 'false',
          };
        }
      }

      // Originator Type Filter
      if (config.originatorTypes && config.originatorTypes.length > 0) {
        if (!config.originatorTypes.includes(input.originator.type)) {
          return {
            success: false,
            route: 'false',
          };
        }
      }

      // Script Filter (JavaScript)
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
    } catch (error) {
      return {
        success: false,
        error: error.message,
        route: 'failure',
      };
    }
  }

  private executeScript(script: string, msg: NodeMessage): boolean {
    try {
      // Create a safe context for script execution
      const func = new Function('msg', 'metadata', script);
      return func(msg.data, msg.metadata);
    } catch (error) {
      throw new Error(`Script execution failed: ${error.message}`);
    }
  }
}
