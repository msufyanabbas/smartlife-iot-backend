// src/modules/protocols/adapters/zigbee.adapter.ts
// Zigbee Protocol Adapter - For smart home devices (Philips Hue, IKEA, etc.)

import { Injectable, OnModuleInit, OnModuleDestroy } from '@nestjs/common';
import {
  StandardTelemetry,
  IProtocolAdapter,
} from '@/common/interfaces/standard-telemetry.interface';
import { DeviceListenerService } from '@/modules/gateway/device-listener.service';

// Note: You'll need to install: npm install zigbee-herdsman zigbee-herdsman-converters
// import { Controller } from 'zigbee-herdsman';
// import * as zhc from 'zigbee-herdsman-converters';

/**
 * Zigbee Adapter - Connects to Zigbee coordinator (USB dongle)
 *
 * Compatible Hardware:
 * - Texas Instruments CC2531 USB dongle
 * - ConBee II (deCONZ)
 * - Electrolama zig-a-zig-ah (zzh!)
 *
 * Supported Devices:
 * - Philips Hue bulbs
 * - IKEA TRÅDFRI lights/sensors
 * - Xiaomi Aqara sensors
 * - Tuya smart plugs
 * - And 1000+ more Zigbee devices!
 */

@Injectable()
export class ZigbeeAdapter
  implements IProtocolAdapter, OnModuleInit, OnModuleDestroy
{
  protocol = 'zigbee';
  private controller: any = null;
  private isStarted = false;
  private devices = new Map<string, any>();

  constructor(private readonly deviceListener: DeviceListenerService) {}

  async onModuleInit() {
    if (process.env.ZIGBEE_ENABLED === 'true') {
      await this.start();
    }
  }

  async onModuleDestroy() {
    await this.stop();
  }

  /**
   * Start Zigbee coordinator
   */
  async start(): Promise<void> {
    if (this.isStarted) {
      console.log('⚠️  Zigbee Adapter already started');
      return;
    }

    try {
      console.log('🔷 Starting Zigbee Adapter...');

      // Configuration for Zigbee coordinator
      const config = {
        network: {
          panID: parseInt(process.env.ZIGBEE_PAN_ID || '0x1a62'),
          channelList: [11, 15, 20, 25], // Best non-overlapping channels
          networkKey: this.parseNetworkKey(process.env.ZIGBEE_NETWORK_KEY),
        },
        serial: {
          port: process.env.ZIGBEE_PORT || '/dev/ttyACM0', // USB coordinator port
          baudRate: 115200,
        },
        databasePath: process.env.ZIGBEE_DATABASE_PATH || './data/zigbee.db',
      };

      // Initialize Zigbee controller
      // Uncomment when you install zigbee-herdsman:
      // this.controller = new Controller(config);

      // Register event handlers
      this.setupEventHandlers();

      // Start the controller
      // await this.controller.start();

      console.log('✅ Zigbee coordinator started');
      console.log(`📍 Port: ${config.serial.port}`);
      console.log(`🔢 PAN ID: 0x${config.network.panID.toString(16)}`);

      // Permit joining for 60 seconds on startup
      await this.permitJoin(60);

      this.isStarted = true;
      console.log('✅ Zigbee Adapter ready\n');
    } catch (error) {
      console.error('❌ Failed to start Zigbee Adapter:', error);
      console.log('\n💡 Tips:');
      console.log('   - Check if Zigbee coordinator is plugged in');
      console.log('   - Verify USB port: ls /dev/ttyACM* or /dev/ttyUSB*');
      console.log('   - Install zigbee-herdsman: npm install zigbee-herdsman');
      throw error;
    }
  }

  /**
   * Setup Zigbee event handlers
   */
  private setupEventHandlers(): void {
    if (!this.controller) return;

    // Device joined network
    this.controller.on('deviceJoined', async (device: any) => {
      console.log(`\n🆕 New Zigbee device joined!`);
      console.log(`   IEEE Address: ${device.ieeeAddr}`);
      console.log(
        `   Network Address: 0x${device.networkAddress.toString(16)}`,
      );
      console.log(`   Model: ${device.modelID}`);
      console.log(`   Manufacturer: ${device.manufacturerName}\n`);

      this.devices.set(device.ieeeAddr, device);

      // Auto-register in platform
      await this.registerDevice(device);
    });

    // Device message received
    this.controller.on('message', async (data: any) => {
      await this.handleMessage(data);
    });

    // Device left network
    this.controller.on('deviceLeave', (device: any) => {
      console.log(`👋 Zigbee device left: ${device.ieeeAddr}`);
      this.devices.delete(device.ieeeAddr);
    });

    // Device interview (pairing) progress
    this.controller.on('deviceInterview', (device: any) => {
      console.log(
        `🔍 Interviewing device: ${device.ieeeAddr} (${device.interviewCompleted ? 'Complete' : 'In Progress'})`,
      );
    });
  }

  /**
   * Handle incoming Zigbee message
   */
  private async handleMessage(data: any): Promise<void> {
    try {
      console.log(`\n📨 Zigbee Message`);
      console.log(`📍 From: ${data.device.ieeeAddr}`);
      console.log(`📦 Type: ${data.type}`);
      console.log(`📊 Data:`, data.data);

      // Convert to standard telemetry
      const standardTelemetry = this.parse(data);

      // Send to device listener
      await this.deviceListener.handleTelemetry(standardTelemetry);

      console.log(`✅ Zigbee message processed\n`);
    } catch (error) {
      console.error('❌ Failed to handle Zigbee message:', error);
    }
  }

  /**
   * Parse Zigbee message to StandardTelemetry
   */
  parse(data: any): StandardTelemetry {
    const device = data.device;
    const payload = data.data;

    // Extract common sensor values
    const telemetry: any = {
      deviceId: device.ieeeAddr,
      deviceKey: device.ieeeAddr,
      tenantId: 'default',
      data: payload,
      timestamp: new Date().toISOString(),
      receivedAt: Date.now(),
      protocol: 'zigbee',
      metadata: {
        networkAddress: device.networkAddress,
        modelID: device.modelID,
        manufacturerName: device.manufacturerName,
        linkQuality: data.linkquality,
        endpoint: data.endpoint?.ID,
      },
      rawPayload: data,
    };

    // Extract common fields based on Zigbee clusters
    if (payload.temperature !== undefined) {
      telemetry.temperature = payload.temperature;
    }
    if (payload.humidity !== undefined) {
      telemetry.humidity = payload.humidity;
    }
    if (payload.pressure !== undefined) {
      telemetry.pressure = payload.pressure;
    }
    if (payload.battery !== undefined) {
      telemetry.batteryLevel = payload.battery;
    }
    if (payload.linkquality !== undefined) {
      telemetry.signalStrength = payload.linkquality;
    }

    // Lighting-specific fields
    if (payload.state !== undefined) {
      telemetry.data.state = payload.state; // on/off
    }
    if (payload.brightness !== undefined) {
      telemetry.data.brightness = payload.brightness;
    }
    if (payload.color !== undefined) {
      telemetry.data.color = payload.color;
    }

    // Motion sensor
    if (payload.occupancy !== undefined) {
      telemetry.data.motion = payload.occupancy;
    }

    // Door/window sensor
    if (payload.contact !== undefined) {
      telemetry.data.contact = payload.contact;
    }

    return telemetry as StandardTelemetry;
  }

  /**
   * Register new Zigbee device in platform
   */
  private async registerDevice(device: any): Promise<void> {
    // Device will be auto-registered by device-listener
    // Just log for now
    console.log(`📝 Device ${device.ieeeAddr} will be auto-registered`);
  }

  /**
   * Send command to Zigbee device
   */
  async sendCommand(deviceId: string, command: any): Promise<void> {
    if (!this.controller) {
      throw new Error('Zigbee controller not initialized');
    }

    try {
      const device = this.devices.get(deviceId);

      if (!device) {
        throw new Error(`Zigbee device not found: ${deviceId}`);
      }

      console.log(`📤 Sending Zigbee command to ${deviceId}`);
      console.log(`🎯 Command:`, command);

      // Get endpoint (usually endpoint 1 for most devices)
      const endpoint = device.endpoints[0] || device.getEndpoint(1);

      // Route command based on type
      switch (command.type) {
        case 'on':
          await endpoint.command('genOnOff', 'on', {});
          break;

        case 'off':
          await endpoint.command('genOnOff', 'off', {});
          break;

        case 'toggle':
          await endpoint.command('genOnOff', 'toggle', {});
          break;

        case 'brightness':
          await endpoint.command('genLevelCtrl', 'moveToLevel', {
            level: command.params.brightness,
            transtime: command.params.transition || 0,
          });
          break;

        case 'color':
          await endpoint.command('lightingColorCtrl', 'moveToColor', {
            colorx: command.params.x,
            colory: command.params.y,
            transtime: command.params.transition || 0,
          });
          break;

        default:
          throw new Error(`Unknown command type: ${command.type}`);
      }

      console.log(`✅ Zigbee command sent successfully`);
    } catch (error) {
      console.error(`❌ Failed to send Zigbee command:`, error);
      throw error;
    }
  }

  /**
   * Permit devices to join network
   */
  async permitJoin(seconds: number): Promise<void> {
    if (!this.controller) return;

    console.log(`🔓 Permitting Zigbee joins for ${seconds} seconds...`);
    await this.controller.permitJoin(seconds);

    console.log('💡 Put your Zigbee device in pairing mode now!');
    console.log(
      '   (Usually: Press reset button 5 times or hold for 10 seconds)',
    );
  }

  /**
   * Get all paired devices
   */
  async getDevices(): Promise<any[]> {
    if (!this.controller) return [];

    return Array.from(this.devices.values()).map((device) => ({
      ieeeAddr: device.ieeeAddr,
      networkAddress: device.networkAddress,
      modelID: device.modelID,
      manufacturerName: device.manufacturerName,
      type: device.type,
      powerSource: device.powerSource,
      dateCode: device.dateCode,
    }));
  }

  /**
   * Parse network key from hex string
   */
  private parseNetworkKey(key?: string): number[] {
    if (!key) {
      // Generate random key if not provided
      return Array.from({ length: 16 }, () => Math.floor(Math.random() * 256));
    }

    // Parse hex string to byte array
    const cleanKey = key.replace(/[^0-9a-fA-F]/g, '');
    const bytes: any = [];

    for (let i = 0; i < cleanKey.length; i += 2) {
      bytes.push(parseInt(cleanKey.substr(i, 2), 16));
    }

    return bytes;
  }

  /**
   * Stop Zigbee adapter
   */
  async stop(): Promise<void> {
    if (this.controller) {
      console.log('🛑 Stopping Zigbee Adapter...');
      await this.controller.stop();
      this.controller = null;
      this.isStarted = false;
      this.devices.clear();
      console.log('✅ Zigbee Adapter stopped');
    }
  }
}
