// lib/mqtt/mqtt.service.ts
//
// KEY FIX: buildStandardTelemetry() now detects LoRaWAN envelopes by SHAPE
// (devEUI + base64 data field), not by topic prefix.
// This fixes WS558/WS101 and all other Milesight devices whose gateway
// publishes to devices/:deviceKey/telemetry instead of application/1/device/:devEUI/rx.

import * as mqtt from 'mqtt';
import {
  Injectable,
  Logger,
  OnModuleInit,
  OnModuleDestroy,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { MqttConfig } from '@common/interfaces/common.interface';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import {
  Device,
  DeviceProtocol,
} from '@modules/devices/entities/device.entity';
import { DeviceStatus } from '@common/enums/index.enum';
import { DeviceListenerService } from '@modules/protocols/device-listener.service';
import { StandardTelemetry } from '@common/interfaces/standard-telemetry.interface';

// LoRaWAN network-server topics (ChirpStack). These are protocol-defined
// patterns rather than deployment settings, so they stay in code; the
// device-facing topics below come from MQTT_TOPIC_* because they depend on how
// each deployment namespaces its devices.
const LORAWAN_UPLINK_TOPICS = [
  'application/1/device/+/rx',
  'application/1/device/+/event/+',
  'application/+/device/+/event/up',
  'application/+/device/+/event/+',
];

/** Extra topics a deployment wants subscribed, as a comma-separated list. */
const EXTRA_TOPICS_VAR = 'MQTT_EXTRA_UPLINK_TOPICS';

@Injectable()
export class MQTTService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(MQTTService.name);
  private client: mqtt.MqttClient | null = null;
  private isConnected = false;

  private readonly settings: MqttConfig;
  private readonly uplinkTopics: string[];

  constructor(
    private readonly deviceListener: DeviceListenerService,
    @InjectRepository(Device)
    private readonly deviceRepository: Repository<Device>,
    private readonly configService: ConfigService,
  ) {
    this.settings = this.configService.get<MqttConfig>('mqtt')!;

    // MQTT_TOPIC_TELEMETRY/COMMANDS/STATUS/ALERTS were declared in the example
    // env and parsed by mqtt.config.ts, but the service subscribed to a frozen
    // array instead — so changing them had no effect. They are used now.
    const configured = [
      this.settings.topics?.telemetry,
      this.settings.topics?.status,
      this.settings.topics?.alerts,
      'devices/+/attributes',
    ].filter((topic): topic is string => Boolean(topic));

    const extra = (this.configService.get<string>(EXTRA_TOPICS_VAR) ?? '')
      .split(',')
      .map((topic) => topic.trim())
      .filter((topic) => topic.length > 0);

    // Duplicates would cause the broker to deliver the same uplink twice.
    this.uplinkTopics = [
      ...new Set([...configured, ...LORAWAN_UPLINK_TOPICS, ...extra]),
    ];
  }

  async onModuleInit(): Promise<void> {
    await this.connect();
  }
  async onModuleDestroy(): Promise<void> {
    await this.disconnect();
  }

  // ── Connection ────────────────────────────────────────────────────────────

  async connect(): Promise<void> {
    // A fixed MQTT_CLIENT_ID across replicas is a footgun: MQTT requires client
    // ids to be unique, and a broker will disconnect the existing session when a
    // second client claims the same id — two replicas would kick each other off
    // in a loop. The configured id is therefore used as a *prefix* and made
    // unique per process.
    const clientIdPrefix = this.settings.clientId || 'smartlife-platform';
    const clientId = `${clientIdPrefix}-${process.pid}-${Date.now()}`;

    this.client = mqtt.connect(this.settings.brokerUrl!, {
      clientId,
      username: this.settings.username,
      password: this.settings.password,
      clean: this.settings.cleanSession ?? true,
      keepalive: this.settings.keepAlive,
      connectTimeout: this.settings.connectTimeout,
      reconnectPeriod: this.settings.reconnectPeriod,
      // Only meaningful for mqtts:// / wss:// broker URLs, and left strict by
      // default so TLS is actually verified.
      rejectUnauthorized: this.settings.rejectUnauthorized ?? true,
    });

    this.client.on('connect', () => {
      this.logger.log('MQTT broker connected');
      this.isConnected = true;
      this.subscribeToTopics();
    });

    this.client.on('error', (err) => {
      this.logger.error(`MQTT error: ${err.message}`);
      this.isConnected = false;
    });

    this.client.on('close', () => {
      this.logger.warn('MQTT connection closed');
      this.isConnected = false;
    });

    this.client.on('message', async (topic, message) => {
      await this.handleMessage(topic, message);
    });
  }

  /**
   * Wrap a topic filter in `$share/<group>/` so the broker load-balances it.
   *
   * ── Why this is the most important line in the file on a scaled deploy ────
   * A plain `devices/+/telemetry` subscription is FAN-OUT. Every replica that
   * subscribes gets its own copy of every uplink, and each copy ran the whole
   * ingestion path: a `telemetry` row written, a `telemetry.device.raw` Kafka
   * message produced, device-profile alarm rules evaluated, the WebSocket
   * broadcast emitted. Three replicas therefore tripled the telemetry table,
   * tripled Kafka throughput, and evaluated every DURATION/REPEATING alarm
   * three times against shared `alarms.metadata.conditionState` — which is how
   * a 10-minute window could be satisfied in under four minutes. This is the
   * data-corrupting one, because it is the primary ingestion path.
   *
   * `$share/<group>/<filter>` (MQTT 5 shared subscriptions, supported by EMQX
   * 5) makes the broker pick ONE member of `<group>` per message.
   *
   * Two details that matter:
   *   • The prefix is a *subscription-time* wrapper only. The broker delivers
   *     the message under its ORIGINAL topic, so `extractDeviceKey()` and
   *     `findDevice()` need no change — do not strip anything in handleMessage.
   *   • `$share` is meaningless for a publish; `publish()` below is untouched.
   */
  private sharedTopic(filter: string): string {
    if (!this.settings.sharedSubscription) return filter;
    // Already shared (e.g. someone put a $share filter in
    // MQTT_EXTRA_UPLINK_TOPICS) — do not double-wrap, the broker would treat
    // the inner `$share` as a literal level.
    if (filter.startsWith('$share/')) return filter;
    return `$share/${this.settings.sharedGroup}/${filter}`;
  }

  private subscribeToTopics(): void {
    const qos = this.settings.qos ?? 1;

    if (!this.settings.sharedSubscription) {
      this.logger.warn(
        'MQTT_SHARED_SUBSCRIPTION=false — every replica will receive every ' +
          'uplink and persist it. Only correct when exactly one instance runs.',
      );
    }

    for (const topic of this.uplinkTopics) {
      const filter = this.sharedTopic(topic);
      this.client?.subscribe(filter, { qos }, (err) => {
        if (err)
          this.logger.error(`Failed to subscribe to ${filter}: ${err.message}`);
        else this.logger.log(`Subscribed → ${filter}`);
      });
    }
  }

  /** The filters actually sent to the broker. Read by the guard script and ops. */
  subscribedFilters(): string[] {
    return this.uplinkTopics.map((topic) => this.sharedTopic(topic));
  }

  // ── Message handling ──────────────────────────────────────────────────────

  private async handleMessage(
    topic: string,
    rawMessage: Buffer,
  ): Promise<void> {
    try {
      const deviceKey = this.extractDeviceKey(topic);
      if (!deviceKey) {
        this.logger.warn(`Cannot extract device key from topic: ${topic}`);
        return;
      }

      const device = await this.findDevice(topic, deviceKey);
      if (!device) {
        this.logger.warn(`No device for key/devEUI: ${deviceKey}`);
        return;
      }

      void this.deviceRepository.update(
        { id: device.id },
        { lastSeenAt: new Date(), status: DeviceStatus.ACTIVE },
      );

      const telemetry = this.buildStandardTelemetry(topic, rawMessage, device);
      await this.deviceListener.handleTelemetry(telemetry);
    } catch (error) {
      this.logger.error(
        `Error handling message on ${topic}: ${(error as Error).message}`,
      );
    }
  }

  // ── Build StandardTelemetry ───────────────────────────────────────────────

  private buildStandardTelemetry(
    topic: string,
    rawMessage: Buffer,
    device: Device,
  ): StandardTelemetry {
    let payload: any;

    // Try to parse as JSON first
    try {
      payload = JSON.parse(rawMessage.toString('utf-8'));
    } catch {
      // Not JSON — pass raw hex to codec (e.g. raw binary MQTT payload)
      const hexStr = rawMessage.toString('hex');
      return this.buildResult(topic, device, hexStr, hexStr);
    }

    let rawPayloadForCodec: any;

    // ── Detect LoRaWAN envelope by SHAPE, not by topic ────────────────────
    // Both Milesight UG65 and ChirpStack forward:
    //   { devEUI: string, data: "<base64>", fPort: number, ... }
    // The topic may be devices/.../telemetry OR application/.../rx — we
    // detect by payload shape so the codec path works regardless of topic.

    if (this.isLoRaWANEnvelope(payload)) {
      // ChirpStack v4 with pre-decoded object — skip raw byte decode
      if (
        device.protocol === DeviceProtocol.LORAWAN_CHIRPSTACK &&
        payload.object &&
        typeof payload.object === 'object'
      ) {
        rawPayloadForCodec = payload.object;
      } else {
        // Decode base64 → hex string for the Milesight IPSO codecs
        try {
          rawPayloadForCodec = Buffer.from(payload.data, 'base64').toString(
            'hex',
          );
          this.logger.debug(
            `LoRaWAN envelope detected — base64 '${payload.data}' → hex '${rawPayloadForCodec}'`,
          );
        } catch {
          this.logger.warn(`base64 decode failed for data: ${payload.data}`);
          rawPayloadForCodec = payload.data;
        }
      }
    } else {
      // Plain JSON device (ESP32, custom firmware, etc.) — pass object as-is
      // The GenericMqttJsonCodec or a pre-decoded path will handle it
      rawPayloadForCodec = payload;
    }

    return this.buildResult(topic, device, rawPayloadForCodec, payload);
  }

  /**
   * A LoRaWAN envelope is any JSON object that has:
   *   - devEUI: a non-empty string (8-byte hex EUI)
   *   - data:   a non-empty base64 string (the actual LoRaWAN payload bytes)
   *
   * This covers both Milesight UG65 and ChirpStack v3/v4 formats.
   * We do NOT check the topic — gateways may publish to any topic.
   */
  private isLoRaWANEnvelope(payload: any): boolean {
    return (
      payload !== null &&
      typeof payload === 'object' &&
      typeof payload.devEUI === 'string' &&
      payload.devEUI.length > 0 &&
      typeof payload.data === 'string' &&
      payload.data.length > 0 &&
      // Valid base64: only A-Z, a-z, 0-9, +, /, =
      /^[A-Za-z0-9+/]+=*$/.test(payload.data)
    );
  }

  private buildResult(
    topic: string,
    device: Device,
    rawPayloadForCodec: any,
    rawPayload: any,
  ): StandardTelemetry {
    // fPort comes from the LoRaWAN envelope if present
    const fPort: number | undefined =
      typeof rawPayload?.fPort === 'number' ? rawPayload.fPort : undefined;

    // Prefer the envelope timestamp; fall back to now
    const timestamp: string =
      rawPayload?.time ?? rawPayload?.timestamp ?? new Date().toISOString();

    return {
      deviceId: device.id,
      deviceKey: device.deviceKey,
      tenantId: device.tenantId,
      customerId: device.customerId,
      data: rawPayloadForCodec,
      timestamp,
      receivedAt: Date.now(),
      protocol: 'mqtt',
      metadata: {
        topic,
        protocol: device.protocol,
        // Codec resolution priority: device.metadata > device columns
        codecId: device.metadata?.codecId as string | undefined,
        manufacturer:
          (device.metadata?.manufacturer as string | undefined) ??
          device.manufacturer,
        model: (device.metadata?.model as string | undefined) ?? device.model,
        devEUI:
          (device.metadata?.devEUI as string | undefined) ?? rawPayload?.devEUI,
        fPort,
      },
      rawPayload,
    };
  }

  // ── Device key extraction ─────────────────────────────────────────────────

  private extractDeviceKey(topic: string): string | null {
    const parts = topic.split('/');
    if (parts[0] === 'devices' && parts.length >= 3) return parts[1];
    if (
      parts[0] === 'application' &&
      parts[2] === 'device' &&
      parts.length >= 4
    )
      return parts[3];
    return null;
  }

  private async findDevice(
    topic: string,
    keyFromTopic: string,
  ): Promise<Device | null> {
    const parts = topic.split('/');
    if (parts[0] === 'application') {
      // LoRaWAN topic — keyFromTopic is the devEUI
      return this.deviceRepository
        .createQueryBuilder('device')
        .where(`device.metadata->>'devEUI' = :devEUI`, { devEUI: keyFromTopic })
        .andWhere('device.deletedAt IS NULL')
        .getOne();
    }
    // Generic MQTT topic — keyFromTopic is the deviceKey
    return this.deviceRepository.findOne({
      where: { deviceKey: keyFromTopic },
    });
  }

  // ── Publish ───────────────────────────────────────────────────────────────
  // ── Publish ───────────────────────────────────────────────────────────────
  async publish(topic: string, message: any): Promise<void> {
    this.logger.debug('--- MQTT PUBLISH START ---');

    // Check client existence
    if (!this.client) {
      this.logger.error('MQTT client is NULL');
      throw new Error('MQTT client is not initialized');
    }

    // Check connection state
    this.logger.debug(`MQTT connected state: ${this.isConnected}`);

    if (!this.isConnected) {
      this.logger.error('MQTT client is NOT connected');
      throw new Error('MQTT client is not connected');
    }

    // Log topic + payload BEFORE publishing
    let payload: string;
    try {
      payload = JSON.stringify(message);
    } catch (err) {
      this.logger.error('Failed to stringify message', err);
      throw err;
    }

    this.logger.debug(`Publishing to topic: ${topic}`);
    this.logger.debug(`Payload: ${payload}`);

    return new Promise((resolve, reject) => {
      this.logger.debug('Calling MQTT publish...');

      this.client!.publish(
        topic,
        payload,
        {
          qos: this.settings.qos ?? 1,
          retain: this.settings.retainMessages ?? false,
        },
        (err) => {
          if (err) {
            this.logger.error(`❌ Publish FAILED → ${topic}`);
            this.logger.error(`Error: ${err.message}`, err);
            reject(err);
          } else {
            this.logger.debug(`✅ Publish SUCCESS → ${topic}`);
            resolve();
          }
        },
      );
    });
  }

  async disconnect(): Promise<void> {
    if (this.client) {
      await this.client.end();
      this.isConnected = false;
      this.logger.log('MQTT disconnected');
    }
  }

  isClientConnected(): boolean {
    return this.isConnected;
  }
}
