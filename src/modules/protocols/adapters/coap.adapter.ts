// src/modules/protocols/adapters/coap.adapter.ts
// CoAP Protocol Adapter - For constrained IoT devices

import {
  Injectable,
  OnModuleInit,
  OnModuleDestroy,
  Logger,
} from '@nestjs/common';
import {
  StandardTelemetry,
  IProtocolAdapter,
} from '@/common/interfaces/standard-telemetry.interface';
import { DeviceListenerService } from '@/modules/gateway/device-listener.service';
import * as coap from 'coap';

/**
 * CoAP Adapter - Production Ready
 *
 * CoAP (Constrained Application Protocol) is like HTTP but for tiny devices
 *
 * Use Cases:
 * - Battery-powered sensors (ultra-low power)
 * - Devices with limited memory (< 256KB RAM)
 * - Lossy networks (unreliable connections)
 * - Resource discovery
 *
 * Compatible Devices:
 * - ESP32/ESP8266 with CoAP library
 * - Zolertia sensors
 * - Contiki-based sensors
 * - Nordic Semiconductor nRF devices
 *
 * Installation:
 * npm install coap
 */

@Injectable()
export class CoAPAdapter
  implements IProtocolAdapter, OnModuleInit, OnModuleDestroy
{
  protocol = 'coap';
  private readonly logger = new Logger(CoAPAdapter.name);
  private server: any = null;
  private isStarted = false;

  constructor(private readonly deviceListener: DeviceListenerService) {}

  async onModuleInit() {
    if (process.env.COAP_ENABLED === 'true') {
      await this.start();
    }
  }

  async onModuleDestroy() {
    await this.stop();
  }

  async start(): Promise<void> {
    if (this.isStarted) {
      this.logger.warn('CoAP Adapter already started');
      return;
    }

    try {
      this.logger.log('📡 Starting CoAP Adapter...');

      // Create CoAP server
      this.server = coap.createServer({
        type: 'udp4',
        proxy: true,
      });

      // Handle requests
      this.server.on('request', async (req: any, res: any) => {
        await this.handleRequest(req, res);
      });

      // Start listening
      const port = parseInt(process.env.COAP_PORT || '5683');
      this.server.listen(port, () => {
        this.logger.log(`✅ CoAP server listening on port ${port}`);
      });

      this.isStarted = true;
      this.logger.log('✅ CoAP Adapter started');
    } catch (error) {
      this.logger.error('Failed to start CoAP Adapter:', error);
      throw error;
    }
  }

  /**
   * Handle incoming CoAP request
   */
  private async handleRequest(req: any, res: any): Promise<void> {
    try {
      this.logger.log(`📨 CoAP ${req.method} ${req.url}`);

      // Parse URL to extract device ID
      // Example: /device/sensor-001/telemetry
      const urlParts = req.url.split('/').filter(Boolean);

      if (urlParts.length < 2) {
        res.code = '4.00'; // Bad Request
        res.end('Invalid URL format. Use: /device/{deviceId}/telemetry');
        return;
      }

      const deviceId = urlParts[1];
      const endpoint = urlParts[2];

      // Handle different endpoints
      if (endpoint === 'telemetry' && req.method === 'POST') {
        await this.handleTelemetry(deviceId, req, res);
      } else if (endpoint === 'command' && req.method === 'GET') {
        await this.handleCommandRequest(deviceId, req, res);
      } else {
        res.code = '4.04'; // Not Found
        res.end('Endpoint not found');
      }
    } catch (error) {
      this.logger.error('CoAP request error:', error);
      res.code = '5.00'; // Internal Server Error
      res.end('Server error');
    }
  }

  /**
   * Handle telemetry data from device
   */
  private async handleTelemetry(
    deviceId: string,
    req: any,
    res: any,
  ): Promise<void> {
    try {
      const payload = JSON.parse(req.payload.toString());

      // Convert to standard telemetry
      const telemetry = this.parse(payload, { deviceId });

      // Send to device listener
      await this.deviceListener.handleTelemetry(telemetry);

      // Respond to device
      res.code = '2.04'; // Changed (success)
      res.end(JSON.stringify({ status: 'ok', timestamp: Date.now() }));

      this.logger.log(`✅ Telemetry received from ${deviceId}`);
    } catch (error) {
      this.logger.error(`Failed to process telemetry from ${deviceId}:`, error);
      res.code = '4.00'; // Bad Request
      res.end('Invalid payload');
    }
  }

  /**
   * Handle command request from device (device asks for commands)
   */
  private async handleCommandRequest(
    deviceId: string,
    req: any,
    res: any,
  ): Promise<void> {
    // TODO: Check if there are pending commands for this device in Redis
    // For now, return empty
    res.code = '2.05'; // Content
    res.end(JSON.stringify({ commands: [] }));
  }

  /**
   * Parse CoAP payload to StandardTelemetry
   */
  parse(payload: any, context: any): StandardTelemetry {
    return {
      deviceId: context.deviceId,
      deviceKey: context.deviceId,
      tenantId: 'default',
      data: payload,
      temperature: payload.temperature || payload.temp,
      humidity: payload.humidity || payload.hum,
      pressure: payload.pressure,
      batteryLevel: payload.battery || payload.bat,
      signalStrength: payload.rssi,
      timestamp: payload.timestamp || new Date().toISOString(),
      receivedAt: Date.now(),
      protocol: 'coap',
      metadata: {
        contentFormat: payload.contentFormat,
      },
      rawPayload: payload,
    };
  }

  /**
   * Send command to CoAP device
   */
  async sendCommand(deviceKey: string, command: any): Promise<void> {
    try {
      // Get device IP from configuration (you'd need to store this)
      const deviceIp = await this.getDeviceIp(deviceKey);

      const req = coap.request({
        host: deviceIp,
        port: 5683,
        pathname: `/device/${deviceKey}/command`,
        method: 'POST',
        confirmable: true,
      });

      req.write(JSON.stringify(command));

      req.on('response', (res: any) => {
        this.logger.log(
          `✅ Command sent to ${deviceKey}, response: ${res.code}`,
        );
      });

      req.on('error', (error: any) => {
        this.logger.error(`Failed to send command to ${deviceKey}:`, error);
      });

      req.end();
    } catch (error) {
      this.logger.error(`Failed to send CoAP command:`, error);
      throw error;
    }
  }

  /**
   * Get device IP address (implement based on your needs)
   */
  private async getDeviceIp(deviceKey: string): Promise<string> {
    // TODO: Get from database or configuration
    return process.env[`COAP_DEVICE_${deviceKey}_IP`] || 'localhost';
  }

  /**
   * Stop adapter
   */
  async stop(): Promise<void> {
    if (this.server) {
      this.logger.log('🛑 Stopping CoAP Adapter...');
      this.server.close();
      this.server = null;
      this.isStarted = false;
      this.logger.log('✅ CoAP Adapter stopped');
    }
  }
}
