import { Injectable, Logger, OnApplicationShutdown } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { KafkaConfig as KafkaSettings } from '@/config/kafka.config';
import {
  Kafka,
  Producer,
  Consumer,
  EachMessagePayload,
  Admin,
  logLevel,
  CompressionTypes,
} from 'kafkajs';

/**
 * ─────────────────────────────────────────────────────────────────────────────
 * The broker must never decide whether the platform boots
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * This service used to make Kafka a hard boot dependency in two independent
 * ways, either of which was enough to kill the process:
 *
 *   1. `KafkaModule`'s factory awaited `initProducer()` and `createTopics()`.
 *      A refused TCP connect rejected the factory, Nest aborted the whole DI
 *      graph, and the process exited — with no HTTP server, so nothing on the
 *      platform was reachable, not even `/health`, and nothing explained why.
 *   2. Every consumer's `onModuleInit()` awaited `createConsumer()`. Three of
 *      the five wrapped it in try/catch; `DeviceCommandsConsumer` did not, so
 *      its failed `connect()` surfaced as an unhandled rejection.
 *
 * Kafka here carries telemetry, rule-engine input and downlink commands. None
 * of that is a reason to refuse to serve dashboards, authenticate users or
 * answer a health probe. So:
 *
 *   • Nothing in the boot path awaits a broker round trip. `bootstrap()`
 *     returns immediately and the connect runs in the background with capped
 *     exponential backoff, forever, logging each failure.
 *   • `createConsumer()` records the subscription and returns. It is retried
 *     by the same background loop, so a consumer registered while the broker
 *     is down attaches by itself once the broker comes back — no restart.
 *   • A produce while disconnected THROWS (`KafkaUnavailableError`). That is
 *     deliberate: an ingestion frame that cannot be queued must fail loudly at
 *     its own call site, where the caller can answer 503 or retry, rather than
 *     being swallowed into a log line that says the reading was accepted.
 *   • `KAFKA_ENABLED=false` is a first-class local mode: no client is
 *     constructed at all and a produce is a logged no-op rather than a throw,
 *     because "there is no broker in this environment" is a different
 *     statement from "the broker is down".
 *
 * Message failure is bounded and visible: a handler that throws is retried
 * `KAFKA_CONSUMER_MAX_ATTEMPTS` times in process with backoff and then
 * dead-lettered to `<topic>.dlq`. Before this it was caught, logged once and
 * dropped — which is why a malformed frame left no trace anywhere.
 */

/** Thrown by a produce attempted while the broker is unreachable. */
export class KafkaUnavailableError extends Error {
  constructor(topic: string, reason: string) {
    super(`Kafka unavailable — cannot produce to "${topic}": ${reason}`);
    this.name = 'KafkaUnavailableError';
  }
}

interface ConsumerRegistration {
  groupId: string;
  topics: string[];
  handler: (payload: EachMessagePayload) => Promise<void>;
  consumer: Consumer | null;
  running: boolean;
  lastError: string | null;
}

export interface KafkaStatus {
  enabled: boolean;
  producerConnected: boolean;
  topicsDeclared: boolean;
  brokers: string[];
  bootstrapAttempts: number;
  lastError: string | null;
  /** Messages a caller tried to produce while the broker was unreachable. */
  refusedProduces: number;
  refusedProducesByTopic: Record<string, number>;
  consumers: Array<{
    groupId: string;
    topics: string[];
    running: boolean;
    lastError: string | null;
  }>;
}

export interface ConsumerLagEntry {
  groupId: string;
  topic: string;
  partition: number;
  offset: number;
  high: number;
  lag: number;
}

/**
 * Every topic this platform declares, with the consumer group that reads it.
 *
 * `consumedBy: null` means nothing in this codebase subscribes — and the
 * `reason` then has to say why that is acceptable. A topic created on a broker
 * that nobody reads is not neutral: it accumulates retained segments, it shows
 * up in every operator's topic list as though it were live, and the next
 * person to touch the area assumes a consumer exists somewhere. Making the
 * absence explicit here is what `npm run check:infra-wiring` asserts against.
 */
export const TOPIC_REGISTRY: ReadonlyArray<{
  topic: string;
  numPartitions: number;
  consumedBy: string | null;
  /**
   * Where a message goes once its consumer has exhausted its retries.
   * Required on every consumed topic — a stream with no dead-letter
   * destination drops poison messages silently, which is the behaviour this
   * registry exists to make impossible to reintroduce by omission.
   */
  dlqTopic?: string;
  reason?: string;
}> = [
  // ── Telemetry ─────────────────────────────────────────────────────────────
  {
    topic: 'telemetry.device.raw',
    numPartitions: 10,
    consumedBy: 'telemetry-processor-group',
    // Not `telemetry.device.raw.dlq`: this stream's dead-letter topic already
    // existed under this name and operators' kafka-ui bookmarks point at it.
    dlqTopic: 'telemetry.device.invalid',
  },
  {
    topic: 'telemetry.device.validated',
    numPartitions: 10,
    consumedBy: 'automation-processor-group',
    dlqTopic: 'telemetry.device.validated.dlq',
  },
  {
    topic: 'telemetry.device.invalid',
    numPartitions: 3,
    consumedBy: null,
    reason:
      'Dead-letter sink for frames TelemetryConsumer could not process. ' +
      'Read by an operator through kafka-ui when investigating; a consumer ' +
      'would have nothing to do with a frame that already failed once.',
  },
  {
    topic: 'telemetry.device.processed',
    numPartitions: 10,
    consumedBy: null,
    reason:
      'Declared for a downstream analytics sink that does not exist yet. ' +
      'Nothing produces to it either, so it stays empty — see §11.',
  },
  // ── Device lifecycle ──────────────────────────────────────────────────────
  {
    topic: 'device.lifecycle.created',
    numPartitions: 3,
    consumedBy: null,
    reason:
      'Device lifecycle is carried by EventEmitter2 (`device.*` events, read ' +
      'by AutomationListener) rather than Kafka. Nothing produces here.',
  },
  {
    topic: 'device.lifecycle.updated',
    numPartitions: 3,
    consumedBy: null,
    reason: 'As device.lifecycle.created — EventEmitter2 carries this.',
  },
  {
    topic: 'device.lifecycle.deleted',
    numPartitions: 3,
    consumedBy: null,
    reason: 'As device.lifecycle.created — EventEmitter2 carries this.',
  },
  {
    topic: 'device.connectivity.online',
    numPartitions: 5,
    consumedBy: null,
    reason:
      'Connectivity transitions are written to devices.status by ' +
      'DevicesService.checkOfflineDevices() and broadcast over Socket.IO. ' +
      'Nothing produces here.',
  },
  {
    topic: 'device.connectivity.offline',
    numPartitions: 5,
    consumedBy: null,
    reason: 'As device.connectivity.online.',
  },
  // ── Alarms ────────────────────────────────────────────────────────────────
  {
    topic: 'alarms.created',
    numPartitions: 5,
    consumedBy: null,
    reason:
      'Alarm fan-out is Bull (the `alarms` queue, for escalation timing that ' +
      'survives a restart) plus EventEmitter2 `alarm.*`. See alarms.consumer.ts, ' +
      'which is a Bull processor and not a Kafka consumer despite the filename.',
  },
  {
    topic: 'alarms.updated',
    numPartitions: 3,
    consumedBy: null,
    reason: 'As alarms.created.',
  },
  {
    topic: 'alarms.acknowledged',
    numPartitions: 3,
    consumedBy: null,
    reason: 'As alarms.created.',
  },
  {
    topic: 'alarms.cleared',
    numPartitions: 3,
    consumedBy: null,
    reason: 'As alarms.created.',
  },
  // ── Rules ─────────────────────────────────────────────────────────────────
  {
    topic: 'rules.input',
    numPartitions: 10,
    consumedBy: 'rule-engine-processor-group',
    dlqTopic: 'rules.input.dlq',
  },
  {
    topic: 'rules.output',
    numPartitions: 5,
    consumedBy: null,
    reason:
      'RuleEngineService applies a node’s outcome in process (action nodes ' +
      'write alarms, call REST, enqueue commands) rather than emitting a ' +
      'result message. Nothing produces here.',
  },
  // ── Notifications ─────────────────────────────────────────────────────────
  {
    topic: 'notifications.email',
    numPartitions: 3,
    consumedBy: null,
    reason:
      'NotificationsService dispatches through its channel classes ' +
      '(MailService, FCM, Web Push, SMS) synchronously. Nothing produces here.',
  },
  {
    topic: 'notifications.push',
    numPartitions: 3,
    consumedBy: null,
    reason: 'As notifications.email.',
  },
  // ── Audit ─────────────────────────────────────────────────────────────────
  {
    topic: 'audit.user.actions',
    numPartitions: 5,
    consumedBy: null,
    reason:
      'AuditInterceptor writes audit_logs rows directly. ' +
      'src/modules/audit/audit.consumer.ts would read this topic but is not ' +
      'registered in any module and nothing produces to it — see §11.',
  },
  {
    topic: 'audit.api.requests',
    numPartitions: 5,
    consumedBy: null,
    reason:
      'ApiLoggingMiddleware writes api_logs rows directly. Same dead-consumer ' +
      'situation as audit.user.actions — see §11.',
  },
  // ── Commands ──────────────────────────────────────────────────────────────
  {
    topic: 'device.commands',
    numPartitions: 5,
    consumedBy: 'device-commands-consumer-group',
    dlqTopic: 'device.commands.dlq',
  },
  {
    topic: 'device.commands.retry',
    numPartitions: 3,
    consumedBy: 'device-commands-consumer-group',
    // Shares the DLQ with the primary topic: a command that failed its last
    // retry is one command's failure, and splitting it across two dead-letter
    // topics by which hop it died on makes replay harder, not easier.
    dlqTopic: 'device.commands.dlq',
  },
  // ── Firmware ──────────────────────────────────────────────────────────────
  // Both were produced to by FirmwareService without ever being declared, so
  // they existed only by broker auto-creation — which uses the broker's
  // default partition count and replication factor, not this platform's.
  {
    topic: 'firmware.update',
    numPartitions: 3,
    consumedBy: 'firmware-update-group',
    dlqTopic: 'firmware.update.dlq',
  },
  {
    topic: 'firmware.status',
    numPartitions: 3,
    consumedBy: null,
    reason:
      'Terminal rollout outcome. FirmwareService already persists it to ' +
      'devices.firmwareUpdateStatus before producing; the topic exists so an ' +
      'external pipeline can tail rollouts.',
  },
];

@Injectable()
export class KafkaService implements OnApplicationShutdown {
  private readonly logger = new Logger(KafkaService.name);

  private readonly kafka: Kafka | null = null;
  private producer: Producer | null = null;
  private admin: Admin | null = null;
  private isProducerConnected = false;
  private topicsDeclared = false;
  private shuttingDown = false;
  private bootstrapAttempts = 0;
  private lastError: string | null = null;
  private bootstrapTimer: NodeJS.Timeout | null = null;
  private bootstrapInFlight = false;
  private disabledWarned = false;
  private refusedProduces = 0;
  private readonly refusedProducesByTopic: Record<string, number> = {};

  private readonly registrations = new Map<string, ConsumerRegistration>();
  private readonly settings: KafkaSettings;

  /** Lag snapshots are cached — `fetchOffsets` is several broker round trips. */
  private lagCache: { at: number; entries: ConsumerLagEntry[] } | null = null;

  constructor(private readonly configService: ConfigService) {
    // The whole 'kafka' namespace is read once. `brokers` arrives already split
    // on commas — the previous `[process.env.KAFKA_BROKERS]` passed a multi-broker
    // string to kafkajs as a single hostname, so only single-broker setups worked.
    this.settings = this.configService.get<KafkaSettings>('kafka')!;

    if (!this.settings.enabled) {
      this.logger.warn(
        'KAFKA_ENABLED=false — no client constructed. Telemetry will not be ' +
          'queued, consumers will not run, and every produce is a no-op. ' +
          'This is the supported mode for working without the Docker stack.',
      );
      return;
    }

    this.kafka = new Kafka({
      clientId: this.settings.clientId,
      brokers: this.settings.brokers,
      ssl: this.settings.ssl,
      sasl: this.settings.sasl,
      logLevel: logLevel.ERROR,
      retry: {
        initialRetryTime: this.settings.initialRetryTime,
        retries: this.settings.retries,
      },
      connectionTimeout: this.settings.connectionTimeout,
      requestTimeout: this.settings.requestTimeout,
    });

    this.admin = this.kafka.admin();
  }

  // ── Bootstrap ─────────────────────────────────────────────────────────────

  /**
   * Start connecting, and return immediately.
   *
   * Deliberately NOT async over the connect: this is called from the module
   * factory, and anything awaited here is a boot dependency. The retry loop
   * owns the connect from this point on.
   */
  bootstrap(): void {
    if (!this.settings.enabled) return;
    this.scheduleBootstrap(0);
  }

  private scheduleBootstrap(delayMs: number): void {
    if (this.shuttingDown || this.bootstrapTimer || this.bootstrapInFlight) {
      return;
    }
    this.bootstrapTimer = setTimeout(() => {
      this.bootstrapTimer = null;
      void this.runBootstrap();
    }, delayMs);
    // Do not hold the event loop open on this timer — a process that is
    // otherwise finished should be allowed to exit.
    this.bootstrapTimer.unref?.();
  }

  private async runBootstrap(): Promise<void> {
    if (this.shuttingDown || this.bootstrapInFlight) return;
    this.bootstrapInFlight = true;
    this.bootstrapAttempts++;

    try {
      await this.initProducer();
      await this.createTopics();
      await this.attachPendingConsumers();
      this.lastError = null;
      this.bootstrapInFlight = false;

      // Consumers registered after this point attach immediately, but one
      // that failed its own attach (a transient rebalance, say) is picked up
      // by the next sweep. Keep sweeping while anything is unattached.
      if (this.hasPendingConsumers()) {
        this.scheduleBootstrap(this.backoffMs());
      }
      return;
    } catch (error) {
      this.lastError = (error as Error).message;
      this.bootstrapInFlight = false;

      const delay = this.backoffMs();
      this.logger.error(
        `Kafka bootstrap attempt ${this.bootstrapAttempts} failed ` +
          `(brokers: ${this.settings.brokers.join(', ')}): ${this.lastError}. ` +
          `Retrying in ${Math.round(delay / 1000)}s. The application stays up; ` +
          `Kafka-backed ingestion is unavailable until this succeeds.`,
      );
      this.scheduleBootstrap(delay);
    }
  }

  /** Capped exponential backoff, so a long outage does not retry every 100ms. */
  private backoffMs(): number {
    const base = Math.max(this.settings.initialRetryTime, 500);
    const grown = base * Math.pow(2, Math.min(this.bootstrapAttempts, 10));
    return Math.min(grown, this.settings.bootstrapMaxBackoffMs);
  }

  // ── Producer ──────────────────────────────────────────────────────────────

  async initProducer(): Promise<void> {
    if (!this.settings.enabled || !this.kafka) return;
    if (this.isProducerConnected) return;

    // A producer object left over from a failed connect is discarded rather
    // than reconnected — kafkajs does not guarantee a producer is reusable
    // after a connect rejection, and a half-initialised one silently buffers.
    if (this.producer) {
      await this.producer.disconnect().catch(() => undefined);
      this.producer = null;
    }

    const producer = this.kafka.producer({
      idempotent: true,
      maxInFlightRequests: 5,
      retry: {
        initialRetryTime: this.settings.initialRetryTime,
        retries: this.settings.retries,
      },
    });

    await producer.connect();
    this.producer = producer;
    this.isProducerConnected = true;

    // A disconnect at runtime has to flip the flag back, or `sendMessage`
    // keeps believing it is connected and every produce rejects deep inside
    // kafkajs instead of at this service's boundary — and the background
    // retry loop never restarts, because nothing told it the link was gone.
    producer.on('producer.disconnect', () => {
      if (this.shuttingDown) return;
      this.isProducerConnected = false;
      this.logger.warn('Kafka producer disconnected — scheduling reconnect');
      this.scheduleBootstrap(this.backoffMs());
    });

    this.logger.log(
      `Kafka producer connected (brokers: ${this.settings.brokers.join(', ')})`,
    );
  }

  /**
   * Whether the shared producer is currently connected.
   *
   * Reflects the real connect/disconnect lifecycle rather than issuing a
   * broker round-trip, so health endpoints can call it on every request
   * without cost. With `KAFKA_ENABLED=false` this reports healthy: the
   * platform is correctly configured for an environment with no broker, and a
   * readiness probe must not fail on a deliberate choice.
   */
  isHealthy(): boolean {
    if (!this.settings.enabled) return true;
    return this.isProducerConnected;
  }

  isEnabled(): boolean {
    return this.settings.enabled;
  }

  /** Cheap snapshot for `/health` — no broker round trips. */
  getStatus(): KafkaStatus {
    return {
      enabled: this.settings.enabled,
      producerConnected: this.isProducerConnected,
      topicsDeclared: this.topicsDeclared,
      brokers: this.settings.brokers,
      bootstrapAttempts: this.bootstrapAttempts,
      lastError: this.lastError,
      refusedProduces: this.refusedProduces,
      refusedProducesByTopic: { ...this.refusedProducesByTopic },
      consumers: [...this.registrations.values()].map((r) => ({
        groupId: r.groupId,
        topics: r.topics,
        running: r.running,
        lastError: r.lastError,
      })),
    };
  }

  // ── Topics ────────────────────────────────────────────────────────────────

  async createTopics(): Promise<void> {
    if (!this.settings.enabled || !this.admin) return;

    // Replication factor is a *cluster* property: it was pinned at 1, which
    // silently means "no replicas, lose the partition if that broker dies".
    // It has to track the real broker count, so it comes from
    // KAFKA_TOPIC_REPLICATION_FACTOR. Partition counts are a topology
    // decision and stay in code, in TOPIC_REGISTRY, alongside the consumer
    // group that reads each one.
    const replicationFactor = this.settings.topicReplicationFactor;

    const topics = TOPIC_REGISTRY.map((t) => ({
      topic: t.topic,
      numPartitions: t.numPartitions,
      replicationFactor,
    }));

    // Every consumed topic's dead-letter topic is declared too, because a DLQ
    // the broker auto-creates on first use takes the broker's defaults rather
    // than this platform's replication factor — and on a cluster with
    // auto-creation disabled the DLQ send fails and the message really is
    // lost, which is the one outcome the DLQ exists to prevent.
    const declared = new Set(topics.map((t) => t.topic));
    for (const t of TOPIC_REGISTRY) {
      if (!t.consumedBy) continue;
      const dlq = t.dlqTopic ?? `${t.topic}${this.settings.dlqSuffix}`;
      if (declared.has(dlq)) continue;
      declared.add(dlq);
      topics.push({ topic: dlq, numPartitions: 1, replicationFactor });
    }

    await this.admin.connect();
    try {
      const existing = await this.admin.listTopics();
      const toCreate = topics.filter((t) => !existing.includes(t.topic));

      if (toCreate.length > 0) {
        await this.admin.createTopics({
          topics: toCreate,
          waitForLeaders: true,
        });
        this.logger.log(`Created ${toCreate.length} Kafka topic(s)`);
      } else {
        this.logger.log('All Kafka topics already exist');
      }
      this.topicsDeclared = true;
    } finally {
      await this.admin.disconnect().catch(() => undefined);
    }
  }

  // ── Send ──────────────────────────────────────────────────────────────────

  /**
   * Produce one message.
   *
   * Throws `KafkaUnavailableError` when the broker is unreachable. Callers on
   * the ingestion path must let that propagate — a reading that was not queued
   * has not been accepted, and reporting success for it is worse than a 503.
   */
  async sendMessage(
    topic: string,
    message: any,
    key?: string,
    headers?: Record<string, string>,
  ): Promise<void> {
    if (!this.settings.enabled) {
      this.warnDisabledOnce(topic);
      return;
    }

    this.assertProducerReady(topic);

    const msgHeaders: Record<string, Buffer> = {};
    if (headers) {
      for (const [k, v] of Object.entries(headers)) {
        msgHeaders[k] = Buffer.from(v);
      }
    }

    await this.producer!.send({
      topic,
      messages: [
        {
          key: key ?? null,
          value: JSON.stringify(message),
          headers: msgHeaders,
          timestamp: Date.now().toString(),
        },
      ],
      compression: CompressionTypes.GZIP, // Snappy requires an optional native dep; GZIP is built-in
    });

    this.logger.debug(`Message sent → ${topic} (key: ${key ?? 'none'})`);
  }

  async sendBatch(
    topic: string,
    messages: Array<{ key?: string; value: any }>,
  ): Promise<void> {
    if (!this.settings.enabled) {
      this.warnDisabledOnce(topic);
      return;
    }

    this.assertProducerReady(topic);

    await this.producer!.send({
      topic,
      messages: messages.map((m) => ({
        key: m.key ?? null,
        value: JSON.stringify(m.value),
        timestamp: Date.now().toString(),
      })),
      compression: CompressionTypes.GZIP,
    });

    this.logger.debug(`Batch of ${messages.length} sent → ${topic}`);
  }

  private assertProducerReady(topic: string): void {
    if (this.isProducerConnected && this.producer) return;

    // Counted here rather than at each call site, so every refused produce on
    // the platform lands in one number that `/health/messaging` can report.
    // "Telemetry stopped arriving" and "telemetry is arriving and being thrown
    // away" look identical on a dashboard and need different responses.
    this.refusedProduces++;
    this.refusedProducesByTopic[topic] =
      (this.refusedProducesByTopic[topic] ?? 0) + 1;

    // Nudge the retry loop: a produce arriving while disconnected is the
    // clearest possible signal that someone wants the link back.
    this.scheduleBootstrap(0);

    throw new KafkaUnavailableError(
      topic,
      this.lastError ??
        `producer not connected (brokers: ${this.settings.brokers.join(', ')})`,
    );
  }

  private warnDisabledOnce(topic: string): void {
    if (this.disabledWarned) {
      this.logger.debug(`Kafka disabled — dropped message for ${topic}`);
      return;
    }
    this.disabledWarned = true;
    this.logger.warn(
      `Kafka disabled (KAFKA_ENABLED=false) — dropping the message for ` +
        `"${topic}" and every later one. Telemetry will not be persisted by ` +
        `TelemetryConsumer and no automation or rule chain will fire from the ` +
        `MQTT/CoAP path while this is set.`,
    );
  }

  // ── Consumer ──────────────────────────────────────────────────────────────
  // Uses autoCommit (the KafkaJS default) — do NOT call consumer.commitOffsets()
  // manually inside eachMessage when autoCommit is enabled; they conflict.
  // If you need manual offset control, set autoCommit: false and handle it yourself.

  /**
   * Register a consumer group.
   *
   * Returns as soon as the registration is recorded. It does NOT reject when
   * the broker is unreachable — that is the whole point: a consumer's
   * `onModuleInit` is in the boot path, and before this change
   * `DeviceCommandsConsumer`'s un-caught `connect()` failure was an unhandled
   * rejection that killed the process. The attach is retried in the background
   * and happens by itself once the broker is reachable.
   */
  async createConsumer(
    groupId: string,
    topics: string[],
    handler: (payload: EachMessagePayload) => Promise<void>,
  ): Promise<void> {
    if (!this.settings.enabled) {
      this.logger.warn(
        `Kafka disabled — consumer [${groupId}] will not run ` +
          `(topics: ${topics.join(', ')})`,
      );
      return;
    }

    const existing = this.registrations.get(groupId);
    if (existing?.running) {
      this.logger.warn(`Consumer [${groupId}] is already running — ignoring`);
      return;
    }

    this.registrations.set(groupId, {
      groupId,
      topics,
      handler,
      consumer: null,
      running: false,
      lastError: null,
    });

    // Attempt it now so a healthy broker attaches synchronously and the boot
    // log reads the way it always has. A failure here is recorded, not thrown.
    await this.attachConsumer(this.registrations.get(groupId)!).catch(
      () => undefined,
    );

    if (!this.registrations.get(groupId)!.running) {
      this.scheduleBootstrap(this.backoffMs());
    }
  }

  private hasPendingConsumers(): boolean {
    return [...this.registrations.values()].some((r) => !r.running);
  }

  private async attachPendingConsumers(): Promise<void> {
    for (const reg of this.registrations.values()) {
      if (reg.running) continue;
      await this.attachConsumer(reg).catch(() => undefined);
    }
  }

  private async attachConsumer(reg: ConsumerRegistration): Promise<void> {
    if (!this.kafka || this.shuttingDown || reg.running) return;

    // Discard a consumer left behind by a failed attach for the same reason
    // the producer is discarded — a half-connected consumer that is run()
    // twice throws, and the second failure looks like a different bug.
    if (reg.consumer) {
      await reg.consumer.disconnect().catch(() => undefined);
      reg.consumer = null;
    }

    const consumer = this.kafka.consumer({
      groupId: reg.groupId,
      sessionTimeout: this.settings.sessionTimeout,
      heartbeatInterval: this.settings.heartbeatInterval,
      retry: { initialRetryTime: 100, retries: 8 },
    });

    try {
      await consumer.connect();
      await consumer.subscribe({ topics: reg.topics, fromBeginning: false });

      await consumer.run({
        // autoCommit is true by default — offsets are committed automatically
        // after eachMessage resolves without throwing. This wrapper therefore
        // never rethrows: the offset must advance, or a single poison message
        // blocks its partition forever. Bounded retry then DLQ is how the
        // message survives without blocking the stream.
        eachMessage: (payload) => this.runHandler(reg, payload),
      });

      reg.consumer = consumer;
      reg.running = true;
      reg.lastError = null;

      consumer.on('consumer.crash', (event) => {
        if (this.shuttingDown) return;
        reg.running = false;
        reg.lastError = event.payload?.error?.message ?? 'consumer crashed';
        this.logger.error(
          `Consumer [${reg.groupId}] crashed: ${reg.lastError} — will reattach`,
        );
        this.scheduleBootstrap(this.backoffMs());
      });

      this.logger.log(
        `Consumer [${reg.groupId}] subscribed to: ${reg.topics.join(', ')}`,
      );
    } catch (error) {
      reg.lastError = (error as Error).message;
      reg.running = false;
      await consumer.disconnect().catch(() => undefined);
      this.logger.error(
        `Consumer [${reg.groupId}] could not attach: ${reg.lastError} — ` +
          `retrying in the background`,
      );
      throw error;
    }
  }

  /**
   * Run one message through its handler, with bounded retry and a DLQ.
   *
   * The previous shape caught, logged one line, and returned — so a frame
   * that failed for a transient reason (a deadlock, a momentary DB blip) was
   * gone, and a frame that failed for a permanent reason left nothing to
   * inspect. Neither was recoverable and neither was countable.
   */
  private async runHandler(
    reg: ConsumerRegistration,
    payload: EachMessagePayload,
  ): Promise<void> {
    const attempts = Math.max(1, this.settings.consumerMaxAttempts);
    let lastError: Error | null = null;

    for (let attempt = 1; attempt <= attempts; attempt++) {
      try {
        await reg.handler(payload);
        return;
      } catch (error) {
        lastError = error as Error;
        this.logger.warn(
          `[${reg.groupId}] attempt ${attempt}/${attempts} failed for ` +
            `${payload.topic}[${payload.partition}]@${payload.message.offset}: ` +
            lastError.message,
        );
        if (attempt < attempts) {
          await new Promise((r) =>
            setTimeout(r, this.settings.consumerRetryBackoffMs * attempt),
          );
        }
      }
    }

    await this.deadLetter(reg, payload, lastError!);
  }

  /**
   * The registry decides where a failed message goes; the suffix is only the
   * fallback for a topic someone consumes without declaring it. Deriving it
   * from the name alone would have silently created a second, empty DLQ for
   * telemetry alongside the `telemetry.device.invalid` that already existed.
   */
  private dlqTopicFor(topic: string): string {
    const entry = TOPIC_REGISTRY.find((t) => t.topic === topic);
    return entry?.dlqTopic ?? `${topic}${this.settings.dlqSuffix}`;
  }

  private async deadLetter(
    reg: ConsumerRegistration,
    payload: EachMessagePayload,
    error: Error,
  ): Promise<void> {
    const dlqTopic = this.dlqTopicFor(payload.topic);

    this.logger.error(
      `[${reg.groupId}] exhausted retries for ` +
        `${payload.topic}[${payload.partition}]@${payload.message.offset} — ` +
        `dead-lettering to ${dlqTopic}: ${error.message}`,
    );

    try {
      // The original key is preserved so a device's failures stay ordered and
      // co-located in the DLQ, and the original value is passed through
      // verbatim: a DLQ entry that cannot be replayed byte-for-byte is only a
      // log line with extra steps.
      await this.sendMessage(
        dlqTopic,
        {
          originalTopic: payload.topic,
          originalPartition: payload.partition,
          originalOffset: payload.message.offset,
          groupId: reg.groupId,
          error: error.message,
          failedAt: Date.now(),
          value: payload.message.value?.toString() ?? null,
        },
        payload.message.key?.toString() ?? undefined,
      );
    } catch (dlqError) {
      // Last resort. The offset still advances — blocking the partition on a
      // DLQ that is itself unavailable turns one lost message into a stalled
      // stream — so the full payload goes to the log, which is the only place
      // left that can hold it.
      this.logger.error(
        `[${reg.groupId}] DLQ send to ${dlqTopic} ALSO failed ` +
          `(${(dlqError as Error).message}). Message is lost; raw value: ` +
          (payload.message.value?.toString() ?? 'null'),
      );
    }
  }

  // ── Consumer lag ──────────────────────────────────────────────────────────

  /**
   * Committed offset vs log end offset, per partition, for every registered
   * consumer group.
   *
   * There was previously no way at all to see whether a consumer was keeping
   * up: a telemetry consumer falling behind looked exactly like devices that
   * had stopped reporting, and the only symptom was dashboards going quiet.
   *
   * Cached for KAFKA_LAG_CACHE_SECONDS — this is several admin round trips per
   * group and `/health` is polled by a load balancer.
   */
  async getConsumerLag(): Promise<ConsumerLagEntry[]> {
    if (!this.settings.enabled || !this.admin || !this.isProducerConnected) {
      return [];
    }

    const now = Date.now();
    if (
      this.lagCache &&
      now - this.lagCache.at < this.settings.lagCacheSeconds * 1000
    ) {
      return this.lagCache.entries;
    }

    const entries: ConsumerLagEntry[] = [];

    await this.admin.connect();
    try {
      const highWater = new Map<string, Map<number, number>>();

      for (const reg of this.registrations.values()) {
        if (!reg.running) continue;

        for (const topic of reg.topics) {
          if (!highWater.has(topic)) {
            const offsets = await this.admin.fetchTopicOffsets(topic);
            highWater.set(
              topic,
              new Map(offsets.map((o) => [o.partition, Number(o.high)])),
            );
          }
        }

        const committed = await this.admin.fetchOffsets({
          groupId: reg.groupId,
          topics: reg.topics,
        });

        for (const t of committed) {
          const highs = highWater.get(t.topic);
          for (const p of t.partitions) {
            const offset = Number(p.offset);
            const high = highs?.get(p.partition) ?? 0;
            entries.push({
              groupId: reg.groupId,
              topic: t.topic,
              partition: p.partition,
              // -1 means the group has never committed on this partition.
              // Reporting a lag of `high` there would make a freshly created
              // group look catastrophically behind on every empty partition.
              offset,
              high,
              lag: offset < 0 ? 0 : Math.max(0, high - offset),
            });
          }
        }
      }
    } finally {
      await this.admin.disconnect().catch(() => undefined);
    }

    this.lagCache = { at: now, entries };
    return entries;
  }

  /** Total lag per group — the one number an operator actually wants. */
  async getConsumerLagSummary(): Promise<Record<string, number>> {
    const entries = await this.getConsumerLag();
    const summary: Record<string, number> = {};
    for (const e of entries) {
      summary[e.groupId] = (summary[e.groupId] ?? 0) + e.lag;
    }
    return summary;
  }

  // ── Shutdown ──────────────────────────────────────────────────────────────

  async onApplicationShutdown(): Promise<void> {
    this.shuttingDown = true;

    if (this.bootstrapTimer) {
      clearTimeout(this.bootstrapTimer);
      this.bootstrapTimer = null;
    }

    if (this.producer) {
      await this.producer.disconnect().catch(() => undefined);
      this.isProducerConnected = false;
      this.logger.log('Kafka producer disconnected');
    }

    for (const reg of this.registrations.values()) {
      if (!reg.consumer) continue;
      await reg.consumer.disconnect().catch(() => undefined);
      reg.running = false;
      this.logger.log(`Consumer [${reg.groupId}] disconnected`);
    }
    this.registrations.clear();
  }
}
