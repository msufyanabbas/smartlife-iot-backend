// src/modules/protocols/adapters/http.adapter.ts
// HTTP Protocol Adapter - Receives webhooks from ANY device/gateway

import {
  Injectable,
  Controller,
  Post,
  Body,
  Param,
  Headers,
  HttpCode,
} from '@nestjs/common';
import {
  StandardTelemetry,
  IProtocolAdapter,
} from '@/common/interfaces/standard-telemetry.interface';
import { DeviceListenerService } from '@/modules/gateway/device-listener.service';

@Injectable()
@Controller('v1/ingestion')
export class HTTPAdapter implements IProtocolAdapter {
  protocol = 'http';

  constructor(private readonly deviceListener: DeviceListenerService) {}

  async start(): Promise<void> {
    console.log('✅ HTTP Adapter ready (runs with NestJS server)');
  }

  async stop(): Promise<void> {
    console.log('✅ HTTP Adapter stopped');
  }

  /**
   * PUBLIC ENDPOINT - Generic device ingestion
   * POST /api/v1/ingestion/:deviceId
   *
   * Works with ANY device sending HTTP POST
   */
  @Post(':deviceId')
  @HttpCode(200)
  async ingest(
    @Param('deviceId') deviceId: string,
    @Body() payload: any,
    @Headers('x-api-key') apiKey?: string,
    @Headers('user-agent') userAgent?: string,
    @Headers('content-type') contentType?: string,
  ) {
    try {
      console.log(`\n📨 HTTP Ingestion - ${new Date().toISOString()}`);
      console.log(`📱 Device ID: ${deviceId}`);
      console.log(`🔑 API Key: ${apiKey ? '✓' : '✗'}`);
      console.log(`🌐 User Agent: ${userAgent}`);
      console.log(`📦 Payload:`, JSON.stringify(payload, null, 2));

      // Validate API key (optional)
      if (process.env.REQUIRE_API_KEY === 'true') {
        if (!apiKey || apiKey !== process.env.DEVICE_API_KEY) {
          return { success: false, error: 'Invalid API key' };
        }
      }

      // Parse to standard format
      const standardTelemetry: any = this.parse(payload, {
        deviceId,
        userAgent,
        contentType,
      });

      console.log(`✨ Parsed telemetry:`, standardTelemetry);

      // Send to device listener
      await this.deviceListener.handleTelemetry(standardTelemetry);

      console.log(`✅ HTTP ingestion successful\n`);

      return {
        success: true,
        message: 'Telemetry received',
        timestamp: new Date().toISOString(),
      };
    } catch (error: any) {
      console.error('❌ HTTP ingestion failed:', error);
      return {
        success: false,
        error: error.message,
      };
    }
  }

  /**
   * Batch ingestion endpoint
   * POST /api/v1/ingestion/batch
   * Body: { devices: [{ deviceId: "...", data: {...} }] }
   */
  @Post('batch')
  @HttpCode(200)
  async ingestBatch(
    @Body() payload: { devices: Array<{ deviceId: string; data: any }> },
    @Headers('x-api-key') apiKey?: string,
  ) {
    try {
      console.log(
        `📨 HTTP Batch Ingestion - ${payload.devices?.length || 0} devices`,
      );

      if (process.env.REQUIRE_API_KEY === 'true') {
        if (!apiKey || apiKey !== process.env.DEVICE_API_KEY) {
          return { success: false, error: 'Invalid API key' };
        }
      }

      const results: any = [];

      for (const device of payload.devices) {
        try {
          const standardTelemetry: any = this.parse(device.data, {
            deviceId: device.deviceId,
          });
          await this.deviceListener.handleTelemetry(standardTelemetry);
          results.push({ deviceId: device.deviceId, success: true });
        } catch (error: any) {
          results.push({
            deviceId: device.deviceId,
            success: false,
            error: error.message,
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
