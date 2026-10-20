import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { IsNull, Repository } from 'typeorm';
import { Device } from '@modules/devices/entities/device.entity';
import {
  MODBUS_CONNECTION_TYPES,
  MODBUS_DATA_TYPES,
  MODBUS_REGISTER_TYPES,
  ModbusDevice,
  type ModbusRegisterDefinition,
} from './entities/modbus-device.entity';
import { ModbusAdapter } from '../adapters/modbus.adapter';

/** Registers that need two 16-bit words to hold one value. */
const TWO_WORD_TYPES = new Set(['int32', 'uint32', 'float']);

export interface ModbusDeviceListQuery {
  page?: number;
  limit?: number;
  search?: string;
  enabled?: boolean;
}

/**
 * CRUD for the Modbus fleet.
 *
 * Every query is pinned to the caller's tenant and answers 404 — never 403 —
 * for a row outside it: a 403 confirms the id exists, which turns any detail
 * route into an enumeration oracle (CLAUDE.md §4g).
 *
 * Writes call `ModbusAdapter.reload()` so a saved change takes effect without
 * a restart. The dependency runs one way only (service → adapter); the adapter
 * reads the repository directly, so there is no cycle to forwardRef around.
 */
@Injectable()
export class ModbusDevicesService {
  private readonly logger = new Logger(ModbusDevicesService.name);

  constructor(
    @InjectRepository(ModbusDevice)
    private readonly repository: Repository<ModbusDevice>,
    @InjectRepository(Device)
    private readonly deviceRepository: Repository<Device>,
    private readonly adapter: ModbusAdapter,
  ) {}

  // ══════════════════════════════════════════════════════════════════════════
  // READS
  // ══════════════════════════════════════════════════════════════════════════

  async findAll(tenantId: string, query: ModbusDeviceListQuery = {}) {
    const page = Math.max(1, Number(query.page) || 1);
    const limit = Math.min(200, Math.max(1, Number(query.limit) || 25));

    const qb = this.repository
      .createQueryBuilder('md')
      .leftJoinAndSelect('md.device', 'device')
      // Explicit, unconditional tenant predicate. The pattern
      // `if (tenantId) qb.andWhere(...)` leaves the query UNSCOPED for a
      // caller whose tenantId is missing (§4g) — the controller refuses that
      // caller before this method is reached.
      .where('md.tenantId = :tenantId', { tenantId })
      .orderBy('md.name', 'ASC')
      .skip((page - 1) * limit)
      .take(limit);

    if (query.search?.trim()) {
      qb.andWhere(
        '(md.name ILIKE :search OR md.host ILIKE :search OR md.serialPort ILIKE :search)',
        { search: `%${query.search.trim()}%` },
      );
    }
    if (query.enabled !== undefined) {
      qb.andWhere('md.enabled = :enabled', { enabled: query.enabled });
    }

    const [data, totalItems] = await qb.getManyAndCount();

    return {
      data,
      meta: {
        page,
        limit,
        totalItems,
        totalPages: Math.max(1, Math.ceil(totalItems / limit)),
        hasNextPage: page * limit < totalItems,
        hasPreviousPage: page > 1,
      },
    };
  }

  async findOne(id: string, tenantId: string): Promise<ModbusDevice> {
    const row = await this.repository.findOne({
      where: { id, tenantId },
      relations: ['device'],
    });
    if (!row) throw new NotFoundException('Modbus device not found');
    return row;
  }

  /**
   * Runtime view: what the poller is doing right now, merged with the stored
   * rows. Without this the screen can show a configuration and give no hint
   * that the adapter never managed to connect to it.
   */
  async getStatus(tenantId: string) {
    const rows = await this.repository.find({
      where: { tenantId },
      order: { name: 'ASC' },
    });
    const runtime = this.adapter.getRuntimeStatus();

    return {
      adapter: {
        enabled: runtime.enabled,
        started: runtime.started,
        source: runtime.source,
        pollingCount: runtime.pollingCount,
        /**
         * Surfaced to the UI on purpose — see the comment on
         * `ModbusAdapter.startPolling`. Every replica runs its own
         * `setInterval`, so N replicas poll each device N times.
         */
        clusteringNote: runtime.clusteringNote,
      },
      devices: rows.map((row) => ({
        id: row.id,
        name: row.name,
        enabled: row.enabled,
        pollable: row.isPollable(),
        connected: runtime.connectedIds.includes(row.id),
        polling: runtime.pollingIds.includes(row.id),
        registers: Array.isArray(row.registers) ? row.registers.length : 0,
        lastPollStatus: row.lastPollStatus ?? null,
        lastPollError: row.lastPollError ?? null,
        lastPollAt: row.lastPollAt ?? null,
        pollCount: Number(row.pollCount ?? 0),
        errorCount: Number(row.errorCount ?? 0),
      })),
    };
  }

  /** The vocabulary the form is generated from. */
  getCapabilities() {
    return {
      connectionTypes: MODBUS_CONNECTION_TYPES,
      registerTypes: MODBUS_REGISTER_TYPES,
      dataTypes: MODBUS_DATA_TYPES,
      /** Register types that yield a boolean and ignore `dataType`/`scale`. */
      booleanRegisterTypes: ['coil', 'discrete'],
      /** Data types that occupy two consecutive registers. */
      twoWordDataTypes: [...TWO_WORD_TYPES],
      defaults: {
        port: 502,
        unitId: 1,
        pollIntervalMs: 5000,
        timeoutMs: 5000,
        baudRate: 9600,
        parity: 'none',
        dataBits: 8,
        stopBits: 1,
      },
      limits: {
        minPollIntervalMs: 250,
        maxRegistersPerDevice: 200,
        unitIdRange: [0, 247],
      },
    };
  }

  // ══════════════════════════════════════════════════════════════════════════
  // WRITES
  // ══════════════════════════════════════════════════════════════════════════

  async create(
    tenantId: string,
    dto: Partial<ModbusDevice>,
  ): Promise<ModbusDevice> {
    await this.assertDeviceInTenant(dto.deviceId, tenantId);
    const registers = this.validateRegisters(dto.registers ?? []);
    this.assertTransport({ ...dto, connectionType: dto.connectionType ?? 'TCP' });
    this.assertRanges(dto);

    const row = this.repository.create({
      ...this.scrub(dto),
      tenantId,
      registers,
      pollCount: '0',
      errorCount: '0',
    });

    const saved = await this.repository.save(row);
    await this.reloadAdapter(`created '${saved.name}'`);
    return saved;
  }

  async update(
    id: string,
    tenantId: string,
    dto: Partial<ModbusDevice>,
  ): Promise<ModbusDevice> {
    const existing = await this.findOne(id, tenantId);

    if (dto.deviceId && dto.deviceId !== existing.deviceId) {
      await this.assertDeviceInTenant(dto.deviceId, tenantId);
    }

    Object.assign(existing, this.scrub(dto));

    if (dto.registers !== undefined) {
      existing.registers = this.validateRegisters(dto.registers);
    }

    // Validated against the MERGED row, not the patch: switching
    // connectionType from TCP to RTU without a serialPort used to save happily
    // and then fail at connect time, far from the edit that caused it.
    this.assertTransport(existing);
    this.assertRanges(existing);

    const saved = await this.repository.save(existing);
    await this.reloadAdapter(`updated '${saved.name}'`);
    return saved;
  }

  async remove(id: string, tenantId: string): Promise<{ message: string }> {
    const row = await this.findOne(id, tenantId);
    await this.repository.softRemove(row);
    await this.reloadAdapter(`removed '${row.name}'`);
    return { message: `Modbus device '${row.name}' removed` };
  }

  async setEnabled(
    id: string,
    tenantId: string,
    enabled: boolean,
  ): Promise<ModbusDevice> {
    const row = await this.findOne(id, tenantId);
    row.enabled = enabled;
    const saved = await this.repository.save(row);
    await this.reloadAdapter(
      `${enabled ? 'enabled' : 'disabled'} '${saved.name}'`,
    );
    return saved;
  }

  /**
   * Read the configured registers once, right now, and return the values.
   *
   * This is the only way to tell a wrong address from a wrong scale factor
   * without waiting for a poll cycle and then reading telemetry. It does NOT
   * publish telemetry — a test read must not pollute the device's history.
   */
  async testRead(id: string, tenantId: string) {
    const row = await this.findOne(id, tenantId);
    if (!Array.isArray(row.registers) || row.registers.length === 0) {
      throw new BadRequestException(
        'This device has no registers mapped, so there is nothing to read.',
      );
    }
    return this.adapter.testRead(row);
  }

  // ══════════════════════════════════════════════════════════════════════════
  // VALIDATION
  // ══════════════════════════════════════════════════════════════════════════

  /**
   * The register map is jsonb, so nothing in the database enforces its shape —
   * which means a bad entry becomes a runtime read failure logged once per
   * poll, forever. It is validated here instead.
   */
  private validateRegisters(
    raw: unknown,
  ): ModbusRegisterDefinition[] {
    if (!Array.isArray(raw)) {
      throw new BadRequestException('registers must be an array');
    }
    if (raw.length > 200) {
      throw new BadRequestException(
        'A device may map at most 200 registers; split it across two entries.',
      );
    }

    const seen = new Set<string>();
    const errors: string[] = [];

    const registers = raw.map((entry: any, index: number) => {
      const where = `registers[${index}]`;
      const name = typeof entry?.name === 'string' ? entry.name.trim() : '';

      if (!name) errors.push(`${where}.name is required`);
      else if (!/^[A-Za-z_][\w.]*$/.test(name)) {
        // The name becomes a telemetry key and a column header; a space or a
        // dash makes it unusable in the query layer downstream.
        errors.push(
          `${where}.name '${name}' is not a usable telemetry key — use ` +
            'letters, digits, underscore and dot, starting with a letter.',
        );
      } else if (seen.has(name)) {
        errors.push(
          `${where}.name '${name}' is used twice; the second read would ` +
            'overwrite the first in the same payload.',
        );
      } else {
        seen.add(name);
      }

      const address = Number(entry?.address);
      if (!Number.isInteger(address) || address < 0 || address > 65535) {
        errors.push(`${where}.address must be an integer between 0 and 65535`);
      }

      if (!(MODBUS_REGISTER_TYPES as readonly string[]).includes(entry?.type)) {
        errors.push(
          `${where}.type must be one of ${MODBUS_REGISTER_TYPES.join(' | ')}`,
        );
      }

      const isBooleanRegister = entry?.type === 'coil' || entry?.type === 'discrete';
      const dataType = isBooleanRegister ? 'bool' : entry?.dataType;

      if (!(MODBUS_DATA_TYPES as readonly string[]).includes(dataType)) {
        errors.push(
          `${where}.dataType must be one of ${MODBUS_DATA_TYPES.join(' | ')}`,
        );
      }

      // A float or 32-bit integer spans two registers. Recorded explicitly
      // rather than inferred at read time, because the env format let a float
      // be declared with length 1 and the driver then returned a buffer too
      // short to read — an exception per poll, per register.
      const length = Number.isInteger(Number(entry?.length))
        ? Number(entry.length)
        : TWO_WORD_TYPES.has(dataType)
          ? 2
          : 1;

      if (length < 1 || length > 125) {
        errors.push(`${where}.length must be between 1 and 125`);
      } else if (TWO_WORD_TYPES.has(dataType) && length < 2) {
        errors.push(
          `${where}.dataType '${dataType}' needs length 2 (it spans two registers)`,
        );
      }

      const scale = entry?.scale === undefined || entry?.scale === null
        ? undefined
        : Number(entry.scale);
      if (scale !== undefined && !Number.isFinite(scale)) {
        errors.push(`${where}.scale must be a number`);
      }

      const offset = entry?.offset === undefined || entry?.offset === null
        ? undefined
        : Number(entry.offset);
      if (offset !== undefined && !Number.isFinite(offset)) {
        errors.push(`${where}.offset must be a number`);
      }

      return {
        name,
        address,
        type: entry?.type,
        dataType,
        length,
        ...(scale !== undefined ? { scale } : {}),
        ...(offset !== undefined ? { offset } : {}),
        ...(typeof entry?.unit === 'string' && entry.unit.trim()
          ? { unit: entry.unit.trim() }
          : {}),
      } as ModbusRegisterDefinition;
    });

    if (errors.length > 0) {
      throw new BadRequestException({
        message: 'The register map is not valid',
        errors,
      });
    }

    return registers;
  }

  private assertTransport(row: Partial<ModbusDevice>): void {
    const type = row.connectionType ?? 'TCP';
    if (!(MODBUS_CONNECTION_TYPES as readonly string[]).includes(type)) {
      throw new BadRequestException(
        `connectionType must be one of ${MODBUS_CONNECTION_TYPES.join(' | ')}`,
      );
    }
    if (type === 'TCP' && !row.host?.trim()) {
      throw new BadRequestException('A Modbus TCP device needs a host');
    }
    if (type === 'RTU' && !row.serialPort?.trim()) {
      throw new BadRequestException(
        'A Modbus RTU device needs a serialPort, e.g. /dev/ttyUSB0',
      );
    }
  }

  private assertRanges(row: Partial<ModbusDevice>): void {
    const errors: string[] = [];

    if (row.unitId !== undefined && (row.unitId < 0 || row.unitId > 247)) {
      errors.push('unitId must be between 0 and 247');
    }
    if (row.port !== undefined && (row.port < 1 || row.port > 65535)) {
      errors.push('port must be between 1 and 65535');
    }
    if (row.pollIntervalMs !== undefined && row.pollIntervalMs < 250) {
      // Below this the poller spends more time on the wire than the device can
      // answer in, and a slow RS-485 bus backs up until every read times out.
      errors.push('pollIntervalMs must be at least 250');
    }
    if (row.timeoutMs !== undefined && row.timeoutMs < 100) {
      errors.push('timeoutMs must be at least 100');
    }
    if (
      row.pollIntervalMs !== undefined &&
      row.timeoutMs !== undefined &&
      row.timeoutMs > row.pollIntervalMs
    ) {
      errors.push(
        'timeoutMs must not exceed pollIntervalMs, or a slow device queues ' +
          'reads faster than it answers them',
      );
    }

    if (errors.length > 0) {
      throw new BadRequestException({ message: 'Invalid settings', errors });
    }
  }

  /**
   * The referenced device must exist IN THIS TENANT.
   *
   * Without this check a tenant admin could attach a Modbus endpoint to
   * another tenant's device id and start writing telemetry into their history —
   * the entity's FK only guarantees the row exists, not whose it is.
   */
  private async assertDeviceInTenant(
    deviceId: string | undefined,
    tenantId: string,
  ): Promise<void> {
    if (!deviceId) {
      throw new BadRequestException(
        'deviceId is required — a Modbus endpoint feeds an existing device.',
      );
    }
    const device = await this.deviceRepository.findOne({
      where: { id: deviceId, tenantId, deletedAt: IsNull() },
      select: { id: true },
    });
    if (!device) {
      // 404-shaped message, not "forbidden": see §4g.
      throw new NotFoundException('Device not found');
    }
  }

  /** Strip fields a caller must never set directly. */
  private scrub(dto: Record<string, any>): Partial<ModbusDevice> {
    const {
      id: _id,
      tenantId: _tenantId,
      registers: _registers,
      pollCount: _pollCount,
      errorCount: _errorCount,
      lastPollAt: _lastPollAt,
      lastPollStatus: _lastPollStatus,
      lastPollError: _lastPollError,
      device: _device,
      createdAt: _createdAt,
      updatedAt: _updatedAt,
      deletedAt: _deletedAt,
      ...rest
    } = dto;
    return rest as Partial<ModbusDevice>;
  }

  private async reloadAdapter(reason: string): Promise<void> {
    try {
      await this.adapter.reload();
      this.logger.log(`Modbus poller reloaded after ${reason}`);
    } catch (error: any) {
      // A failed reload must not fail the save — the row is correct, the
      // poller will pick it up on the next reload or restart.
      this.logger.error(
        `Modbus poller reload failed after ${reason}: ${error.message}`,
      );
    }
  }
}
