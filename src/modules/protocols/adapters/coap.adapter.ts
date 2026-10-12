// src/modules/protocols/adapters/coap.adapter.ts
// CoAP Protocol Adapter — ThingsBoard-compatible device API over UDP.

import {
  Injectable,
  OnModuleInit,
  OnModuleDestroy,
  Logger,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
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
import { Lwm2mService } from '@/modules/protocols/lwm2m/lwm2m.service';
import { RpcCorrelatorService } from '@/modules/protocols/rpc-correlator.service';
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
 *                                                            / RPC response
 *
 * ── LwM2M routes (same UDP socket) ────────────────────────────────────────
 *   POST   coap://host:5683/rd?ep={endpoint}&lt=&b=&lwm2m=  → Register
 *   POST   coap://host:5683/rd/{registrationId}             → Update
 *   DELETE coap://host:5683/rd/{registrationId}             → De-register
 *   POST   coap://host:5683/dp?ep={endpoint}                → Send (SenML JSON)
 *
 * Handled by Lwm2mService. Registration and client-initiated reporting ONLY —
 * no Observe/Notify, no server-initiated Read/Write/Execute, no Bootstrap, no
 * DTLS. `GET /lwm2m/capabilities` (HTTP) serves that scope list for the UI.
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
  private readonly port: number;
  private readonly enabled: boolean;
  private readonly defaultDeviceHost: string;
  private server: coap.CoapServer | null = null;
  private isStarted = false;

  constructor(
    private readonly deviceListener: DeviceListenerService,
    private readonly attributesService: AttributesService,
    private readonly firmwareService: FirmwareService,
    private readonly lwm2mService: Lwm2mService,
    private readonly rpcCorrelator: RpcCorrelatorService,
    @InjectRepository(Device)
    private readonly deviceRepository: Repository<Device>,
    private readonly configService: ConfigService,
  ) {
    this.port = Number(this.configService.get<string>('COAP_PORT') ?? 5683);
    this.enabled = this.configService.get<string>('COAP_ENABLED') !== 'false';
    // Used only when a device row has no ipAddress recorded. 'localhost' was
    // the old fallback, which silently pointed downlinks at the server itself.
    this.defaultDeviceHost =
      this.configService.get<string>('COAP_DEFAULT_DEVICE_HOST') ?? '';
  }

  // ── Lifecycle ─────────────────────────────────────────────────────────────

  async onModuleInit(): Promise<void> {
    // CoAP starts automatically with the app; opt out with COAP_ENABLED=false.
    if (!this.enabled) {
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

    // LwM2M registration lifetimes are only meaningful while the socket that
    // receives registration updates is open, so the expiry sweep is tied to
    // the server's lifecycle rather than to module init. COAP_ENABLED=false
    // therefore leaves no stray timer behind.
    this.lwm2mService.startExpirySweep();
  }

  async stop(): Promise<void> {
    this.lwm2mService.stopExpirySweep();
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
    const rawUrl: string = req.url || '';
    const path: string = rawUrl.split('?')[0];
    this.logger.log(`CoAP ${method} ${path}`);

    const parts = path.split('/').filter(Boolean);

    // ── LwM2M shares this socket ────────────────────────────────────────────
    // /rd and /dp are the LwM2M registration and reporting interfaces. They
    // are checked before the /api/v1 shape because they are top-level paths
    // defined by the LwM2M specification and cannot be moved under /api/v1.
    if (parts[0] === 'rd') {
      return this.handleLwm2mRegistration(method, parts, rawUrl, req, res);
    }
    if (parts[0] === 'dp') {
      return this.handleLwm2mSend(method, rawUrl, req, res);
    }

    // Expected: /api/v1/{deviceToken}/{resource}
    if (parts.length < 4 || parts[0] !== 'api' || parts[1] !== 'v1') {
      this.safeRespond(res, '4.00', {
        error:
          'Invalid path. Use /api/v1/{deviceToken}/{telemetry|attributes|rpc}, ' +
          'or the LwM2M paths /rd and /dp.',
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

    // A device POSTs here for two different reasons, distinguished by whether
    // the `id` matches something the platform is waiting on:
    //
    //   1. It is ANSWERING a server-issued RPC. The id correlates, so the
    //      pending request is resolved through the same RpcCorrelatorService
    //      that the MQTT path uses — one pending map, one timeout policy, one
    //      place where the outcome gets persisted.
    //   2. It is INITIATING an RPC of its own (ThingsBoard's client-side RPC).
    //      Nothing is waiting on that id, so it is acknowledged, as before.
    //
    // Case 1 is why `sendRpcRequest` can target a CoAP device at all.
    const matched = this.rpcCorrelator.resolveResponse({
      requestId: payload?.id,
      payload,
      via: 'coap',
      deviceKey: device.deviceKey,
    });

    if (matched) {
      this.logger.log(
        `CoAP RPC response from ${device.deviceKey} resolved pending request ${payload.id}`,
      );
      this.safeRespond(res, '2.04', { id: payload.id, result: 'correlated' });
      return;
    }

    this.logger.log(
      `CoAP device-initiated RPC from ${device.deviceKey}: method=${payload?.method ?? 'unknown'} ` +
        '(no pending server request with this id)',
    );
    this.safeRespond(res, '2.05', {
      id: payload?.id ?? null,
      method: payload?.method ?? null,
      result: 'accepted',
    });
  }

  // ── LwM2M: registration interface (/rd) ───────────────────────────────────

  /**
   * POST   /rd?ep=&lt=&b=&lwm2m=   → 2.01 Created + Location-Path /rd/{id}
   * POST   /rd/{registrationId}    → 2.04 Changed
   * DELETE /rd/{registrationId}    → 2.02 Deleted
   *
   * Response codes follow LwM2M/RFC 7252: 4.00 malformed, 4.03 the endpoint is
   * not a known device (never auto-provisioned), 4.04 unknown registration id,
   * 4.05 wrong method.
   */
  private async handleLwm2mRegistration(
    method: string,
    parts: string[],
    rawUrl: string,
    req: any,
    res: any,
  ): Promise<void> {
    const query = this.parseQuery(rawUrl);
    const body = this.payloadAsString(req);
    const { address, port } = this.sourceOf(req);
    const registrationId = parts[1];

    // ── Register ────────────────────────────────────────────────────────────
    if (!registrationId) {
      if (method !== 'POST') return this.methodNotAllowed(res, method, 'rd');

      const result = await this.lwm2mService.register({
        endpoint: query.ep,
        lifetime: query.lt !== undefined ? Number(query.lt) : undefined,
        binding: query.b,
        version: query.lwm2m,
        payload: body,
        address,
        port,
      });

      if (!result.ok) {
        this.safeRespond(res, result.code, { error: result.error });
        return;
      }

      // LwM2M clients read the registration id from Location-Path and use it
      // for Update/De-register, so this option is load-bearing, not cosmetic.
      // The values MUST be Buffers: coap-packet serialises each option with
      // `value.copy(...)`, so a plain string fails at res.end() with
      // "value.copy is not a function" — the response is simply never sent and
      // the client times out.
      try {
        res.setOption('Location-Path', [
          Buffer.from('rd'),
          Buffer.from(result.value.registrationId),
        ]);
      } catch (error) {
        this.logger.warn(
          `Could not set Location-Path on LwM2M registration response: ${(error as Error).message}`,
        );
      }
      this.safeRespond(res, '2.01', {
        registrationId: result.value.registrationId,
        location: `/rd/${result.value.registrationId}`,
        lifetime: result.value.lifetime,
        binding: result.value.binding,
      });
      return;
    }

    // ── Update ──────────────────────────────────────────────────────────────
    if (method === 'POST') {
      const result = await this.lwm2mService.update(registrationId, {
        lifetime: query.lt !== undefined ? Number(query.lt) : undefined,
        binding: query.b,
        payload: body,
        address,
        port,
      });
      if (!result.ok) {
        this.safeRespond(res, result.code, { error: result.error });
        return;
      }
      this.safeRespond(res, '2.04', {
        registrationId,
        lifetime: result.value.lifetime,
        expiresAt: result.value.expiresAt.toISOString(),
      });
      return;
    }

    // ── De-register ─────────────────────────────────────────────────────────
    if (method === 'DELETE') {
      const result = await this.lwm2mService.deregister(registrationId);
      if (!result.ok) {
        this.safeRespond(res, result.code, { error: result.error });
        return;
      }
      this.safeRespond(res, '2.02', { registrationId, status: 'deregistered' });
      return;
    }

    return this.methodNotAllowed(res, method, 'rd/{registrationId}');
  }

  // ── LwM2M: Send (/dp) ─────────────────────────────────────────────────────

  /**
   * POST /dp?ep={endpoint} with a SenML JSON body → 2.04 Changed.
   *
   * Readings go through `DeviceListenerService.handleTelemetry()` — the same
   * unified path as MQTT/HTTP/CoAP telemetry — so they get codec decode, the
   * Kafka publish, alarm evaluation and WebSocket broadcast.
   */
  private async handleLwm2mSend(
    method: string,
    rawUrl: string,
    req: any,
    res: any,
  ): Promise<void> {
    if (method !== 'POST') return this.methodNotAllowed(res, method, 'dp');

    const query = this.parseQuery(rawUrl);
    const { address, port } = this.sourceOf(req);

    const result = await this.lwm2mService.handleSend({
      endpoint: query.ep,
      payload: req?.payload,
      // Content-Format 110 = application/senml+json. Recorded for diagnostics;
      // the parser decides by payload shape so a client that omits the option
      // still works.
      contentFormat: req?.headers?.['Content-Format'],
      address,
      port,
    });

    if (!result.ok) {
      this.safeRespond(res, result.code, { error: result.error });
      return;
    }

    this.safeRespond(res, '2.04', {
      endpoint: result.value.endpoint,
      keys: Object.keys(result.value.values),
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
    // Per-device override, then the configured default. Dynamic env keys like
    // COAP_DEVICE_<key>_IP are kept for compatibility but are not a scalable
    // mechanism — the device row's ipAddress is the intended source.
    const resolved =
      device?.ipAddress ||
      this.configService.get<string>(`COAP_DEVICE_${deviceKey}_IP`) ||
      this.defaultDeviceHost;

    if (!resolved) {
      throw new Error(
        `No IP address known for device ${deviceKey}. Set the device's ipAddress or configure COAP_DEFAULT_DEVICE_HOST.`,
      );
    }
    return resolved;
  }

  /**
   * CoAP Uri-Query options, as `req.url`'s query string.
   *
   * The /api/v1 routes discard the query (they have no use for it), but LwM2M
   * carries the endpoint name, lifetime and binding there, so it is parsed
   * rather than dropped. A repeated key keeps the first value; a bare key
   * (`?obs`) becomes an empty string.
   */
  private parseQuery(rawUrl: string): Record<string, string | undefined> {
    const queryString = rawUrl.split('?').slice(1).join('?');
    if (!queryString) return {};

    const out: Record<string, string> = {};
    for (const pair of queryString.split('&')) {
      if (!pair) continue;
      const eq = pair.indexOf('=');
      const key = decodeURIComponent(eq === -1 ? pair : pair.slice(0, eq));
      if (!key || key in out) continue;
      out[key] = eq === -1 ? '' : decodeURIComponent(pair.slice(eq + 1));
    }
    return out;
  }

  /** Raw request body as text (CoRE Link Format / SenML JSON), never undefined. */
  private payloadAsString(req: any): string {
    return req?.payload ? req.payload.toString('utf8') : '';
  }

  /**
   * Source address of the datagram. Used only as a fallback for identifying a
   * /dp sender that omitted `?ep=` — it is not authentication (there is no
   * DTLS; see lwm2m.scope.ts).
   */
  private sourceOf(req: any): { address?: string; port?: number } {
    const rsinfo = req?.rsinfo;
    if (!rsinfo) return {};
    return { address: rsinfo.address, port: rsinfo.port };
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
