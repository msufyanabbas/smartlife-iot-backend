// src/metrics/metrics.provider.ts
import { makeCounterProvider, makeHistogramProvider, makeGaugeProvider } from '@willsoto/nestjs-prometheus';

export const metricsProviders = [
  // HTTP Metrics
  makeCounterProvider({
    name: 'smartlife_http_requests_total',
    help: 'Total number of HTTP requests',
    labelNames: ['method', 'path', 'status'],
  }),
  makeHistogramProvider({
    name: 'smartlife_http_request_duration_seconds',
    help: 'HTTP request duration in seconds',
    labelNames: ['method', 'path'],
    buckets: [0.1, 0.5, 1, 2, 5, 10],
  }),

  // Device Metrics
  makeGaugeProvider({
    name: 'smartlife_device_connections',
    help: 'Number of connected devices',
    labelNames: ['tenant_id'],
  }),

  // MQTT Metrics
  makeCounterProvider({
    name: 'smartlife_mqtt_messages_total',
    help: 'Total number of MQTT messages',
    labelNames: ['topic', 'direction'],
  }),

  // Kafka Metrics
  makeCounterProvider({
    name: 'smartlife_kafka_messages_total',
    help: 'Total number of Kafka messages',
    labelNames: ['topic', 'action'],
  }),

  // Telemetry Metrics
  makeHistogramProvider({
    name: 'smartlife_telemetry_processing_duration',
    help: 'Telemetry processing duration in seconds',
    labelNames: ['device_type'],
    buckets: [0.01, 0.05, 0.1, 0.5, 1, 2, 5],
  }),

  // Database Metrics
  makeGaugeProvider({
    name: 'smartlife_database_connections',
    help: 'Number of active database connections',
  }),
  makeCounterProvider({
    name: 'smartlife_database_queries_total',
    help: 'Total number of database queries',
    labelNames: ['operation'],
  }),

  // Authentication Metrics
  makeCounterProvider({
    name: 'smartlife_auth_attempts_total',
    help: 'Total authentication attempts',
    labelNames: ['method', 'status'],
  }),

  // Error Metrics
  makeCounterProvider({
    name: 'smartlife_errors_total',
    help: 'Total number of errors',
    labelNames: ['type', 'severity'],
  }),
];