// src/modules/integrations/adapters/http.adapter.ts
import axios from 'axios';
import { Logger } from '@nestjs/common';
import type {
  ConnectionResult,
  DispatchResult,
  IIntegrationAdapter,
} from './adapter.interface';

/**
 * Generic outbound HTTP API call (IntegrationType.API).
 *
 * Note this is a *different* HTTPAdapter from
 * src/modules/protocols/adapters/http.adapter.ts, which is an inbound
 * ingestion controller. This one only sends.
 */
export class HttpAdapter implements IIntegrationAdapter {
  private readonly logger = new Logger(HttpAdapter.name);

  async dispatch(config: any, payload: any): Promise<DispatchResult> {
    if (!config?.url) {
      return { success: false, error: 'No URL configured for this integration' };
    }

    try {
      const headers: Record<string, string> = {
        'Content-Type': 'application/json',
        ...(config.headers || {}),
      };

      // basicAuth is applied after apiKey so that, if both are somehow set,
      // the more specific credential wins deterministically.
      if (config.apiKey) headers['Authorization'] = `Bearer ${config.apiKey}`;
      if (config.basicAuth?.username) {
        const encoded = Buffer.from(
          `${config.basicAuth.username}:${config.basicAuth.password ?? ''}`,
        ).toString('base64');
        headers['Authorization'] = `Basic ${encoded}`;
      }

      const response = await axios({
        method: config.method || 'POST',
        url: config.url,
        headers,
        data: payload,
        params: config.queryParams,
        timeout: config.timeout || 10000,
      });

      return { success: true, statusCode: response.status };
    } catch (err: any) {
      return {
        success: false,
        statusCode: err.response?.status,
        error: err.message,
      };
    }
  }

  async testConnection(config: any): Promise<ConnectionResult> {
    try {
      const result = await this.dispatch(config, {
        test: true,
        timestamp: new Date().toISOString(),
        source: 'SmartLife IoT Platform',
      });

      return {
        connected: result.success,
        message: result.success
          ? `Connected — HTTP ${result.statusCode}`
          : `Failed — ${result.error}`,
        statusCode: result.statusCode,
      };
    } catch (err: any) {
      this.logger.warn(`HTTP test failed: ${err.message}`);
      return { connected: false, message: err.message };
    }
  }
}
