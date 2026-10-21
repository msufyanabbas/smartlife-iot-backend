// src/health/indicators/kafka.health.ts
//
// ── What this used to do, and why it was replaced ───────────────────────────
//
// It constructed its OWN `Kafka` client from a raw `KAFKA_BROKERS` read —
// bypassing the `kafka` config namespace, so SSL, SASL and the timeouts were
// all absent and a secured cluster reported "down" from a probe that could
// never have connected. Then, on every single request, it did a full
// `admin.connect()` → `describeCluster()` → `disconnect()`. A load balancer
// polling `/health/full` every 5s meant a TCP connect, a metadata fetch and a
// teardown every 5s, per replica, forever — and a slow broker turned the
// health endpoint itself into the slowest route on the platform.
//
// `KafkaService` already tracks the real producer/consumer lifecycle, so the
// liveness half of this is free. Consumer lag is the part that genuinely needs
// the broker, and `KafkaService.getConsumerLag()` caches it
// (KAFKA_LAG_CACHE_SECONDS) so polling cannot amplify into load.

import { Injectable } from '@nestjs/common';
import {
  HealthIndicator,
  HealthIndicatorResult,
  HealthCheckError,
} from '@nestjs/terminus';
import { KafkaService } from '@/lib/kafka/kafka.service';

/**
 * Total lag across a group above which the probe fails.
 *
 * A non-zero lag is normal and healthy — it is the depth of the queue at the
 * instant it was read. What is not healthy is a lag that keeps growing because
 * a consumer group has stopped making progress, and this threshold is where
 * "busy" is called "behind".
 */
const LAG_UNHEALTHY_THRESHOLD = Number(
  process.env.KAFKA_LAG_UNHEALTHY_THRESHOLD ?? 10000,
);

@Injectable()
export class KafkaHealthIndicator extends HealthIndicator {
  constructor(private readonly kafkaService: KafkaService) {
    super();
  }

  async isHealthy(key: string): Promise<HealthIndicatorResult> {
    const status = this.kafkaService.getStatus();

    // A deliberately disabled Kafka is a correct configuration, not a fault.
    // Failing the probe here would make KAFKA_ENABLED=false unusable with any
    // orchestrator that restarts on a failed readiness check — which would
    // defeat the point of having the flag.
    if (!status.enabled) {
      return this.getStatus(key, true, {
        enabled: false,
        note: 'KAFKA_ENABLED=false — no broker expected in this environment',
      });
    }

    if (!status.producerConnected) {
      throw new HealthCheckError('Kafka check failed', {
        [key]: {
          status: 'down',
          brokers: status.brokers,
          bootstrapAttempts: status.bootstrapAttempts,
          error: status.lastError ?? 'producer not connected',
          note:
            'The application is up and serving; Kafka-backed ingestion is ' +
            'not. Reconnect is retried in the background.',
        },
      });
    }

    const notRunning = status.consumers.filter((c) => !c.running);

    // Lag is best-effort: it needs the broker, and a probe that fails because
    // the *diagnostic* failed would report a healthy pipeline as down.
    let lag: Record<string, number> = {};
    let lagError: string | undefined;
    try {
      lag = await this.kafkaService.getConsumerLagSummary();
    } catch (error) {
      lagError = (error as Error).message;
    }

    const behind = Object.entries(lag).filter(
      ([, total]) => total > LAG_UNHEALTHY_THRESHOLD,
    );

    const detail = {
      brokers: status.brokers,
      topicsDeclared: status.topicsDeclared,
      // Non-zero means frames were decoded and then thrown away because the
      // broker was unreachable at that moment. It never resets, so it is a
      // record of what the platform lost, not a current-state gauge.
      refusedProduces: status.refusedProduces,
      refusedProducesByTopic: status.refusedProducesByTopic,
      consumers: status.consumers.map((c) => ({
        groupId: c.groupId,
        running: c.running,
        lag: lag[c.groupId] ?? null,
        lastError: c.lastError,
      })),
      ...(lagError ? { lagError } : {}),
    };

    if (notRunning.length > 0 || behind.length > 0) {
      throw new HealthCheckError('Kafka check failed', {
        [key]: {
          status: 'down',
          reason:
            notRunning.length > 0
              ? `consumer group(s) not running: ${notRunning
                  .map((c) => c.groupId)
                  .join(', ')}`
              : `consumer group(s) behind by more than ` +
                `${LAG_UNHEALTHY_THRESHOLD}: ${behind
                  .map(([g, t]) => `${g}=${t}`)
                  .join(', ')}`,
          ...detail,
        },
      });
    }

    return this.getStatus(key, true, detail);
  }
}
