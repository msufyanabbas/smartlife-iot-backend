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

  /**
   * Access tokens, keyed by clientId+region.
   *
   * Tuya tokens are valid for two hours, and `GET /v1.0/token` is itself rate
   * limited. Without this cache the 30-second device poll would spend one full
   * round trip re-authenticating before every request — ~2,900 token calls per
   * integration per day, which Tuya throttles. Static so it is shared by every
   * TuyaAdapter instance, since callers construct them ad hoc.
   */
  private static readonly tokenCache = new Map<
    string,
    { token: string; expiresAt: number }
  >();

  /** Tuya error codes that mean "this token is no longer usable". */
  private static readonly TOKEN_ERROR_CODES = new Set([1010, 1011, 1012, 1013]);

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

  private tokenCacheKey(config: any): string {
    return `${config.clientId}@${config.region ?? 'eu'}`;
  }

  /** Drop the cached token so the next call re-authenticates. */
  private invalidateToken(config: any): void {
    TuyaAdapter.tokenCache.delete(this.tokenCacheKey(config));
  }

  private async getAccessToken(config: any): Promise<string> {
    this.assertCredentials(config);

    const cacheKey = this.tokenCacheKey(config);
    const cached = TuyaAdapter.tokenCache.get(cacheKey);
    if (cached && cached.expiresAt > Date.now()) {
      return cached.token;
    }

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

    const token: string = response.data.result.access_token;

    // `expire_time` is in seconds (7200 in practice). A 60s safety margin
    // keeps a token from expiring mid-flight on a slow request; the fallback
    // covers a response that omits the field.
    const ttlSeconds = Number(response.data.result?.expire_time) || 7200;
    TuyaAdapter.tokenCache.set(cacheKey, {
      token,
      expiresAt: Date.now() + Math.max(ttlSeconds - 60, 60) * 1000,
    });

    return token;
  }

  /**
   * Append query parameters to a path in the form Tuya signs.
   *
   * Tuya's sign v2 signs the path INCLUDING its query string, with keys sorted
   * asciibetically. Passing params via axios `params` while signing the bare
   * path produces a valid-looking request that Tuya rejects with code 1004
   * ("sign invalid"), so the signed string and the URL must be built once here
   * and used for both.
   */
  private buildSignedPath(
    path: string,
    params: Record<string, string | number> = {},
  ): string {
    const keys = Object.keys(params).sort();
    if (keys.length === 0) return path;

    const qs = keys.map((k) => `${k}=${params[k]}`).join('&');
    return `${path}?${qs}`;
  }

  /**
   * Signed request helper for business (post-token) calls.
   *
   * `accessToken` may be supplied by the caller so a multi-call flow does not
   * re-authenticate for every request — each getAccessToken() is a full round
   * trip to Tuya.
   */
  private async signedRequest(
    config: any,
    method: 'GET' | 'POST',
    path: string,
    body = '',
    token?: string,
    /** Internal: prevents the token-expiry retry from recursing. */
    isRetry = false,
  ): Promise<any> {
    const accessToken = token ?? (await this.getAccessToken(config));
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

    // Tuya reports a revoked/expired token as a business error with HTTP 200.
    // Since tokens are now cached, a stale entry would otherwise fail every
    // subsequent call until it aged out — so drop it and retry once.
    const data = response.data;
    if (
      !isRetry &&
      !data?.success &&
      TuyaAdapter.TOKEN_ERROR_CODES.has(Number(data?.code))
    ) {
      this.logger.warn(
        `Tuya token rejected (code=${data?.code}) — re-authenticating and retrying once`,
      );
      this.invalidateToken(config);
      return this.signedRequest(config, method, path, body, undefined, true);
    }

    return data;
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

  /**
   * Devices bound to the Tuya cloud project.
   *
   * `GET /v1.0/devices` (the previous implementation) is the legacy endpoint:
   * without a `uid`/`schema` it returns an empty list rather than an error, so
   * a project with devices still reported zero. Two endpoints are tried in
   * order:
   *
   *   1. GET /v1.0/iot-01/associated-users/devices — devices belonging to the
   *      app accounts linked to the project. This is what a Smart Life / Tuya
   *      app account's devices show up under, and covers the usual case.
   *   2. GET /v1.2/iot-03/devices — project-scoped device list, for projects
   *      whose devices are bound directly rather than via an app account.
   *
   * **This method now throws** instead of returning []. Swallowing the error
   * made an auth failure, a signing mismatch and a missing API subscription all
   * look identical to "you have no devices", which is the single most
   * misleading outcome for whoever is configuring the integration.
   */
  async getDevices(config: any): Promise<any[]> {
    // One token for the whole flow.
    const accessToken = await this.getAccessToken(config);

    const attempts: Array<{ label: string; path: string }> = [
      {
        label: 'associated-users',
        path: this.buildSignedPath('/v1.0/iot-01/associated-users/devices', {
          page_size: 100,
        }),
      },
      {
        label: 'iot-03',
        path: this.buildSignedPath('/v1.2/iot-03/devices', { page_size: 100 }),
      },
    ];

    const failures: string[] = [];

    for (const attempt of attempts) {
      let data: any;
      try {
        data = await this.signedRequest(
          config,
          'GET',
          attempt.path,
          '',
          accessToken,
        );
      } catch (err: any) {
        // A 404/permission error on one endpoint is not fatal — try the next.
        const detail = err.response?.data
          ? JSON.stringify(err.response.data)
          : err.message;
        this.logger.warn(`Tuya ${attempt.label} request failed: ${detail}`);
        failures.push(`${attempt.label}: ${detail}`);
        continue;
      }

      this.logger.debug(
        `Tuya ${attempt.label} response: ${JSON.stringify(data)}`,
      );

      if (!data?.success) {
        // Tuya reports business errors in the body with HTTP 200 — code 1004
        // is a signing mismatch, 28841002 a missing API subscription.
        const detail = `code=${data?.code} msg=${data?.msg}`;
        this.logger.warn(`Tuya ${attempt.label} returned an error: ${detail}`);
        failures.push(`${attempt.label}: ${detail}`);
        continue;
      }

      // Result shape differs per endpoint: associated-users returns
      // {devices:[…]}, iot-03 returns {list:[…]}, per-user returns a bare array.
      const list: any[] = Array.isArray(data.result)
        ? data.result
        : (data.result?.devices ?? data.result?.list ?? []);

      this.logger.log(
        `Tuya ${attempt.label} returned ${list.length} device(s)`,
      );
      if (list.length > 0) return list;
    }

    // Every endpoint errored — surface why rather than reporting zero devices.
    if (failures.length === attempts.length) {
      throw new Error(`Tuya device lookup failed — ${failures.join('; ')}`);
    }

    // At least one endpoint answered successfully with an empty list: the
    // project genuinely has no devices bound.
    return [];
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
      // getDevices() throws if the lookup itself failed, so a signing or
      // permission problem now reports connected:false with the reason rather
      // than a misleading "connected — 0 devices".
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
