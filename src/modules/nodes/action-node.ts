import { Injectable } from '@nestjs/common';
import {
  INodeProcessor,
  NodeMessage,
  NodeProcessorResult,
} from './nodes-processor.interface';

@Injectable()
export class ActionNodeProcessor implements INodeProcessor {
  async process(input: NodeMessage, config: any): Promise<NodeProcessorResult> {
    try {
      let actionResult: any;

      switch (config.actionType) {
        case 'save_telemetry':
          actionResult = await this.saveTelemetry(input, config);
          break;
        case 'save_attributes':
          actionResult = await this.saveAttributes(input, config);
          break;
        case 'create_alarm':
          actionResult = await this.createAlarm(input, config);
          break;
        case 'send_email':
          actionResult = await this.sendEmail(input, config);
          break;
        case 'rest_api_call':
          actionResult = await this.restApiCall(input, config);
          break;
        case 'mqtt_publish':
          actionResult = await this.mqttPublish(input, config);
          break;
        default:
          throw new Error(`Unknown action type: ${config.actionType}`);
      }

      return {
        success: true,
        output: {
          ...input,
          metadata: {
            ...input.metadata,
            actionExecuted: config.actionType,
            actionResult,
            executedAt: Date.now(),
          },
        },
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

  private async saveTelemetry(input: NodeMessage, config: any): Promise<any> {
    // TODO: Implement actual telemetry saving
    console.log('Saving telemetry:', input.data);
    return { saved: true };
  }

  private async saveAttributes(input: NodeMessage, config: any): Promise<any> {
    // TODO: Implement actual attribute saving
    console.log('Saving attributes:', input.data);
    return { saved: true };
  }

  private async createAlarm(input: NodeMessage, config: any): Promise<any> {
    // TODO: Implement actual alarm creation
    console.log('Creating alarm:', config.alarmType);
    return { alarmId: 'alarm-' + Date.now() };
  }

  private async sendEmail(input: NodeMessage, config: any): Promise<any> {
    // TODO: Implement actual email sending
    console.log('Sending email to:', config.recipients);
    return { sent: true };
  }

  private async restApiCall(input: NodeMessage, config: any): Promise<any> {
    // TODO: Implement actual REST API call
    console.log('Making REST API call to:', config.url);
    return { statusCode: 200 };
  }

  private async mqttPublish(input: NodeMessage, config: any): Promise<any> {
    // TODO: Implement actual MQTT publish
    console.log('Publishing to MQTT topic:', config.topic);
    return { published: true };
  }
}
