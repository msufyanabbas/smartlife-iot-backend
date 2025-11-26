import { Injectable } from '@nestjs/common';
import {
  INodeProcessor,
  NodeMessage,
  NodeProcessorResult,
} from './nodes-processor.interface';

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

  private executeTransformScript(script: string, msg: NodeMessage): any {
    try {
      const func = new Function('msg', 'metadata', script);
      return func(msg.data, msg.metadata);
    } catch (error) {
      throw new Error(`Transformation script failed: ${error.message}`);
    }
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
