import { Injectable } from '@nestjs/common';
import {
  INodeProcessor,
  NodeMessage,
  NodeProcessorResult,
} from './nodes-processor.interface';
import { runUserScript } from '@common/utils/script-sandbox';

@Injectable()
export class TransformationNodeProcessor implements INodeProcessor {
  async process(input: NodeMessage, config: any): Promise<NodeProcessorResult> {
    try {
      let transformedData = { ...input.data };

      // Script Transformation
      if (config.script) {
        transformedData = this.executeTransformScript(config.script, input);
      }

      // Data Key Mapping
      if (config.dataKeyMapping) {
        transformedData = this.applyKeyMapping(
          transformedData,
          config.dataKeyMapping,
        );
      }

      // Unit Conversion
      if (config.conversions) {
        transformedData = this.applyConversions(
          transformedData,
          config.conversions,
        );
      }

      const output: NodeMessage = {
        ...input,
        data: transformedData,
        metadata: {
          ...input.metadata,
          transformed: true,
          transformedAt: Date.now(),
        },
      };

      return {
        success: true,
        output,
        route: 'success',
      };
    } catch (error) {
      return {
        success: false,
        error: error.message,
        route: 'failure',
      };
    }
  }

  /**
   * Run the node's transformation script.
   *
   * Was `new Function('msg', 'metadata', script)` — host-realm compilation of
   * tenant-authored code, i.e. remote code execution for anyone able to edit a
   * rule chain. See `@common/utils/script-sandbox`.
   */
  private executeTransformScript(script: string, msg: NodeMessage): any {
    return runUserScript(
      script,
      { msg: msg.data, metadata: msg.metadata },
      { label: 'transformation node script' },
    );
  }

  private applyKeyMapping(data: any, mapping: Record<string, string>): any {
    const result = { ...data };
    for (const [oldKey, newKey] of Object.entries(mapping)) {
      if (oldKey in result) {
        result[newKey] = result[oldKey];
        delete result[oldKey];
      }
    }
    return result;
  }

  private applyConversions(
    data: any,
    conversions: Array<{ key: string; from: string; to: string }>,
  ): any {
    const result = { ...data };
    for (const conversion of conversions) {
      if (conversion.key in result) {
        result[conversion.key] = this.convert(
          result[conversion.key],
          conversion.from,
          conversion.to,
        );
      }
    }
    return result;
  }

  private convert(value: number, from: string, to: string): number {
    // Temperature conversions
    if (from === 'celsius' && to === 'fahrenheit') {
      return (value * 9) / 5 + 32;
    }
    if (from === 'fahrenheit' && to === 'celsius') {
      return ((value - 32) * 5) / 9;
    }
    // Add more conversions as needed
    return value;
  }
}
