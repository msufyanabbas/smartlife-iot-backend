import { MqttConfig } from '@/common/interfaces/common.interface';
import { registerAs } from '@nestjs/config';

export default registerAs(
  'mqtt',
  (): MqttConfig => ({
    // Broker Connection
    brokerUrl: process.env.MQTT_BROKER_URL,
    clientId: process.env.MQTT_CLIENT_ID,
    username: process.env.MQTT_USERNAME,
    password: process.env.MQTT_PASSWORD,

    // Connection Options
    protocol: process.env.MQTT_PROTOCOL,
    port: parseInt(process.env.MQTT_PORT || '1883', 10),
    keepAlive: parseInt(process.env.MQTT_KEEP_ALIVE || '60', 10),
    connectTimeout: parseInt(process.env.MQTT_CONNECT_TIMEOUT || '30000', 10),
    reconnectPeriod: parseInt(process.env.MQTT_RECONNECT_PERIOD || '5000', 10),

    // QoS (Quality of Service)
    // 0 = At most once, 1 = At least once, 2 = Exactly once
    qos: parseInt(process.env.MQTT_QOS || '1', 10) as 0 | 1 | 2,

    // Topics
    topics: {
      telemetry: process.env.MQTT_TOPIC_TELEMETRY,
      commands: process.env.MQTT_TOPIC_COMMANDS,
      status: process.env.MQTT_TOPIC_STATUS,
      alerts: process.env.MQTT_TOPIC_ALERTS,
    },

    // SSL/TLS
    ssl: process.env.MQTT_SSL === 'true',
    rejectUnauthorized: process.env.MQTT_REJECT_UNAUTHORIZED !== 'false',

    // Features
    cleanSession: process.env.MQTT_CLEAN_SESSION !== 'false',
    retainMessages: process.env.MQTT_RETAIN_MESSAGES === 'true',
  }),
);
