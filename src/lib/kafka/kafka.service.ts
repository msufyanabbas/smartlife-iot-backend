// src/lib/kafka/kafka.service.ts
import {
  Kafka,
  Producer,
  Consumer,
  EachMessagePayload,
  Admin,
  logLevel,
} from 'kafkajs';

class KafkaService {
  private kafka: Kafka;
  private producer: Producer | null = null;
  private consumers: Map<string, Consumer> = new Map();
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

  /**
   * Initialize Kafka Producer
   */
  async initProducer(): Promise<void> {
    if (this.isProducerConnected) {
      return;
    }

    try {
      this.producer = this.kafka.producer({
        idempotent: true,
        maxInFlightRequests: 5,
        retry: {
          initialRetryTime: 100,
          retries: 8,
        },
      });

      await this.producer.connect();
      this.isProducerConnected = true;
      console.log('✅ Kafka Producer connected');
    } catch (error) {
      console.error('❌ Failed to connect Kafka Producer:', error);
      throw error;
    }
  }

  /**
   * Create Kafka Topics
   */
  async createTopics(): Promise<void> {
    try {
      await this.admin.connect();

      const topics = [
        // Telemetry Topics
        {
          topic: 'telemetry.device.raw',
          numPartitions: 10,
          replicationFactor: 1,
        },
        {
          topic: 'telemetry.device.validated',
          numPartitions: 10,
          replicationFactor: 1,
        },
        {
          topic: 'telemetry.device.processed',
          numPartitions: 10,
          replicationFactor: 1,
        },

        // Device Lifecycle
        {
          topic: 'device.lifecycle.created',
          numPartitions: 3,
          replicationFactor: 1,
        },
        {
          topic: 'device.lifecycle.updated',
          numPartitions: 3,
          replicationFactor: 1,
        },
        {
          topic: 'device.lifecycle.deleted',
          numPartitions: 3,
          replicationFactor: 1,
        },
        {
          topic: 'device.connectivity.online',
          numPartitions: 5,
          replicationFactor: 1,
        },
        {
          topic: 'device.connectivity.offline',
          numPartitions: 5,
          replicationFactor: 1,
        },

        // Alarms
        { topic: 'alarms.created', numPartitions: 5, replicationFactor: 1 },
        { topic: 'alarms.updated', numPartitions: 3, replicationFactor: 1 },
        {
          topic: 'alarms.acknowledged',
          numPartitions: 3,
          replicationFactor: 1,
        },
        { topic: 'alarms.cleared', numPartitions: 3, replicationFactor: 1 },

        // Rules
        { topic: 'rules.input', numPartitions: 10, replicationFactor: 1 },
        { topic: 'rules.output', numPartitions: 5, replicationFactor: 1 },

        // Notifications
        {
          topic: 'notifications.email',
          numPartitions: 3,
          replicationFactor: 1,
        },
        { topic: 'notifications.push', numPartitions: 3, replicationFactor: 1 },

        // Audit
        { topic: 'audit.user.actions', numPartitions: 5, replicationFactor: 1 },
        { topic: 'audit.api.requests', numPartitions: 5, replicationFactor: 1 },

        { topic: 'device.commands', numPartitions: 5, replicationFactor: 1 },
        {
          topic: 'device.commands.retry',
          numPartitions: 3,
          replicationFactor: 1,
        },
      ];

      const existingTopics = await this.admin.listTopics();
      const topicsToCreate = topics.filter(
        (t) => !existingTopics.includes(t.topic),
      );

      if (topicsToCreate.length > 0) {
        await this.admin.createTopics({
          topics: topicsToCreate,
          waitForLeaders: true,
        });
        console.log(`✅ Created ${topicsToCreate.length} Kafka topics`);
      } else {
        console.log('✅ All Kafka topics already exist');
      }

      await this.admin.disconnect();
    } catch (error) {
      console.error('❌ Failed to create Kafka topics:', error);
      throw error;
    }
  }

  /**
   * Send message to Kafka topic
   */
  async sendMessage(
    topic: string,
    message: any,
    key?: string,
    headers?: Record<string, string>,
  ): Promise<void> {
    if (!this.producer || !this.isProducerConnected) {
      await this.initProducer();
    }

    try {
      const messageHeaders: Record<string, Buffer> = {};
      if (headers) {
        Object.entries(headers).forEach(([k, v]) => {
          messageHeaders[k] = Buffer.from(v);
        });
      }

      await this.producer!.send({
        topic,
        messages: [
          {
            key: key || null,
            value: JSON.stringify(message),
            headers: messageHeaders,
            timestamp: Date.now().toString(),
          },
        ],
        compression: 1, // Snappy
      });

      console.log(`📤 Sent message to ${topic}`);
    } catch (error) {
      console.error(`❌ Failed to send message to ${topic}:`, error);
      throw error;
    }
  }

  /**
   * Send batch of messages
   */
  async sendBatch(
    topic: string,
    messages: Array<{ key?: string; value: any }>,
  ): Promise<void> {
    if (!this.producer || !this.isProducerConnected) {
      await this.initProducer();
    }

    try {
      await this.producer!.send({
        topic,
        messages: messages.map((msg) => ({
          key: msg.key || null,
          value: JSON.stringify(msg.value),
          timestamp: Date.now().toString(),
        })),
        compression: 1,
      });

      console.log(`📤 Sent batch of ${messages.length} messages to ${topic}`);
    } catch (error) {
      console.error(`❌ Failed to send batch to ${topic}:`, error);
      throw error;
    }
  }

  /**
   * Create and start a consumer
   */
  async createConsumer(
    groupId: string,
    topics: string[],
    handler: (payload: EachMessagePayload) => Promise<void>,
  ): Promise<void> {
    try {
      const consumer = this.kafka.consumer({
        groupId,
        sessionTimeout: 30000,
        heartbeatInterval: 3000,
        retry: {
          initialRetryTime: 100,
          retries: 8,
        },
      });

      await consumer.connect();
      await consumer.subscribe({ topics, fromBeginning: false });

      await consumer.run({
        eachMessage: async (payload) => {
          try {
            await handler(payload);

            // Commit offset after successful processing
            await consumer.commitOffsets([
              {
                topic: payload.topic,
                partition: payload.partition,
                offset: (Number(payload.message.offset) + 1).toString(),
              },
            ]);
          } catch (error) {
            console.error(
              `❌ Error processing message from ${payload.topic}:`,
              error,
            );
          }
        },
      });

      this.consumers.set(groupId, consumer);
      console.log(
        `✅ Consumer ${groupId} started for topics: ${topics.join(', ')}`,
      );
    } catch (error) {
      console.error(`❌ Failed to create consumer ${groupId}:`, error);
      throw error;
    }
  }

  /**
   * Disconnect all
   */
  async disconnect(): Promise<void> {
    try {
      if (this.producer) {
        await this.producer.disconnect();
        this.isProducerConnected = false;
        console.log('✅ Kafka Producer disconnected');
      }

      for (const [groupId, consumer] of this.consumers) {
        await consumer.disconnect();
        console.log(`✅ Consumer ${groupId} disconnected`);
      }
      this.consumers.clear();
    } catch (error) {
      console.error('❌ Error disconnecting from Kafka:', error);
    }
  }
}

export const kafkaService = new KafkaService();
