// src/modules/integrations/adapters/mqtt.adapter.ts
import * as mqtt from 'mqtt';
import * as crypto from 'crypto';
import { Logger } from '@nestjs/common';
import type {
  ConnectionResult,
  DispatchResult,
  IIntegrationAdapter,
} from './adapter.interface';

/**
 * Outbound MQTT publish to a third-party broker.
 *
 * One-shot by design: connect, publish, disconnect. `reconnectPeriod: 0` keeps
 * a dead broker from leaving a retry loop behind for every telemetry message.
 */
export class MqttAdapter implements IIntegrationAdapter {
  private readonly logger = new Logger(MqttAdapter.name);

  /**
   * Accepts both config shapes in circulation: the flat `brokerUrl` used by
   * new integrations, and the `broker` + `port` + `useTls` triple the existing
   * entity and seeded rows use.
   */
  private buildBrokerUrl(config: any): string | null {
    const raw = (config?.brokerUrl ?? config?.broker)?.toString().trim();
    if (!raw) return null;

    if (/^(mqtts?|wss?):\/\//i.test(raw)) return raw;

    const scheme = config?.useTls ? 'mqtts' : 'mqtt';
    return config?.port ? `${scheme}://${raw}:${config.port}` : `${scheme}://${raw}`;
  }

  /** `smartlife/{{deviceId}}/telemetry` style topics are resolved here. */
  private resolveTopic(config: any, payload: any): string {
    const template = config?.topic || 'smartlife/{{deviceId}}/telemetry';
    return template
      .replace(/\{\{\s*deviceId\s*\}\}/g, payload?.deviceId ?? 'unknown')
      .replace(/\{\{\s*deviceKey\s*\}\}/g, payload?.deviceKey ?? 'unknown')
      .replace(/\{\{\s*tenantId\s*\}\}/g, payload?.tenantId ?? 'unknown');
  }

  private clientId(config: any, prefix: string): string {
    return (
      config?.clientId ||
      `${prefix}-${crypto.randomBytes(6).toString('hex')}`
    );
  }

  async dispatch(config: any, payload: any): Promise<DispatchResult> {
    const brokerUrl = this.buildBrokerUrl(config);
    if (!brokerUrl) {
      return { success: false, error: 'No MQTT broker configured' };
    }

    return new Promise<DispatchResult>((resolve) => {
      let settled = false;
      const finish = (result: DispatchResult) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        try {
          client.end(true);
        } catch {
          /* ignore close errors */
        }
        resolve(result);
      };

      const client = mqtt.connect(brokerUrl, {
        username: config.username,
        password: config.password,
        clientId: this.clientId(config, 'smartlife-dispatch'),
        connectTimeout: 5000,
        reconnectPeriod: 0,
      });

      // Outer guard: covers connect + publish, not just the connect handshake.
      const timer = setTimeout(
        () => finish({ success: false, error: 'Connection timeout' }),
        8000,
      );

      client.on('connect', () => {
        const topic = this.resolveTopic(config, payload);
        client.publish(
          topic,
          JSON.stringify(payload),
          { qos: config.qos ?? 0 },
          (err) =>
            finish(
              err ? { success: false, error: err.message } : { success: true },
            ),
        );
      });

      client.on('error', (err) =>
        finish({ success: false, error: err.message }),
      );
    });
  }

  async testConnection(config: any): Promise<ConnectionResult> {
    const brokerUrl = this.buildBrokerUrl(config);
    if (!brokerUrl) {
      return { connected: false, message: 'No MQTT broker configured' };
    }

    return new Promise<ConnectionResult>((resolve) => {
      let settled = false;
      const finish = (result: ConnectionResult) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        try {
          client.end(true);
        } catch {
          /* ignore close errors */
        }
        resolve(result);
      };

      const client = mqtt.connect(brokerUrl, {
        username: config.username,
        password: config.password,
        clientId: this.clientId(config, 'smartlife-test'),
        connectTimeout: 5000,
        reconnectPeriod: 0,
      });

      const timer = setTimeout(
        () =>
          finish({ connected: false, message: 'Connection timeout after 5s' }),
        6000,
      );

      client.on('connect', () =>
        finish({ connected: true, message: `Connected to ${brokerUrl}` }),
      );

      client.on('error', (err) => {
        this.logger.warn(`MQTT test failed for ${brokerUrl}: ${err.message}`);
        finish({ connected: false, message: err.message });
      });
    });
  }
}
