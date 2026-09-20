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
import { DeviceCredentialsSummaryDto } from './dto/device-credentials-summary.dto';
import { User } from '../users/entities/user.entity';
import { UserRole } from '@common/enums/index.enum';

// ─── Topic strategy result ────────────────────────────────────────────────────

interface TopicStrategy {
  telemetryTopic: string;
  attributesTopic: string;
  /**
   * Downlink the device SUBSCRIBES to for server-set shared attributes.
   *
   * Deliberately one level deeper than attributesTopic: the platform's MQTT
   * client subscribes to `devices/+/attributes` and treats anything arriving
   * there as telemetry, so a shared-attribute push onto that topic would be
   * re-ingested as a fake sensor reading. `+` matches a single level, so the
   * deeper topic cannot be caught by that subscription.
   */
  sharedAttributesTopic: string;
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

  // ── Internal: read-or-heal ────────────────────────────────────────────────

  /**
   * Same as getCredentialsWithSecret(), but mints a default ACCESS_TOKEN set
   * when the device has no credentials row instead of throwing 404.
   *
   * A missing row is a data gap, not a client error: devices predating the
   * credentials flow, rows lost to a partial restore, or devices inserted by
   * a seeder that skipped them. 404 left the operator with no way to recover
   * short of deleting and re-creating the device. Self-healing is safe here
   * precisely because there is nothing to invalidate — no device can already
   * be authenticating with a credential that does not exist.
   *
   * Deliberately NOT used by getCredentialsWithSecret() itself: rotation and
   * the provisioning handshake must keep failing loudly on a missing row,
   * since there a gap means something upstream went wrong.
   */
  private async getOrCreateCredentialsWithSecret(
    device: Device,
  ): Promise<DeviceCredentials> {
    const existing = await this.credentialsRepository
      .createQueryBuilder('creds')
      .addSelect('creds.credentialsValue')
      .where('creds.deviceId = :deviceId', { deviceId: device.id })
      .getOne();

    if (existing) return existing;

    this.logger.warn(
      `No credentials found for device ${device.deviceKey} — creating a ` +
        `default ACCESS_TOKEN set on read`,
    );

    try {
      await this.createCredentials(device, CredentialsType.ACCESS_TOKEN);
    } catch (error) {
      // Two concurrent reads both see "missing" and both insert; the unique
      // index on deviceId lets exactly one win. The loser re-reads the
      // winner's row rather than surfacing a spurious 409.
      const pgCode = (error as { code?: string; driverError?: { code?: string } })
        ?.driverError?.code ?? (error as { code?: string })?.code;

      if (!(error instanceof ConflictException) && pgCode !== '23505') {
        throw error;
      }
    }

    return this.getCredentialsWithSecret(device.id);
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

  // ── Masked summary (safe for repeat reads) ────────────────────────────────

  /**
   * First 8 characters followed by ****. Deliberately not enough to
   * authenticate with — it exists so an operator can tell two credentials
   * apart in the UI, nothing more.
   */
  private static mask(value?: string | null): string {
    if (!value) return '';
    return `${value.slice(0, 8)}****`;
  }

  /**
   * Non-secret view of a device's credentials.
   *
   * The full secret is returned only at creation (DevicesService.create) and
   * at rotation (regenerateCredentials) — never on a plain read, so an
   * attacker with a stolen session cannot harvest live device tokens.
   *
   * Self-heals: a device with no credentials row gets a default ACCESS_TOKEN
   * set minted here rather than a 404. The caller has already passed the
   * access check below, so this cannot be used to mint credentials for a
   * device the caller cannot see.
   */
  async getMaskedSummary(
    deviceId: string,
    user: User,
  ): Promise<DeviceCredentialsSummaryDto> {
    const device = await this.deviceRepository.findOne({ where: { id: deviceId } });

    if (!device) {
      throw new NotFoundException(`Device not found: ${deviceId}`);
    }

    this.verifyAccess(device, user);

    const credentials = await this.getOrCreateCredentialsWithSecret(device);

    // For ACCESS_TOKEN the credentialsId IS the secret, so it is masked too.
    // For MQTT_BASIC / X509 the credentialsId is a username / certificate CN —
    // non-secret — and the secret lives in credentialsValue.
    const idIsSecret =
      credentials.credentialsType === CredentialsType.ACCESS_TOKEN;

    const secret = idIsSecret
      ? credentials.credentialsId
      : credentials.credentialsValue;

    return {
      deviceId: device.id,
      deviceKey: device.deviceKey,
      credentialsType: credentials.credentialsType,
      credentialsId: idIsSecret
        ? DeviceCredentialsService.mask(credentials.credentialsId)
        : credentials.credentialsId,
      maskedToken: DeviceCredentialsService.mask(secret),
      isActive: credentials.isActive,
      lastUsedAt: credentials.lastUsedAt,
      expiresAt: credentials.expiresAt,
      createdAt: credentials.createdAt,
    };
  }

  /**
   * The value a device must present to authenticate, for the provisioning
   * handshake only. Unlike getMaskedSummary() this returns the real secret —
   * the caller is the device itself, which has already proven possession of
   * the profile's provision key and secret.
   */
  async getProvisioningCredentials(
    deviceId: string,
  ): Promise<{ credentialsType: CredentialsType; credentialsValue: string }> {
    const credentials = await this.getCredentialsWithSecret(deviceId);

    if (!credentials.isValid()) {
      throw new ForbiddenException('Device credentials are revoked or expired');
    }

    return {
      credentialsType: credentials.credentialsType,
      credentialsValue:
        credentials.credentialsType === CredentialsType.ACCESS_TOKEN
          ? credentials.credentialsId
          : (credentials.credentialsValue ?? credentials.credentialsId),
    };
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
    const mqttBrokerUrl = this.configService.get<string>('MQTT_BROKER_URL');
    if (!mqttBrokerUrl) {
      // This URL is printed into the connection snippet handed to whoever is
      // provisioning a device. A localhost default produced instructions that
      // could not work anywhere except on the server itself.
      throw new Error(
        'MQTT_BROKER_URL must be configured — it is embedded in device connection instructions',
      );
    }
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
          // LoRaWAN downlinks are codec-encoded onto the tx topic; shared
          // attributes are not pushed for this protocol.
          sharedAttributesTopic: `application/1/device/${devEUI}/tx`,
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
          // As above — ChirpStack downlinks go through command/down.
          sharedAttributesTopic: `application/+/device/${devEUI}/command/down`,
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
          sharedAttributesTopic: `devices/${device.deviceKey}/attributes/shared`,
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
        documentation: (this.configService.get<string>('DOCS_BASE_URL') ?? 'https://docs.smartlife.sa') + '/gateways/milesight-ug65',
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
        `7. Subscribe to shared attributes at: ${topics.sharedAttributesTopic}`,
      ],
      documentation: (this.configService.get<string>('DOCS_BASE_URL') ?? 'https://docs.smartlife.sa') + '/device-setup',
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