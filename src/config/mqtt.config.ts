import { MqttConfig } from '@/common/interfaces/common.interface';
import { registerAs } from '@nestjs/config';
import { envBoolean, envNumber, envRequired, envString } from './env.utils';

export default registerAs(
  'mqtt',
  (): MqttConfig => ({
    // Broker Connection.
    // The broker URL has no default on purpose — MQTTService previously did
    // `mqtt.connect(process.env.MQTT_BROKER_URL!)`, and the non-null assertion
    // turned a missing variable into an opaque connect error at runtime instead
    // of a named failure at boot.
    brokerUrl: envRequired('MQTT_BROKER_URL', process.env.MQTT_BROKER_URL),
    clientId: envString(
      process.env.MQTT_CLIENT_ID,
      'smartlife-mqtt-iot-platform',
    ),
    username: envString(process.env.MQTT_USERNAME),
    password: envString(process.env.MQTT_PASSWORD),

    // Connection Options
    protocol: envString(process.env.MQTT_PROTOCOL, 'mqtt'),
    port: envNumber(process.env.MQTT_PORT, 1883),
    keepAlive: envNumber(process.env.MQTT_KEEP_ALIVE, 60),
    connectTimeout: envNumber(process.env.MQTT_CONNECT_TIMEOUT, 30000),
    reconnectPeriod: envNumber(process.env.MQTT_RECONNECT_PERIOD, 5000),

    // QoS (Quality of Service)
    // 0 = At most once, 1 = At least once, 2 = Exactly once
    qos: envNumber(process.env.MQTT_QOS, 1) as 0 | 1 | 2,

    // Topics — the wildcard patterns the platform subscribes to for uplinks.
    topics: {
      telemetry: envString(
        process.env.MQTT_TOPIC_TELEMETRY,
        'devices/+/telemetry',
      ),
      commands: envString(
        process.env.MQTT_TOPIC_COMMANDS,
        'devices/+/commands',
      ),
      status: envString(process.env.MQTT_TOPIC_STATUS, 'devices/+/status'),
      alerts: envString(process.env.MQTT_TOPIC_ALERTS, 'devices/+/alerts'),
    },

    // SSL/TLS
    ssl: envBoolean(process.env.MQTT_SSL, false),
    rejectUnauthorized: envBoolean(process.env.MQTT_REJECT_UNAUTHORIZED, true),

    // Features
    cleanSession: envBoolean(process.env.MQTT_CLEAN_SESSION, true),
    retainMessages: envBoolean(process.env.MQTT_RETAIN_MESSAGES, false),
  }),
);
