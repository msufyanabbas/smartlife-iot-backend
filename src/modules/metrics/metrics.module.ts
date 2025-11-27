import { Module } from '@nestjs/common';
import { PrometheusModule, makeCounterProvider, makeHistogramProvider, makeGaugeProvider } from '@willsoto/nestjs-prometheus';
import { CustomMetricsService } from './custom-metrics.service';
import { MetricsController } from './metrics.controller';

@Module({
  imports: [
    PrometheusModule.register({
      path: '/metrics',
      defaultMetrics: {
        enabled: true,
        config: {
          prefix: 'smartlife_',
        },
      },
    }),
  ],
  controllers: [MetricsController],
  providers: [
    CustomMetricsService,
    
    // HTTP Requests Counter
    makeCounterProvider({
      name: 'smartlife_http_requests_total',
      help: 'Total number of HTTP requests',
      labelNames: ['method', 'path', 'status'],
    }),
    
    // HTTP Request Duration Histogram
    makeHistogramProvider({
      name: 'smartlife_http_request_duration_seconds',
      help: 'HTTP request duration in seconds',
      labelNames: ['method', 'path'],
      buckets: [0.1, 0.5, 1, 2, 5, 10],
    }),
    
    // Device Connections Gauge
    makeGaugeProvider({
      name: 'smartlife_device_connections',
      help: 'Number of connected devices',
      labelNames: ['tenant_id'],
    }),
    
    // MQTT Messages Counter
    makeCounterProvider({
      name: 'smartlife_mqtt_messages_total',
      help: 'Total number of MQTT messages',
      labelNames: ['topic', 'direction'],
    }),
    
    // Kafka Messages Counter
    makeCounterProvider({
      name: 'smartlife_kafka_messages_total',
      help: 'Total number of Kafka messages',
      labelNames: ['topic', 'action'],
    }),
    
    // Telemetry Processing Duration
    makeHistogramProvider({
      name: 'smartlife_telemetry_processing_duration',
      help: 'Telemetry processing duration in seconds',
      labelNames: ['device_type'],
      buckets: [0.01, 0.05, 0.1, 0.5, 1, 2],
    }),
    
    // Database Connections Gauge
    makeGaugeProvider({
      name: 'smartlife_database_connections',
      help: 'Number of active database connections',
    }),
    
    // Database Queries Counter
    makeCounterProvider({
      name: 'smartlife_database_queries_total',
      help: 'Total number of database queries',
      labelNames: ['operation', 'table'],
    }),
    
    // Auth Attempts Counter
    makeCounterProvider({
      name: 'smartlife_auth_attempts_total',
      help: 'Total authentication attempts',
      labelNames: ['method', 'status'],
    }),
    
    // Errors Counter
    makeCounterProvider({
      name: 'smartlife_errors_total',
      help: 'Total number of errors',
      labelNames: ['type', 'severity'],
    }),
  ],
  exports: [CustomMetricsService],
})
export class MetricsModule {}