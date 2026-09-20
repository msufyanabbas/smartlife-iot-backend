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

@Injectable()
export class KafkaService implements OnApplicationShutdown {
  private readonly logger = new Logger(KafkaService.name);

  private readonly kafka: Kafka;
  private producer: Producer | null = null;
  private readonly consumers = new Map<string, Consumer>();
  private admin: Admin;
  private isProducerConnected = false;
  private readonly settings: KafkaSettings;

  constructor(private readonly configService: ConfigService) {
    // The whole 'kafka' namespace is read once. `brokers` arrives already split
    // on commas — the previous `[process.env.KAFKA_BROKERS]` passed a multi-broker
    // string to kafkajs as a single hostname, so only single-broker setups worked.
    this.settings = this.configService.get<KafkaSettings>('kafka')!;

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

  // ── Producer ──────────────────────────────────────────────────────────────

  async initProducer(): Promise<void> {
    if (this.isProducerConnected) return;

    this.producer = this.kafka.producer({
      idempotent: true,
      maxInFlightRequests: 5,
      retry: {
        initialRetryTime: this.settings.initialRetryTime,
        retries: this.settings.retries,
      },
    });

    await this.producer.connect();
    this.isProducerConnected = true;
    this.logger.log('Kafka producer connected');
  }

  /**
   * Whether the shared producer is currently connected.
   *
   * Reflects the real connect/disconnect lifecycle (set in initProducer() and
   * cleared in onApplicationShutdown()) rather than issuing a broker round-trip,
   * so health endpoints can call it on every request without cost.
   */
  isHealthy(): boolean {
    return this.isProducerConnected;
  }

  // ── Topics ────────────────────────────────────────────────────────────────

  async createTopics(): Promise<void> {
    await this.admin.connect();

    // Partition counts are a topology decision and stay in code — they encode
    // how much parallelism each stream needs. Replication factor is a *cluster*
    // property: it was pinned at 1, which silently means "no replicas, lose the
    // partition if that broker dies". It has to track the real broker count, so
    // it comes from KAFKA_TOPIC_REPLICATION_FACTOR.
    const replicationFactor = this.settings.topicReplicationFactor;

    const topics = [
      // Telemetry
      { topic: 'telemetry.device.raw', numPartitions: 10, replicationFactor },
      {
        topic: 'telemetry.device.validated',
        numPartitions: 10,
        replicationFactor,
      },
      {
        topic: 'telemetry.device.processed',
        numPartitions: 10,
        replicationFactor,
      },
      // Device lifecycle
      {
        topic: 'device.lifecycle.created',
        numPartitions: 3,
        replicationFactor,
      },
      {
        topic: 'device.lifecycle.updated',
        numPartitions: 3,
        replicationFactor,
      },
      {
        topic: 'device.lifecycle.deleted',
        numPartitions: 3,
        replicationFactor,
      },
      {
        topic: 'device.connectivity.online',
        numPartitions: 5,
        replicationFactor,
      },
      {
        topic: 'device.connectivity.offline',
        numPartitions: 5,
        replicationFactor,
      },
      // Alarms
      { topic: 'alarms.created', numPartitions: 5, replicationFactor },
      { topic: 'alarms.updated', numPartitions: 3, replicationFactor },
      { topic: 'alarms.acknowledged', numPartitions: 3, replicationFactor },
      { topic: 'alarms.cleared', numPartitions: 3, replicationFactor },
      // Rules
      { topic: 'rules.input', numPartitions: 10, replicationFactor },
      { topic: 'rules.output', numPartitions: 5, replicationFactor },
      // Notifications
      { topic: 'notifications.email', numPartitions: 3, replicationFactor },
      { topic: 'notifications.push', numPartitions: 3, replicationFactor },
      // Audit
      { topic: 'audit.user.actions', numPartitions: 5, replicationFactor },
      { topic: 'audit.api.requests', numPartitions: 5, replicationFactor },
      // Commands
      { topic: 'device.commands', numPartitions: 5, replicationFactor },
      { topic: 'device.commands.retry', numPartitions: 3, replicationFactor },
    ];

    const existing = await this.admin.listTopics();
    const toCreate = topics.filter((t) => !existing.includes(t.topic));

    if (toCreate.length > 0) {
      await this.admin.createTopics({ topics: toCreate, waitForLeaders: true });
      this.logger.log(`Created ${toCreate.length} Kafka topic(s)`);
    } else {
      this.logger.log('All Kafka topics already exist');
    }

    await this.admin.disconnect();
  }

  // ── Send ──────────────────────────────────────────────────────────────────

  async sendMessage(
    topic: string,
    message: any,
    key?: string,
    headers?: Record<string, string>,
  ): Promise<void> {
    if (!this.isProducerConnected) {
      await this.initProducer();
    }

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
    if (!this.isProducerConnected) {
      await this.initProducer();
    }

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

  // ── Consumer ──────────────────────────────────────────────────────────────
  // Uses autoCommit (the KafkaJS default) — do NOT call consumer.commitOffsets()
  // manually inside eachMessage when autoCommit is enabled; they conflict.
  // If you need manual offset control, set autoCommit: false and handle it yourself.

  async createConsumer(
    groupId: string,
    topics: string[],
    handler: (payload: EachMessagePayload) => Promise<void>,
  ): Promise<void> {
    const consumer = this.kafka.consumer({
      groupId,
      sessionTimeout: 30000,
      heartbeatInterval: 3000,
      retry: { initialRetryTime: 100, retries: 8 },
    });

    await consumer.connect();
    await consumer.subscribe({ topics, fromBeginning: false });

    await consumer.run({
      // autoCommit is true by default — offsets are committed automatically
      // after eachMessage resolves without throwing.
      eachMessage: async (payload) => {
        try {
          await handler(payload);
        } catch (error) {
          this.logger.error(
            `Error processing message from ${payload.topic}[${payload.partition}]@${payload.message.offset}: ${(error as Error).message}`,
          );
          // Do not rethrow — KafkaJS will pause the partition on repeated errors.
          // Add a dead-letter-queue (DLQ) send here when you need that pattern.
        }
      },
    });

    this.consumers.set(groupId, consumer);
    this.logger.log(
      `Consumer [${groupId}] subscribed to: ${topics.join(', ')}`,
    );
  }

  // ── Shutdown ──────────────────────────────────────────────────────────────

  async onApplicationShutdown(): Promise<void> {
    if (this.producer) {
      await this.producer.disconnect();
      this.isProducerConnected = false;
      this.logger.log('Kafka producer disconnected');
    }

    for (const [groupId, consumer] of this.consumers) {
      await consumer.disconnect();
      this.logger.log(`Consumer [${groupId}] disconnected`);
    }
    this.consumers.clear();
  }
}
