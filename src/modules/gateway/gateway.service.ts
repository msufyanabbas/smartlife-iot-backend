import {
  Injectable,
  Logger,
  OnModuleInit,
  OnModuleDestroy,
  Inject,
  forwardRef,
} from '@nestjs/common';
import type { ConfigType } from '@nestjs/config';
import { ModuleRef } from '@nestjs/core';
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

/**
 * The slice of `LorawanDownlinkService` this module uses.
 *
 * Declared structurally rather than importing the class: the whole point of
 * the `ModuleRef` lookup in `sendLorawanDownlink()` is that this file does not
 * import `IntegrationsModule`'s graph, and importing the class for its type
 * alone would reintroduce the module edge the lookup exists to avoid.
 */
interface LorawanDownlinkPort {
  enqueue(
    device: unknown,
    request: {
      data: string;
      fPort: number;
      confirmed?: boolean;
      reference?: string;
    },
  ): Promise<{
    network: 'chirpstack' | 'ttn';
    fPort: number;
    queueItemId?: string;
    message: string;
  }>;
}

/** Protocols whose downlinks go through a network server's REST API, not MQTT. */
const LORAWAN_NETWORK_PROTOCOLS = new Set<string>([
  DeviceProtocol.LORAWAN_CHIRPSTACK,
  DeviceProtocol.LORAWAN_TTN,
]);

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

  /**
   * Resolved lazily through ModuleRef, then memoised. `undefined` means "not
   * looked up yet"; `null` means "looked up and not present", which must not
   * be retried on every command.
   */
  private lorawanDownlink?: LorawanDownlinkPort | null;

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
    // Used only to resolve LorawanDownlinkService without importing
    // IntegrationsModule — see sendLorawanDownlink().
    private readonly moduleRef: ModuleRef,
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

  /**
   * `actor` is optional because this method has two callers with different
   * origins: an authenticated HTTP route, and `DeviceCommandsConsumer` working
   * through a queue where there is no request. Passing it through is what lets
   * the `device.command.sent` audit row name who pressed the button — without
   * it the row records the command and not the person, which is the half of
   * the question nobody asks.
   */
  async sendCommand(
    deviceKey: string,
    command: DeviceCommand,
    actor?: Pick<User, 'id' | 'name' | 'email'>,
  ): Promise<void> {
    const device = await this.devicesService.findByDeviceKey(deviceKey, this.systemUser);

    this.logger.log(`sendCommand — deviceKey: ${deviceKey}, protocol: ${device.protocol}, devEUI: ${device.metadata?.devEUI}`);

    const devEUI = device.metadata?.devEUI as string | undefined;

    // ── LoRaWAN network servers are not reachable over this broker ──────────
    // A ChirpStack or TTN device's downlinks have to be queued through that
    // network server's REST API; it is the server that owns the device's
    // receive windows and decides when the frame is actually transmitted.
    // Publishing to `milesight/downlink/<devEUI>` on this platform's own
    // broker — which is what this method did for both protocols — succeeded
    // every time and reached nothing, marking the command DELIVERED.
    //
    // Checked before the switch so it covers both protocols in one place and
    // so a deployment WITHOUT the network-server credentials configured still
    // falls through to the old broker behaviour rather than losing a path it
    // may be relying on (a sidecar bridging that topic into ChirpStack).
    if (await this.sendLorawanDownlink(device, command)) return;

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

    // Actuation is the most consequential thing a user can do to a device and
    // it was not recorded: `device.command.sent` has an audit handler and had
    // no emitter. Emitted here rather than in the controller so the queued
    // path (DeviceCommandsConsumer → sendCommand) is covered too.
    //
    // `sentBy` is null for the queued path — a command dispatched by
    // DeviceCommandsConsumer has no request behind it, and inventing an actor
    // would be worse than an empty field. The HTTP route passes one.
    this.eventEmitter.emit('device.command.sent', {
      deviceId: device.id,
      deviceName: device.name,
      deviceKey: device.deviceKey,
      tenantId: device.tenantId,
      customerId: device.customerId,
      command: command.method,
      params: command.params,
      sentBy: actor,
    });
  }

  // ── LoRaWAN downlink (ChirpStack / The Things Stack) ──────────────────────

  /**
   * Queue a downlink through the device's LoRaWAN network server.
   *
   * Returns **true** when this command was handled here and `sendCommand()`
   * should stop; **false** when the device is not a LoRaWAN network-server
   * device, or no downlink service is available, so the caller continues to
   * its MQTT branches.
   *
   * ── Why ModuleRef and not an import ────────────────────────────────────────
   * `LorawanDownlinkService` lives in `IntegrationsModule`, next to the uplink
   * webhooks and the integration catalogue it reads credentials from. Importing
   * that module here would close a third edge on an already-cyclic graph —
   * `GatewayModule` ← `ProtocolsModule` ← `IntegrationsModule` — and a module
   * load cycle in this application does not degrade, it crashes `bootstrap()`
   * (CLAUDE.md §4e). `AiInsightsService` resolves `TelemetryService` through
   * `ModuleRef` for exactly this reason, and the token is registered as a
   * string alias so it can be named without the import.
   *
   * The lookup is memoised: `ModuleRef.get` walks the container, and this is on
   * the command path for every actuation.
   *
   * ── Payload: the codec first, raw params second ────────────────────────────
   * A LoRaWAN downlink is bytes, an fPort and a confirmed flag. Those come
   * from the device's codec when it has one — the same `codecRegistry.encode()`
   * the Milesight branch uses, so a `setSwitch` command means the same thing on
   * both transports. A caller that already holds the frame can pass
   * `params: { data, fPort, confirmed }` and bypass the codec, which is what
   * the raw-downlink path needs and what no codec can express generically.
   */
  private async sendLorawanDownlink(
    device: { id: string; deviceKey: string; protocol?: string | null; metadata?: any },
    command: DeviceCommand,
  ): Promise<boolean> {
    if (!LORAWAN_NETWORK_PROTOCOLS.has(String(device.protocol))) return false;

    const downlink = this.resolveLorawanDownlinkService();
    if (!downlink) {
      this.logger.warn(
        `LorawanDownlinkService is not available — falling back to the MQTT ` +
          `branch for ${device.deviceKey}, which will not reach its network server.`,
      );
      return false;
    }

    const request = this.buildLorawanDownlink(device, command);

    // Errors propagate: `sendCommand()`'s callers treat a throw as "this
    // command failed" (DeviceCommandsConsumer marks the row FAILED and retries,
    // the HTTP route answers 5xx). Swallowing one here would restore exactly
    // the silent-success behaviour this branch exists to remove.
    const result = await downlink.enqueue(device as any, request);

    this.logger.log(
      `LoRaWAN downlink queued → ${device.deviceKey} via ${result.network} ` +
        `(fPort ${result.fPort}, ${result.queueItemId ?? 'no queue id'})`,
    );

    this.eventEmitter.emit('device.command.sent', {
      deviceId: device.id,
      deviceKey: device.deviceKey,
      tenantId: (device as any).tenantId,
      customerId: (device as any).customerId,
      command: command.method,
      params: command.params,
      transport: result.network,
      // Not "sent": the network server holds it until the device's next
      // uplink opens a receive window.
      queued: true,
    });

    return true;
  }

  /** Bytes + fPort + confirmed, from an explicit payload or from the codec. */
  private buildLorawanDownlink(
    device: { deviceKey: string; metadata?: any },
    command: DeviceCommand,
  ): { data: string; fPort: number; confirmed?: boolean; reference?: string } {
    const params = (command.params ?? {}) as Record<string, any>;

    // Raw passthrough. `data` is base64 (the wire format); `hex` is accepted
    // because every Milesight codec in this repo emits hex and an operator
    // reading codec documentation has hex in front of them.
    const rawBase64 =
      typeof params.data === 'string'
        ? params.data
        : typeof params.payload === 'string'
          ? params.payload
          : undefined;
    const rawHex = typeof params.hex === 'string' ? params.hex : undefined;

    if (rawBase64 || rawHex) {
      return {
        data: rawHex
          ? Buffer.from(rawHex.replace(/\s+/g, ''), 'hex').toString('base64')
          : rawBase64!,
        fPort: Number(params.fPort ?? params.port ?? 1),
        confirmed: params.confirmed === true,
        reference: command.method,
      };
    }

    const encoded = this.codecRegistry.encode(
      { type: command.method, params: command.params },
      { codecId: device.metadata?.codecId as string },
    );

    return {
      // Codecs in this repo return hex; the network servers take base64.
      data: Buffer.from(encoded.data, 'hex').toString('base64'),
      fPort: encoded.fPort ?? 1,
      confirmed: encoded.confirmed ?? false,
      reference: command.method,
    };
  }

  /** Memoised ModuleRef lookup — see `sendLorawanDownlink()`. */
  private resolveLorawanDownlinkService(): LorawanDownlinkPort | null {
    if (this.lorawanDownlink !== undefined) return this.lorawanDownlink;
    try {
      this.lorawanDownlink = this.moduleRef.get<LorawanDownlinkPort>(
        'LorawanDownlinkService',
        { strict: false },
      );
    } catch (error) {
      this.logger.warn(
        `Could not resolve LorawanDownlinkService: ${(error as Error).message}`,
      );
      this.lorawanDownlink = null;
    }
    return this.lorawanDownlink;
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