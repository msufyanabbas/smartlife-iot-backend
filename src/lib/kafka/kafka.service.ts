import { Injectable, Logger, OnApplicationShutdown } from '@nestjs/common';
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

  constructor() {
    this.kafka = new Kafka({
      clientId: 'smartlife-iot-platform',
      brokers: [process.env.KAFKA_BROKERS || 'localhost:9093'],
      logLevel: logLevel.ERROR,
      retry: {
        initialRetryTime: 100,
        retries: 8,
      },
      connectionTimeout: 10000,
      requestTimeout: 30000,
    });

    this.admin = this.kafka.admin();
  }

  // ── Producer ──────────────────────────────────────────────────────────────

  async initProducer(): Promise<void> {
    if (this.isProducerConnected) return;

    this.producer = this.kafka.producer({
      idempotent: true,
      maxInFlightRequests: 5,
      retry: { initialRetryTime: 100, retries: 8 },
    });

    await this.producer.connect();
    this.isProducerConnected = true;
    this.logger.log('Kafka producer connected');
  }

  // ── Topics ────────────────────────────────────────────────────────────────

  async createTopics(): Promise<void> {
    await this.admin.connect();

    const topics = [
      // Telemetry
      { topic: 'telemetry.device.raw',       numPartitions: 10, replicationFactor: 1 },
      { topic: 'telemetry.device.validated', numPartitions: 10, replicationFactor: 1 },
      { topic: 'telemetry.device.processed', numPartitions: 10, replicationFactor: 1 },
      // Device lifecycle
      { topic: 'device.lifecycle.created',      numPartitions: 3, replicationFactor: 1 },
      { topic: 'device.lifecycle.updated',      numPartitions: 3, replicationFactor: 1 },
      { topic: 'device.lifecycle.deleted',      numPartitions: 3, replicationFactor: 1 },
      { topic: 'device.connectivity.online',    numPartitions: 5, replicationFactor: 1 },
      { topic: 'device.connectivity.offline',   numPartitions: 5, replicationFactor: 1 },
      // Alarms
      { topic: 'alarms.created',      numPartitions: 5, replicationFactor: 1 },
      { topic: 'alarms.updated',      numPartitions: 3, replicationFactor: 1 },
      { topic: 'alarms.acknowledged', numPartitions: 3, replicationFactor: 1 },
      { topic: 'alarms.cleared',      numPartitions: 3, replicationFactor: 1 },
      // Rules
      { topic: 'rules.input',  numPartitions: 10, replicationFactor: 1 },
      { topic: 'rules.output', numPartitions: 5,  replicationFactor: 1 },
      // Notifications
      { topic: 'notifications.email', numPartitions: 3, replicationFactor: 1 },
      { topic: 'notifications.push',  numPartitions: 3, replicationFactor: 1 },
      // Audit
      { topic: 'audit.user.actions', numPartitions: 5, replicationFactor: 1 },
      { topic: 'audit.api.requests', numPartitions: 5, replicationFactor: 1 },
      // Commands
      { topic: 'device.commands',       numPartitions: 5, replicationFactor: 1 },
      { topic: 'device.commands.retry', numPartitions: 3, replicationFactor: 1 },
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
    this.logger.log(`Consumer [${groupId}] subscribed to: ${topics.join(', ')}`);
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