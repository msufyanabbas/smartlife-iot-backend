import {
  Injectable,
  Logger,
  OnModuleInit,
  OnModuleDestroy,
  Inject,
} from '@nestjs/common';
import type { ConfigType } from '@nestjs/config';
import { EventEmitter2 } from '@nestjs/event-emitter';
import mqttConfig from '../../config/mqtt.config';
import { DevicesService } from '../devices/devices.service';
import { MQTTService } from '@/lib/mqtt/mqtt.service';
import { CodecRegistryService } from '@modules/devices/codecs/codec-registry.service';
import { DeviceProtocol } from '@modules/devices/entities/device.entity';
import { UserRole } from '@/common/enums/user.enum';
import { User } from '../index.entities';

export interface DeviceMessage {
  deviceKey: string;
  timestamp: Date;
  data: Record<string, any> | string;
  messageType: 'telemetry' | 'attributes' | 'rpc_request' | 'rpc_response' | 'status' | 'alerts';
}

export interface DeviceCommand {
  method: string;
  params?: Record<string, any>;
}

interface VerifiedConnection {
  deviceKey: string;
  deviceId: string;
  verifiedAt: Date;
}

@Injectable()
export class GatewayService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(GatewayService.name);

  // A synthetic SUPER_ADMIN user for internal lookups that are not user-initiated.
  // DevicesService.applyAccessFilter() skips all filters for SUPER_ADMIN.
  private readonly systemUser = {
    id: 'system',
    role: UserRole.SUPER_ADMIN,
    tenantId: null,
    customerId: null,
  } as any as User;

  private readonly verifiedConnections = new Map<string, VerifiedConnection>();
  private cleanupInterval: NodeJS.Timeout | null = null;

  constructor(
    @Inject(mqttConfig.KEY)
    private readonly config: ConfigType<typeof mqttConfig>,
    private readonly eventEmitter: EventEmitter2,
    private readonly devicesService: DevicesService,
    // GatewayService does NOT create its own MQTT client.
    // It delegates all publish operations to MQTTService (the single client).
    private readonly mqttService: MQTTService,
    private readonly codecRegistry: CodecRegistryService,
  ) {}

  async onModuleInit(): Promise<void> {
    this.startConnectionCleanup();
  }

  async onModuleDestroy(): Promise<void> {
    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval);
      this.cleanupInterval = null;
    }
  }

  // ── Send command (downlink) ────────────────────────────────────────────────

  async sendCommand(deviceKey: string, command: DeviceCommand): Promise<void> {
    const device = await this.devicesService.findByDeviceKey(deviceKey, this.systemUser);

    this.logger.log(`sendCommand — deviceKey: ${deviceKey}, protocol: ${device.protocol}, devEUI: ${device.metadata?.devEUI}`);

    const devEUI = device.metadata?.devEUI as string | undefined;

    let topic: string;
    let payload: any;

    switch (device.protocol) {
      case DeviceProtocol.LORAWAN_MILESIGHT: {
        if (!devEUI) throw new Error(`devEUI required for Milesight device: ${deviceKey}`);

        // Map DeviceCommand { method, params } → codec format { type, params }
        const encoded = this.codecRegistry.encode(
          { type: command.method, params: command.params },
          { codecId: (device.metadata?.codecId as string) ?? 'milesight-ws558' },
        );

        topic = `milesight/downlink/${devEUI}`;
        payload = {
          devEUI,
          fPort: encoded.fPort ?? 85,
          confirmed: encoded.confirmed ?? false,
          data: encoded.data,
        };
        break;
      }


      case DeviceProtocol.LORAWAN_CHIRPSTACK: {
        if (!devEUI) throw new Error(`devEUI required for ChirpStack device: ${deviceKey}`);

        const encoded = this.codecRegistry.encode(
          { type: command.method, params: command.params },
          { codecId: device.metadata?.codecId as string },
        );

        topic = `milesight/downlink/${devEUI}`;
        payload = {
          devEUI,
          confirmed: false,
          fPort: encoded.fPort ?? 1,
          data: Buffer.from(encoded.data, 'hex').toString('base64'),
        };
        break;
      }

      default: {
        // Generic MQTT — send command JSON directly to the commands topic
        topic = `milesight/downlink/${devEUI}`;
        payload = command;
        break;
      }
    }

    await this.mqttService.publish(topic, payload);
    this.logger.log(`Command sent → ${deviceKey} (${command.method})`);
  }

  // ── Send RPC request ──────────────────────────────────────────────────────

  async sendRpcRequest(
    deviceKey: string,
    method: string,
    params?: Record<string, any>,
  ): Promise<void> {
    const topic = `devices/${deviceKey}/rpc/request`;
    await this.mqttService.publish(topic, {
      id: Date.now().toString(),
      method,
      params,
    });
    this.logger.log(`RPC request sent → ${deviceKey}: ${method}`);
  }

  // ── Update device attributes ──────────────────────────────────────────────

  async updateDeviceAttributes(
    deviceKey: string,
    attributes: Record<string, any>,
  ): Promise<void> {
    await this.mqttService.publish(`devices/${deviceKey}/attributes`, attributes);
  }

  // ── Publish telemetry (testing) ───────────────────────────────────────────

  async publishTelemetry(
    deviceKey: string,
    telemetry: Record<string, any>,
  ): Promise<void> {
    await this.mqttService.publish(`devices/${deviceKey}/telemetry`, {
      ts: Date.now(),
      values: telemetry,
    });
  }

  // ── Verify device connection (used by event handler) ─────────────────────

  async verifyDeviceConnection(deviceIdentifier: string): Promise<VerifiedConnection | null> {
    // Return cached verification if less than 5 minutes old
    const cached = this.verifiedConnections.get(deviceIdentifier);
    if (cached) {
      const fiveMinutesAgo = new Date(Date.now() - 5 * 60 * 1000);
      if (cached.verifiedAt > fiveMinutesAgo) return cached;
    }

    try {
      // Generic MQTT devices: identifier is deviceKey
      // LoRaWAN devices: identifier is devEUI stored in metadata
      let device;

      if (deviceIdentifier.startsWith('dev_')) {
        device = await this.devicesService.findByDeviceKey(deviceIdentifier, this.systemUser);
      } else {
        // devEUI lookup — find device by JSONB metadata field
        const { data } = await this.devicesService.findAll(
          undefined,  // tenantId — SUPER_ADMIN sees all
          undefined,  // customerId
          this.systemUser,
          { page: 1, limit: 1 } as any,
        );
        device = data.find((d) => d.metadata?.devEUI === deviceIdentifier) ?? null;
      }

      if (!device) {
        this.logger.warn(`Device not found for identifier: ${deviceIdentifier}`);
        return null;
      }

      if (device.status === 'inactive') {
        this.logger.warn(`Device ${device.deviceKey} is inactive`);
        return null;
      }

      const verification: VerifiedConnection = {
        deviceKey: device.deviceKey,
        deviceId: device.id,
        verifiedAt: new Date(),
      };

      this.verifiedConnections.set(deviceIdentifier, verification);
      return verification;
    } catch (error) {
      this.logger.error(`Verification failed for ${deviceIdentifier}: ${(error as Error).message}`);
      return null;
    }
  }

  // ── Status ────────────────────────────────────────────────────────────────

  getStatus() {
    return {
      mqttConnected: this.mqttService.isClientConnected(),
      brokerUrl: this.config.brokerUrl,
      clientId: this.config.clientId,
      verifiedConnectionsCached: this.verifiedConnections.size,
    };
  }

  // ── Cleanup ───────────────────────────────────────────────────────────────

  private startConnectionCleanup(): void {
    this.cleanupInterval = setInterval(() => {
      const tenMinutesAgo = new Date(Date.now() - 10 * 60 * 1000);
      for (const [key, v] of this.verifiedConnections.entries()) {
        if (v.verifiedAt < tenMinutesAgo) this.verifiedConnections.delete(key);
      }
    }, 10 * 60 * 1000);
  }
}