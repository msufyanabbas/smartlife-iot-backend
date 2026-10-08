import axios from 'axios';
import * as crypto from 'crypto';
import { Logger } from '@nestjs/common';
import type {
  ConnectionResult,
  DispatchResult,
  IIntegrationAdapter,
} from './adapter.interface';

/**
 * Azure Event Hubs — send a single event over the REST surface.
 *
 * Same reasoning as the IoT Hub adapter: `@azure/event-hubs` is an AMQP client
 * built around a long-lived producer that batches, which is the opposite of a
 * per-message stateless dispatch, and it would be a new production dependency.
 * The REST endpoint plus a SAS token (an HMAC over two strings) does the job
 * with what is already installed.
 *
 * The trade-off is real and worth knowing: REST sends one event per HTTP
 * request with no batching, so a very high-rate tenant will see more overhead
 * than the AMQP producer would. For telemetry fan-out, where each reading is
 * already its own event, that is the natural shape anyway.
 */
export class AzureEventHubAdapter implements IIntegrationAdapter {
  private readonly logger = new Logger(AzureEventHubAdapter.name);

  private buildSasToken(config: any, resourceUri: string): string {
    const expiry = Math.floor(Date.now() / 1000) + 3600;
    const encodedUri = encodeURIComponent(resourceUri);

    // Event Hubs keys are used as UTF-8 text, NOT base64-decoded first — this
    // is the one place its SAS differs from IoT Hub's, and getting it wrong
    // produces a 401 that looks identical to a wrong key.
    const signature = crypto
      .createHmac('sha256', String(config.sharedAccessKey))
      .update(`${encodedUri}\n${expiry}`)
      .digest('base64');

    return (
      `SharedAccessSignature sr=${encodedUri}` +
      `&sig=${encodeURIComponent(signature)}` +
      `&se=${expiry}` +
      `&skn=${encodeURIComponent(String(config.sharedAccessKeyName))}`
    );
  }

  private validate(config: any): string | null {
    if (!config?.namespace) return 'Event Hubs integration needs a namespace';
    if (!config?.eventHubName) return 'Event Hubs integration needs an Event Hub name';
    if (!config?.sharedAccessKeyName)
      return 'Event Hubs integration needs a shared access policy name';
    if (!config?.sharedAccessKey)
      return 'Event Hubs integration needs a shared access key';
    return null;
  }

  async dispatch(config: any, payload: any): Promise<DispatchResult> {
    const invalid = this.validate(config);
    if (invalid) return { success: false, error: invalid };

    const namespace = String(config.namespace)
      .replace(/^https?:\/\//, '')
      .replace(/\/+$/, '');
    // Accept a bare namespace as well as the full FQDN.
    const host = namespace.includes('.')
      ? namespace
      : `${namespace}.servicebus.windows.net`;

    const hub = encodeURIComponent(String(config.eventHubName));
    const resourceUri = `https://${host}/${hub}`;
    const url = `${resourceUri}/messages?timeout=60&api-version=2014-01`;

    try {
      const response = await axios({
        method: 'POST',
        url,
        data: payload,
        timeout: Number(config.timeout) || 10000,
        headers: {
          Authorization: this.buildSasToken(config, resourceUri),
          'Content-Type': 'application/json',
          // Partition by device so one device's readings stay in order on one
          // partition. Without it Event Hubs round-robins and ordering is lost.
          ...(payload?.deviceId
            ? { BrokerProperties: JSON.stringify({ PartitionKey: payload.deviceId }) }
            : {}),
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
      this.logger.warn(`Event Hubs dispatch failed: ${error.message}`);
      return { success: false, error: error.message };
    }
  }

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
        ? 'Connected — a test event was accepted by the Event Hub.'
        : `Connection failed: ${result.error ?? 'unknown error'}`,
      statusCode: result.statusCode,
      sideEffect: 'A test event is visible to the hub’s consumers.',
    };
  }
}
