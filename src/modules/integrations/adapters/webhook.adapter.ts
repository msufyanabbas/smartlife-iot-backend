// src/modules/integrations/adapters/webhook.adapter.ts
import axios from 'axios';
import * as crypto from 'crypto';
import { Logger } from '@nestjs/common';
import type {
  ConnectionResult,
  DispatchResult,
  IIntegrationAdapter,
} from './adapter.interface';

/**
 * Outbound HTTP webhook.
 *
 * Differs from HttpAdapter only in authentication style: a webhook proves
 * authenticity with an HMAC signature over the body, an API integration sends
 * a bearer/basic credential. Both are kept because a receiver usually supports
 * one or the other, not both.
 */
export class WebhookAdapter implements IIntegrationAdapter {
  private readonly logger = new Logger(WebhookAdapter.name);

  async dispatch(config: any, payload: any): Promise<DispatchResult> {
    if (!config?.url) {
      return { success: false, error: 'No URL configured for this integration' };
    }

    try {
      const body = JSON.stringify(payload);

      const headers: Record<string, string> = {
        'Content-Type': 'application/json',
        ...(config.headers || {}),
      };

      // HMAC-SHA256 over the exact bytes sent, so the receiver can verify the
      // payload was not tampered with. Signed over `body` (not a re-stringify)
      // because key order must match what goes on the wire.
      if (config.secret) {
        const signature = crypto
          .createHmac('sha256', config.secret)
          .update(body)
          .digest('hex');
        headers['X-Signature'] = `sha256=${signature}`;
      }

      const response = await axios({
        method: config.method || 'POST',
        url: config.url,
        headers,
        data: body,
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

  /**
   * Probe by sending a real, clearly-marked test payload to the configured
   * URL — the same code path a live dispatch takes, so a pass means dispatch
   * will work rather than merely that the host resolves.
   */
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
      this.logger.warn(`Webhook test failed: ${err.message}`);
      return { connected: false, message: err.message };
    }
  }
}
