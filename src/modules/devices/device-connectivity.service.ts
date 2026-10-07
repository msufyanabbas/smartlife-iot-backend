import { Injectable, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Device } from './entities/device.entity';
import { DeviceCredentialsService } from './device-credentials.service';
import { DeviceTransportType } from '@common/enums/index.enum';

/**
 * ─────────────────────────────────────────────────────────────────────────────
 * Device connectivity — "how do I actually talk to this device?"
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * ThingsBoard shows a "Check connectivity" panel per device with ready-to-paste
 * commands. This is the equivalent, with one deliberate difference: it reports
 * the routes this platform ACTUALLY serves, not ThingsBoard's.
 *
 * That difference matters. `DeviceProfilesService.getDefaultTransportConfig()`
 * seeds an HTTP profile with `deviceTelemetryUrl: '/api/v1/{deviceToken}/telemetry'`
 * because that is ThingsBoard's path — but this platform has no such HTTP route.
 * Its HTTP ingest is `POST /api/v1/ingestion/:deviceKey`. A panel built from the
 * profile's stored config would hand out a 404 and look authoritative doing it,
 * so the snippets below are generated from the real adapters:
 *
 *   HTTP  → HTTPAdapter      @Controller('v1/ingestion') @Post(':deviceId')
 *   MQTT  → MQTTService      devices/:deviceKey/telemetry (+ LoRaWAN patterns)
 *   CoAP  → CoAPAdapter      /api/v1/{deviceToken}/telemetry on UDP 5683
 *
 * `{deviceToken}` is the deviceKey in all three — see the auth note on each.
 */
@Injectable()
export class DeviceConnectivityService {
  constructor(
    @InjectRepository(Device)
    private readonly deviceRepo: Repository<Device>,
    private readonly credentialsService: DeviceCredentialsService,
    private readonly configService: ConfigService,
  ) {}

  async getConnectivity(deviceId: string, tenantId: string | undefined) {
    const device = await this.deviceRepo.findOne({
      where: { id: deviceId, tenantId },
      relations: ['deviceProfile'],
    });
    if (!device) throw new NotFoundException('Device not found');

    const deviceKey = device.deviceKey;

    // getTopicStrategy() THROWS for a LoRaWAN device whose metadata has no
    // devEUI — it has no way to build `application/…/device/<devEUI>/rx`.
    // Letting that escape would 500 the entire panel, including the HTTP, CoAP
    // and OTA sections that need no topics at all, for exactly the devices
    // whose operator is most likely trying to work out why nothing arrives.
    // Same reasoning as the unconfigured-broker fallback in mqttEndpoint().
    let topics: Partial<Record<string, string | string[]>> = {};
    let topicError: string | null = null;
    try {
      topics = this.credentialsService.getTopicStrategy(device) as never;
    } catch (error) {
      topicError =
        error instanceof Error
          ? error.message
          : 'MQTT topics could not be resolved for this device.';
    }

    const baseUrl = this.publicBaseUrl();
    const mqtt = this.mqttEndpoint();
    const coapEnabled =
      this.configService.get<string>('COAP_ENABLED') !== 'false';
    const coapPort = Number(this.configService.get('COAP_PORT') ?? 5683);
    const coapHost = this.hostOf(baseUrl);

    const transport =
      (device.deviceProfile?.transportType as DeviceTransportType) ??
      DeviceTransportType.DEFAULT;

    const sampleBody = JSON.stringify({ temperature: 22.5, humidity: 48 });

    return {
      device: {
        id: device.id,
        name: device.name,
        deviceKey,
        transportType: transport,
        profileName: device.deviceProfile?.name ?? null,
      },

      http: {
        label: 'HTTP',
        // The real route. See the class comment for why this is not
        // /api/v1/{token}/telemetry.
        telemetryUrl: `${baseUrl}/v1/ingestion/${deviceKey}`,
        batchUrl: `${baseUrl}/v1/ingestion/batch`,
        method: 'POST',
        headers: this.httpHeaders(),
        authNote:
          'The deviceKey in the path identifies the device. x-api-key is a single platform-wide secret, enabled with REQUIRE_API_KEY=true — there is no per-device HTTP credential.',
        curl: [
          `curl -X POST '${baseUrl}/v1/ingestion/${deviceKey}' \\`,
          `  -H 'Content-Type: application/json' \\`,
          ...(this.requiresApiKey()
            ? [`  -H 'x-api-key: <DEVICE_API_KEY>' \\`]
            : []),
          `  -d '${sampleBody}'`,
        ].join('\n'),
        batchCurl: [
          `curl -X POST '${baseUrl}/v1/ingestion/batch' \\`,
          `  -H 'Content-Type: application/json' \\`,
          ...(this.requiresApiKey()
            ? [`  -H 'x-api-key: <DEVICE_API_KEY>' \\`]
            : []),
          `  -d '${JSON.stringify({
            devices: [{ deviceId: deviceKey, data: { temperature: 22.5 } }],
          })}'`,
        ].join('\n'),
      },

      mqtt: {
        label: 'MQTT',
        host: mqtt.host,
        port: mqtt.port,
        brokerUrl: mqtt.url,
        clientId: deviceKey,
        // Username/password come from the credentials endpoint — not repeated
        // here, so a connectivity panel can be shown without exposing secrets.
        credentialsHint:
          'Username and password are on GET /devices/:id/credentials.',
        topics: {
          telemetry: topics.telemetryTopic,
          attributes: topics.attributesTopic,
          sharedAttributes: topics.sharedAttributesTopic,
          status: topics.statusTopic,
          alerts: topics.alertsTopic,
          commands: topics.commandsTopic,
        },
        subscribePatterns: topics.uplinkPatterns ?? [],
        // Present only when topics could not be resolved — typically a LoRaWAN
        // device with no devEUI in its metadata. Naming the cause is the whole
        // value: it is the actual reason that device's uplinks go nowhere.
        unavailableReason: topicError,
        authNote:
          'MQTT authentication is enforced by the broker (EMQX), not by this API.',
        mosquitto: topicError
          ? null
          : [
              `mosquitto_pub -h ${mqtt.host} -p ${mqtt.port} \\`,
              `  -t '${topics.telemetryTopic}' \\`,
              `  -u '<username>' -P '<password>' \\`,
              `  -m '${sampleBody}'`,
            ].join('\n'),
      },

      coap: coapEnabled
        ? {
            label: 'CoAP',
            host: coapHost,
            port: coapPort,
            telemetryUrl: `coap://${coapHost}:${coapPort}/api/v1/${deviceKey}/telemetry`,
            attributesUrl: `coap://${coapHost}:${coapPort}/api/v1/${deviceKey}/attributes`,
            rpcUrl: `coap://${coapHost}:${coapPort}/api/v1/${deviceKey}/rpc`,
            firmwareUrl: `coap://${coapHost}:${coapPort}/api/v1/${deviceKey}/firmware`,
            authNote:
              'The path token is the deviceKey. An unknown token answers 4.04.',
            coapClient: `coap-client -m post -e '${sampleBody}' coap://${coapHost}:${coapPort}/api/v1/${deviceKey}/telemetry`,
          }
        : {
            label: 'CoAP',
            disabled: true,
            // Reported rather than omitted: "CoAP is switched off" is a useful
            // answer, and silently hiding the section looks like the platform
            // does not support CoAP at all.
            authNote: 'CoAP is disabled on this deployment (COAP_ENABLED=false).',
          },

      ota: {
        label: 'OTA',
        checkUrl: `${baseUrl.replace(/\/api$/, '')}/ota/${deviceKey}`,
        downloadUrl: `${baseUrl.replace(/\/api$/, '')}/ota/${deviceKey}/download`,
        statusUrl: `${baseUrl.replace(/\/api$/, '')}/ota/${deviceKey}/status`,
        authNote:
          'Device-token authenticated (the deviceKey), outside the API prefix.',
      },
    };
  }

  // ── Helpers ────────────────────────────────────────────────────────────────

  /**
   * The origin a DEVICE should call, which is not necessarily the one the
   * browser is on. Falls back through the same chain FirmwareService uses so a
   * deployment that configured OTA_PUBLIC_URL gets consistent answers.
   */
  private publicBaseUrl(): string {
    const configured =
      this.configService.get<string>('DEVICE_PUBLIC_URL') ??
      this.configService.get<string>('OTA_PUBLIC_URL') ??
      this.configService.get<string>('BACKEND_URL') ??
      'http://localhost:5000';

    const trimmed = configured.replace(/\/+$/, '');
    const prefix = this.configService.get<string>('API_PREFIX') ?? 'api';

    // Only append the prefix when it is not already part of the configured URL,
    // otherwise a BACKEND_URL that already ends in /api produces /api/api/...
    return prefix && !trimmed.endsWith(`/${prefix}`)
      ? `${trimmed}/${prefix}`
      : trimmed;
  }

  private mqttEndpoint(): { host: string; port: number; url: string } {
    const raw =
      this.configService.get<string>('MQTT_PUBLIC_URL') ??
      this.configService.get<string>('MQTT_BROKER_URL');

    if (!raw) {
      // Deliberately not thrown: an unconfigured broker should not make the
      // whole connectivity panel fail, it should say what is missing.
      return { host: 'not-configured', port: 1883, url: 'not-configured' };
    }

    try {
      const url = new URL(raw);
      return {
        host: url.hostname,
        port: parseInt(url.port, 10) || 1883,
        url: raw,
      };
    } catch {
      return { host: raw, port: 1883, url: raw };
    }
  }

  private hostOf(url: string): string {
    try {
      return new URL(url).hostname;
    } catch {
      return 'localhost';
    }
  }

  private requiresApiKey(): boolean {
    return this.configService.get<string>('REQUIRE_API_KEY') === 'true';
  }

  private httpHeaders(): Record<string, string> {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
    };
    if (this.requiresApiKey()) headers['x-api-key'] = '<DEVICE_API_KEY>';
    return headers;
  }
}
