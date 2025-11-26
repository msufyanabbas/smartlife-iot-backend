// src/modules/devices/dto/device-credentials.dto.ts
// UPDATED - Supports multiple device types and gateway configurations

import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class DeviceCredentialsDto {
  @ApiProperty({
    example: 'dev_abc123xyz',
    description: 'Unique device identifier (Client ID for MQTT)',
  })
  deviceKey: string;

  @ApiProperty({
    example: 'device_access_token',
    description: 'Device access token (use as MQTT username)',
  })
  accessToken: string | undefined;

  @ApiProperty({
    example: 'secret_key_example',
    description: 'Device secret key (use as MQTT password)',
  })
  secretKey: string | undefined;

  @ApiProperty({
    example: 'mqtt://broker.example.com:1883',
    description: 'MQTT broker URL',
  })
  mqttBroker: string;

  @ApiProperty({
    example: 'broker.example.com',
    description: 'MQTT broker host (without protocol)',
  })
  mqttHost: string;

  @ApiProperty({
    example: 1883,
    description: 'MQTT broker port',
  })
  mqttPort: number;

  // ============================================
  // UPLINK TOPICS (Device → Platform)
  // ============================================

  @ApiProperty({
    example: 'devices/dev_abc123xyz/telemetry',
    description: 'Topic where device publishes telemetry data',
  })
  telemetryTopic: string;

  @ApiProperty({
    example: 'devices/dev_abc123xyz/attributes',
    description: 'Topic where device publishes attributes/configuration',
  })
  attributesTopic: string;

  @ApiProperty({
    example: 'devices/dev_abc123xyz/status',
    description: 'Topic where device publishes status updates',
  })
  statusTopic: string;

  @ApiProperty({
    example: 'devices/dev_abc123xyz/alerts',
    description: 'Topic where device publishes alerts/alarms',
  })
  alertsTopic: string;

  // ============================================
  // DOWNLINK TOPICS (Platform → Device)
  // ============================================

  @ApiProperty({
    example: 'devices/dev_abc123xyz/commands',
    description: 'Topic where platform publishes commands to device (DOWNLINK)',
  })
  commandsTopic: string;

  // ============================================
  // TOPIC PATTERNS FOR SUBSCRIPTION
  // ============================================

  @ApiPropertyOptional({
    example: ['devices/dev_abc123xyz/telemetry', 'devices/dev_abc123xyz/+'],
    description: 'Topic patterns that the platform listens to for this device',
  })
  uplinkPatterns?: string[];

  // ============================================
  // GATEWAY CONFIGURATION (Generic MQTT)
  // ============================================

  @ApiPropertyOptional({
    description: 'Complete MQTT configuration for generic MQTT devices',
    example: {
      clientId: 'dev_abc123xyz',
      username: 'token_here',
      password: 'secret_key_test_key',
      host: 'broker.example.com',
      port: 1883,
      publishTopic: 'devices/dev_abc123xyz/telemetry',
      qos: 1,
    },
  })
  gatewayConfig?: {
    clientId: string;
    username: string;
    password: string;
    host: string;
    port: number;
    publishTopic: string;
    subscribeTopic?: string; // Optional: for bidirectional devices
    qos: number;
    devEUI?: string; // For LoRaWAN devices
    downlinkTopic?: string; // For devices that receive commands
  };

  // ============================================
  // DEVICE-SPECIFIC CONFIGURATIONS
  // ============================================

  @ApiPropertyOptional({
    description: 'Configuration specific to Milesight UG65 Gateway',
    example: {
      type: 'milesight-ug65',
      networkServerId: 'smartlife-iot',
      devEUI: '24e124538d063257',
      uplinkTopic: 'application/1/device/24e124538d063257/rx',
      downlinkTopic: 'application/1/device/24e124538d063257/tx',
      host: 'broker.example.com',
      port: 1883,
      username: 'token_here',
      password: 'secret_key_test_key',
      fPort: 85,
      confirmed: false,
    },
  })
  milesightConfig?: {
    type: 'milesight-ug65';
    networkServerId: string;
    devEUI: string;
    uplinkTopic: string; // application/1/device/{devEUI}/rx
    downlinkTopic: string; // application/1/device/{devEUI}/tx
    host: string;
    port: number;
    username: string;
    password: string;
    fPort: number;
    confirmed: boolean;
  };

  @ApiPropertyOptional({
    description: 'Configuration for ChirpStack LoRaWAN devices',
    example: {
      type: 'chirpstack',
      applicationId: 'smartlife-app',
      devEUI: '24e124538d063257',
      uplinkTopic: 'application/smartlife-app/device/24e124538d063257/event/up',
      downlinkTopic:
        'application/smartlife-app/device/24e124538d063257/command/down',
      host: 'broker.example.com',
      port: 1883,
      username: 'token_here',
      password: 'secret_key_test_key',
    },
  })
  chirpstackConfig?: {
    type: 'chirpstack';
    applicationId: string;
    devEUI: string;
    uplinkTopic: string;
    downlinkTopic: string;
    host: string;
    port: number;
    username: string;
    password: string;
  };

  @ApiPropertyOptional({
    description: 'Configuration for ThingsBoard-style devices',
    example: {
      type: 'thingsboard',
      accessToken: 'device_access_token',
      telemetryTopic: 'v1/devices/me/telemetry',
      attributesTopic: 'v1/devices/me/attributes',
      rpcRequestTopic: 'v1/devices/me/rpc/request/+',
      rpcResponseTopic: 'v1/devices/me/rpc/response',
      host: 'broker.example.com',
      port: 1883,
    },
  })
  thingsboardConfig?: {
    type: 'thingsboard';
    accessToken: string;
    telemetryTopic: string;
    attributesTopic: string;
    rpcRequestTopic: string;
    rpcResponseTopic: string;
    host: string;
    port: number;
  };

  // ============================================
  // DEVICE INSTRUCTIONS
  // ============================================

  @ApiPropertyOptional({
    description: 'Human-readable instructions for configuring the device',
    example: {
      steps: [
        '1. Connect to device via serial/USB',
        '2. Configure MQTT broker: broker.example.com:1883',
        '3. Set username: token_here',
        '4. Set password: secret_key_test_key',
        '5. Set publish topic: devices/dev_abc123xyz/telemetry',
        '6. Save and reboot device',
      ],
      video: 'https://docs.example.com/setup-guide',
      documentation: 'https://docs.example.com/device-config',
    },
  })
  setupInstructions?: {
    steps: string[];
    video?: string;
    documentation?: string;
    notes?: string[];
  };

  // ============================================
  // CONNECTION EXAMPLES
  // ============================================

  @ApiPropertyOptional({
    description: 'Code examples for connecting the device',
    example: {
      arduino:
        'WiFiClient client;\nPubSubClient mqtt(client);\nmqtt.connect("dev_abc123xyz", "token", "secret_key_key");',
      python:
        'import paho.mqtt.client as mqtt\nclient = mqtt.Client("dev_abc123xyz")\nclient.username_pw_set("token", "secret_key_key")',
      nodejs:
        'const mqtt = require("mqtt");\nconst client = mqtt.connect("mqtt://broker:1883", {clientId: "dev_abc123xyz", username: "token", password: "secret_key_key"});',
    },
  })
  codeExamples?: {
    arduino?: string;
    python?: string;
    nodejs?: string;
    curl?: string;
  };
}
