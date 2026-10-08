import axios from 'axios';
import * as crypto from 'crypto';
import { Logger } from '@nestjs/common';
import type {
  ConnectionResult,
  DispatchResult,
  IIntegrationAdapter,
} from './adapter.interface';

interface CachedToken {
  accessToken: string;
  expiresAt: number;
}

/**
 * Google Cloud Pub/Sub — publish over the REST API with a service account.
 *
 * `@google-cloud/pubsub` would be a large new dependency (it pulls gRPC) for
 * one publish call. The OAuth2 service-account flow is a signed JWT exchanged
 * for an access token, and Node's `crypto` signs RS256 natively, so this needs
 * nothing that is not already installed.
 *
 * Flow per the Google docs:
 *   1. build a JWT asserting {iss: clientEmail, scope: pubsub, aud: token URI}
 *   2. sign it RS256 with the service account's private key
 *   3. POST it to oauth2.googleapis.com/token as a jwt-bearer grant
 *   4. use the returned access token as a Bearer on the publish call
 *
 * Tokens are cached per service account until a minute before expiry. Without
 * that, a busy tenant would perform a full OAuth exchange per reading — two
 * round trips instead of one, and Google rate-limits token minting.
 */
export class GooglePubSubAdapter implements IIntegrationAdapter {
  private readonly logger = new Logger(GooglePubSubAdapter.name);

  private static readonly TOKEN_URI = 'https://oauth2.googleapis.com/token';
  private static readonly SCOPE = 'https://www.googleapis.com/auth/pubsub';

  /**
   * Static so every dispatch shares one cache — the dispatcher holds a single
   * adapter instance today, but a token cache that silently depends on that
   * is a trap for whoever changes it.
   */
  private static tokenCache = new Map<string, CachedToken>();

  private base64Url(input: Buffer | string): string {
    return Buffer.from(input)
      .toString('base64')
      .replace(/=/g, '')
      .replace(/\+/g, '-')
      .replace(/\//g, '_');
  }

  private async getAccessToken(config: any): Promise<string> {
    const cacheKey = `${config.clientEmail}`;
    const cached = GooglePubSubAdapter.tokenCache.get(cacheKey);
    if (cached && cached.expiresAt > Date.now()) return cached.accessToken;

    const issuedAt = Math.floor(Date.now() / 1000);
    const claims = {
      iss: config.clientEmail,
      scope: GooglePubSubAdapter.SCOPE,
      aud: GooglePubSubAdapter.TOKEN_URI,
      iat: issuedAt,
      exp: issuedAt + 3600,
    };

    const signingInput =
      `${this.base64Url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }))}.` +
      `${this.base64Url(JSON.stringify(claims))}`;

    // A key pasted from the JSON file keeps its literal \n escapes; PEM parsing
    // needs real newlines, and the failure otherwise is an opaque
    // "error:0909006C:PEM routines" rather than anything about the key.
    const privateKey = String(config.privateKey).replace(/\\n/g, '\n');

    const signature = crypto
      .createSign('RSA-SHA256')
      .update(signingInput)
      .sign(privateKey);

    const assertion = `${signingInput}.${this.base64Url(signature)}`;

    const response = await axios.post(
      GooglePubSubAdapter.TOKEN_URI,
      new URLSearchParams({
        grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
        assertion,
      }).toString(),
      {
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        timeout: Number(config.timeout) || 10000,
      },
    );

    const accessToken = response.data?.access_token;
    if (!accessToken) throw new Error('Google returned no access token');

    const lifetime = Number(response.data?.expires_in) || 3600;
    GooglePubSubAdapter.tokenCache.set(cacheKey, {
      accessToken,
      // 60s of slack so a token never expires mid-flight.
      expiresAt: Date.now() + Math.max(lifetime - 60, 60) * 1000,
    });

    return accessToken;
  }

  private validate(config: any): string | null {
    if (!config?.projectId) return 'Pub/Sub integration needs a project ID';
    if (!config?.topic) return 'Pub/Sub integration needs a topic';
    if (!config?.clientEmail)
      return 'Pub/Sub integration needs a service account email';
    if (!config?.privateKey) return 'Pub/Sub integration needs a private key';
    return null;
  }

  async dispatch(config: any, payload: any): Promise<DispatchResult> {
    const invalid = this.validate(config);
    if (invalid) return { success: false, error: invalid };

    try {
      const accessToken = await this.getAccessToken(config);

      const topic = String(config.topic).includes('/')
        ? String(config.topic)
        : `projects/${config.projectId}/topics/${config.topic}`;

      const response = await axios({
        method: 'POST',
        url: `https://pubsub.googleapis.com/v1/${topic}:publish`,
        timeout: Number(config.timeout) || 10000,
        headers: {
          Authorization: `Bearer ${accessToken}`,
          'Content-Type': 'application/json',
        },
        data: {
          messages: [
            {
              data: Buffer.from(JSON.stringify(payload)).toString('base64'),
              // Attributes are filterable in a Pub/Sub subscription without
              // decoding the body, which is what makes per-device routing
              // possible downstream.
              attributes: {
                ...(payload?.deviceId ? { deviceId: String(payload.deviceId) } : {}),
                ...(payload?.deviceKey ? { deviceKey: String(payload.deviceKey) } : {}),
                ...(payload?.tenantId ? { tenantId: String(payload.tenantId) } : {}),
                source: 'smartlife',
              },
              ...(payload?.deviceId ? { orderingKey: String(payload.deviceId) } : {}),
            },
          ],
        },
        validateStatus: () => true,
      });

      if (response.status >= 200 && response.status < 300) {
        return { success: true, statusCode: response.status };
      }

      // A 401 here almost always means a stale cached token (key rotated,
      // account disabled), so drop it rather than serving it for another hour.
      if (response.status === 401) {
        GooglePubSubAdapter.tokenCache.delete(String(config.clientEmail));
      }

      return {
        success: false,
        statusCode: response.status,
        error: (
          response.data?.error?.message ??
          JSON.stringify(response.data ?? {})
        )
          .toString()
          .slice(0, 300),
      };
    } catch (error: any) {
      this.logger.warn(`Pub/Sub dispatch failed: ${error.message}`);
      return { success: false, error: error.message };
    }
  }

  /**
   * Probes by reading the topic, not by publishing.
   *
   * Unlike IoT Hub and Event Hubs, Pub/Sub has a plain GET on the topic, so the
   * probe can prove both the credential and the topic's existence without
   * putting a test message in front of every subscriber.
   */
  async testConnection(config: any): Promise<ConnectionResult> {
    const invalid = this.validate(config);
    if (invalid) return { connected: false, message: invalid };

    try {
      const accessToken = await this.getAccessToken(config);
      const topic = String(config.topic).includes('/')
        ? String(config.topic)
        : `projects/${config.projectId}/topics/${config.topic}`;

      const response = await axios.get(
        `https://pubsub.googleapis.com/v1/${topic}`,
        {
          headers: { Authorization: `Bearer ${accessToken}` },
          timeout: Number(config.timeout) || 10000,
          validateStatus: () => true,
        },
      );

      if (response.status === 200) {
        return { connected: true, message: `Connected to ${topic}.` };
      }
      if (response.status === 404) {
        return {
          connected: false,
          message: `Authenticated, but the topic "${topic}" does not exist in this project.`,
        };
      }
      return {
        connected: false,
        message: `Connection failed (${response.status}): ${
          response.data?.error?.message ?? 'unknown error'
        }`,
      };
    } catch (error: any) {
      return { connected: false, message: `Connection failed: ${error.message}` };
    }
  }
}
