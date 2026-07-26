import { Injectable, Logger } from '@nestjs/common';
import {
  INodeProcessor,
  NodeMessage,
  NodeProcessorResult,
} from './nodes-processor.interface';
import { AttributesService } from '../attributes/attributes.service';

@Injectable()
export class EnrichmentNodeProcessor implements INodeProcessor {
  private readonly logger = new Logger(EnrichmentNodeProcessor.name);

  constructor(private readonly attributesService: AttributesService) {}

  async process(input: NodeMessage, config: any): Promise<NodeProcessorResult> {
    try {
      const tenantId = input.metadata?.tenantId as string | undefined;
      const enrichedMetadata = { ...input.metadata };

      if (config.customerAttributes && input.metadata?.customerId) {
        enrichedMetadata.customer = await this.fetchCustomerAttributes(
          tenantId,
          input.metadata.customerId as string,
          config.customerAttributes,
        );
      }

      if (config.deviceAttributes) {
        const entityId =
          config.deviceId ??
          (input.originator?.type === 'DEVICE'
            ? input.originator.id
            : undefined);

        if (entityId) {
          enrichedMetadata.device = await this.fetchDeviceAttributes(
            tenantId,
            entityId,
            config.deviceAttributes,
          );
        }
      }

      // relatedEntities is best-effort; not backed by AttributesService
      if (config.relatedEntities) {
        enrichedMetadata.related = await this.fetchRelatedEntities(
          input.originator?.id,
          config.relatedEntities,
        );
      }

      if (config.customFields) {
        Object.assign(enrichedMetadata, config.customFields);
      }

      return {
        success: true,
        output: {
          ...input,
          metadata: {
            ...enrichedMetadata,
            enriched: true,
            enrichedAt: Date.now(),
          },
        },
        route: 'success',
      };
    } catch (error: any) {
      this.logger.error(`Enrichment failed: ${error.message}`);
      return {
        success: false,
        error: error.message,
        route: 'failure',
      };
    }
  }

  // ══════════════════════════════════════════════════════════════════════════
  // PRIVATE FETCHERS
  // ══════════════════════════════════════════════════════════════════════════

  private async fetchCustomerAttributes(
    tenantId: string | undefined,
    customerId: string,
    keys: string[],
  ): Promise<Record<string, any>> {
    if (!tenantId) return { id: customerId };

    const all = await this.attributesService.findByEntity(
      tenantId,
      'CUSTOMER',
      customerId,
    );

    if (!keys || keys.length === 0) return all;
    return Object.fromEntries(
      Object.entries(all).filter(([k]) => keys.includes(k)),
    );
  }

  private async fetchDeviceAttributes(
    tenantId: string | undefined,
    deviceId: string,
    keys: string[],
  ): Promise<Record<string, any>> {
    if (!tenantId) return { id: deviceId };

    const all = await this.attributesService.findByEntity(
      tenantId,
      'DEVICE',
      deviceId,
    );

    if (!keys || keys.length === 0) return all;
    return Object.fromEntries(
      Object.entries(all).filter(([k]) => keys.includes(k)),
    );
  }

  private async fetchRelatedEntities(
    _entityId: string | undefined,
    _relationTypes: string[],
  ): Promise<Record<string, any>> {
    // Full relation traversal requires a graph query layer not yet implemented.
    return {};
  }
}
