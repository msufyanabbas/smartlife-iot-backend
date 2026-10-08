import axios from 'axios';
import * as crypto from 'crypto';
import { Logger } from '@nestjs/common';
import type {
  ConnectionResult,
  DispatchResult,
  IIntegrationAdapter,
} from './adapter.interface';

/**
 * Azure IoT Hub — device-to-cloud messages over the REST API.
 *
 * Deliberately REST + a hand-rolled SAS token rather than the `azure-iot-device`
 * SDK. The SDK pulls in an AMQP/MQTT stack and a persistent client per device,
 * which is the wrong shape for a stateless per-message dispatch, and it would be
 * a new production dependency for this one feature. A SAS token is an HMAC over
 * two strings — there is nothing here worth a dependency.
 *
 * Token format (Azure's "Service Bus" SAS, which IoT Hub reuses):
 *   SharedAccessSignature sr={uri}&sig={sig}&se={expiry}[&skn={policy}]
 * where sig = base64(HMAC-SHA256(base64decode(key), uri + "\n" + expiry)).
 *
 * Two credential shapes are supported, and they differ in `sr`:
 *   · per-device key   → sr = host/devices/{deviceId}, no skn
 *   · hub-level policy → sr = host,                    skn = policy name
 * Getting that wrong is the usual cause of a 401 from IoT Hub, so the scope is
 * derived from whether a policy name was supplied rather than being guessed.
 */
export class AzureIotAdapter implements IIntegrationAdapter {
  private readonly logger = new Logger(AzureIotAdapter.name);

  /** IoT Hub pins its REST surface to a dated api-version. */
  private static readonly API_VERSION = '2020-03-13';

  private buildSasToken(config: any, resourceUri: string): string {
    const expiry = Math.floor(Date.now() / 1000) + 3600;
    const encodedUri = encodeURIComponent(resourceUri);

    // The key is base64 in the portal; the HMAC is over its RAW bytes.
    const key = Buffer.from(String(config.sharedAccessKey), 'base64');
    const signature = crypto
      .createHmac('sha256', key)
      .update(`${encodedUri}\n${expiry}`)
      .digest('base64');

    let token =
      `SharedAccessSignature sr=${encodedUri}` +
      `&sig=${encodeURIComponent(signature)}` +
      `&se=${expiry}`;

    if (config.sharedAccessKeyName) {
      token += `&skn=${encodeURIComponent(String(config.sharedAccessKeyName))}`;
    }
    return token;
  }

  /**
   * The Azure identity to send as.
   *
   * `{{deviceKey}}` / `{{deviceId}}` let one integration map each platform
   * device onto its own IoT Hub identity, rather than collapsing a whole fleet
   * into a single device row in Azure.
   */
  private resolveDeviceId(config: any, payload: any): string {
    const template = String(config?.deviceId ?? '');
    return template
      .replace(/\{\{\s*deviceId\s*\}\}/g, payload?.deviceId ?? 'unknown')
      .replace(/\{\{\s*deviceKey\s*\}\}/g, payload?.deviceKey ?? 'unknown')
      .replace(/\{\{\s*tenantId\s*\}\}/g, payload?.tenantId ?? 'unknown');
  }

  private validate(config: any): string | null {
    if (!config?.hostName) return 'Azure IoT Hub integration needs a hub host name';
    if (!config?.deviceId) return 'Azure IoT Hub integration needs a device ID';
    if (!config?.sharedAccessKey)
      return 'Azure IoT Hub integration needs a shared access key';
    return null;
  }

  async dispatch(config: any, payload: any): Promise<DispatchResult> {
    const invalid = this.validate(config);
    if (invalid) return { success: false, error: invalid };

    const host = String(config.hostName).replace(/^https?:\/\//, '').replace(/\/+$/, '');
    const deviceId = this.resolveDeviceId(config, payload);

    // Scope the token to the device when using a device key, to the hub when
    // using a policy — see the class note.
    const resourceUri = config.sharedAccessKeyName
      ? host
      : `${host}/devices/${deviceId}`;

    const url =
      `https://${host}/devices/${encodeURIComponent(deviceId)}/messages/events` +
      `?api-version=${AzureIotAdapter.API_VERSION}`;

    try {
      const response = await axios({
        method: 'POST',
        url,
        data: payload,
        timeout: Number(config.timeout) || 10000,
        headers: {
          Authorization: this.buildSasToken(config, resourceUri),
          'Content-Type': 'application/json',
        },
        validateStatus: () => true,
      });

      if (response.status >= 200 && response.status < 300) {
        return { success: true, statusCode: response.status };
      }
      return {
        success: false,
        statusCode: response.status,
        error:
          typeof response.data === 'string'
            ? response.data.slice(0, 300)
            : JSON.stringify(response.data ?? {}).slice(0, 300),
      };
    } catch (error: any) {
      this.logger.warn(`Azure IoT dispatch failed: ${error.message}`);
      return { success: false, error: error.message };
    }
  }

  /**
   * Probing sends a real, marked message.
   *
   * IoT Hub's device-facing REST surface has no ping. Reading the twin would
   * need a different (service-level) permission than sending does, so a twin
   * read that succeeded would not prove the configured credential can actually
   * send. A marked message tests the real path — at the cost of one visible
   * message, which is stated to the caller.
   */
  async testConnection(config: any): Promise<ConnectionResult> {
    const invalid = this.validate(config);
    if (invalid) return { connected: false, message: invalid };

    const result = await this.dispatch(config, {
      test: true,
      source: 'SmartLife IoT Platform',
      timestamp: new Date().toISOString(),
    });

    return {
      connected: result.success,
      message: result.success
        ? 'Connected — a test message was delivered to the hub.'
        : `Connection failed: ${result.error ?? 'unknown error'}`,
      statusCode: result.statusCode,
      sideEffect: 'A test message is visible to the hub’s consumers.',
    };
  }
}
