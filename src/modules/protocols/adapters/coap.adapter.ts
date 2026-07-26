// src/modules/protocols/adapters/coap.adapter.ts
// CoAP Protocol Adapter — ThingsBoard-compatible device API over UDP.

import {
  Injectable,
  OnModuleInit,
  OnModuleDestroy,
  Logger,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import {
  StandardTelemetry,
  IProtocolAdapter,
} from '@/common/interfaces/standard-telemetry.interface';
import { DeviceListenerService } from '@/modules/protocols/device-listener.service';
import { AttributesService } from '@/modules/attributes/attributes.service';
import { FirmwareService } from '@/modules/firmware/firmware.service';
import { OtaStatusDto } from '@/modules/firmware/dto/ota-status.dto';
import { AttributeScope } from '@common/enums/index.enum';
import { Device } from '@modules/devices/entities/device.entity';
import type { User } from '@modules/users/entities/user.entity';
import * as coap from 'coap';

/**
 * CoAP Adapter — Production Ready
 *
 * CoAP (Constrained Application Protocol, RFC 7252) is a lightweight
 * request/response protocol for constrained IoT devices, running over UDP.
 * This adapter mirrors ThingsBoard's CoAP device API so existing firmware
 * targeting ThingsBoard works unchanged.
 *
 * ── Routes (device token embedded in the path) ────────────────────────────
 *   POST coap://host:5683/api/v1/{deviceToken}/telemetry   → ingest telemetry
 *   POST coap://host:5683/api/v1/{deviceToken}/attributes  → set attributes
 *   GET  coap://host:5683/api/v1/{deviceToken}/attributes  → read attributes
 *   POST coap://host:5683/api/v1/{deviceToken}/rpc         → RPC request
 *
 * ── Device authentication ─────────────────────────────────────────────────
 * The {deviceToken} segment is the platform-wide unique `deviceKey` — the same
 * identifier used by the MQTT and HTTP ingestion paths. An unknown token is
 * rejected with 4.04 (Not Found).
 *
 * ── Response codes ────────────────────────────────────────────────────────
 *   2.05 Content               → success
 *   4.00 Bad Request           → payload is not valid JSON / malformed path
 *   4.04 Not Found             → unknown device token / unknown resource
 *   4.05 Method Not Allowed    → wrong CoAP method for the resource
 *   5.00 Internal Server Error → unexpected failure
 *
 * Enabled by default; set COAP_ENABLED=false to disable. Port via COAP_PORT
 * (default 5683). Installation: `npm install coap`.
 */
@Injectable()
export class CoAPAdapter
  implements IProtocolAdapter, OnModuleInit, OnModuleDestroy
{
  protocol = 'coap';
  private readonly logger = new Logger(CoAPAdapter.name);
  private readonly port = parseInt(process.env.COAP_PORT || '5683', 10);
  private server: coap.CoapServer | null = null;
  private isStarted = false;

  constructor(
    private readonly deviceListener: DeviceListenerService,
    private readonly attributesService: AttributesService,
    private readonly firmwareService: FirmwareService,
    @InjectRepository(Device)
    private readonly deviceRepository: Repository<Device>,
  ) {}

  // ── Lifecycle ─────────────────────────────────────────────────────────────

  async onModuleInit(): Promise<void> {
    // CoAP starts automatically with the app; opt out with COAP_ENABLED=false.
    if (process.env.COAP_ENABLED === 'false') {
      this.logger.warn('CoAP adapter disabled (COAP_ENABLED=false)');
      return;
    }
    await this.start();
  }

  async onModuleDestroy(): Promise<void> {
    await this.stop();
  }

  async start(): Promise<void> {
    if (this.isStarted) {
      this.logger.warn('CoAP adapter already started');
      return;
    }

    this.server = coap.createServer({ type: 'udp4' });

    this.server.on('request', (req: any, res: any) => {
      // Never let a rejected handler take down the UDP server.
      this.handleRequest(req, res).catch((error) => {
        this.logger.error(`Unhandled CoAP error: ${(error as Error).message}`);
        this.safeRespond(res, '5.00', { error: 'Internal server error' });
      });
    });

    this.server.on('error', (error: Error) => {
      this.logger.error(`CoAP server error: ${error.message}`);
    });

    await new Promise<void>((resolve) => {
      this.server!.listen(this.port, () => {
        // NOTE: keep this exact message — deploy checks grep for it.
        this.logger.log(`CoAP server listening on port ${this.port}`);
        resolve();
      });
    });

    this.isStarted = true;
  }

  async stop(): Promise<void> {
    if (!this.server) return;
    this.logger.log('Stopping CoAP adapter...');
    try {
      this.server.close();
    } catch (error) {
      this.logger.error(
        `Error closing CoAP server: ${(error as Error).message}`,
      );
    }
    this.server = null;
    this.isStarted = false;
    this.logger.log('CoAP adapter stopped');
  }

  // ── Request routing ───────────────────────────────────────────────────────

  private async handleRequest(req: any, res: any): Promise<void> {
    const method: string = req.method || 'GET';
    const path: string = (req.url || '').split('?')[0];
    this.logger.log(`CoAP ${method} ${path}`);

    // Expected: /api/v1/{deviceToken}/{resource}
    const parts = path.split('/').filter(Boolean);
    if (parts.length < 4 || parts[0] !== 'api' || parts[1] !== 'v1') {
      this.safeRespond(res, '4.00', {
        error:
          'Invalid path. Use /api/v1/{deviceToken}/{telemetry|attributes|rpc}',
      });
      return;
    }

    const deviceToken = parts[2];
    const resource = parts[3];
    const subResource = parts[4];

    // ── Authenticate device by token ────────────────────────────────────────
    const device = await this.findDeviceByToken(deviceToken);
    if (!device) {
      this.logger.warn(`CoAP rejected — unknown device token: ${deviceToken}`);
      this.safeRespond(res, '4.04', { error: 'Device not found' });
      return;
    }

    // ── Dispatch ────────────────────────────────────────────────────────────
    switch (resource) {
      case 'telemetry':
        if (method !== 'POST')
          return this.methodNotAllowed(res, method, resource);
        return this.handleTelemetry(device, req, res);

      case 'attributes':
        if (method === 'POST')
          return this.handleSetAttributes(device, req, res);
        if (method === 'GET') return this.handleGetAttributes(device, res);
        return this.methodNotAllowed(res, method, resource);

      case 'rpc':
        if (method !== 'POST')
          return this.methodNotAllowed(res, method, resource);
        return this.handleRpc(device, req, res);

      case 'firmware':
        // GET  /api/v1/{token}/firmware         → check for a pending update
        // POST /api/v1/{token}/firmware/status  → report OTA progress
        // Binary transfer is intentionally NOT over CoAP (RFC 7959 block-wise
        // is out of scope); devices fetch the binary via the HTTP downloadUrl.
        if (subResource === 'status') {
          if (method !== 'POST')
            return this.methodNotAllowed(res, method, 'firmware/status');
          return this.handleFirmwareStatus(deviceToken, req, res);
        }
        if (method !== 'GET')
          return this.methodNotAllowed(res, method, 'firmware');
        return this.handleFirmwareCheck(deviceToken, res);

      default:
        this.safeRespond(res, '4.04', {
          error: `Unknown resource: ${resource}`,
        });
    }
  }

  // ── Telemetry ─────────────────────────────────────────────────────────────

  private async handleTelemetry(
    device: Device,
    req: any,
    res: any,
  ): Promise<void> {
    const payload = this.tryParseJson(req);
    if (payload === undefined) {
      this.safeRespond(res, '4.00', { error: 'Invalid JSON payload' });
      return;
    }

    // Route through the unified DeviceListenerService entry point — same path
    // the MQTT and HTTP adapters use (codec decode → device activity update →
    // Kafka → persistence + WebSocket broadcast + alarm/automation triggers).
    const telemetry = this.parse(payload, device);
    await this.deviceListener.handleTelemetry(telemetry);

    this.logger.log(`CoAP telemetry accepted — device: ${device.deviceKey}`);
    this.safeRespond(res, '2.05', { status: 'ok' });
  }

  // ── Attributes ────────────────────────────────────────────────────────────

  private async handleSetAttributes(
    device: Device,
    req: any,
    res: any,
  ): Promise<void> {
    const payload = this.tryParseJson(req);
    if (
      payload === undefined ||
      typeof payload !== 'object' ||
      Array.isArray(payload)
    ) {
      this.safeRespond(res, '4.00', {
        error: 'Invalid JSON payload — expected an object',
      });
      return;
    }

    // AttributesService is user-scoped; a device-authenticated request has no
    // human user, so we act as the device's owner (id + tenantId are all that
    // saveAttributes reads). CLIENT scope = device-reported attributes.
    const actor = { id: device.userId, tenantId: device.tenantId } as User;
    await this.attributesService.saveAttributes(
      actor,
      'device',
      device.id,
      AttributeScope.CLIENT,
      payload,
    );

    this.logger.log(
      `CoAP attributes saved — device: ${device.deviceKey}, keys: [${Object.keys(payload).join(', ')}]`,
    );
    this.safeRespond(res, '2.05', { status: 'ok' });
  }

  private async handleGetAttributes(device: Device, res: any): Promise<void> {
    const [client, shared] = await Promise.all([
      this.attributesService.findByEntity(
        device.tenantId,
        'device',
        device.id,
        AttributeScope.CLIENT,
      ),
      this.attributesService.findByEntity(
        device.tenantId,
        'device',
        device.id,
        AttributeScope.SHARED,
      ),
    ]);
    this.safeRespond(res, '2.05', { client, shared });
  }

  // ── RPC ───────────────────────────────────────────────────────────────────

  private async handleRpc(device: Device, req: any, res: any): Promise<void> {
    const payload = this.tryParseJson(req);
    if (payload === undefined) {
      this.safeRespond(res, '4.00', { error: 'Invalid JSON payload' });
      return;
    }

    // ThingsBoard RPC request shape: { id, method, params }.
    // Server-side RPC dispatch (matching against a pending-command queue and
    // returning a device-command response) is not wired yet — we acknowledge
    // receipt so device-initiated RPC does not error. TODO: integrate with
    // DeviceCommandsService for two-way RPC.
    this.logger.log(
      `CoAP RPC from ${device.deviceKey}: method=${payload?.method ?? 'unknown'}`,
    );
    this.safeRespond(res, '2.05', {
      id: payload?.id ?? null,
      method: payload?.method ?? null,
      result: 'accepted',
    });
  }

  // ── Firmware / OTA (BUILD 5) ──────────────────────────────────────────────

  private async handleFirmwareCheck(
    deviceToken: string,
    res: any,
  ): Promise<void> {
    const result = await this.firmwareService.checkForDevice(deviceToken);
    this.logger.log(
      `CoAP firmware check — device: ${deviceToken}, updateAvailable: ${result.updateAvailable}`,
    );
    this.safeRespond(res, '2.05', result);
  }

  private async handleFirmwareStatus(
    deviceToken: string,
    req: any,
    res: any,
  ): Promise<void> {
    const payload = this.tryParseJson(req);
    if (payload === undefined || typeof payload !== 'object') {
      this.safeRespond(res, '4.00', { error: 'Invalid JSON payload' });
      return;
    }
    const result = await this.firmwareService.reportStatus(
      deviceToken,
      payload as OtaStatusDto,
    );
    this.logger.log(
      `CoAP firmware status — device: ${deviceToken}, status: ${payload.status}`,
    );
    this.safeRespond(res, '2.05', result);
  }

  // ── StandardTelemetry mapping ─────────────────────────────────────────────

  parse(rawPayload: any, context?: any): StandardTelemetry {
    const device: Partial<Device> = context || {};
    const payload = rawPayload || {};
    return {
      deviceId: device.id ?? '',
      deviceKey: device.deviceKey ?? '',
      tenantId: device.tenantId,
      customerId: device.customerId,
      data: payload,
      temperature: payload.temperature ?? payload.temp,
      humidity: payload.humidity ?? payload.hum,
      pressure: payload.pressure,
      batteryLevel: payload.battery ?? payload.batteryLevel ?? payload.bat,
      signalStrength: payload.rssi ?? payload.signalStrength,
      timestamp: payload.timestamp || new Date().toISOString(),
      receivedAt: Date.now(),
      protocol: 'coap',
      metadata: {
        coapMethod: 'POST',
        coapPath: `/api/v1/${device.deviceKey ?? ''}/telemetry`,
      },
      rawPayload: payload,
    };
  }

  // ── Outbound command (bi-directional CoAP) ────────────────────────────────

  async sendCommand(deviceKey: string, command: any): Promise<void> {
    const host = await this.getDeviceIp(deviceKey);
    const req = coap.request({
      host,
      port: this.port,
      pathname: `/api/v1/${deviceKey}/rpc`,
      method: 'POST',
      confirmable: true,
    });
    req.write(JSON.stringify(command));
    req.on('response', (res: any) =>
      this.logger.log(
        `CoAP command sent to ${deviceKey} — response: ${res.code}`,
      ),
    );
    req.on('error', (error: Error) =>
      this.logger.error(
        `Failed to send CoAP command to ${deviceKey}: ${error.message}`,
      ),
    );
    req.end();
  }

  // ── Helpers ───────────────────────────────────────────────────────────────

  /** Device token == deviceKey (unique across the platform). */
  private async findDeviceByToken(token: string): Promise<Device | null> {
    return this.deviceRepository.findOne({ where: { deviceKey: token } });
  }

  private async getDeviceIp(deviceKey: string): Promise<string> {
    const device = await this.deviceRepository.findOne({
      where: { deviceKey },
      select: ['ipAddress'],
    });
    return (
      device?.ipAddress ||
      process.env[`COAP_DEVICE_${deviceKey}_IP`] ||
      'localhost'
    );
  }

  /** Returns the parsed object, or `undefined` when the body is not valid JSON. */
  private tryParseJson(req: any): any {
    try {
      const raw = req?.payload ? req.payload.toString('utf8') : '';
      if (!raw) return {};
      return JSON.parse(raw);
    } catch {
      return undefined;
    }
  }

  private methodNotAllowed(res: any, method: string, resource: string): void {
    this.logger.warn(`CoAP method ${method} not allowed on ${resource}`);
    this.safeRespond(res, '4.05', {
      error: `Method ${method} not allowed on ${resource}`,
    });
  }

  private safeRespond(res: any, code: string, body?: any): void {
    try {
      res.code = code;
      res.end(body !== undefined ? JSON.stringify(body) : undefined);
    } catch (error) {
      this.logger.error(
        `Failed to send CoAP response: ${(error as Error).message}`,
      );
    }
  }
}
