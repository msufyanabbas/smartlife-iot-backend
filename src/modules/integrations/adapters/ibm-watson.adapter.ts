import { Logger } from '@nestjs/common';
import { MqttAdapter } from './mqtt.adapter';
import type {
  ConnectionResult,
  DispatchResult,
  IIntegrationAdapter,
} from './adapter.interface';

/**
 * IBM Watson IoT Platform, as an application client over MQTT.
 *
 * Watson is MQTT underneath with a fixed naming scheme, so this composes
 * MqttAdapter rather than reimplementing a client. What Watson adds is the
 * conventions, and those are the only reason this file exists:
 *
 *   broker    {orgId}.messaging.internetofthings.ibmcloud.com:8883 (TLS)
 *   clientId  a:{orgId}:{appId}          — the "a:" prefix means application
 *   username  the literal "use-token-auth" is for DEVICES; an application
 *             authenticates with its API key as the username
 *   topic     iot-2/type/{deviceType}/id/{deviceId}/evt/{eventId}/fmt/json
 *
 * Getting the clientId prefix wrong is the classic Watson failure: the broker
 * accepts the connection and then silently drops every publish, because a
 * device client may only publish as itself.
 */
export class IbmWatsonAdapter implements IIntegrationAdapter {
  private readonly logger = new Logger(IbmWatsonAdapter.name);
  private readonly mqtt = new MqttAdapter();

  private validate(config: any): string | null {
    if (!config?.orgId) return 'Watson IoT integration needs an organisation ID';
    if (!config?.apiKey) return 'Watson IoT integration needs an API key';
    if (!config?.apiToken) return 'Watson IoT integration needs an authentication token';
    if (!config?.deviceType) return 'Watson IoT integration needs a device type';
    return null;
  }

  /**
   * Translate Watson settings into the MQTT config the shared adapter speaks.
   *
   * The application id is derived from the API key rather than asked for: it
   * must be unique per connected client, and Watson disconnects the older
   * client when two share one. Deriving it from the key keeps it stable across
   * restarts while staying unique per integration.
   */
  private toMqttConfig(config: any, payload: any): Record<string, unknown> {
    const orgId = String(config.orgId).trim();
    const appId = `smartlife-${String(config.apiKey).slice(-8)}`;

    const deviceType = String(config.deviceType).trim();
    const eventId = String(config.eventId || 'telemetry').trim();
    // Watson device ids may not contain '/', which a deviceKey could.
    const deviceId = String(payload?.deviceKey ?? payload?.deviceId ?? 'unknown')
      .replace(/[^A-Za-z0-9_.-]/g, '-');

    return {
      brokerUrl: `mqtts://${orgId}.messaging.internetofthings.ibmcloud.com:8883`,
      clientId: `a:${orgId}:${appId}`,
      username: String(config.apiKey),
      password: String(config.apiToken),
      topic: `iot-2/type/${deviceType}/id/${deviceId}/evt/${eventId}/fmt/json`,
      qos: 0,
    };
  }

  async dispatch(config: any, payload: any): Promise<DispatchResult> {
    const invalid = this.validate(config);
    if (invalid) return { success: false, error: invalid };

    return this.mqtt.dispatch(this.toMqttConfig(config, payload), payload);
  }

  async testConnection(config: any): Promise<ConnectionResult> {
    const invalid = this.validate(config);
    if (invalid) return { connected: false, message: invalid };

    // MqttAdapter's probe connects without publishing, so unlike the Azure
    // adapters this leaves nothing behind for subscribers to see.
    const result = await this.mqtt.testConnection(this.toMqttConfig(config, {}));

    return {
      ...result,
      message: result.connected
        ? 'Connected to the Watson IoT MQTT broker.'
        : `${result.message} — check the organisation ID, API key and token.`,
    };
  }
}
