import { Kafka, Producer, logLevel, SASLOptions } from 'kafkajs';
import * as crypto from 'crypto';
import { Logger } from '@nestjs/common';
import type {
  ConnectionResult,
  DispatchResult,
  IIntegrationAdapter,
} from './adapter.interface';

interface PooledProducer {
  producer: Producer;
  connecting: Promise<void> | null;
  lastUsed: number;
}

/**
 * Apache Kafka producer.
 *
 * Unlike the HTTP-ish adapters, this one POOLS connections. A Kafka producer
 * negotiates the cluster topology on connect, so the connect-publish-disconnect
 * pattern the MQTT adapter uses would cost several round trips per reading and
 * churn the broker's connection table. Producers are therefore kept per
 * configuration and reused, and idle ones are reaped.
 *
 * `kafkajs` is already a platform dependency (it carries the telemetry
 * pipeline), so this adds no new package.
 */
export class KafkaAdapter implements IIntegrationAdapter {
  private readonly logger = new Logger(KafkaAdapter.name);

  /** Idle producers are disconnected after this long. */
  private static readonly IDLE_MS = 5 * 60 * 1000;

  private static pool = new Map<string, PooledProducer>();
  private static reaper: NodeJS.Timeout | null = null;

  /**
   * Identity of a connection. Anything that changes where or as whom we
   * connect must be in here, or an edited integration would keep publishing
   * through its old producer.
   */
  private poolKey(config: any): string {
    return crypto
      .createHash('sha1')
      .update(
        JSON.stringify([
          config?.brokers,
          config?.clientId,
          config?.ssl,
          config?.saslMechanism,
          config?.saslUsername,
          config?.saslPassword,
        ]),
      )
      .digest('hex');
  }

  private parseBrokers(config: any): string[] {
    const raw = config?.brokers;
    if (Array.isArray(raw)) return raw.map((b) => String(b).trim()).filter(Boolean);
    return String(raw ?? '')
      .split(',')
      .map((broker) => broker.trim())
      .filter(Boolean);
  }

  private buildSasl(config: any): SASLOptions | undefined {
    const mechanism = String(config?.saslMechanism ?? '').trim();
    if (!mechanism) return undefined;
    return {
      mechanism: mechanism as 'plain' | 'scram-sha-256' | 'scram-sha-512',
      username: String(config?.saslUsername ?? ''),
      password: String(config?.saslPassword ?? ''),
    } as SASLOptions;
  }

  private startReaper(): void {
    if (KafkaAdapter.reaper) return;
    KafkaAdapter.reaper = setInterval(() => {
      const cutoff = Date.now() - KafkaAdapter.IDLE_MS;
      for (const [key, pooled] of KafkaAdapter.pool.entries()) {
        if (pooled.lastUsed < cutoff && !pooled.connecting) {
          KafkaAdapter.pool.delete(key);
          void pooled.producer.disconnect().catch(() => undefined);
        }
      }
    }, 60_000);
    // Do not hold the process open just to reap idle producers.
    KafkaAdapter.reaper.unref?.();
  }

  private async getProducer(config: any): Promise<Producer> {
    this.startReaper();
    const key = this.poolKey(config);
    const existing = KafkaAdapter.pool.get(key);

    if (existing) {
      // Two messages racing on a cold producer must not both call connect().
      if (existing.connecting) await existing.connecting;
      existing.lastUsed = Date.now();
      return existing.producer;
    }

    const kafka = new Kafka({
      clientId: String(config?.clientId || 'smartlife-integration'),
      brokers: this.parseBrokers(config),
      ssl: Boolean(config?.ssl),
      sasl: this.buildSasl(config),
      // One retry; the dispatcher already records and surfaces the failure, and
      // a long internal retry would hold the telemetry path open.
      retry: { retries: 1, initialRetryTime: 200 },
      connectionTimeout: 5000,
      logLevel: logLevel.ERROR,
    });

    const producer = kafka.producer({ allowAutoTopicCreation: false });
    const entry: PooledProducer = {
      producer,
      connecting: null,
      lastUsed: Date.now(),
    };
    entry.connecting = producer
      .connect()
      .finally(() => {
        entry.connecting = null;
      });

    KafkaAdapter.pool.set(key, entry);

    try {
      await entry.connecting;
    } catch (error) {
      // A failed connect must not leave a poisoned entry that every later
      // message then awaits.
      KafkaAdapter.pool.delete(key);
      throw error;
    }

    return producer;
  }

  private resolveTopic(config: any, payload: any): string {
    return String(config?.topic ?? '')
      .replace(/\{\{\s*deviceId\s*\}\}/g, payload?.deviceId ?? 'unknown')
      .replace(/\{\{\s*deviceKey\s*\}\}/g, payload?.deviceKey ?? 'unknown')
      .replace(/\{\{\s*tenantId\s*\}\}/g, payload?.tenantId ?? 'unknown');
  }

  private validate(config: any): string | null {
    if (this.parseBrokers(config).length === 0)
      return 'Kafka integration needs at least one bootstrap server';
    if (!config?.topic) return 'Kafka integration needs a topic';
    return null;
  }

  async dispatch(config: any, payload: any): Promise<DispatchResult> {
    const invalid = this.validate(config);
    if (invalid) return { success: false, error: invalid };

    try {
      const producer = await this.getProducer(config);
      await producer.send({
        topic: this.resolveTopic(config, payload),
        messages: [
          {
            // Keying by device is what keeps one device's readings on one
            // partition, and therefore in order.
            key: payload?.deviceId ? String(payload.deviceId) : undefined,
            value: JSON.stringify(payload),
            headers: {
              source: 'smartlife',
              ...(payload?.tenantId ? { tenantId: String(payload.tenantId) } : {}),
            },
          },
        ],
      });
      return { success: true };
    } catch (error: any) {
      this.logger.warn(`Kafka dispatch failed: ${error.message}`);
      // Drop the pooled producer so the next message rebuilds the connection
      // rather than reusing one that is in an unknown state.
      KafkaAdapter.pool.delete(this.poolKey(config));
      return { success: false, error: error.message };
    }
  }

  /**
   * Probes with an admin metadata call — connects to the cluster and confirms
   * the topic exists, without producing anything. The only adapter here that
   * can test fully without a side effect.
   */
  async testConnection(config: any): Promise<ConnectionResult> {
    const invalid = this.validate(config);
    if (invalid) return { connected: false, message: invalid };

    const kafka = new Kafka({
      clientId: String(config?.clientId || 'smartlife-integration-test'),
      brokers: this.parseBrokers(config),
      ssl: Boolean(config?.ssl),
      sasl: this.buildSasl(config),
      retry: { retries: 0 },
      connectionTimeout: 5000,
      logLevel: logLevel.NOTHING,
    });

    const admin = kafka.admin();
    try {
      await admin.connect();
      const topics = await admin.listTopics();
      const topic = this.resolveTopic(config, {});
      // A templated topic has no single name to look for, so existence is only
      // asserted for a literal one.
      const templated = String(config?.topic ?? '').includes('{{');

      if (!templated && !topics.includes(topic)) {
        return {
          connected: false,
          message: `Connected to the cluster, but the topic "${topic}" does not exist. Auto-creation is disabled.`,
          topicCount: topics.length,
        };
      }

      return {
        connected: true,
        message: `Connected — ${topics.length} topic(s) visible.`,
        topicCount: topics.length,
      };
    } catch (error: any) {
      return { connected: false, message: `Connection failed: ${error.message}` };
    } finally {
      await admin.disconnect().catch(() => undefined);
    }
  }
}
