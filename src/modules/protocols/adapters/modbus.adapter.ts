// src/modules/protocols/adapters/modbus.adapter.ts
// Modbus Protocol Adapter - For industrial devices (PLCs, meters, sensors)

import {
  Injectable,
  OnModuleInit,
  OnModuleDestroy,
  Logger,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { IsNull, Repository } from 'typeorm';
import {
  StandardTelemetry,
  IProtocolAdapter,
} from '@/common/interfaces/standard-telemetry.interface';
import { DeviceListenerService } from '@/modules/protocols/device-listener.service';
import { envBoolean } from '@/config/env.utils';
import {
  ModbusDevice,
  type ModbusRegisterDefinition,
} from '@modules/protocols/modbus/entities/modbus-device.entity';
import ModbusRTU from 'modbus-serial';

/**
 * Modbus Adapter
 *
 * Supports:
 * - Modbus TCP (Ethernet-based PLCs, meters)
 * - Modbus RTU (RS-485 serial devices)
 *
 * ─── What changed ─────────────────────────────────────────────────────────
 * Two things made this real driver code unreachable in practice:
 *
 *   1. `onModuleInit()` was gated on `process.env.MODBUS_ENABLED === 'true'`,
 *      so the adapter was **off unless explicitly switched on** — and nothing
 *      in the product said so. It is now on by default; `MODBUS_ENABLED=false`
 *      disables it.
 *   2. The fleet came from a `MODBUS_DEVICES` environment variable holding a
 *      JSON blob. Adding a meter meant a redeploy, the configuration was
 *      invisible to the product and untenanted, and a typo in the JSON logged
 *      one parse error and then silently polled nothing.
 *
 * The `modbus_devices` table is now the source of truth, managed through
 * `ModbusDevicesController` and the Modbus screen. `MODBUS_DEVICES` is still
 * read, but **only when the table is empty for that key**, so an existing
 * deployment keeps working across the upgrade and can migrate at its own pace.
 *
 * ─── Telemetry identity ───────────────────────────────────────────────────
 * A database row carries `deviceId` with an FK, so `deviceKey` and `tenantId`
 * come from the joined `devices` row. The env format carried a bare
 * `deviceKey` string that was never checked against anything, and `parse()`
 * hardcoded `tenantId: 'default'` — telemetry from an env-configured device is
 * therefore still only as good as the key that was typed into the blob.
 */

/** Normalised, source-independent shape the poller works from. */
interface ModbusRuntimeConfig {
  /** Row id for a database device; `env:<n>` for an env-configured one. */
  id: string;
  source: 'database' | 'env';
  deviceKey: string;
  /** Null for env devices — they have no `devices` row reference. */
  deviceId: string | null;
  tenantId: string | null;
  customerId: string | null;
  name: string;
  type: 'TCP' | 'RTU';

  host?: string;
  port: number;

  serialPort?: string;
  baudRate: number;
  parity: 'none' | 'even' | 'odd';
  dataBits: 5 | 6 | 7 | 8;
  stopBits: 1 | 2;

  unitId: number;
  pollIntervalMs: number;
  timeoutMs: number;

  registers: ModbusRegisterDefinition[];
}

/** The legacy `MODBUS_DEVICES` entry shape, kept for the fallback path. */
interface LegacyModbusDeviceConfig {
  id: string;
  deviceKey: string;
  name: string;
  type: 'TCP' | 'RTU';
  ip?: string;
  host?: string;
  port?: number;
  serialPort?: string;
  baudRate?: number;
  parity?: 'none' | 'even' | 'odd';
  dataBits?: 5 | 6 | 7 | 8;
  stopBits?: 1 | 2;
  slaveId?: number;
  unitId?: number;
  pollInterval?: number;
  pollIntervalMs?: number;
  timeout?: number;
  registers?: Array<
    ModbusRegisterDefinition & {
      /** The env format called it `registerType`. */
      registerType?: ModbusRegisterDefinition['type'];
    }
  >;
}

const TWO_WORD_TYPES = new Set(['int32', 'uint32', 'float']);

@Injectable()
export class ModbusAdapter
  implements IProtocolAdapter, OnModuleInit, OnModuleDestroy
{
  protocol = 'modbus';
  private readonly logger = new Logger(ModbusAdapter.name);
  private clients = new Map<string, ModbusRTU>();
  private pollingIntervals = new Map<string, NodeJS.Timeout>();
  private isStarted = false;
  private deviceConfigs: ModbusRuntimeConfig[] = [];
  private configSource: 'database' | 'env' | 'none' = 'none';
  /** Guards against two concurrent reloads interleaving connect/disconnect. */
  private reloading: Promise<void> | null = null;

  constructor(
    private readonly deviceListener: DeviceListenerService,
    @InjectRepository(ModbusDevice)
    private readonly modbusDeviceRepository: Repository<ModbusDevice>,
  ) {}

  /**
   * ON by default.
   *
   * `envBoolean(…, true)` — so an unset variable enables the adapter and only
   * an explicit `MODBUS_ENABLED=false` (or `0`/`no`/`off`) disables it. The
   * old `=== 'true'` test meant every deployment that had not heard of the
   * variable ran with Modbus silently off.
   *
   * Starting with no devices configured is a no-op that costs nothing: no
   * socket is opened and no timer is created until a row exists.
   */
  async onModuleInit() {
    if (!this.isEnabled()) {
      this.logger.log('Modbus Adapter disabled (MODBUS_ENABLED=false)');
      return;
    }
    // Failures are logged, not thrown: an unreachable PLC must not stop the
    // application booting (compare the Kafka module, §11).
    try {
      await this.start();
    } catch (error: any) {
      this.logger.error(`Modbus Adapter failed to start: ${error.message}`);
    }
  }

  async onModuleDestroy() {
    await this.stop();
  }

  isEnabled(): boolean {
    return envBoolean(process.env.MODBUS_ENABLED, true);
  }

  async start(): Promise<void> {
    if (this.isStarted) {
      this.logger.warn('Modbus Adapter already started');
      return;
    }

    this.logger.log('Starting Modbus Adapter...');

    this.deviceConfigs = await this.loadDeviceConfigs();
    this.isStarted = true;

    if (this.deviceConfigs.length === 0) {
      this.logger.log(
        'Modbus Adapter started with no devices configured — add one from ' +
          'Integrations → Modbus devices (or set MODBUS_DEVICES).',
      );
      return;
    }

    for (const config of this.deviceConfigs) {
      await this.connectDevice(config);
    }

    this.logger.log(
      `Modbus Adapter started with ${this.deviceConfigs.length} device(s) ` +
        `from ${this.configSource}`,
    );
  }

  /**
   * Re-read the configuration and reconcile the live connections.
   *
   * Called by `ModbusDevicesService` after every write, so a saved change takes
   * effect without a restart. Implemented as a full stop/start rather than a
   * diff: reconnecting a handful of serial and TCP clients is cheap next to
   * the bug surface of partially-applied changes, and a changed host, unit id
   * or baud rate invalidates the existing socket anyway.
   */
  async reload(): Promise<void> {
    if (!this.isEnabled()) return;

    // Serialise: two saves in quick succession would otherwise have one
    // reload's stop() tearing down the other's freshly-opened clients.
    const run = (async () => {
      await this.stop();
      await this.start();
    })();

    this.reloading = run.finally(() => {
      if (this.reloading === run) this.reloading = null;
    });

    return this.reloading;
  }

  /**
   * Connect to a Modbus device
   */
  private async connectDevice(config: ModbusRuntimeConfig): Promise<void> {
    try {
      const client = new ModbusRTU();

      if (config.type === 'TCP') {
        await client.connectTCP(config.host!, { port: config.port });
        this.logger.log(
          `Connected to Modbus TCP: ${config.name} (${config.host}:${config.port})`,
        );
      } else {
        await client.connectRTUBuffered(config.serialPort!, {
          baudRate: config.baudRate,
          parity: config.parity,
          dataBits: config.dataBits,
          stopBits: config.stopBits,
        });
        this.logger.log(
          `Connected to Modbus RTU: ${config.name} (${config.serialPort})`,
        );
      }

      client.setID(config.unitId);
      client.setTimeout(config.timeoutMs);

      this.clients.set(config.id, client);
      this.startPolling(config);
    } catch (error: any) {
      this.logger.error(
        `Failed to connect to Modbus device ${config.name}: ${error.message}`,
      );
      await this.recordPollResult(config, false, `connect failed: ${error.message}`);
    }
  }

  /**
   * Start polling a device for data.
   *
   * ─── KNOWN LIMITATION: this double-polls under multiple replicas ──────────
   * The scheduler is a plain `setInterval` inside the application process, so
   * EVERY replica runs its own timer for every configured device. Two replicas
   * means each PLC is read twice per interval and each reading is ingested
   * twice; N replicas means N times. On an RS-485 bus that also means N
   * competing masters on a half-duplex line, where the extra traffic shows up
   * as intermittent read timeouts rather than as duplicate data.
   *
   * This is NOT solved here, deliberately — a correct fix is distributed
   * leader election or a dedicated single-replica poller deployment, and
   * either is a deployment-topology decision rather than an adapter change.
   * The same limitation applies to `SnmpAdapter`, which is the other polling
   * transport. Until it is addressed, run Modbus polling on exactly one
   * replica (`MODBUS_ENABLED=false` on the rest). `GET /modbus/devices/status`
   * reports this caveat so the screen can say so too.
   */
  private startPolling(config: ModbusRuntimeConfig): void {
    const interval = setInterval(() => {
      void this.pollOnce(config);
    }, config.pollIntervalMs);

    // Unref'd so a stuck interval cannot hold the process open during a
    // graceful shutdown.
    interval.unref?.();

    this.pollingIntervals.set(config.id, interval);
    this.logger.log(
      `Polling started for ${config.name} (every ${config.pollIntervalMs}ms, ` +
        `${config.registers.length} register(s))`,
    );
  }

  private async pollOnce(config: ModbusRuntimeConfig): Promise<void> {
    const client = this.clients.get(config.id);
    if (!client) return;

    const data: Record<string, any> = {};
    const failures: string[] = [];

    for (const register of config.registers) {
      try {
        data[register.name] = await this.readRegister(client, register);
      } catch (error: any) {
        failures.push(`${register.name}: ${error.message}`);
      }
    }

    // A cycle where EVERY register failed is a connectivity problem, not a
    // reading — publishing an empty payload would write a telemetry row that
    // says nothing and reset the device's "last seen" as though it answered.
    if (Object.keys(data).length === 0) {
      this.logger.error(
        `Modbus poll of ${config.name} read nothing: ${failures.join('; ')}`,
      );
      await this.recordPollResult(config, false, failures.join('; '));
      return;
    }

    try {
      await this.deviceListener.handleTelemetry(this.toTelemetry(config, data));
      await this.recordPollResult(
        config,
        failures.length === 0,
        failures.length > 0 ? failures.join('; ') : null,
      );
    } catch (error: any) {
      this.logger.error(
        `Failed to ingest Modbus telemetry for ${config.name}: ${error.message}`,
      );
      await this.recordPollResult(config, false, error.message);
    }
  }

  /**
   * Read a single register
   */
  private async readRegister(
    client: ModbusRTU,
    register: ModbusRegisterDefinition,
  ): Promise<number | boolean> {
    const length =
      register.length ??
      (TWO_WORD_TYPES.has(register.dataType) ? 2 : 1);

    let rawValue: any;

    switch (register.type) {
      case 'holding':
        rawValue = await client.readHoldingRegisters(register.address, length);
        break;
      case 'input':
        rawValue = await client.readInputRegisters(register.address, length);
        break;
      case 'coil':
        rawValue = await client.readCoils(register.address, length);
        return rawValue.data[0];
      case 'discrete':
        rawValue = await client.readDiscreteInputs(register.address, length);
        return rawValue.data[0];
      default:
        throw new Error(`Unknown register type '${register.type}'`);
    }

    const buffer = Buffer.from(rawValue.buffer);

    // Guard before reading: a 32-bit type declared with length 1 yields a
    // 2-byte buffer, and `readFloatBE(0)` on it throws an out-of-range error
    // once per register per poll. The validator refuses that combination on
    // save; this catches rows written before it existed, and env entries.
    const needed = TWO_WORD_TYPES.has(register.dataType) ? 4 : 2;
    if (buffer.length < needed) {
      throw new Error(
        `dataType '${register.dataType}' needs ${needed} bytes but the read ` +
          `returned ${buffer.length} — set length to ${needed / 2}`,
      );
    }

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

    // Scale first, then offset — the inverse order gives a different number,
    // and scale-then-offset is what every meter datasheet means.
    if (register.scale !== undefined && register.scale !== null) {
      value *= register.scale;
    }
    if (register.offset !== undefined && register.offset !== null) {
      value += register.offset;
    }

    return value;
  }

  /**
   * Read a configured device's registers once and return the results,
   * WITHOUT publishing telemetry.
   *
   * Used by `POST /modbus/devices/:id/test-read`, which is the only way to
   * tell a wrong address from a wrong scale factor without waiting for a poll
   * cycle and then querying telemetry. It opens its own short-lived client so
   * a test on a disabled device works too.
   */
  async testRead(row: ModbusDevice): Promise<{
    connected: boolean;
    error?: string;
    values: Array<{
      name: string;
      address: number;
      type: string;
      dataType: string;
      unit?: string;
      value?: number | boolean;
      error?: string;
    }>;
  }> {
    const config = this.fromRow(row, row.device?.deviceKey ?? '');
    const client = new ModbusRTU();

    try {
      if (config.type === 'TCP') {
        await client.connectTCP(config.host!, { port: config.port });
      } else {
        await client.connectRTUBuffered(config.serialPort!, {
          baudRate: config.baudRate,
          parity: config.parity,
          dataBits: config.dataBits,
          stopBits: config.stopBits,
        });
      }
      client.setID(config.unitId);
      client.setTimeout(config.timeoutMs);
    } catch (error: any) {
      return { connected: false, error: error.message, values: [] };
    }

    const values: Array<any> = [];
    for (const register of config.registers) {
      const entry = {
        name: register.name,
        address: register.address,
        type: register.type,
        dataType: register.dataType,
        ...(register.unit ? { unit: register.unit } : {}),
      };
      try {
        values.push({ ...entry, value: await this.readRegister(client, register) });
      } catch (error: any) {
        values.push({ ...entry, error: error.message });
      }
    }

    try {
      client.close(() => undefined);
    } catch {
      // A test read's socket failing to close cleanly is not worth reporting.
    }

    return { connected: true, values };
  }

  /**
   * Parse Modbus data to StandardTelemetry.
   *
   * Kept for `IProtocolAdapter`. Prefer `toTelemetry()`, which carries the real
   * tenant and device ids from the database row — this signature has only a
   * loose object to work from, which is why the old implementation hardcoded
   * `tenantId: 'default'`.
   */
  parse(data: any): StandardTelemetry {
    return {
      deviceId: data.deviceId ?? data.deviceKey,
      deviceKey: data.deviceKey,
      tenantId: data.tenantId ?? 'default',
      data: data.data,
      temperature: data.data?.temperature,
      humidity: data.data?.humidity,
      pressure: data.data?.pressure,
      timestamp: new Date().toISOString(),
      receivedAt: Date.now(),
      protocol: 'modbus',
      metadata: {
        deviceName: data.name,
      },
      rawPayload: data,
    };
  }

  private toTelemetry(
    config: ModbusRuntimeConfig,
    data: Record<string, any>,
  ): StandardTelemetry {
    return {
      // `deviceId` is the real `devices` row id for a database-configured
      // device. DeviceListenerService resolves by deviceKey either way, but a
      // correct id here is what lets a downstream consumer skip the lookup.
      deviceId: config.deviceId ?? config.deviceKey,
      deviceKey: config.deviceKey,
      tenantId: config.tenantId ?? 'default',
      ...(config.customerId ? { customerId: config.customerId } : {}),
      data,
      temperature: data.temperature,
      humidity: data.humidity,
      pressure: data.pressure,
      batteryLevel: data.batteryLevel,
      timestamp: new Date().toISOString(),
      receivedAt: Date.now(),
      protocol: 'modbus',
      metadata: {
        deviceName: config.name,
        modbusSource: config.source,
        modbusUnitId: config.unitId,
        ...(config.host ? { modbusHost: `${config.host}:${config.port}` } : {}),
        ...(config.serialPort ? { modbusSerialPort: config.serialPort } : {}),
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

    const { address, value, registerType } = command ?? {};
    if (!Number.isInteger(Number(address))) {
      throw new Error('A Modbus write needs an integer `address`');
    }

    if (registerType === 'holding') {
      await client.writeRegister(Number(address), Number(value));
    } else if (registerType === 'coil') {
      await client.writeCoil(Number(address), !!value);
    } else {
      // The old code silently did nothing for any other type and still logged
      // success, so an operator's write to an input register looked applied.
      throw new Error(
        `Modbus writes are only possible to 'holding' or 'coil' registers, ` +
          `not '${registerType}' (input and discrete registers are read-only).`,
      );
    }

    this.logger.log(
      `Modbus write to ${config.name}: ${value} → ${registerType} ${address}`,
    );
  }

  // ══════════════════════════════════════════════════════════════════════════
  // CONFIGURATION LOADING
  // ══════════════════════════════════════════════════════════════════════════

  /**
   * Database first, environment as a fallback.
   *
   * The two are NOT merged. A deployment is either managing Modbus through the
   * product or through its environment; mixing them would mean a device
   * deleted from the table silently reverting to its env definition, which is
   * the kind of behaviour nobody can debug from a log line.
   */
  private async loadDeviceConfigs(): Promise<ModbusRuntimeConfig[]> {
    let rows: ModbusDevice[] = [];
    try {
      rows = await this.modbusDeviceRepository.find({
        where: { enabled: true, deletedAt: IsNull() },
        relations: ['device'],
      });
    } catch (error: any) {
      // A missing table (migration not applied yet) must not stop the app.
      this.logger.error(
        `Could not read modbus_devices — falling back to MODBUS_DEVICES: ${error.message}`,
      );
    }

    const fromDb: ModbusRuntimeConfig[] = [];
    for (const row of rows) {
      if (!row.isPollable()) {
        this.logger.warn(
          `Modbus device '${row.name}' is skipped: ` +
            (Array.isArray(row.registers) && row.registers.length > 0
              ? 'no host/serial port configured'
              : 'no registers mapped'),
        );
        continue;
      }
      const deviceKey = row.device?.deviceKey;
      if (!deviceKey) {
        // The FK guarantees the devices row exists; a soft-deleted one still
        // satisfies it, and telemetry for it would be dropped downstream.
        this.logger.warn(
          `Modbus device '${row.name}' is skipped: its platform device has no ` +
            'device key (deleted?).',
        );
        continue;
      }
      fromDb.push(this.fromRow(row, deviceKey));
    }

    if (fromDb.length > 0) {
      this.configSource = 'database';
      return fromDb;
    }

    const fromEnv = this.loadEnvDeviceConfigs();
    if (fromEnv.length > 0) {
      this.configSource = 'env';
      this.logger.warn(
        `Using ${fromEnv.length} Modbus device(s) from the MODBUS_DEVICES ` +
          'environment variable. This path is a compatibility fallback — move ' +
          'them into Integrations → Modbus devices, which is tenant-scoped ' +
          'and editable without a redeploy.',
      );
      return fromEnv;
    }

    this.configSource = 'none';
    return [];
  }

  private fromRow(row: ModbusDevice, deviceKey: string): ModbusRuntimeConfig {
    return {
      id: row.id,
      source: 'database',
      deviceKey,
      deviceId: row.deviceId,
      tenantId: row.tenantId,
      customerId: row.device?.customerId ?? null,
      name: row.name,
      type: row.connectionType,
      host: row.host ?? undefined,
      port: row.port ?? 502,
      serialPort: row.serialPort ?? undefined,
      baudRate: row.baudRate ?? 9600,
      parity: row.parity ?? 'none',
      dataBits: (row.dataBits ?? 8) as 5 | 6 | 7 | 8,
      stopBits: (row.stopBits ?? 1) as 1 | 2,
      unitId: row.unitId ?? 1,
      pollIntervalMs: row.pollIntervalMs ?? 5000,
      timeoutMs: row.timeoutMs ?? 5000,
      registers: Array.isArray(row.registers) ? row.registers : [],
    };
  }

  /**
   * Legacy `MODBUS_DEVICES` JSON blob.
   *
   * Tolerant of both the old key names (`ip`, `slaveId`, `pollInterval`,
   * `registerType`) and the new ones, and it skips an entry it cannot use
   * instead of discarding the whole blob — the old implementation returned
   * `[]` on any parse error, so one trailing comma disabled every device with
   * a single log line.
   */
  private loadEnvDeviceConfigs(): ModbusRuntimeConfig[] {
    const raw = process.env.MODBUS_DEVICES;
    if (!raw?.trim()) return [];

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (error: any) {
      this.logger.error(
        `MODBUS_DEVICES is not valid JSON (${error.message}) — no env ` +
          'devices will be polled.',
      );
      return [];
    }

    if (!Array.isArray(parsed)) {
      this.logger.error('MODBUS_DEVICES must be a JSON array of devices');
      return [];
    }

    const out: ModbusRuntimeConfig[] = [];
    parsed.forEach((entry: LegacyModbusDeviceConfig, index: number) => {
      const name = entry?.name ?? entry?.id ?? `MODBUS_DEVICES[${index}]`;
      const type = entry?.type === 'RTU' ? 'RTU' : 'TCP';
      const host = entry?.host ?? entry?.ip;

      if (!entry?.deviceKey) {
        this.logger.error(`${name}: skipped — deviceKey is required`);
        return;
      }
      if (type === 'TCP' && !host) {
        this.logger.error(`${name}: skipped — a TCP device needs ip/host`);
        return;
      }
      if (type === 'RTU' && !entry?.serialPort) {
        this.logger.error(`${name}: skipped — an RTU device needs serialPort`);
        return;
      }

      const registers = (entry.registers ?? [])
        .map((register) => {
          const registerType = register.type ?? register.registerType;
          if (!register?.name || !registerType) return null;
          const dataType =
            registerType === 'coil' || registerType === 'discrete'
              ? 'bool'
              : (register.dataType ?? 'uint16');
          return {
            name: register.name,
            address: Number(register.address),
            type: registerType,
            dataType,
            length:
              register.length ?? (TWO_WORD_TYPES.has(dataType) ? 2 : 1),
            ...(register.scale !== undefined ? { scale: register.scale } : {}),
            ...(register.offset !== undefined
              ? { offset: register.offset }
              : {}),
            ...(register.unit ? { unit: register.unit } : {}),
          } as ModbusRegisterDefinition;
        })
        .filter((register): register is ModbusRegisterDefinition => !!register);

      if (registers.length === 0) {
        this.logger.error(`${name}: skipped — no usable registers`);
        return;
      }

      out.push({
        id: `env:${entry.id ?? index}`,
        source: 'env',
        deviceKey: entry.deviceKey,
        deviceId: null,
        tenantId: null,
        customerId: null,
        name,
        type,
        host,
        port: entry.port ?? 502,
        serialPort: entry.serialPort,
        baudRate: entry.baudRate ?? 9600,
        parity: entry.parity ?? 'none',
        dataBits: entry.dataBits ?? 8,
        stopBits: entry.stopBits ?? 1,
        unitId: entry.unitId ?? entry.slaveId ?? 1,
        pollIntervalMs: Math.max(
          250,
          entry.pollIntervalMs ?? entry.pollInterval ?? 5000,
        ),
        timeoutMs: entry.timeout ?? 5000,
        registers,
      });
    });

    return out;
  }

  // ══════════════════════════════════════════════════════════════════════════
  // STATE
  // ══════════════════════════════════════════════════════════════════════════

  /** What the management screen reads. */
  getRuntimeStatus(): {
    enabled: boolean;
    started: boolean;
    source: 'database' | 'env' | 'none';
    pollingCount: number;
    connectedIds: string[];
    pollingIds: string[];
    clusteringNote: string;
  } {
    return {
      enabled: this.isEnabled(),
      started: this.isStarted,
      source: this.configSource,
      pollingCount: this.pollingIntervals.size,
      connectedIds: [...this.clients.keys()],
      pollingIds: [...this.pollingIntervals.keys()],
      clusteringNote:
        'Polling uses an in-process setInterval, so every replica polls every ' +
        'device. Run Modbus polling on exactly one replica ' +
        '(MODBUS_ENABLED=false elsewhere) until leader election is added.',
    };
  }

  /**
   * Record the outcome of a poll on the row.
   *
   * Env-configured devices have no row, so there is nowhere to record it —
   * another reason the database is the better source. Write failures are
   * swallowed: bookkeeping must not turn a successful reading into a failed
   * poll, and a poll runs on a timer with no caller to report to.
   */
  private async recordPollResult(
    config: ModbusRuntimeConfig,
    ok: boolean,
    error: string | null,
  ): Promise<void> {
    if (config.source !== 'database') return;
    try {
      await this.modbusDeviceRepository
        .createQueryBuilder()
        .update(ModbusDevice)
        .set({
          lastPollStatus: ok ? 'ok' : 'error',
          lastPollError: error,
          lastPollAt: new Date(),
          pollCount: () => '"pollCount" + 1',
          ...(ok ? {} : { errorCount: () => '"errorCount" + 1' }),
        })
        .where('id = :id', { id: config.id })
        .execute();
    } catch {
      // Intentionally silent — see above.
    }
  }

  /**
   * Stop adapter
   */
  async stop(): Promise<void> {
    if (!this.isStarted && this.clients.size === 0) return;

    this.logger.log('Stopping Modbus Adapter...');

    for (const [id, interval] of this.pollingIntervals.entries()) {
      clearInterval(interval);
      this.logger.debug(`Stopped polling for device: ${id}`);
    }
    this.pollingIntervals.clear();

    for (const [id, client] of this.clients.entries()) {
      try {
        client.close(() => undefined);
      } catch (error: any) {
        this.logger.error(`Failed to disconnect ${id}: ${error.message}`);
      }
    }
    this.clients.clear();
    this.deviceConfigs = [];

    this.isStarted = false;
    this.logger.log('Modbus Adapter stopped');
  }
}

/**
 * Legacy environment configuration, still accepted as a fallback.
 *
 * The database (`modbus_devices`, managed at Integrations → Modbus devices) is
 * the source of truth; this is read only when the table has no enabled rows.
 *
 * MODBUS_ENABLED=false            # the adapter is ON by default
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
 *       { "name": "temperature", "registerType": "holding", "address": 0,
 *         "dataType": "int16", "scale": 0.1, "unit": "°C" },
 *       { "name": "pressure", "registerType": "holding", "address": 1,
 *         "dataType": "uint16", "unit": "bar" }
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
 *       { "name": "voltage", "registerType": "input", "address": 0,
 *         "dataType": "float", "length": 2, "unit": "V" },
 *       { "name": "current", "registerType": "input", "address": 2,
 *         "dataType": "float", "length": 2, "unit": "A" }
 *     ]
 *   }
 * ]'
 */
