import {
  Inject,
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
  forwardRef,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Cron, CronExpression } from '@nestjs/schedule';
import * as mqtt from 'mqtt';
import * as crypto from 'crypto';
import { Integration } from './entities/integration.entity';
import { Device } from '@modules/devices/entities/device.entity';
import { IntegrationStatus, IntegrationType } from '@common/enums/index.enum';
import { DeviceListenerService } from '@modules/protocols/device-listener.service';
import { IntegrationDispatchService } from './integration-dispatch.service';
import { IntegrationEventType } from './entities/integration-event.entity';
import type { StandardTelemetry } from '@common/interfaces/standard-telemetry.interface';

interface InboundSubscription {
  integrationId: string;
  tenantId: string;
  name: string;
  /** Hash of the connection-relevant config — a change here forces a reconnect. */
  fingerprint: string;
  topic: string;
  deviceKeyField: string;
  deviceKeyTopicIndex?: number;
  client: mqtt.MqttClient;
}

/**
 * ─────────────────────────────────────────────────────────────────────────────
 * Persistent MQTT subscriptions on behalf of MQTT-type integrations.
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * Until this service existed, an MQTT integration could only SEND. `MqttAdapter`
 * is one-shot on purpose — connect, publish, `client.end(true)`, with
 * `reconnectPeriod: 0` — because a dead broker must not leave a retry loop
 * behind for every telemetry message. That is right for publishing and useless
 * for receiving, so the two concerns get two clients with opposite lifetimes:
 *
 *   MqttAdapter (outbound)   one connection per message, never reconnects
 *   this service (inbound)   one connection per integration, always reconnects
 *
 * This is also distinct from `lib/mqtt/MQTTService`, which owns the platform's
 * OWN broker and subscribes to `devices/+/telemetry` for first-party devices.
 * Here each client points at a THIRD-PARTY broker chosen per integration, with
 * that integration's own credentials and topic.
 *
 * Reconciliation rather than event wiring: `sync()` compares the desired set
 * (active, enabled, `inboundTopic` set) against what is connected, and adds,
 * drops or reconnects the difference. It runs at boot, on a cron, and whenever
 * IntegrationsService changes an MQTT row. A cron as well as the hooks because
 * a row can also change underneath us — another replica, a manual SQL fix, or
 * the quarantine in IntegrationDispatchService flipping `enabled` to false.
 */
@Injectable()
export class IntegrationMqttInboundService
  implements OnModuleInit, OnModuleDestroy
{
  private readonly logger = new Logger(IntegrationMqttInboundService.name);

  private readonly subscriptions = new Map<string, InboundSubscription>();

  /**
   * deviceKey → device id, so a firehose topic does not mean one SELECT per
   * message. Short-lived on purpose: a device renamed or deleted elsewhere
   * should not stay resolvable for long.
   */
  private readonly deviceCache = new Map<
    string,
    { deviceId: string; customerId?: string; expires: number }
  >();
  private static readonly DEVICE_CACHE_TTL_MS = 60_000;

  /** Guards against two reconciles overlapping — each one does I/O. */
  private syncing = false;

  private shuttingDown = false;

  constructor(
    @InjectRepository(Integration)
    private readonly integrationRepository: Repository<Integration>,
    @InjectRepository(Device)
    private readonly deviceRepository: Repository<Device>,
    @Inject(forwardRef(() => DeviceListenerService))
    private readonly deviceListener: DeviceListenerService,
    private readonly dispatch: IntegrationDispatchService,
  ) {}

  async onModuleInit(): Promise<void> {
    // Detached: a third-party broker that refuses connections must not be able
    // to hold up application boot.
    setImmediate(() => {
      void this.sync();
    });
  }

  async onModuleDestroy(): Promise<void> {
    this.shuttingDown = true;
    for (const subscription of this.subscriptions.values()) {
      this.closeClient(subscription);
    }
    this.subscriptions.clear();
  }

  /** Connected subscriptions, for the controller's diagnostics route. */
  getStatus(tenantId?: string) {
    return Array.from(this.subscriptions.values())
      .filter((s) => !tenantId || s.tenantId === tenantId)
      .map((s) => ({
        integrationId: s.integrationId,
        name: s.name,
        topic: s.topic,
        connected: s.client.connected,
      }));
  }

  /**
   * Called by IntegrationsService after a create, update, toggle or delete.
   *
   * Takes no arguments and reconciles everything rather than acting on the one
   * row: the work is a map comparison plus one indexed query, and a targeted
   * version would need its own copy of the "is this still wanted?" rules.
   */
  async refresh(): Promise<void> {
    await this.sync();
  }

  @Cron(CronExpression.EVERY_MINUTE)
  async sync(): Promise<void> {
    if (this.syncing || this.shuttingDown) return;
    this.syncing = true;

    try {
      const rows = await this.integrationRepository.find({
        where: {
          type: IntegrationType.MQTT,
          status: IntegrationStatus.ACTIVE,
          enabled: true,
        },
      });

      const desired = new Map<string, Integration>();
      for (const row of rows) {
        const config = (row.configuration ?? {}) as Record<string, any>;
        const topic = String(config.inboundTopic ?? '').trim();
        // No subscribe topic means publish-only, which is the default and the
        // common case — not a misconfiguration worth logging.
        if (topic) desired.set(row.id, row);
      }

      // Drop what is no longer wanted, or whose connection settings changed.
      for (const [id, subscription] of this.subscriptions) {
        const row = desired.get(id);
        if (!row) {
          this.logger.log(
            `Dropping inbound MQTT subscription for ${subscription.name}`,
          );
          this.closeClient(subscription);
          this.subscriptions.delete(id);
          continue;
        }
        if (this.fingerprint(row) !== subscription.fingerprint) {
          this.logger.log(
            `Reconnecting inbound MQTT subscription for ${subscription.name} (configuration changed)`,
          );
          this.closeClient(subscription);
          this.subscriptions.delete(id);
        }
      }

      // Add what is missing.
      for (const [id, row] of desired) {
        if (!this.subscriptions.has(id)) this.open(row);
      }
    } catch (error: any) {
      this.logger.error(`Inbound MQTT reconcile failed: ${error.message}`);
    } finally {
      this.syncing = false;
    }
  }

  /**
   * Everything that would require a new TCP connection or a new SUBSCRIBE.
   *
   * The publish-side settings (`topic`, `qos`) are deliberately excluded —
   * editing the publish topic should not interrupt an inbound stream.
   */
  private fingerprint(integration: Integration): string {
    const config = (integration.configuration ?? {}) as Record<string, any>;
    const material = JSON.stringify([
      config.brokerUrl ?? config.broker ?? '',
      config.port ?? '',
      config.useTls ?? false,
      config.username ?? '',
      config.password ?? '',
      config.inboundTopic ?? '',
      config.inboundDeviceKeyField ?? '',
      config.inboundDeviceKeyTopicIndex ?? '',
    ]);
    return crypto.createHash('sha1').update(material).digest('hex');
  }

  private brokerUrl(config: any): string | null {
    const raw = (config?.brokerUrl ?? config?.broker)?.toString().trim();
    if (!raw) return null;
    if (/^(mqtts?|wss?):\/\//i.test(raw)) return raw;
    const scheme = config?.useTls ? 'mqtts' : 'mqtt';
    return config?.port ? `${scheme}://${raw}:${config.port}` : `${scheme}://${raw}`;
  }

  private open(integration: Integration): void {
    const config = (integration.configuration ?? {}) as Record<string, any>;
    const brokerUrl = this.brokerUrl(config);
    const topic = String(config.inboundTopic ?? '').trim();

    if (!brokerUrl) {
      this.logger.warn(
        `Integration ${integration.name} has a subscribe topic but no broker URL`,
      );
      return;
    }

    const rawIndex = Number(config.inboundDeviceKeyTopicIndex);

    const subscription: InboundSubscription = {
      integrationId: integration.id,
      tenantId: integration.tenantId,
      name: integration.name,
      fingerprint: this.fingerprint(integration),
      topic,
      deviceKeyField: String(config.inboundDeviceKeyField ?? 'deviceKey'),
      deviceKeyTopicIndex:
        Number.isInteger(rawIndex) && rawIndex >= 0 ? rawIndex : undefined,
      // Assigned below; declared here so the handlers can close over it.
      client: undefined as unknown as mqtt.MqttClient,
    };

    const client = mqtt.connect(brokerUrl, {
      username: config.username,
      password: config.password,
      // Scoped to the integration id, so a restart reclaims the same session
      // instead of accumulating ghost clients on brokers that enforce a client
      // limit. Truncated because some brokers cap the client id at 23 bytes.
      clientId: `smartlife-in-${integration.id.replace(/-/g, '').slice(0, 10)}`,
      connectTimeout: 10_000,
      // The opposite of MqttAdapter: this client is meant to live, so it backs
      // off and retries rather than giving up on the first refusal.
      reconnectPeriod: 15_000,
      // A clean session means the broker does not queue messages for us while
      // we are down. Preferable to the alternative: a long outage with a
      // persistent session would reconnect into a flood of stale readings,
      // every one of which would be stored with its original timestamp.
      clean: true,
    });

    subscription.client = client;
    this.subscriptions.set(integration.id, subscription);

    client.on('connect', () => {
      client.subscribe(topic, { qos: 1 }, (error) => {
        if (error) {
          this.logger.error(
            `Could not subscribe to "${topic}" for ${integration.name}: ${error.message}`,
          );
          void this.dispatch.recordInbound({
            integrationId: integration.id,
            tenantId: integration.tenantId,
            success: false,
            message: `Subscribe to "${topic}" failed: ${error.message}`,
            eventType: IntegrationEventType.ERROR,
          });
          return;
        }
        this.logger.log(
          `Subscribed to "${topic}" on ${brokerUrl} for ${integration.name}`,
        );
      });
    });

    client.on('message', (messageTopic, payload) => {
      void this.handleMessage(subscription, messageTopic, payload);
    });

    client.on('error', (error) => {
      // Logged at warn, not error: with a 15s reconnect this fires repeatedly
      // for one unreachable broker, and it is not an application fault.
      this.logger.warn(
        `Inbound MQTT error for ${integration.name}: ${error.message}`,
      );
    });

    client.on('close', () => {
      if (!this.shuttingDown && this.subscriptions.has(integration.id)) {
        this.logger.debug(
          `Inbound MQTT connection closed for ${integration.name}; will retry`,
        );
      }
    });
  }

  private closeClient(subscription: InboundSubscription): void {
    try {
      // force=true: a graceful DISCONNECT waits for in-flight packets, and a
      // broker that has stopped answering would hold the shutdown open.
      subscription.client?.end(true);
    } catch {
      /* already gone */
    }
  }

  /**
   * One inbound message.
   *
   * Never throws: an exception here would surface inside the mqtt client's
   * event emitter, where there is nothing to catch it.
   */
  private async handleMessage(
    subscription: InboundSubscription,
    topic: string,
    raw: Buffer,
  ): Promise<void> {
    try {
      const text = raw.toString('utf8');
      let body: any;
      try {
        body = JSON.parse(text);
      } catch {
        // Not JSON — kept as a raw frame rather than dropped. A LoRaWAN-style
        // hex or base64 body is a legitimate payload, and the codec registry
        // knows how to decode it once it reaches DeviceListenerService.
        body = { rawPayload: text };
      }

      const deviceKey = this.resolveDeviceKey(subscription, topic, body);
      if (!deviceKey) {
        await this.dispatch.recordInbound({
          integrationId: subscription.integrationId,
          tenantId: subscription.tenantId,
          success: false,
          message: `No device key on "${topic}" — looked at the "${subscription.deviceKeyField}" property${
            subscription.deviceKeyTopicIndex !== undefined
              ? ` and topic segment ${subscription.deviceKeyTopicIndex}`
              : ''
          }`,
          payload: this.asRecord(body),
        });
        return;
      }

      const device = await this.resolveDevice(deviceKey, subscription.tenantId);
      if (!device) {
        // Same reasoning as the HTTP uplink path: a wildcard subscription can
        // match anything on the broker, and auto-creating a device per
        // unrecognised key would let someone else's traffic fill the tenant
        // and consume its device quota.
        await this.dispatch.recordInbound({
          integrationId: subscription.integrationId,
          tenantId: subscription.tenantId,
          success: false,
          message: `Unknown device "${deviceKey}" for this tenant — register it first`,
          deviceKey,
          payload: this.asRecord(body),
        });
        return;
      }

      const telemetry: StandardTelemetry = {
        deviceId: device.deviceId,
        deviceKey,
        tenantId: subscription.tenantId,
        customerId: device.customerId,
        data: this.extractData(body),
        timestamp: this.extractTimestamp(body),
        receivedAt: Date.now(),
        protocol: 'mqtt',
        metadata: {
          topic,
          integrationId: subscription.integrationId,
        },
      };

      // The shared entry point, so an integration uplink gets the same codec
      // decode, Kafka publish, alarm evaluation and WebSocket broadcast as a
      // reading from a first-party device.
      await this.deviceListener.handleTelemetry(telemetry);

      await this.dispatch.recordInbound({
        integrationId: subscription.integrationId,
        tenantId: subscription.tenantId,
        success: true,
        deviceId: device.deviceId,
        deviceKey,
      });
    } catch (error: any) {
      this.logger.error(
        `Failed to handle inbound MQTT message for ${subscription.name}: ${error.message}`,
      );
      await this.dispatch
        .recordInbound({
          integrationId: subscription.integrationId,
          tenantId: subscription.tenantId,
          success: false,
          message: error.message,
          eventType: IntegrationEventType.ERROR,
        })
        .catch(() => undefined);
    }
  }

  /**
   * Payload field first, topic segment second.
   *
   * That order because the payload is the more specific statement: a wildcard
   * topic index is a positional guess, and a message that names its own device
   * should win over the position it happened to arrive on.
   */
  private resolveDeviceKey(
    subscription: InboundSubscription,
    topic: string,
    body: any,
  ): string | null {
    const fromField = this.readPath(body, subscription.deviceKeyField);
    if (typeof fromField === 'string' && fromField.trim()) {
      return fromField.trim();
    }
    if (typeof fromField === 'number') return String(fromField);

    if (subscription.deviceKeyTopicIndex !== undefined) {
      const segments = topic.split('/');
      const segment = segments[subscription.deviceKeyTopicIndex];
      if (segment && segment.trim()) return segment.trim();
    }

    return null;
  }

  private readPath(body: any, path: string): unknown {
    if (!body || typeof body !== 'object' || !path) return undefined;
    if (!path.includes('.')) return body[path];
    return path
      .split('.')
      .reduce<any>((node, part) => (node == null ? undefined : node[part]), body);
  }

  private async resolveDevice(
    deviceKey: string,
    tenantId: string,
  ): Promise<{ deviceId: string; customerId?: string } | null> {
    const cacheKey = `${tenantId}:${deviceKey}`;
    const cached = this.deviceCache.get(cacheKey);
    if (cached && cached.expires > Date.now()) {
      return { deviceId: cached.deviceId, customerId: cached.customerId };
    }

    const device = await this.deviceRepository.findOne({
      where: { deviceKey, tenantId },
      select: ['id', 'customerId'],
    });

    if (!device) {
      // Deliberately not cached. A miss is the case an operator is about to
      // fix by registering the device, and caching it would make the fix look
      // like it had not worked.
      this.deviceCache.delete(cacheKey);
      return null;
    }

    // Bounded so a wildcard topic carrying thousands of keys cannot grow this
    // without limit; the eviction is crude because entries are interchangeable.
    if (this.deviceCache.size > 5000) this.deviceCache.clear();

    this.deviceCache.set(cacheKey, {
      deviceId: device.id,
      customerId: device.customerId,
      expires: Date.now() + IntegrationMqttInboundService.DEVICE_CACHE_TTL_MS,
    });

    return { deviceId: device.id, customerId: device.customerId };
  }

  /** Unwraps the ThingsBoard `{ts, values:{…}}` envelope; otherwise passes through. */
  private extractData(body: any): Record<string, any> {
    if (body && typeof body === 'object' && !Array.isArray(body)) {
      if (body.values && typeof body.values === 'object') {
        return body.values as Record<string, any>;
      }
      return body as Record<string, any>;
    }
    return { value: body };
  }

  private extractTimestamp(body: any): Date {
    const raw = body?.ts ?? body?.timestamp ?? body?.time ?? null;
    if (!raw) return new Date();
    if (typeof raw === 'number') {
      // Below ~1973 in milliseconds, so it is almost certainly seconds.
      return new Date(raw < 1e11 ? raw * 1000 : raw);
    }
    const parsed = new Date(raw);
    return Number.isNaN(parsed.getTime()) ? new Date() : parsed;
  }

  private asRecord(body: any): Record<string, unknown> | null {
    return body && typeof body === 'object' && !Array.isArray(body)
      ? (body as Record<string, unknown>)
      : null;
  }
}
