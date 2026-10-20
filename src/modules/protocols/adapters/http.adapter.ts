// src/modules/protocols/adapters/http.adapter.ts
// HTTP Protocol Adapter - Receives webhooks from ANY device/gateway

import { DeviceAuthService } from '@modules/device-auth/device-auth.service';
import {
  Injectable,
  Controller,
  Post,
  Body,
  Param,
  Headers,
  HttpCode,
  Logger,
} from '@nestjs/common';
import {
  StandardTelemetry,
  IProtocolAdapter,
} from '@/common/interfaces/standard-telemetry.interface';
import { ConfigService } from '@nestjs/config';
import { timingSafeEqual } from 'crypto';
import { DeviceListenerService } from '@/modules/protocols/device-listener.service';
import { Public } from '@common/decorators/public.decorator';

@Injectable()
@Controller('v1/ingestion')
export class HTTPAdapter implements IProtocolAdapter {
  protocol = 'http';
  private readonly logger = new Logger(HTTPAdapter.name);


  constructor(
    private readonly deviceListener: DeviceListenerService,
    private readonly configService: ConfigService,
    private readonly deviceAuth: DeviceAuthService,
  ) {}

  /**
   * Device API-key check for the public ingestion endpoints.
   *
   * Two things were wrong with the inline version this replaces:
   *
   *   1. It read process.env on every request, bypassing config validation.
   *   2. `apiKey !== process.env.DEVICE_API_KEY` compares with early exit, so
   *      response time leaks how many leading characters matched. That is a
   *      practical attack against an unauthenticated ingestion endpoint.
   *      timingSafeEqual takes constant time.
   *
   * Also closes a fail-open case: if REQUIRE_API_KEY was true but
   * DEVICE_API_KEY was unset, both sides were undefined and every request with
   * no key passed. Missing configuration now denies.
   */
  private isApiKeyValid(apiKey?: string): boolean {
    const required =
      this.configService.get<string>('REQUIRE_API_KEY') === 'true';
    if (!required) return true;

    const expected = this.configService.get<string>('DEVICE_API_KEY');
    if (!expected) {
      this.logger.error(
        'REQUIRE_API_KEY is enabled but DEVICE_API_KEY is not set — rejecting all device ingestion',
      );
      return false;
    }
    if (!apiKey) return false;

    const provided = Buffer.from(apiKey);
    const secret = Buffer.from(expected);
    // Length must match before timingSafeEqual, which throws on unequal
    // buffers. Length alone is not a useful oracle here.
    if (provided.length !== secret.length) return false;

    return timingSafeEqual(provided, secret);
  }

  async start(): Promise<void> {
    console.log('✅ HTTP Adapter ready (runs with NestJS server)');
  }

  async stop(): Promise<void> {
    console.log('✅ HTTP Adapter stopped');
  }

  // ── ROUTE ORDER IS LOAD BEARING ──────────────────────────────────────
  //
  // `batch` is declared BEFORE `:deviceId`. Nest matches in declaration
  // order, so with the parameterised route first every POST to
  // /v1/ingestion/batch was captured by `ingest()` with deviceId='batch'
  // — the batch handler below was unreachable dead code, and a batch
  // client was silently treated as a single device literally named
  // 'batch'. Moving a static segment above a parameter is the fix; do not
  // reorder these two back.

  /**
   * Batch ingestion endpoint
   * POST /api/v1/ingestion/batch
   * Body: { devices: [{ deviceId: "...", data: {...}, token?: "..." }] }
   *
   * This was the widest hole in the platform: it accepted an array of
   * arbitrary deviceIds behind nothing but an optional platform-wide shared
   * key, so one request could forge readings for every device of every
   * tenant at once.
   *
   * Two things now gate it:
   *
   *   1. The CALLER must authenticate, exactly as the single-device route
   *      requires. There is no anonymous batch.
   *   2. Each entry must either carry its own `token`, or name a device in
   *      the SAME TENANT as the authenticated caller.
   *
   * The tenant bound is the honest limit of what can be enforced today: this
   * platform has no gateway-to-child-device model (no `isGateway` flag, no
   * connector configuration), so there is nothing that says "gateway G speaks
   * for devices X, Y, Z". Until that exists, same-tenant is the tightest rule
   * that keeps batch usable, and it removes cross-tenant forgery entirely.
   * Per-entry tokens are the way to be strict now.
   */
  @Post('batch')
  @Public()
  @HttpCode(200)
  async ingestBatch(
    @Body()
    payload: {
      devices: Array<{ deviceId: string; data: any; token?: string }>;
    },
    @Headers('x-api-key') apiKey?: string,
    @Headers('authorization') authorization?: string,
    @Headers('x-device-token') deviceToken?: string,
  ) {
    try {
      if (process.env.REQUIRE_API_KEY === 'true') {
        if (!apiKey || apiKey !== process.env.DEVICE_API_KEY) {
          return { success: false, error: 'Invalid API key' };
        }
      }

      if (!Array.isArray(payload?.devices)) {
        return { success: false, error: 'Invalid payload' };
      }

      const bearer = authorization?.toLowerCase().startsWith('bearer ')
        ? authorization.slice(7).trim()
        : undefined;
      const callerToken = bearer ?? deviceToken;

      const caller = callerToken
        ? await this.deviceAuth.authenticate({
            kind: 'token',
            token: callerToken,
          })
        : null;

      if (!caller && this.deviceAuth.isEnforced) {
        return { success: false, error: 'Unauthorized' };
      }

      const results: any = [];

      for (const device of payload.devices) {
        try {
          // An entry's own token always wins. Otherwise the entry is allowed
          // only within the caller's tenant.
          let target: { deviceKey: string; tenantId: string } | null = null;

          if (device.token) {
            // Strict path: the entry proves its own identity.
            const authed = await this.deviceAuth.authenticate({
              kind: 'token',
              token: device.token,
            });
            target = authed
              ? {
                  deviceKey: authed.device.deviceKey,
                  tenantId: authed.device.tenantId,
                }
              : null;
          } else if (caller) {
            // Delegated path: the CALLER has authenticated, and may write for
            // devices in its own tenant. `lookupByDeviceKey` is a lookup, not
            // an authentication — the tenant comparison below is what
            // authorises it.
            const found = await this.deviceAuth.lookupByDeviceKey(
              device.deviceId,
            );
            if (found && found.tenantId === caller.device.tenantId) {
              target = {
                deviceKey: found.deviceKey,
                tenantId: found.tenantId,
              };
            }
          } else if (!this.deviceAuth.isEnforced) {
            // Enforcement explicitly disabled — legacy behaviour.
            const found = await this.deviceAuth.lookupByDeviceKey(
              device.deviceId,
            );
            target = found
              ? { deviceKey: found.deviceKey, tenantId: found.tenantId }
              : null;
          }

          if (!target) {
            results.push({
              deviceId: device.deviceId,
              success: false,
              error: 'Unauthorized',
            });
            continue;
          }

          const standardTelemetry: any = this.parse(device.data, {
            deviceId: target.deviceKey,
          });
          await this.deviceListener.handleTelemetry(standardTelemetry);
          results.push({ deviceId: device.deviceId, success: true });
        } catch {
          results.push({
            deviceId: device.deviceId,
            success: false,
            error: 'Ingestion failed',
          });
        }
      }

      return {
        success: true,
        totalDevices: payload.devices.length,
        successCount: results.filter((r) => r.success).length,
        failureCount: results.filter((r) => !r.success).length,
        results,
      };
    } catch (error: any) {
      console.error('❌ Batch ingestion failed:', error);
      return { success: false, error: error.message };
    }
  }

  /**
   * Generic device ingestion — POST /api/v1/ingestion/:deviceKey
   *
   * `@Public()` is what makes this usable by a device. The route was documented
   * as a PUBLIC ENDPOINT but carried no decorator, and JwtAuthGuard is
   * registered globally as an APP_GUARD — so every bare device POST got a 401.
   * The only clients that could reach it were ones holding a signed-in user's
   * Bearer token, which no device has.
   *
   * AUTHENTICATION — this used to be the hole.
   *
   * The path segment was treated as BOTH the identifier and the secret: a
   * deviceKey alone was enough to post telemetry as that device. A deviceKey
   * is not a secret — it appears in URLs, MQTT topics, logs and the UI.
   *
   * Now every request must carry a real per-device credential, verified by
   * `DeviceAuthService` against `device_credentials`:
   *
   *   Authorization: Bearer <accessToken>     (preferred)
   *   x-device-token: <accessToken>           (for constrained clients)
   *
   * ThingsBoard's own convention is also accepted, where the path segment IS
   * the access token rather than the deviceKey — so a device fleet already
   * built against `POST /api/v1/{token}/telemetry` works unchanged.
   *
   * The device is resolved FROM THE CREDENTIAL, never from the path. That
   * ordering is the point: a valid token for device A cannot be used to post
   * as device B by changing the URL.
   *
   * `x-api-key` remains as an optional platform-wide gate in front of all of
   * this. It is defence in depth, not authentication — it identifies no one.
   */
  @Post(':deviceId')
  @Public()
  @HttpCode(200)
  async ingest(
    @Param('deviceId') deviceId: string,
    @Body() payload: any,
    @Headers('x-api-key') apiKey?: string,
    @Headers('user-agent') userAgent?: string,
    @Headers('content-type') contentType?: string,
    @Headers('authorization') authorization?: string,
    @Headers('x-device-token') deviceToken?: string,
  ) {
    try {
      // The payload is no longer logged. It was printed in full on every
      // ingest — that is the device's data on the hot path, and for a device
      // whose payload carries a token it was a credential in the log.
      this.logger.debug(`HTTP ingest for ${deviceId}`);

      // Validate API key (optional — controlled by REQUIRE_API_KEY)
      if (!this.isApiKeyValid(apiKey)) {
        return { success: false, error: 'Invalid API key' };
      }

      const authed = await this.resolveDevice(
        deviceId,
        authorization,
        deviceToken,
      );
      if (!authed) {
        // One generic message for "no credential", "wrong credential" and
        // "unknown device". Distinguishing them turns this route into an
        // oracle for which deviceKeys and tokens exist.
        return { success: false, error: 'Unauthorized' };
      }

      // Parse to standard format. The deviceKey comes from the AUTHENTICATED
      // device, not from the URL, so a valid token cannot be pointed at
      // another device by editing the path.
      const standardTelemetry: any = this.parse(payload, {
        deviceId: authed.device.deviceKey,
        userAgent,
        contentType,
      });

      await this.deviceListener.handleTelemetry(standardTelemetry);

      return {
        success: true,
        message: 'Telemetry received',
        timestamp: new Date().toISOString(),
      };
    } catch (error: any) {
      this.logger.error(`HTTP ingestion failed: ${error?.message}`);
      return {
        success: false,
        error: 'Ingestion failed',
      };
    }
  }

  /**
   * Resolve the device from whichever credential the client supplied.
   *
   * Three shapes are accepted, in priority order:
   *   1. `Authorization: Bearer <token>`
   *   2. `x-device-token: <token>`
   *   3. the path segment itself as the token (ThingsBoard's convention)
   *
   * Only if enforcement is explicitly disabled does the path segment fall
   * back to being treated as a bare deviceKey.
   */
  private async resolveDevice(
    pathSegment: string,
    authorization?: string,
    deviceToken?: string,
  ) {
    const bearer = authorization?.toLowerCase().startsWith('bearer ')
      ? authorization.slice(7).trim()
      : undefined;

    for (const token of [bearer, deviceToken, pathSegment]) {
      if (!token) continue;
      const authed = await this.deviceAuth.authenticate({ kind: 'token', token });
      if (authed) return authed;
    }

    return this.deviceAuth.authenticate({
      kind: 'deviceKey',
      deviceKey: pathSegment,
    });
  }
  /**
   * Parse HTTP payload to StandardTelemetry
   */
  parse(rawPayload: any, context?: any): StandardTelemetry {
    const deviceId =
      context?.deviceId || rawPayload.deviceId || rawPayload.device_id;

    // Auto-detect format and parse
    let data: Record<string, any>;
    let temperature: number | undefined;
    let humidity: number | undefined;
    let pressure: number | undefined;
    let batteryLevel: number | undefined;
    let signalStrength: number | undefined;

    // Format 1: LoRaWAN/UG65 format
    if (
      rawPayload.deveui &&
      rawPayload.data &&
      typeof rawPayload.data === 'string'
    ) {
      const decoded = this.decodeHexPayload(rawPayload.data);
      temperature = decoded.temperature;
      humidity = decoded.humidity;
      pressure = decoded.pressure;
      batteryLevel = decoded.battery;
      signalStrength = rawPayload.rssi;
      data = { ...rawPayload, ...decoded };
    }
    // Format 2: Direct sensor values
    else if (
      rawPayload.temperature !== undefined ||
      rawPayload.temp !== undefined
    ) {
      temperature = rawPayload.temperature || rawPayload.temp;
      humidity = rawPayload.humidity;
      pressure = rawPayload.pressure;
      batteryLevel = rawPayload.battery || rawPayload.batteryLevel;
      signalStrength = rawPayload.rssi || rawPayload.signalStrength;
      data = rawPayload;
    }
    // Format 3: Nested data
    else if (rawPayload.data && typeof rawPayload.data === 'object') {
      temperature = rawPayload.data.temperature;
      humidity = rawPayload.data.humidity;
      pressure = rawPayload.data.pressure;
      batteryLevel = rawPayload.data.battery;
      data = rawPayload.data;
    }
    // Format 4: Unknown - store as-is
    else {
      data = rawPayload;
    }

    return {
      deviceId: deviceId,
      deviceKey: deviceId,
      tenantId: rawPayload.tenantId || 'default',
      data: data,
      temperature: temperature,
      humidity: humidity,
      pressure: pressure,
      batteryLevel: batteryLevel,
      signalStrength: signalStrength,
      timestamp: rawPayload.timestamp || new Date().toISOString(),
      receivedAt: Date.now(),
      protocol: 'http',
      metadata: {
        method: 'POST',
        endpoint: `/api/v1/ingestion/${deviceId}`,
        userAgent: context?.userAgent,
        contentType: context?.contentType,
        rssi: rawPayload.rssi,
        snr: rawPayload.snr,
      },
      rawPayload: rawPayload,
    };
  }

  /**
   * Decode hex payload (reuse from MQTT adapter logic)
   */
  private decodeHexPayload(hexData: string): any {
    try {
      const buffer = Buffer.from(hexData, 'hex');
      const result: any = {};
      let offset = 0;

      while (offset + 3 < buffer.length) {
        const channel = buffer.readUInt8(offset);
        const type = buffer.readUInt8(offset + 1);
        const value = buffer.readUInt16BE(offset + 2);

        switch (type) {
          case 0x67:
            result.temperature = (value / 10).toFixed(1);
            break;
          case 0x68:
            result.humidity = (value / 2).toFixed(1);
            break;
          case 0x73:
            result.pressure = (value / 10).toFixed(1);
            break;
          case 0x75:
            result.battery = value;
            break;
          case 0x76:
            result.motion = value === 1;
            break;
        }

        offset += 4;
      }

      return result;
    } catch (error) {
      return { hex: hexData };
    }
  }
}
