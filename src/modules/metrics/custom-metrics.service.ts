// src/metrics/custom-metrics.service.ts
import { Injectable } from '@nestjs/common';
import { Counter, Histogram, Gauge } from 'prom-client';
import { InjectMetric } from '@willsoto/nestjs-prometheus';

@Injectable()
export class CustomMetricsService {
  constructor(
    @InjectMetric('smartlife_http_requests_total')
    public httpRequestsTotal: Counter<string>,
    
    @InjectMetric('smartlife_http_request_duration_seconds')
    public httpRequestDuration: Histogram<string>,
    
    @InjectMetric('smartlife_device_connections')
    public deviceConnections: Gauge<string>,
    
    @InjectMetric('smartlife_mqtt_messages_total')
    public mqttMessagesTotal: Counter<string>,
    
    @InjectMetric('smartlife_kafka_messages_total')
    public kafkaMessagesTotal: Counter<string>,
    
    @InjectMetric('smartlife_telemetry_processing_duration')
    public telemetryProcessingDuration: Histogram<string>,
  ) {}

  // Track HTTP requests
  trackHttpRequest(method: string, path: string, statusCode: number, duration: number) {
    this.httpRequestsTotal.inc({
      method,
      path,
      status: statusCode.toString(),
    });

    this.httpRequestDuration.observe(
      {
        method,
        path,
      },
      duration,
    );
  }

  // Track device connections
  setDeviceConnections(tenantId: string, count: number) {
    this.deviceConnections.set({ tenant_id: tenantId }, count);
  }

  // Track MQTT messages
  trackMqttMessage(topic: string, direction: 'inbound' | 'outbound') {
    this.mqttMessagesTotal.inc({
      topic,
      direction,
    });
  }

  // Track Kafka messages
  trackKafkaMessage(topic: string, action: 'produced' | 'consumed') {
    this.kafkaMessagesTotal.inc({
      topic,
      action,
    });
  }

  // Track telemetry processing
  trackTelemetryProcessing(deviceType: string, duration: number) {
    this.telemetryProcessingDuration.observe(
      {
        device_type: deviceType,
      },
      duration,
    );
  }
}