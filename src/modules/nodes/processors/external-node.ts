import { Injectable, Logger } from '@nestjs/common';
import { HttpService } from '@nestjs/axios';
import { firstValueFrom } from 'rxjs';
import {
  INodeProcessor,
  NodeMessage,
  NodeProcessorResult,
} from '../nodes-processor.interface';

/**
 * EXTERNAL node — makes an outbound HTTP call to a third-party endpoint.
 *
 * Uses `HttpService` from `@nestjs/axios`. On a 2xx response the response body
 * is merged into the message data and routed 'success'; any error routes
 * 'failure'.
 *
 * configuration:
 * {
 *   url: string,
 *   method: 'GET' | 'POST' | 'PUT' | 'DELETE',
 *   headers?: Record<string, string>,
 *   timeout?: number,            // ms, default 10000
 *   includeMessageAsBody?: boolean
 * }
 */
@Injectable()
export class ExternalNodeProcessor implements INodeProcessor {
  private readonly logger = new Logger(ExternalNodeProcessor.name);

  constructor(private readonly httpService: HttpService) {}

  async process(input: NodeMessage, config: any): Promise<NodeProcessorResult> {
    const url = config?.url;
    if (!url) {
      return {
        success: false,
        route: 'failure',
        error: 'external node requires config.url',
      };
    }

    const method = (config?.method ?? 'GET').toUpperCase();
    const timeout = config?.timeout ?? 10000;
    const headers = config?.headers ?? {};
    const data = config?.includeMessageAsBody ? input : undefined;

    try {
      const response = await firstValueFrom(
        this.httpService.request({ url, method, headers, timeout, data }),
      );

      this.logger.log(`[external] ${method} ${url} → ${response.status}`);

      const body = response.data;
      return {
        success: true,
        route: 'success',
        output: {
          ...input,
          data: {
            ...input.data,
            ...(body && typeof body === 'object' && !Array.isArray(body)
              ? body
              : { response: body }),
          },
          metadata: {
            ...input.metadata,
            externalCall: { url, method, status: response.status },
          },
        },
      };
    } catch (error: any) {
      const status = error?.response?.status;
      const message = status
        ? `HTTP ${status}: ${error.message}`
        : error.message;
      this.logger.warn(`[external] ${method} ${url} failed: ${message}`);
      return {
        success: false,
        route: 'failure',
        error: message,
      };
    }
  }
}
