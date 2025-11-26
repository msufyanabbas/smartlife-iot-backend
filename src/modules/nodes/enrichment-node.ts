import { Injectable } from '@nestjs/common';
import {
  INodeProcessor,
  NodeMessage,
  NodeProcessorResult,
} from './nodes-processor.interface';

@Injectable()
export class EnrichmentNodeProcessor implements INodeProcessor {
  async process(input: NodeMessage, config: any): Promise<NodeProcessorResult> {
    try {
      const enrichedMetadata = { ...input.metadata };

      // Add customer attributes
      if (config.customerAttributes) {
        enrichedMetadata.customer = await this.fetchCustomerAttributes(
          input.originator.id,
          config.customerAttributes,
        );
      }

      // Add device attributes
      if (config.deviceAttributes) {
        enrichedMetadata.device = await this.fetchDeviceAttributes(
          input.originator.id,
          config.deviceAttributes,
        );
      }

      // Add related entities
      if (config.relatedEntities) {
        enrichedMetadata.related = await this.fetchRelatedEntities(
          input.originator.id,
          config.relatedEntities,
        );
      }

      // Add custom fields
      if (config.customFields) {
        Object.assign(enrichedMetadata, config.customFields);
      }

      const output: NodeMessage = {
        ...input,
        metadata: {
          ...enrichedMetadata,
          enriched: true,
          enrichedAt: Date.now(),
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

  private async fetchCustomerAttributes(
    customerId: string,
    keys: string[],
  ): Promise<any> {
    // TODO: Implement actual customer attribute fetching
    // This would query the attributes table
    return {
      id: customerId,
      name: 'Sample Customer',
    };
  }

  private async fetchDeviceAttributes(
    deviceId: string,
    keys: string[],
  ): Promise<any> {
    // TODO: Implement actual device attribute fetching
    return {
      id: deviceId,
      type: 'sensor',
      model: 'TH-100',
    };
  }

  private async fetchRelatedEntities(
    entityId: string,
    relationTypes: string[],
  ): Promise<any> {
    // TODO: Implement actual related entity fetching
    return {};
  }
}
