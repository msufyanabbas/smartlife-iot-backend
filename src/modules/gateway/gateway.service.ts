import {
  Injectable,
  Logger,
  OnModuleInit,
  OnModuleDestroy,
  Inject,
  forwardRef,
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
import {
  RpcCorrelatorService,
  type RpcOutcome,
} from '@modules/protocols/rpc-correlator.service';
import { DeviceCommandsService } from '@modules/device-commands/device-commands.service';
import { RpcResponseListener } from './rpc-response.listener';

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
    // Pending-request table for two-way RPC. Lives in ProtocolsModule because
    // CoAPAdapter resolves into the same map.
    private readonly rpcCorrelator: RpcCorrelatorService,
    private readonly rpcResponseListener: RpcResponseListener,
    // DeviceCommandsModule imports GatewayModule (its consumer needs this
    // service), so this direction must be forwardRef'd at both ends.
    @Inject(forwardRef(() => DeviceCommandsService))
    private readonly deviceCommandsService: DeviceCommandsService,
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

  // ── Send RPC request (two-way) ────────────────────────────────────────────

  /**
   * Send an RPC to a device and wait for its answer.
   *
   * ── What changed and why ────────────────────────────────────────────────
   * This used to publish to `devices/{deviceKey}/rpc/request` and return void.
   * Nothing subscribed to any response topic, so the HTTP caller was told
   * "RPC request sent" whether the device executed the command, rejected it,
   * or had been unplugged for a week. There was also no history row, so you
   * could not find out afterwards either.
   *
   * Three concrete fixes:
   *   1. The correlation id is a UUID. It was `Date.now().toString()`, which
   *      is not a correlation id at all: two requests in the same millisecond
   *      — the normal case when a dashboard fans a command out over a group —
   *      share an id, so one device's answer resolves another's request.
   *   2. `RpcResponseListener` subscribes to `devices/+/rpc/response` and
   *      resolves the pending request through `RpcCorrelatorService`.
   *   3. The outcome is persisted on the `device_commands` row, so
   *      `GET /device-commands/device/:deviceId` reflects what the device did,
   *      not only what was published.
   *
   * ── Wait or poll? WAIT. ─────────────────────────────────────────────────
   * The HTTP caller blocks until the device answers or the timeout expires,
   * and the response body carries the device's payload. That is the two-way
   * semantic the name `sendRpcRequest` already implied, it needs no second
   * round trip from the client, and the timeout bounds the request. The
   * alternative — return a request id and have the UI poll — is available for
   * free as a side effect: every RPC also has a `commandId`, and
   * `GET /device-commands/{commandId}` shows its terminal status. So a caller
   * that does not want to hold a connection open can pass
   * `waitForResponse: false` and poll that row instead.
   *
   * The returned promise NEVER rejects on a device-side problem; a timeout or
   * a device error is a result, not an exception. It rejects only when the
   * publish itself fails (no broker), because that is a server fault.
   */
  async sendRpcRequest(
    deviceKey: string,
    method: string,
    params?: Record<string, any>,
    options: {
      /** Milliseconds. Clamped to 1s–300s; default 30s. */
      timeoutMs?: number;
      /** Who issued it — for the history row. */
      userId?: string;
      tenantId?: string;
      /**
       * false → publish, open the history row, and return immediately without
       * waiting. The caller polls GET /device-commands/{commandId}.
       */
      waitForResponse?: boolean;
    } = {},
  ): Promise<{
    requestId: string;
    commandId?: string;
    deviceKey: string;
    method: string;
    /** 'response' | 'timeout' | 'cancelled' | 'sent' (fire-and-forget). */
    status: RpcOutcome['status'] | 'sent';
    response?: any;
    error?: string;
    durationMs?: number;
    via?: string;
    /** False when no response topic is being listened to right now. */
    responseListenerConnected: boolean;
  }> {
    const device = await this.devicesService.findByDeviceKey(
      deviceKey,
      this.systemUser,
    );

    const requestId = this.rpcCorrelator.newRequestId();
    const timeoutMs = this.rpcCorrelator.clampTimeout(options.timeoutMs);
    const topic = `devices/${deviceKey}/rpc/request`;
    const listening = this.rpcResponseListener.isListening();

    if (!listening) {
      // Say so rather than letting every RPC silently time out.
      this.logger.warn(
        `RPC response listener is not connected — the RPC to ${deviceKey} will ` +
          'almost certainly time out. Check the broker connection and ' +
          'GATEWAY_RPC_LISTENER_ENABLED.',
      );
    }

    // History row first, so even a publish failure leaves a trace.
    let commandId: string | undefined;
    if (options.userId && options.tenantId) {
      try {
        const command = await this.deviceCommandsService.createRpcCommand({
          deviceId: device.id,
          tenantId: options.tenantId,
          userId: options.userId,
          method,
          params,
          timeoutMs,
          requestId,
          transport: 'mqtt',
        });
        commandId = command.id;
      } catch (error) {
        // A missing audit row must not block the command itself.
        this.logger.error(
          `Could not open an RPC history row for ${deviceKey}: ${(error as Error).message}`,
        );
      }
    }

    // ── Fire-and-forget path ────────────────────────────────────────────────
    if (options.waitForResponse === false) {
      await this.mqttService.publish(topic, { id: requestId, method, params });
      if (commandId) await this.deviceCommandsService.markRpcDelivered(commandId);
      this.logger.log(
        `RPC published (no wait) → ${deviceKey}: ${method} [id ${requestId}]`,
      );
      return {
        requestId,
        commandId,
        deviceKey,
        method,
        status: 'sent',
        responseListenerConnected: listening,
      };
    }

    // ── Two-way path ────────────────────────────────────────────────────────
    // Register BEFORE publishing: a fast device could answer between the
    // publish returning and the entry existing, and that response would then
    // match nothing.
    const pending = this.rpcCorrelator.register({
      requestId,
      deviceKey,
      method,
      timeoutMs,
    });

    try {
      await this.mqttService.publish(topic, { id: requestId, method, params });
    } catch (error) {
      // The request never left the host. Settle the pending entry — otherwise
      // it would sit in the map for the whole timeout window for a request
      // that provably cannot be answered.
      this.rpcCorrelator.cancel(
        requestId,
        `Publish to ${topic} failed: ${(error as Error).message}`,
      );
      await pending;
      if (commandId) {
        await this.deviceCommandsService.recordRpcOutcome(commandId, {
          status: 'cancelled',
          error: `Publish failed: ${(error as Error).message}`,
        });
      }
      throw error;
    }

    if (commandId) await this.deviceCommandsService.markRpcDelivered(commandId);
    this.logger.log(
      `RPC request sent → ${deviceKey}: ${method} [id ${requestId}, waiting up to ${timeoutMs}ms]`,
    );

    const outcome = await pending;

    if (commandId) {
      await this.deviceCommandsService.recordRpcOutcome(commandId, {
        status: outcome.status,
        response: outcome.response,
        error: outcome.error,
        durationMs: outcome.durationMs,
        via: outcome.via,
      });
    }

    return {
      requestId,
      commandId,
      deviceKey,
      method,
      status: outcome.status,
      response: outcome.response,
      error: outcome.error,
      durationMs: outcome.durationMs,
      via: outcome.via,
      responseListenerConnected: listening,
    };
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
      // Without this an operator cannot tell a dead device from a gateway that
      // is not listening for responses at all.
      rpcResponseListenerConnected: this.rpcResponseListener.isListening(),
      rpcPendingRequests: this.rpcCorrelator.pendingCount(),
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