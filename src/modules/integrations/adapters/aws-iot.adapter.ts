// src/modules/integrations/adapters/aws-iot.adapter.ts
import { Logger } from '@nestjs/common';
import type {
  ConnectionResult,
  DispatchResult,
  IIntegrationAdapter,
} from './adapter.interface';

/**
 * AWS IoT Core, over the Data Plane HTTPS Publish API.
 *
 * The SDK is loaded with a dynamic import so the ~2MB client is only pulled in
 * when an AWS integration actually dispatches — boot stays fast and a missing
 * optional dependency degrades to a failed dispatch rather than a failed boot.
 */
export class AwsIotAdapter implements IIntegrationAdapter {
  private readonly logger = new Logger(AwsIotAdapter.name);

  /** `endpoint` is the account-specific ATS endpoint, required by the API. */
  private validate(config: any): string | null {
    if (!config?.endpoint) return 'AWS IoT integration needs an endpoint';
    if (!config?.accessKeyId || !config?.secretAccessKey) {
      return 'AWS IoT integration needs accessKeyId and secretAccessKey';
    }
    return null;
  }

  private resolveTopic(config: any, payload: any): string {
    const template = config?.topic || 'smartlife/{{deviceId}}/telemetry';
    return template.replace(
      /\{\{\s*deviceId\s*\}\}/g,
      payload?.deviceId ?? 'unknown',
    );
  }

  async dispatch(config: any, payload: any): Promise<DispatchResult> {
    const invalid = this.validate(config);
    if (invalid) return { success: false, error: invalid };

    try {
      const { IoTDataPlaneClient, PublishCommand } = await import(
        '@aws-sdk/client-iot-data-plane'
      );

      // The endpoint must carry a scheme; ATS endpoints are usually stored bare.
      const endpoint = /^https?:\/\//i.test(config.endpoint)
        ? config.endpoint
        : `https://${config.endpoint}`;

      const client = new IoTDataPlaneClient({
        region: config.region || 'us-east-1',
        credentials: {
          accessKeyId: config.accessKeyId,
          secretAccessKey: config.secretAccessKey,
          ...(config.sessionToken ? { sessionToken: config.sessionToken } : {}),
        },
        endpoint,
      });

      await client.send(
        new PublishCommand({
          topic: this.resolveTopic(config, payload),
          payload: Buffer.from(JSON.stringify(payload)),
          qos: config.qos ?? 0,
        }),
      );

      client.destroy();
      return { success: true };
    } catch (err: any) {
      return { success: false, error: err.message };
    }
  }

  /**
   * There is no ping on the Data Plane API, so the probe publishes a marked
   * test message to the configured topic. That is a real side effect —
   * subscribers will see it.
   */
  async testConnection(config: any): Promise<ConnectionResult> {
    try {
      const result = await this.dispatch(config, {
        test: true,
        timestamp: new Date().toISOString(),
        source: 'SmartLife IoT Platform',
        deviceId: 'connection-test',
      });

      return {
        connected: result.success,
        message: result.success
          ? `Connected to AWS IoT Core (${config.region || 'us-east-1'})`
          : `Failed — ${result.error}`,
      };
    } catch (err: any) {
      this.logger.warn(`AWS IoT test failed: ${err.message}`);
      return { connected: false, message: err.message };
    }
  }
}
