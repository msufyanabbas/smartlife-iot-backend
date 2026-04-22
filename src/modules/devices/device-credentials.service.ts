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
import { DeviceProtocol } from './entities/device.entity';
import { DeviceCredentials, CredentialsType } from './entities/device-credentials.entity';
import { DeviceCredentialsDto } from './dto/device-credentials.dto';
import { User } from '../users/entities/user.entity';
import { UserRole } from '@common/enums/index.enum';

// ─── Topic strategy result ────────────────────────────────────────────────────

interface TopicStrategy {
  telemetryTopic: string;
  attributesTopic: string;
  statusTopic: string;
  alertsTopic: string;
  commandsTopic: string;
  uplinkPatterns: string[];
}

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

  // ── Create credentials ────────────────────────────────────────────────────

  async createCredentials(
    device: Device,
    credentialsType: CredentialsType = CredentialsType.ACCESS_TOKEN,
  ): Promise<DeviceCredentials> {
    this.logger.log(`Creating credentials for device: ${device.deviceKey}`);

    let credentialsId: string;
    let credentialsValue: string | undefined;

    switch (credentialsType) {
      case CredentialsType.ACCESS_TOKEN:
        // The token itself acts as the username — no separate password needed.
        credentialsId = `${device.deviceKey}_${DeviceCredentials.generateToken()}`;
        credentialsValue = undefined;
        break;

      case CredentialsType.MQTT_BASIC:
        credentialsId = device.deviceKey; // username = deviceKey
        credentialsValue = DeviceCredentials.generateToken(); // password
        break;

      case CredentialsType.X509_CERTIFICATE:
        credentialsId = device.deviceKey;
        credentialsValue = `sha256:${DeviceCredentials.generateToken()}`;
        break;

      default:
        throw new Error(`Unsupported credentials type: ${credentialsType}`);
    }

    const existing = await this.credentialsRepository.findOne({
      where: { deviceId: device.id },
    });

    if (existing) {
      throw new ConflictException(
        `Credentials already exist for device ${device.deviceKey}`,
      );
    }

    const credentials = this.credentialsRepository.create({
      deviceId: device.id,
      credentialsType,
      credentialsId,
      credentialsValue,
    });

    const saved = await this.credentialsRepository.save(credentials);
    this.logger.log(`Credentials created: ${saved.id}`);
    return saved;
  }

  // ── Internal: get credentials WITH the secret value selected ─────────────
  // credentialsValue has select:false on the column, so we must explicitly
  // include it whenever we need to expose or compare the secret.

  private async getCredentialsWithSecret(
    deviceId: string,
  ): Promise<DeviceCredentials> {
    const credentials = await this.credentialsRepository
      .createQueryBuilder('creds')
      .addSelect('creds.credentialsValue') // explicitly opt-in to the hidden column
      .where('creds.deviceId = :deviceId', { deviceId })
      .getOne();

    if (!credentials) {
      throw new NotFoundException(
        `Credentials not found for device: ${deviceId}`,
      );
    }

    return credentials;
  }

  // ── Public: get credentials without secret (safe for relations/logging) ───

  async getByDeviceId(deviceId: string): Promise<DeviceCredentials> {
    const credentials = await this.credentialsRepository.findOne({
      where: { deviceId },
    });

    if (!credentials) {
      throw new NotFoundException(
        `Credentials not found for device: ${deviceId}`,
      );
    }

    return credentials;
  }

  // ── Build full MQTT configuration ─────────────────────────────────────────

  async getMqttConfiguration(
    deviceId: string,
    user: User,
  ): Promise<DeviceCredentialsDto> {
    const device = await this.deviceRepository.findOne({ where: { id: deviceId } });

    if (!device) {
      throw new NotFoundException(`Device not found: ${deviceId}`);
    }

    this.verifyAccess(device, user);

    // Use the private method so credentialsValue is populated
    const credentials = await this.getCredentialsWithSecret(deviceId);

    return this.buildMqttConfiguration(device, credentials);
  }

  // ── Build the full DeviceCredentialsDto ───────────────────────────────────

  private buildMqttConfiguration(
    device: Device,
    credentials: DeviceCredentials,
  ): DeviceCredentialsDto {
    const mqttBrokerUrl =
      this.configService.get<string>('MQTT_BROKER_URL') || 'mqtt://localhost:1883';
    const brokerUrl = new URL(mqttBrokerUrl);
    const mqttHost = brokerUrl.hostname;
    const mqttPort = parseInt(brokerUrl.port, 10) || 1883;

    // Topic strategy is now derived from the typed device.protocol column —
    // no more magic string checks against metadata.gatewayType.
    const topics = this.getTopicStrategy(device);

    const accessToken =
      credentials.credentialsType === CredentialsType.ACCESS_TOKEN
        ? credentials.credentialsId
        : undefined;

    const secretKey =
      credentials.credentialsType === CredentialsType.MQTT_BASIC
        ? credentials.credentialsValue
        : undefined;

    return {
      deviceKey: device.deviceKey,
      accessToken,
      secretKey,
      mqttBroker: mqttBrokerUrl,
      mqttHost,
      mqttPort,
      ...topics,
      gatewayConfig: this.buildGatewayConfig(
        device,
        credentials,
        mqttHost,
        mqttPort,
        topics,
      ),
      setupInstructions: this.buildSetupInstructions(
        device,
        credentials,
        mqttHost,
        mqttPort,
        topics,
      ),
      codeExamples: this.buildCodeExamples(
        device,
        credentials,
        mqttBrokerUrl,
        topics.telemetryTopic,
      ),
    };
  }

  // ── Topic strategy — driven by device.protocol ────────────────────────────
  // This is the single source of truth for topic naming. All other services
  // (GatewayService, DeviceListenerService) must call this same logic.

  getTopicStrategy(device: Device): TopicStrategy {
    const devEUI = device.metadata?.devEUI as string | undefined;

    switch (device.protocol) {
      case DeviceProtocol.LORAWAN_MILESIGHT: {
        if (!devEUI) {
          throw new Error(
            `devEUI is required in metadata for LORAWAN_MILESIGHT device: ${device.deviceKey}`,
          );
        }
        return {
          telemetryTopic: `application/1/device/${devEUI}/rx`,
          attributesTopic: `application/1/device/${devEUI}/event/up`,
          statusTopic: `application/1/device/${devEUI}/event/status`,
          alertsTopic: `application/1/device/${devEUI}/event/error`,
          commandsTopic: `application/1/device/${devEUI}/tx`,
          uplinkPatterns: [
            `application/1/device/${devEUI}/rx`,
            `application/1/device/${devEUI}/event/+`,
          ],
        };
      }

      case DeviceProtocol.LORAWAN_CHIRPSTACK: {
        if (!devEUI) {
          throw new Error(
            `devEUI is required in metadata for LORAWAN_CHIRPSTACK device: ${device.deviceKey}`,
          );
        }
        return {
          telemetryTopic: `application/+/device/${devEUI}/event/up`,
          attributesTopic: `application/+/device/${devEUI}/event/join`,
          statusTopic: `application/+/device/${devEUI}/event/status`,
          alertsTopic: `application/+/device/${devEUI}/event/error`,
          commandsTopic: `application/+/device/${devEUI}/command/down`,
          uplinkPatterns: [
            `application/+/device/${devEUI}/event/up`,
            `application/+/device/${devEUI}/event/+`,
          ],
        };
      }

      // Default: plain MQTT device (ESP32, Arduino, etc.)
      case DeviceProtocol.GENERIC_MQTT:
      default: {
        return {
          telemetryTopic: `devices/${device.deviceKey}/telemetry`,
          attributesTopic: `devices/${device.deviceKey}/attributes`,
          statusTopic: `devices/${device.deviceKey}/status`,
          alertsTopic: `devices/${device.deviceKey}/alerts`,
          commandsTopic: `devices/${device.deviceKey}/commands`,
          uplinkPatterns: [
            `devices/${device.deviceKey}/telemetry`,
            `devices/${device.deviceKey}/+`,
          ],
        };
      }
    }
  }

  // ── Gateway config block ──────────────────────────────────────────────────

  private buildGatewayConfig(
    device: Device,
    credentials: DeviceCredentials,
    mqttHost: string,
    mqttPort: number,
    topics: TopicStrategy,
  ): DeviceCredentialsDto['gatewayConfig'] {
    const username =
      credentials.credentialsType === CredentialsType.ACCESS_TOKEN
        ? credentials.credentialsId
        : credentials.credentialsId;

    const password =
      credentials.credentialsType === CredentialsType.MQTT_BASIC
        ? (credentials.credentialsValue ?? '')
        : '';

    const base: any = {
      clientId: device.deviceKey,
      username,
      password,
      host: mqttHost,
      port: mqttPort,
      publishTopic: topics.telemetryTopic,
      qos: 1 as const,
      devEUI: device.metadata?.devEUI as string | undefined,
      downlinkTopic:
        device.protocol !== DeviceProtocol.GENERIC_MQTT
          ? topics.commandsTopic
          : undefined,
    };

    if (device.protocol === DeviceProtocol.LORAWAN_MILESIGHT) {
      return { ...base, type: 'milesight-ug65', networkServerId: 'smartlife-iot', fPort: 85, confirmed: false };
    }

    if (device.protocol === DeviceProtocol.LORAWAN_CHIRPSTACK) {
      return { ...base, type: 'chirpstack', applicationId: 'smartlife-app' };
    }

    return base;
  }

  // ── Setup instructions ────────────────────────────────────────────────────

  private buildSetupInstructions(
    device: Device,
    credentials: DeviceCredentials,
    mqttHost: string,
    mqttPort: number,
    topics: TopicStrategy,
  ): DeviceCredentialsDto['setupInstructions'] {
    const username = credentials.credentialsId;
    const password = credentials.credentialsValue ?? '(use access token)';

    if (device.protocol === DeviceProtocol.LORAWAN_MILESIGHT) {
      return {
        steps: [
          '1. Open the Milesight UG65 web interface',
          '2. Go to Network Server → MQTT Integration',
          `3. Set MQTT Broker: ${mqttHost}:${mqttPort}`,
          `4. Set Username: ${username}`,
          `5. Set Password: ${password}`,
          '6. Enable MQTT Integration and save',
        ],
        documentation: 'https://docs.smartlife.sa/gateways/milesight-ug65',
        notes: [
          'Each sensor application in the gateway UI gets the same broker credentials',
          'The devEUI embedded in the topic must match the sensor registered on the platform',
        ],
      };
    }

    return {
      steps: [
        `1. Configure MQTT broker: ${mqttHost}:${mqttPort}`,
        `2. Set client ID: ${device.deviceKey}`,
        `3. Set username: ${username}`,
        `4. Set password: ${password}`,
        `5. Publish telemetry to: ${topics.telemetryTopic}`,
        `6. Subscribe to commands at: ${topics.commandsTopic}`,
      ],
      documentation: 'https://docs.smartlife.sa/device-setup',
      notes: [
        'Keep credentials secure — do not commit them to source control',
        'Device must be in ACTIVE status before telemetry is processed',
      ],
    };
  }

  // ── Code examples ─────────────────────────────────────────────────────────

  private buildCodeExamples(
    device: Device,
    credentials: DeviceCredentials,
    mqttBroker: string,
    telemetryTopic: string,
  ): DeviceCredentialsDto['codeExamples'] {
    const username = credentials.credentialsId;
    const password = credentials.credentialsValue ?? '';
    const host = mqttBroker.replace(/^mqtt:\/\//, '');

    return {
      arduino: `
#include <PubSubClient.h>
WiFiClient espClient;
PubSubClient client(espClient);

void setup() {
  client.setServer("${host}", 1883);
  client.connect("${device.deviceKey}", "${username}", "${password}");
}

void loop() {
  if (client.connected()) {
    client.publish("${telemetryTopic}", "{\\"temperature\\":25.5}");
  }
  delay(60000);
}`.trim(),

      python: `
import paho.mqtt.client as mqtt, json, time

c = mqtt.Client("${device.deviceKey}")
c.username_pw_set("${username}", "${password}")
c.connect("${host}", 1883)

while True:
    c.publish("${telemetryTopic}", json.dumps({"temperature": 25.5}))
    time.sleep(60)`.trim(),

      nodejs: `
const mqtt = require('mqtt');
const client = mqtt.connect('${mqttBroker}', {
  clientId: '${device.deviceKey}',
  username: '${username}',
  password: '${password}',
});

client.on('connect', () => {
  setInterval(() => {
    client.publish('${telemetryTopic}', JSON.stringify({ temperature: 25.5 }));
  }, 60_000);
});`.trim(),
    };
  }

  // ── Regenerate credentials ────────────────────────────────────────────────

  async regenerateCredentials(
    deviceId: string,
    user: User,
  ): Promise<DeviceCredentialsDto> {
    const device = await this.deviceRepository.findOne({ where: { id: deviceId } });

    if (!device) {
      throw new NotFoundException(`Device not found: ${deviceId}`);
    }

    this.verifyAccess(device, user);

    // Load existing (with secret so we know the type)
    const existing = await this.getCredentialsWithSecret(deviceId);
    const credentialsType = existing.credentialsType;

    // Hard-delete the old row — DB cascade is not involved here because
    // we're deleting the child (credentials), not the parent (device).
    await this.credentialsRepository.remove(existing);

    const newCreds = await this.createCredentials(device, credentialsType);

    // We need the secret value on the new creds for the response
    const newCredsWithSecret = await this.getCredentialsWithSecret(device.id);

    return this.buildMqttConfiguration(device, newCredsWithSecret);
  }

  // ── Verify credentials (called by MQTT gateway auth hook) ────────────────

  async verifyCredentials(
    credentialsId: string,
    credentialsValue?: string,
  ): Promise<{ device: Device; credentials: DeviceCredentials }> {
    const credentials = await this.credentialsRepository
      .createQueryBuilder('creds')
      .addSelect('creds.credentialsValue')
      .leftJoinAndSelect('creds.device', 'device')
      .where('creds.credentialsId = :credentialsId', { credentialsId })
      .getOne();

    if (!credentials || !credentials.isValid()) {
      throw new ForbiddenException('Invalid or revoked credentials');
    }

    if (credentials.credentialsType === CredentialsType.MQTT_BASIC) {
      if (credentials.credentialsValue !== credentialsValue) {
        throw new ForbiddenException('Invalid password');
      }
    }

    if (!credentials.device) {
      throw new ForbiddenException('Device not found for these credentials');
    }

    // Record usage (fire and forget — don't await to avoid slowing auth)
    void this.credentialsRepository.update(credentials.id, {
      lastUsedAt: new Date(),
    });

    return { device: credentials.device, credentials };
  }

  // ── Delete (called explicitly before soft-removing the device) ────────────

  async deleteByDeviceId(deviceId: string): Promise<void> {
    await this.credentialsRepository.delete({ deviceId });
    this.logger.log(`Credentials deleted for device: ${deviceId}`);
  }

  // ── Access control ────────────────────────────────────────────────────────

  private verifyAccess(device: Device, user: User): void {
    if (user.role === UserRole.SUPER_ADMIN) return;

    if (user.role === UserRole.TENANT_ADMIN) {
      if (device.tenantId !== user.tenantId) {
        throw new ForbiddenException('Access denied to this device');
      }
      return;
    }

    if (
      user.role === UserRole.CUSTOMER_USER ||
      user.role === UserRole.CUSTOMER
    ) {
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
}