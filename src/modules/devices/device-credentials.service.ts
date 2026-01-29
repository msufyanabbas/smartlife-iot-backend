// src/modules/devices/device-credentials.service.ts
// Service to manage device credentials and MQTT configurations

import {
  Injectable,
  NotFoundException,
  ConflictException,
  ForbiddenException,
  Logger,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { ConfigService } from '@nestjs/config';
import { Device } from './entities/device.entity';
import { DeviceCredentials, CredentialsType } from './entities/device-credentials.entity';
import { DeviceCredentialsDto } from './dto/device-credentials.dto';
import { generateToken, generateRandomString } from '@/common/utils/helpers';
import { User } from '../users/entities/user.entity';
import { UserRole } from '@common/enums/index.enum';

@Injectable()
export class DeviceCredentialsService {
  private readonly logger = new Logger(DeviceCredentialsService.name);

  constructor(
    @InjectRepository(Device)
    private deviceRepository: Repository<Device>,
    @InjectRepository(DeviceCredentials)
    private credentialsRepository: Repository<DeviceCredentials>,
    private configService: ConfigService,
  ) {}

  /**
   * Create credentials for a new device
   * Called automatically when a device is created
   */
  async createCredentials(
    device: Device,
    credentialsType: CredentialsType = CredentialsType.ACCESS_TOKEN,
  ): Promise<DeviceCredentials> {
    this.logger.log(`Creating credentials for device: ${device.deviceKey}`);

    // Generate credentials based on type
    let credentialsId: string;
    let credentialsValue: string | undefined;

    switch (credentialsType) {
      case CredentialsType.ACCESS_TOKEN:
        // Generate a secure access token
        credentialsId = `${device.deviceKey}_${generateToken(32)}`;
        credentialsValue = undefined; // Token is in credentialsId
        break;

      case CredentialsType.MQTT_BASIC:
        // Generate username and password
        credentialsId = device.deviceKey; // Username
        credentialsValue = generateToken(32); // Password
        break;

      case CredentialsType.X509_CERTIFICATE:
        // For certificate-based auth (advanced)
        credentialsId = device.deviceKey;
        credentialsValue = this.generateCertificateFingerprint();
        break;

      default:
        throw new Error(`Unsupported credentials type: ${credentialsType}`);
    }

    // Check if credentials already exist
    const existingCreds = await this.credentialsRepository.findOne({
      where: { credentialsId },
    });

    if (existingCreds) {
      throw new ConflictException('Credentials already exist for this device');
    }

    // Create credentials
    const credentials = this.credentialsRepository.create({
      deviceId: device.id,
      credentialsType,
      credentialsId,
      credentialsValue,
    });

    const saved = await this.credentialsRepository.save(credentials);
    this.logger.log(`✅ Credentials created: ${saved.id}`);

    return saved;
  }

  /**
   * Get credentials by device ID
   */
  async getByDeviceId(deviceId: string): Promise<DeviceCredentials> {
    const credentials = await this.credentialsRepository.findOne({
      where: { deviceId },
      relations: ['device'],
    });

    if (!credentials) {
      throw new NotFoundException(
        `Credentials not found for device: ${deviceId}`,
      );
    }

    return credentials;
  }

  /**
   * Get complete MQTT configuration for a device
   * This is what the user/gateway will use to connect
   */
  async getMqttConfiguration(
    deviceId: string,
    user: User,
  ): Promise<DeviceCredentialsDto> {
    // Get device
    const device = await this.deviceRepository.findOne({
      where: { id: deviceId },
    });

    if (!device) {
      throw new NotFoundException(`Device not found: ${deviceId}`);
    }

    // Verify access
    this.verifyAccess(device, user);

    // Get credentials
    const credentials = await this.getByDeviceId(deviceId);

    // Build MQTT configuration
    return this.buildMqttConfiguration(device, credentials);
  }

  /**
   * Build complete MQTT configuration
   */
  private buildMqttConfiguration(
    device: Device,
    credentials: DeviceCredentials,
  ): DeviceCredentialsDto {
    const mqttBrokerUrl =
      this.configService.get('MQTT_BROKER_URL') || 'mqtt://localhost:1883';
    const brokerUrlObj = new URL(mqttBrokerUrl);
    const mqttHost = brokerUrlObj.hostname;
    const mqttPort = parseInt(brokerUrlObj.port) || 1883;

    // Get topic strategy based on device type
    const topicStrategy = this.getDeviceTopicStrategy(device);

    // Build configuration based on credentials type
    const config: DeviceCredentialsDto = {
      deviceKey: device.deviceKey,
      accessToken:
        credentials.credentialsType === CredentialsType.ACCESS_TOKEN
          ? credentials.credentialsId
          : undefined,
      secretKey:
        credentials.credentialsType === CredentialsType.MQTT_BASIC
          ? credentials.credentialsValue
          : undefined,
      mqttBroker: mqttBrokerUrl,
      mqttHost,
      mqttPort,

      // Uplink topics (device publishes here)
      telemetryTopic: topicStrategy.telemetryTopic,
      attributesTopic: topicStrategy.attributesTopic,
      statusTopic: topicStrategy.statusTopic,
      alertsTopic: topicStrategy.alertsTopic,

      // Downlink topic (platform publishes commands here)
      commandsTopic: topicStrategy.commandsTopic,

      // Topic patterns for subscription
      uplinkPatterns: topicStrategy.uplinkPattern,

      // Gateway configuration
      gatewayConfig: this.buildGatewayConfig(
        device,
        credentials,
        mqttHost,
        mqttPort,
        topicStrategy,
      ),

      // Setup instructions
      setupInstructions: this.generateSetupInstructions(
        device,
        credentials,
        mqttHost,
        mqttPort,
        topicStrategy,
      ),

      // Code examples
      codeExamples: this.generateCodeExamples(
        device,
        credentials,
        mqttBrokerUrl,
        topicStrategy.telemetryTopic,
      ),
    };

    return config;
  }

  /**
   * Get topic strategy based on device type
   */
  private getDeviceTopicStrategy(device: Device): {
    telemetryTopic: string;
    attributesTopic: string;
    statusTopic: string;
    alertsTopic: string;
    commandsTopic: string;
    uplinkPattern: string[];
  } {
    const deviceType = device.metadata?.deviceType || 'generic';
    const gatewayType = device.metadata?.gatewayType;
    const devEUI = device.metadata?.devEUI;

    // Milesight UG65 Gateway
    if (gatewayType === 'milesight' || deviceType === 'lorawan-milesight') {
      if (!devEUI) {
        throw new Error('devEUI required for Milesight LoRaWAN devices');
      }

      return {
        telemetryTopic: `application/1/device/${devEUI}/rx`,
        attributesTopic: `application/1/device/${devEUI}/event/up`,
        statusTopic: `application/1/device/${devEUI}/event/status`,
        alertsTopic: `application/1/device/${devEUI}/event/error`,
        commandsTopic: `application/1/device/${devEUI}/tx`,
        uplinkPattern: [
          `application/1/device/${devEUI}/rx`,
          `application/1/device/${devEUI}/event/+`,
        ],
      };
    }

    // ChirpStack
    if (gatewayType === 'chirpstack' || deviceType === 'lorawan-chirpstack') {
      if (!devEUI) {
        throw new Error('devEUI required for ChirpStack LoRaWAN devices');
      }

      return {
        telemetryTopic: `application/+/device/${devEUI}/event/up`,
        attributesTopic: `application/+/device/${devEUI}/event/join`,
        statusTopic: `application/+/device/${devEUI}/event/status`,
        alertsTopic: `application/+/device/${devEUI}/event/error`,
        commandsTopic: `application/+/device/${devEUI}/command/down`,
        uplinkPattern: [
          `application/+/device/${devEUI}/event/up`,
          `application/+/device/${devEUI}/event/+`,
        ],
      };
    }

    // ThingsBoard style
    if (deviceType === 'thingsboard' || deviceType === 'mqtt-thingsboard') {
      return {
        telemetryTopic: 'v1/devices/me/telemetry',
        attributesTopic: 'v1/devices/me/attributes',
        statusTopic: 'v1/devices/me/attributes',
        alertsTopic: 'v1/devices/me/telemetry',
        commandsTopic: 'v1/devices/me/rpc/request/+',
        uplinkPattern: ['v1/devices/me/telemetry', 'v1/devices/me/attributes'],
      };
    }

    // Generic MQTT Device (Default)
    return {
      telemetryTopic: `devices/${device.deviceKey}/telemetry`,
      attributesTopic: `devices/${device.deviceKey}/attributes`,
      statusTopic: `devices/${device.deviceKey}/status`,
      alertsTopic: `devices/${device.deviceKey}/alerts`,
      commandsTopic: `devices/${device.deviceKey}/commands`,
      uplinkPattern: [
        `devices/${device.deviceKey}/telemetry`,
        `devices/${device.deviceKey}/+`,
      ],
    };
  }

  /**
   * Build gateway-specific configuration
   */
  private buildGatewayConfig(
    device: Device,
    credentials: DeviceCredentials,
    mqttHost: string,
    mqttPort: number,
    topicStrategy: any,
  ): DeviceCredentialsDto['gatewayConfig'] {
    const config: any = {
      clientId: device.deviceKey,
      host: mqttHost,
      port: mqttPort,
      publishTopic: topicStrategy.telemetryTopic,
      qos: 1,
    };

    // Add credentials based on type
    if (credentials.credentialsType === CredentialsType.ACCESS_TOKEN) {
      config.username = credentials.credentialsId;
      config.password = ''; // Token-based auth doesn't need password
    } else if (credentials.credentialsType === CredentialsType.MQTT_BASIC) {
      config.username = credentials.credentialsId;
      config.password = credentials.credentialsValue;
    }

    // Add LoRaWAN specific config
    if (device.metadata?.devEUI) {
      config.devEUI = device.metadata.devEUI;
      config.downlinkTopic = topicStrategy.commandsTopic;
    }

    // Add gateway type specific config
    if (device.metadata?.gatewayType === 'milesight') {
      return {
        ...config,
        type: 'milesight-ug65',
        networkServerId: 'smartlife-iot',
        fPort: 85,
        confirmed: false,
      };
    }

    if (device.metadata?.gatewayType === 'chirpstack') {
      return {
        ...config,
        type: 'chirpstack',
        applicationId: 'smartlife-app',
      };
    }

    return config;
  }

  /**
   * Generate setup instructions
   */
  private generateSetupInstructions(
    device: Device,
    credentials: DeviceCredentials,
    mqttHost: string,
    mqttPort: number,
    topicStrategy: any,
  ): DeviceCredentialsDto['setupInstructions'] {
    const steps: string[] = [];

    if (device.metadata?.gatewayType === 'milesight') {
      steps.push(
        '1. Access your Milesight UG65 gateway web interface',
        '2. Navigate to Network Server → MQTT Integration',
        `3. Set MQTT Broker: ${mqttHost}:${mqttPort}`,
        `4. Set Username: ${credentials.credentialsId}`,
        `5. Set Password: ${credentials.credentialsValue || '(use token)'}`,
        '6. Enable MQTT Integration',
        '7. Device will automatically start publishing to configured topics',
      );
    } else {
      steps.push(
        '1. Connect to device via serial/USB or network',
        `2. Configure MQTT broker: ${mqttHost}:${mqttPort}`,
        `3. Set client ID: ${device.deviceKey}`,
        `4. Set username: ${credentials.credentialsId}`,
        `5. Set password: ${credentials.credentialsValue || '(use token)'}`,
        `6. Set publish topic: ${topicStrategy.telemetryTopic}`,
        '7. Save configuration and reboot device',
      );
    }

    return {
      steps,
      documentation: 'https://docs.smartlife.sa/device-setup',
      notes: [
        'Keep credentials secure - do not share publicly',
        'Device must be activated before it can publish data',
        'Verify network connectivity before testing',
      ],
    };
  }

  /**
   * Generate code examples
   */
  private generateCodeExamples(
    device: Device,
    credentials: DeviceCredentials,
    mqttBroker: string,
    telemetryTopic: string,
  ): DeviceCredentialsDto['codeExamples'] {
    const username = credentials.credentialsId;
    const password = credentials.credentialsValue || '';

    return {
      arduino: `
#include <WiFi.h>
#include <PubSubClient.h>

WiFiClient espClient;
PubSubClient client(espClient);

void setup() {
  client.setServer("${mqttBroker.replace('mqtt://', '')}", 1883);
  client.connect("${device.deviceKey}", "${username}", "${password}");
}

void loop() {
  if (client.connected()) {
    String payload = "{\\"temperature\\":25.5,\\"humidity\\":60}";
    client.publish("${telemetryTopic}", payload.c_str());
  }
  delay(60000); // Send every minute
}
`.trim(),

      python: `
import paho.mqtt.client as mqtt
import json
import time

client = mqtt.Client("${device.deviceKey}")
client.username_pw_set("${username}", "${password}")
client.connect("${mqttBroker.replace('mqtt://', '')}", 1883)

while True:
    telemetry = {"temperature": 25.5, "humidity": 60}
    client.publish("${telemetryTopic}", json.dumps(telemetry))
    time.sleep(60)
`.trim(),

      nodejs: `
const mqtt = require('mqtt');

const client = mqtt.connect('${mqttBroker}', {
  clientId: '${device.deviceKey}',
  username: '${username}',
  password: '${password}'
});

client.on('connect', () => {
  setInterval(() => {
    const telemetry = { temperature: 25.5, humidity: 60 };
    client.publish('${telemetryTopic}', JSON.stringify(telemetry));
  }, 60000);
});
`.trim(),

      curl: `
# Using MQTT over HTTP (if supported)
curl -X POST ${mqttBroker}/api/v1/${device.deviceKey}/telemetry \\
  -H "Content-Type: application/json" \\
  -H "X-Authorization: Bearer ${username}" \\
  -d '{"temperature":25.5,"humidity":60}'
`.trim(),
    };
  }

  /**
   * Regenerate credentials for a device
   */
  async regenerateCredentials(
    deviceId: string,
    user: User,
  ): Promise<DeviceCredentialsDto> {
    this.logger.log(`Regenerating credentials for device: ${deviceId}`);

    const device = await this.deviceRepository.findOne({
      where: { id: deviceId },
    });

    if (!device) {
      throw new NotFoundException(`Device not found: ${deviceId}`);
    }

    // Verify access
    this.verifyAccess(device, user);

    // Get existing credentials
    const existingCreds = await this.getByDeviceId(deviceId);

    // Delete old credentials
    await this.credentialsRepository.remove(existingCreds);

    // Create new credentials
    const newCredentials = await this.createCredentials(
      device,
      existingCreds.credentialsType,
    );

    this.logger.log(`✅ Credentials regenerated: ${newCredentials.id}`);

    // Return full configuration
    return this.buildMqttConfiguration(device, newCredentials);
  }

  /**
   * Verify device credentials (used by MQTT gateway)
   */
  async verifyCredentials(
    credentialsId: string,
    credentialsValue?: string,
  ): Promise<{ device: Device; credentials: DeviceCredentials }> {
    // Find credentials
    const credentials = await this.credentialsRepository.findOne({
      where: { credentialsId },
      relations: ['device'],
    });

    if (!credentials) {
      throw new ForbiddenException('Invalid credentials');
    }

    // Verify credentials based on type
    if (credentials.credentialsType === CredentialsType.MQTT_BASIC) {
      if (credentials.credentialsValue !== credentialsValue) {
        throw new ForbiddenException('Invalid password');
      }
    }

    // Check if device is active
    if (credentials.device.status === 'inactive') {
      throw new ForbiddenException('Device is not active');
    }

    return {
      device: credentials.device,
      credentials,
    };
  }

  /**
   * Verify user access to device
   */
  private verifyAccess(device: Device, user: User): void {
    if (user.role === UserRole.SUPER_ADMIN) {
      return; // Super admin has access to everything
    }

    if (user.role === UserRole.TENANT_ADMIN) {
      if (device.tenantId !== user.tenantId) {
        throw new ForbiddenException('Access denied to this device');
      }
      return;
    }

    if (user.role === UserRole.CUSTOMER_USER) {
      if (device.customerId !== user.customerId) {
        throw new ForbiddenException('Access denied to this device');
      }
      return;
    }

    // Regular user
    if (device.userId !== user.id) {
      throw new ForbiddenException('Access denied to this device');
    }
  }

  /**
   * Generate certificate fingerprint (for X509)
   */
  private generateCertificateFingerprint(): string {
    return `sha256:${generateToken(64)}`;
  }

  /**
   * Delete credentials when device is deleted
   */
  async deleteByDeviceId(deviceId: string): Promise<void> {
    await this.credentialsRepository.delete({ deviceId });
    this.logger.log(`Credentials deleted for device: ${deviceId}`);
  }
}