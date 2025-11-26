// src/modules/protocols/adapters/modbus.adapter.ts
// Modbus Protocol Adapter - For industrial devices (PLCs, meters, sensors)

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
import ModbusRTU from 'modbus-serial';

/**
 * Modbus Adapter - Production Ready
 *
 * Supports:
 * - Modbus TCP (Ethernet-based PLCs, meters)
 * - Modbus RTU (RS-485 serial devices)
 *
 * Compatible Devices:
 * - Schneider Electric PLCs
 * - Siemens LOGO! controllers
 * - Phoenix Contact I/O modules
 * - Energy meters (Eastron, Carlo Gavazzi)
 * - Temperature/Humidity sensors
 * - Flow meters, pressure sensors
 *
 * Installation:
 * npm install modbus-serial
 */

interface ModbusDeviceConfig {
  id: string;
  deviceKey: string;
  name: string;
  type: 'TCP' | 'RTU';

  // TCP settings
  ip?: string;
  port?: number;

  // RTU settings
  serialPort?: string;
  baudRate?: number;
  parity?: 'none' | 'even' | 'odd';
  dataBits?: 5 | 6 | 7 | 8;
  stopBits?: 1 | 2;

  // Common settings
  slaveId: number;
  pollInterval: number; // milliseconds
  timeout?: number;

  // Register mapping
  registers: ModbusRegisterMap[];
}

interface ModbusRegisterMap {
  name: string; // Field name (e.g., 'temperature', 'pressure')
  registerType: 'holding' | 'input' | 'coil' | 'discrete';
  address: number; // Register address
  length?: number; // Number of registers to read (default: 1)
  dataType: 'int16' | 'uint16' | 'int32' | 'uint32' | 'float' | 'bool';
  scale?: number; // Multiply by this value
  offset?: number; // Add this value
  unit?: string; // Unit of measurement
}

@Injectable()
export class ModbusAdapter
  implements IProtocolAdapter, OnModuleInit, OnModuleDestroy
{
  protocol = 'modbus';
  private readonly logger = new Logger(ModbusAdapter.name);
  private clients = new Map<string, ModbusRTU>();
  private pollingIntervals = new Map<string, NodeJS.Timeout>();
  private isStarted = false;
  private deviceConfigs: ModbusDeviceConfig[] = [];

  constructor(private readonly deviceListener: DeviceListenerService) {}

  async onModuleInit() {
    if (process.env.MODBUS_ENABLED === 'true') {
      await this.start();
    }
  }

  async onModuleDestroy() {
    await this.stop();
  }

  async start(): Promise<void> {
    if (this.isStarted) {
      this.logger.warn('Modbus Adapter already started');
      return;
    }

    try {
      this.logger.log('🏭 Starting Modbus Adapter...');

      // Load device configurations
      this.deviceConfigs = this.loadDeviceConfigs();

      if (this.deviceConfigs.length === 0) {
        this.logger.warn('No Modbus devices configured');
        this.logger.log('Set MODBUS_DEVICES in environment to add devices');
        return;
      }

      // Connect to each device
      for (const config of this.deviceConfigs) {
        await this.connectDevice(config);
      }

      this.isStarted = true;
      this.logger.log(
        `✅ Modbus Adapter started with ${this.deviceConfigs.length} devices`,
      );
    } catch (error) {
      this.logger.error('Failed to start Modbus Adapter:', error);
      throw error;
    }
  }

  /**
   * Connect to a Modbus device
   */
  private async connectDevice(config: ModbusDeviceConfig): Promise<void> {
    try {
      const client = new ModbusRTU();

      // Connect based on type
      if (config.type === 'TCP') {
        await client.connectTCP(config.ip!, {
          port: config.port || 502,
        });
        this.logger.log(
          `✅ Connected to Modbus TCP: ${config.name} (${config.ip}:${config.port || 502})`,
        );
      } else if (config.type === 'RTU') {
        await client.connectRTUBuffered(config.serialPort!, {
          baudRate: config.baudRate || 9600,
          parity: config.parity || 'none',
          dataBits: config.dataBits || 8,
          stopBits: config.stopBits || 1,
        });
        this.logger.log(
          `✅ Connected to Modbus RTU: ${config.name} (${config.serialPort})`,
        );
      }

      // Set slave ID
      client.setID(config.slaveId);

      // Set timeout
      client.setTimeout(config.timeout || 5000);

      // Store client
      this.clients.set(config.id, client);

      // Start polling
      this.startPolling(config);
    } catch (error) {
      this.logger.error(`❌ Failed to connect to ${config.name}:`, error);
    }
  }

  /**
   * Start polling a device for data
   */
  private startPolling(config: ModbusDeviceConfig): void {
    const interval = setInterval(async () => {
      try {
        const client = this.clients.get(config.id);
        if (!client) return;

        // Read all registers
        const data: Record<string, any> = {};

        for (const register of config.registers) {
          try {
            const value = await this.readRegister(client, register);
            data[register.name] = value;
          } catch (error) {
            this.logger.error(
              `Failed to read ${register.name} from ${config.name}:`,
              error,
            );
          }
        }

        // Convert to standard telemetry
        const telemetry = this.parse({
          deviceKey: config.deviceKey,
          name: config.name,
          data,
          timestamp: Date.now(),
        });

        // Send to device listener
        await this.deviceListener.handleTelemetry(telemetry);
      } catch (error) {
        this.logger.error(`Polling error for ${config.name}:`, error);
      }
    }, config.pollInterval);

    this.pollingIntervals.set(config.id, interval);
    this.logger.log(
      `📊 Polling started for ${config.name} (interval: ${config.pollInterval}ms)`,
    );
  }

  /**
   * Read a single register
   */
  private async readRegister(
    client: ModbusRTU,
    register: ModbusRegisterMap,
  ): Promise<number | boolean> {
    const length = register.length || 1;

    let rawValue: any;

    // Read based on register type
    switch (register.registerType) {
      case 'holding':
        rawValue = await client.readHoldingRegisters(register.address, length);
        break;
      case 'input':
        rawValue = await client.readInputRegisters(register.address, length);
        break;
      case 'coil':
        rawValue = await client.readCoils(register.address, length);
        return rawValue.data[0]; // Boolean
      case 'discrete':
        rawValue = await client.readDiscreteInputs(register.address, length);
        return rawValue.data[0]; // Boolean
    }

    // Parse data based on data type
    const buffer = Buffer.from(rawValue.buffer);
    let value: number;

    switch (register.dataType) {
      case 'int16':
        value = buffer.readInt16BE(0);
        break;
      case 'uint16':
        value = buffer.readUInt16BE(0);
        break;
      case 'int32':
        value = buffer.readInt32BE(0);
        break;
      case 'uint32':
        value = buffer.readUInt32BE(0);
        break;
      case 'float':
        value = buffer.readFloatBE(0);
        break;
      case 'bool':
        return buffer.readUInt16BE(0) !== 0;
      default:
        value = buffer.readUInt16BE(0);
    }

    // Apply scaling and offset
    if (register.scale) value *= register.scale;
    if (register.offset) value += register.offset;

    return value;
  }

  /**
   * Parse Modbus data to StandardTelemetry
   */
  parse(data: any): StandardTelemetry {
    return {
      deviceId: data.deviceKey,
      deviceKey: data.deviceKey,
      tenantId: 'default',
      data: data.data,
      temperature: data.data.temperature,
      humidity: data.data.humidity,
      pressure: data.data.pressure,
      timestamp: new Date().toISOString(),
      receivedAt: Date.now(),
      protocol: 'modbus',
      metadata: {
        deviceName: data.name,
      },
      rawPayload: data,
    };
  }

  /**
   * Write to Modbus device (send command)
   */
  async sendCommand(deviceKey: string, command: any): Promise<void> {
    const config = this.deviceConfigs.find((d) => d.deviceKey === deviceKey);
    if (!config) {
      throw new Error(`Modbus device not found: ${deviceKey}`);
    }

    const client = this.clients.get(config.id);
    if (!client) {
      throw new Error(`Modbus client not connected: ${deviceKey}`);
    }

    try {
      const { address, value, registerType } = command;

      // Write based on register type
      if (registerType === 'holding') {
        await client.writeRegister(address, value);
      } else if (registerType === 'coil') {
        await client.writeCoil(address, value);
      }

      this.logger.log(
        `✅ Command sent to ${config.name}: Write ${value} to ${registerType} ${address}`,
      );
    } catch (error) {
      this.logger.error(`Failed to send command to ${deviceKey}:`, error);
      throw error;
    }
  }

  /**
   * Load device configurations from environment
   */
  private loadDeviceConfigs(): ModbusDeviceConfig[] {
    const configStr = process.env.MODBUS_DEVICES;
    if (!configStr) return [];

    try {
      return JSON.parse(configStr);
    } catch (error) {
      this.logger.error('Failed to parse MODBUS_DEVICES:', error);
      return [];
    }
  }

  /**
   * Stop adapter
   */
  async stop(): Promise<void> {
    this.logger.log('🛑 Stopping Modbus Adapter...');

    // Stop all polling
    for (const [id, interval] of this.pollingIntervals.entries()) {
      clearInterval(interval);
      this.logger.log(`Stopped polling for device: ${id}`);
    }
    this.pollingIntervals.clear();

    // Close all connections
    for (const [id, client] of this.clients.entries()) {
      try {
        client.close(() => {
          this.logger.log(`Disconnected device: ${id}`);
        });
      } catch (error) {
        this.logger.error(`Failed to disconnect ${id}:`, error);
      }
    }
    this.clients.clear();

    this.isStarted = false;
    this.logger.log('✅ Modbus Adapter stopped');
  }
}

/**
 * Example Configuration (.env or config file):
 *
 * MODBUS_ENABLED=true
 * MODBUS_DEVICES='[
 *   {
 *     "id": "plc-001",
 *     "deviceKey": "modbus-plc-001",
 *     "name": "Factory PLC",
 *     "type": "TCP",
 *     "ip": "192.168.1.100",
 *     "port": 502,
 *     "slaveId": 1,
 *     "pollInterval": 5000,
 *     "registers": [
 *       {
 *         "name": "temperature",
 *         "registerType": "holding",
 *         "address": 0,
 *         "dataType": "int16",
 *         "scale": 0.1,
 *         "offset": 0,
 *         "unit": "°C"
 *       },
 *       {
 *         "name": "pressure",
 *         "registerType": "holding",
 *         "address": 1,
 *         "dataType": "uint16",
 *         "scale": 1,
 *         "offset": 0,
 *         "unit": "bar"
 *       }
 *     ]
 *   },
 *   {
 *     "id": "energy-meter-001",
 *     "deviceKey": "modbus-meter-001",
 *     "name": "Energy Meter",
 *     "type": "RTU",
 *     "serialPort": "/dev/ttyUSB0",
 *     "baudRate": 9600,
 *     "parity": "none",
 *     "slaveId": 1,
 *     "pollInterval": 10000,
 *     "registers": [
 *       {
 *         "name": "voltage",
 *         "registerType": "input",
 *         "address": 0,
 *         "dataType": "float",
 *         "scale": 1,
 *         "unit": "V"
 *       },
 *       {
 *         "name": "current",
 *         "registerType": "input",
 *         "address": 2,
 *         "dataType": "float",
 *         "scale": 1,
 *         "unit": "A"
 *       },
 *       {
 *         "name": "power",
 *         "registerType": "input",
 *         "address": 4,
 *         "dataType": "float",
 *         "scale": 1,
 *         "unit": "W"
 *       }
 *     ]
 *   }
 * ]'
 */
