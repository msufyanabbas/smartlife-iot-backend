// src/modules/integrations/adapters/tuya.adapter.ts
import axios from 'axios';
import * as crypto from 'crypto';
import { Logger } from '@nestjs/common';
import { WebhookAdapter } from './webhook.adapter';
import type {
  ConnectionResult,
  DispatchResult,
  IIntegrationAdapter,
} from './adapter.interface';

/**
 * Tuya Cloud (OpenAPI v1.0).
 *
 * Tuya is a *command* target rather than a telemetry sink: there is no
 * "receive my telemetry" endpoint, so dispatch() forwards commands when the
 * payload carries them and otherwise falls back to a webhook (or no-ops)
 * rather than pretending to have delivered something.
 *
 * Signing (Tuya "sign v2"):
 *   stringToSign = METHOD \n SHA256(body) \n <optional headers> \n path
 *   signStr      = clientId [+ accessToken] + timestamp + nonce + stringToSign
 *   sign         = HMAC-SHA256(signStr, clientSecret).toUpperCase()
 * The token request omits accessToken; business calls include it.
 */
export class TuyaAdapter implements IIntegrationAdapter {
  private readonly logger = new Logger(TuyaAdapter.name);

  private readonly REGION_URLS: Record<string, string> = {
    eu: 'https://openapi.tuyaeu.com',
    us: 'https://openapi.tuyaus.com',
    cn: 'https://openapi.tuyacn.com',
    in: 'https://openapi.tuyain.com',
  };

  private getBaseUrl(region?: string): string {
    return this.REGION_URLS[region ?? 'eu'] ?? this.REGION_URLS.eu;
  }

  private generateSign(
    clientId: string,
    clientSecret: string,
    accessToken: string,
    timestamp: string,
    method: string,
    path: string,
    body = '',
    nonce = '',
  ): string {
    const contentHash = crypto.createHash('sha256').update(body).digest('hex');
    const stringToSign = [method, contentHash, '', path].join('\n');
    const signStr = clientId + accessToken + timestamp + nonce + stringToSign;

    return crypto
      .createHmac('sha256', clientSecret)
      .update(signStr)
      .digest('hex')
      .toUpperCase();
  }

  private assertCredentials(config: any): void {
    if (!config?.clientId || !config?.clientSecret) {
      throw new Error('Tuya integration needs clientId and clientSecret');
    }
  }

  private async getAccessToken(config: any): Promise<string> {
    this.assertCredentials(config);

    const baseUrl = this.getBaseUrl(config.region);
    const timestamp = Date.now().toString();
    const path = '/v1.0/token?grant_type=1';
    const sign = this.generateSign(
      config.clientId,
      config.clientSecret,
      '',
      timestamp,
      'GET',
      path,
    );

    const response = await axios.get(`${baseUrl}${path}`, {
      headers: {
        client_id: config.clientId,
        sign,
        t: timestamp,
        sign_method: 'HMAC-SHA256',
      },
      timeout: 10000,
    });

    if (!response.data?.success) {
      throw new Error(
        `Tuya auth failed: ${response.data?.msg ?? 'unknown error'}`,
      );
    }

    return response.data.result.access_token;
  }

  /** Signed request helper for business (post-token) calls. */
  private async signedRequest(
    config: any,
    method: 'GET' | 'POST',
    path: string,
    body = '',
  ): Promise<any> {
    const accessToken = await this.getAccessToken(config);
    const baseUrl = this.getBaseUrl(config.region);
    const timestamp = Date.now().toString();
    const sign = this.generateSign(
      config.clientId,
      config.clientSecret,
      accessToken,
      timestamp,
      method,
      path,
      body,
    );

    const headers = {
      client_id: config.clientId,
      access_token: accessToken,
      sign,
      t: timestamp,
      sign_method: 'HMAC-SHA256',
      'Content-Type': 'application/json',
    };

    const response =
      method === 'GET'
        ? await axios.get(`${baseUrl}${path}`, { headers, timeout: 10000 })
        : await axios.post(`${baseUrl}${path}`, body, {
            headers,
            timeout: 10000,
          });

    return response.data;
  }

  async dispatch(config: any, payload: any): Promise<DispatchResult> {
    try {
      const tuyaDeviceId = payload?.tuyaDeviceId || config?.deviceId;
      const commands = payload?.commands;

      // Telemetry (no command) has nowhere to go in the Tuya API. Forward it to
      // a webhook when one is configured; otherwise report a no-op honestly
      // rather than counting it as a delivered message.
      if (!tuyaDeviceId || !Array.isArray(commands) || commands.length === 0) {
        if (config?.webhookUrl) {
          return new WebhookAdapter().dispatch(
            { url: config.webhookUrl, timeout: config.timeout },
            payload,
          );
        }
        return {
          success: false,
          error:
            'Tuya dispatch skipped: no tuyaDeviceId/commands in payload and no webhookUrl fallback configured',
        };
      }

      const path = `/v1.0/devices/${tuyaDeviceId}/commands`;
      const body = JSON.stringify({ commands });
      const data = await this.signedRequest(config, 'POST', path, body);

      return data?.success
        ? { success: true }
        : { success: false, error: data?.msg ?? 'Tuya rejected the command' };
    } catch (err: any) {
      return { success: false, error: err.message };
    }
  }

  /** Devices bound to the Tuya cloud project. */
  async getDevices(config: any): Promise<any[]> {
    try {
      const data = await this.signedRequest(config, 'GET', '/v1.0/devices');
      return data?.result?.list ?? [];
    } catch (err: any) {
      this.logger.error(`Failed to get Tuya devices: ${err.message}`);
      return [];
    }
  }

  /** Current datapoint status of one Tuya device. */
  async getDeviceStatus(config: any, tuyaDeviceId: string): Promise<any> {
    const data = await this.signedRequest(
      config,
      'GET',
      `/v1.0/devices/${tuyaDeviceId}/status`,
    );

    if (!data?.success) {
      throw new Error(data?.msg ?? 'Tuya rejected the status request');
    }
    return data.result ?? [];
  }

  async testConnection(config: any): Promise<ConnectionResult> {
    try {
      // getAccessToken alone proves the credentials; the device list also
      // proves the project has devices bound, which is the usual failure.
      await this.getAccessToken(config);
      const devices = await this.getDevices(config);

      return {
        connected: true,
        message: `Connected to Tuya (${config.region ?? 'eu'}) — ${devices.length} device(s) found`,
        deviceCount: devices.length,
      };
    } catch (err: any) {
      return { connected: false, message: err.message };
    }
  }
}
