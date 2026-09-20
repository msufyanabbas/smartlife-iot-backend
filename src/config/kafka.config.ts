// src/config/kafka.config.ts
//
// Kafka had no config file at all — KafkaService read `process.env.KAFKA_BROKERS`
// inline and hardcoded the client id, timeouts and retry policy. Two consequences
// worth naming:
//
//   * `brokers: [process.env.KAFKA_BROKERS]` wrapped the whole string in a single
//     array element, so a multi-broker value like "a:9092,b:9092" was passed to
//     kafkajs as one hostname and the cluster was never reachable. It is split
//     properly here.
//   * Every instance of the service announced the same client id. In a
//     multi-replica deployment that makes broker-side metrics and consumer
//     diagnostics impossible to attribute to a replica.

import { registerAs } from '@nestjs/config';
import { envList, envNumber, envString } from './env.utils';

export interface KafkaConfig {
  clientId: string;
  brokers: string[];
  ssl: boolean;
  sasl?: { mechanism: 'plain'; username: string; password: string };
  connectionTimeout: number;
  requestTimeout: number;
  initialRetryTime: number;
  retries: number;
  consumerGroupId: string;
  sessionTimeout: number;
  heartbeatInterval: number;
  topicPartitions: number;
  topicReplicationFactor: number;
}

export default registerAs('kafka', (): KafkaConfig => {
  const username = envString(process.env.KAFKA_SASL_USERNAME);
  const password = envString(process.env.KAFKA_SASL_PASSWORD);

  return {
    clientId: envString(process.env.KAFKA_CLIENT_ID, 'smartlife-iot-platform')!,
    brokers: envList(process.env.KAFKA_BROKERS, ['localhost:9093']),

    ssl: envString(process.env.KAFKA_SSL)?.toLowerCase() === 'true',
    // SASL is only configured when both halves are present — a half-set
    // credential should not be sent to the broker as an empty string.
    sasl:
      username && password
        ? { mechanism: 'plain', username, password }
        : undefined,

    connectionTimeout: envNumber(process.env.KAFKA_CONNECTION_TIMEOUT, 10000),
    requestTimeout: envNumber(process.env.KAFKA_REQUEST_TIMEOUT, 30000),
    initialRetryTime: envNumber(process.env.KAFKA_INITIAL_RETRY_TIME, 100),
    retries: envNumber(process.env.KAFKA_RETRIES, 8),

    consumerGroupId: envString(
      process.env.KAFKA_CONSUMER_GROUP_ID,
      'smartlife-iot-consumers',
    )!,
    sessionTimeout: envNumber(process.env.KAFKA_SESSION_TIMEOUT, 30000),
    heartbeatInterval: envNumber(process.env.KAFKA_HEARTBEAT_INTERVAL, 3000),

    topicPartitions: envNumber(process.env.KAFKA_TOPIC_PARTITIONS, 3),
    topicReplicationFactor: envNumber(
      process.env.KAFKA_TOPIC_REPLICATION_FACTOR,
      1,
    ),
  };
});
