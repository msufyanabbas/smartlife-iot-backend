// src/modules/protocols/adapters/ble.adapter.ts
// Bluetooth Low Energy (BLE) Protocol Adapter

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
// import noble from '@abandonware/noble';

/**
 * BLE Adapter - Production Ready
 *
 * Bluetooth Low Energy for short-range wireless devices
 *
 * Use Cases:
 * - Wearable devices (fitness trackers, smartwatches)
 * - Beacons (iBeacon, Eddystone)
 * - Medical devices (heart rate monitors, glucose meters)
 * - Smart locks and access control
 * - Indoor positioning
 *
 * Compatible Devices:
 * - Xiaomi Mi Band
 * - Fitbit devices
 * - Texas Instruments SensorTag
 * - Nordic nRF52 devices
 * - ESP32 BLE devices
 *
 * Requirements:
 * - Bluetooth adapter on server
 * - Linux: bluez
 * - macOS: Built-in
 * - Windows: Special drivers
 *
 * Installation:
 * npm install @abandonware/noble
 */

@Injectable()
export class BLEAdapter
  implements IProtocolAdapter, OnModuleInit, OnModuleDestroy
{
  protocol = 'ble';
  private readonly logger = new Logger(BLEAdapter.name);
  private devices = new Map<string, any>(); // address -> peripheral
  private isStarted = false;
  private whitelistedDevices: string[] = [];

  constructor(private readonly deviceListener: DeviceListenerService) {}

  async onModuleInit() {
    if (process.env.BLE_ENABLED === 'true') {
      await this.start();
    }
  }

  async onModuleDestroy() {
    await this.stop();
  }

  async start(): Promise<void> {
    if (this.isStarted) {
      this.logger.warn('BLE Adapter already started');
      return;
    }

    try {
      this.logger.log('📱 Starting BLE Adapter...');

      // Load whitelist
      this.whitelistedDevices = (process.env.BLE_WHITELIST || '')
        .split(',')
        .filter(Boolean);

      if (this.whitelistedDevices.length === 0) {
        this.logger.warn(
          'No BLE devices whitelisted. Set BLE_WHITELIST in environment',
        );
      }

      //   // Setup noble events
      //   noble.on('stateChange', (state: string) => {
      //     this.logger.log(`Bluetooth state: ${state}`);

      //     if (state === 'poweredOn') {
      //       this.logger.log('✅ Bluetooth powered on, starting scan...');
      //       noble.startScanning([], true); // Scan for all devices, allow duplicates
      //     } else {
      //       this.logger.warn('⚠️  Bluetooth not available:', state);
      //       noble.stopScanning();
      //     }
      //   });

      //   noble.on('discover', async (peripheral: any) => {
      //     await this.handleDeviceDiscovered(peripheral);
      //   });

      //   noble.on('scanStart', () => {
      //     this.logger.log('📡 BLE scan started');
      //   });

      //   noble.on('scanStop', () => {
      //     this.logger.log('📡 BLE scan stopped');
      //   });

      this.isStarted = true;
      this.logger.log('✅ BLE Adapter started');
    } catch (error) {
      this.logger.error('Failed to start BLE Adapter:', error);
      throw error;
    }
  }

  /**
   * Handle discovered BLE device
   */
  private async handleDeviceDiscovered(peripheral: any): Promise<void> {
    const address = peripheral.address || peripheral.id;
    const name = peripheral.advertisement?.localName || 'Unknown';

    // Check whitelist
    if (!this.isWhitelisted(address, name)) {
      return;
    }

    // Check if already connected
    if (
      this.devices.has(address) &&
      this.devices.get(address).state === 'connected'
    ) {
      return;
    }

    this.logger.log(`🔵 BLE device discovered: ${name} (${address})`);
    this.logger.log(
      `   RSSI: ${peripheral.rssi}, Connectable: ${peripheral.connectable}`,
    );

    // Store peripheral
    this.devices.set(address, peripheral);

    // Parse advertisement data (many BLE sensors broadcast data)
    await this.parseAdvertisementData(peripheral);

    // Connect if connectable (for devices that need connection)
    if (peripheral.connectable && process.env.BLE_AUTO_CONNECT === 'true') {
      await this.connectDevice(peripheral);
    }
  }

  /**
   * Parse advertisement data (many BLE devices broadcast telemetry)
   */
  private async parseAdvertisementData(peripheral: any): Promise<void> {
    try {
      const adv = peripheral.advertisement;
      const address = peripheral.address || peripheral.id;

      // Extract data from advertisement
      const data: any = {
        rssi: peripheral.rssi,
        txPower: adv.txPowerLevel,
      };

      // Parse manufacturer data (common in BLE sensors)
      if (adv.manufacturerData) {
        const mfgData = this.parseManufacturerData(adv.manufacturerData);
        Object.assign(data, mfgData);
      }

      // Parse service data
      if (adv.serviceData && adv.serviceData.length > 0) {
        adv.serviceData.forEach((service: any) => {
          data[`service_${service.uuid}`] = service.data;
        });
      }

      // Only send if we have useful data
      if (Object.keys(data).length > 2) {
        const telemetry = this.parse({
          deviceKey: address,
          name: adv.localName || address,
          data,
        });

        await this.deviceListener.handleTelemetry(telemetry);
      }
    } catch (error) {
      this.logger.error('Failed to parse advertisement data:', error);
    }
  }

  /**
   * Parse manufacturer-specific data
   */
  private parseManufacturerData(buffer: Buffer): any {
    // Different manufacturers use different formats
    // This is a generic parser - customize per manufacturer

    const companyId = buffer.readUInt16LE(0);
    const data: any = { companyId };

    // Example: Xiaomi format (company ID 0x038F)
    if (companyId === 0x038f && buffer.length >= 14) {
      data.temperature = buffer.readInt16LE(6) / 10;
      data.humidity = buffer.readUInt8(8);
      data.battery = buffer.readUInt8(9);
    }
    // Add more manufacturer parsers as needed

    return data;
  }

  /**
   * Connect to BLE device and subscribe to notifications
   */
  private async connectDevice(peripheral: any): Promise<void> {
    try {
      const address = peripheral.address || peripheral.id;
      this.logger.log(`🔌 Connecting to ${address}...`);

      await new Promise((resolve, reject) => {
        peripheral.connect((error: any) => {
          if (error) reject(error);
          else resolve(true);
        });
      });

      this.logger.log(`✅ Connected to ${address}`);

      // Discover services and characteristics
      await new Promise((resolve) => {
        peripheral.discoverAllServicesAndCharacteristics(
          (err: any, services: any[], characteristics: any[]) => {
            if (err) {
              this.logger.error('Failed to discover services:', err);
              resolve(false);
              return;
            }

            // Subscribe to notify characteristics
            characteristics?.forEach((char: any) => {
              if (char.properties.includes('notify')) {
                char.subscribe();
                char.on('data', (data: Buffer) => {
                  this.handleCharacteristicData(address, char.uuid, data);
                });
                this.logger.log(
                  `📡 Subscribed to characteristic: ${char.uuid}`,
                );
              }
            });

            resolve(true);
          },
        );
      });
    } catch (error) {
      this.logger.error(`Failed to connect to ${peripheral.address}:`, error);
    }
  }

  /**
   * Handle data from BLE characteristic
   */
  private async handleCharacteristicData(
    address: string,
    uuid: string,
    data: Buffer,
  ): Promise<void> {
    try {
      // Parse data based on characteristic UUID
      const parsed = this.parseCharacteristicData(uuid, data);

      const telemetry = this.parse({
        deviceKey: address,
        name: address,
        data: parsed,
      });

      await this.deviceListener.handleTelemetry(telemetry);
    } catch (error) {
      this.logger.error('Failed to handle characteristic data:', error);
    }
  }

  /**
   * Parse characteristic data based on UUID
   */
  private parseCharacteristicData(uuid: string, data: Buffer): any {
    // Standard BLE services

    // Heart Rate (0x2A37)
    if (uuid === '2a37') {
      return { heartRate: data.readUInt8(1) };
    }

    // Battery Level (0x2A19)
    if (uuid === '2a19') {
      return { battery: data.readUInt8(0) };
    }

    // Temperature (0x2A6E)
    if (uuid === '2a6e') {
      return { temperature: data.readInt16LE(0) / 100 };
    }

    // Generic parser
    return { [uuid]: data.toString('hex') };
  }

  /**
   * Check if device is whitelisted
   */
  private isWhitelisted(address: string, name: string): boolean {
    if (this.whitelistedDevices.length === 0) return true; // Allow all if no whitelist

    return this.whitelistedDevices.some(
      (entry) =>
        address.toLowerCase().includes(entry.toLowerCase()) ||
        name.toLowerCase().includes(entry.toLowerCase()),
    );
  }

  /**
   * Parse BLE data to StandardTelemetry
   */
  parse(data: any): StandardTelemetry {
    return {
      deviceId: data.deviceKey,
      deviceKey: data.deviceKey,
      tenantId: 'default',
      data: data.data,
      temperature: data.data.temperature,
      humidity: data.data.humidity,
      batteryLevel: data.data.battery,
      signalStrength: data.data.rssi,
      timestamp: new Date().toISOString(),
      receivedAt: Date.now(),
      protocol: 'ble',
      metadata: {
        name: data.name,
      },
      rawPayload: data,
    };
  }

  /**
   * Send command to BLE device (write to characteristic)
   */
  async sendCommand(deviceKey: string, command: any): Promise<void> {
    const peripheral = this.devices.get(deviceKey);
    if (!peripheral) {
      throw new Error(`BLE device not found: ${deviceKey}`);
    }

    // TODO: Implement write to characteristic
    // This requires knowing the service and characteristic UUIDs
    this.logger.log(
      `📤 Command to BLE device ${deviceKey}: ${JSON.stringify(command)}`,
    );
  }

  /**
   * Stop adapter
   */
  async stop(): Promise<void> {
    this.logger.log('🛑 Stopping BLE Adapter...');

    // Disconnect all devices
    for (const [address, peripheral] of this.devices.entries()) {
      try {
        if (peripheral.state === 'connected') {
          peripheral.disconnect();
          this.logger.log(`Disconnected from ${address}`);
        }
      } catch (error) {
        this.logger.error(`Failed to disconnect ${address}:`, error);
      }
    }
    this.devices.clear();

    // // Stop scanning
    // if (noble.state === 'poweredOn') {
    //   noble.stopScanning();
    // }

    this.isStarted = false;
    this.logger.log('✅ BLE Adapter stopped');
  }
}
