// src/modules/protocols/modbus/entities/modbus-device.entity.ts
import { Entity, Column, Index, ManyToOne, JoinColumn, Unique } from 'typeorm';
import { BaseEntity } from '@common/entities/base.entity';
import type { Relation } from 'typeorm';
import type { Tenant } from '../../../tenants/entities/tenant.entity';
import type { Device } from '../../../devices/entities/device.entity';

export const MODBUS_CONNECTION_TYPES = ['TCP', 'RTU'] as const;
export type ModbusConnectionType = (typeof MODBUS_CONNECTION_TYPES)[number];

export const MODBUS_REGISTER_TYPES = [
  'holding',
  'input',
  'coil',
  'discrete',
] as const;
export type ModbusRegisterType = (typeof MODBUS_REGISTER_TYPES)[number];

export const MODBUS_DATA_TYPES = [
  'int16',
  'uint16',
  'int32',
  'uint32',
  'float',
  'bool',
] as const;
export type ModbusDataType = (typeof MODBUS_DATA_TYPES)[number];

/**
 * One entry in a device's register map: a Modbus address and what the number
 * at that address means.
 */
export interface ModbusRegisterDefinition {
  /** Telemetry key the value is published under, e.g. 'temperature'. */
  name: string;
  /** Register address, zero-based as the driver expects it. */
  address: number;
  type: ModbusRegisterType;
  dataType: ModbusDataType;
  /** Registers to read. 1 for 16-bit values, 2 for int32/uint32/float. */
  length?: number;
  /** Multiplier applied to the raw value — 0.1 for a tenths-of-a-degree PLC. */
  scale?: number;
  /** Added after scaling. */
  offset?: number;
  unit?: string;
}

/**
 * A Modbus TCP/RTU device the poller should read.
 *
 * ─── Why this table exists ────────────────────────────────────────────────
 * `ModbusAdapter` used to read its entire fleet from a `MODBUS_DEVICES`
 * environment variable holding a JSON blob of devices and register maps. That
 * meant adding a meter was a redeploy, the configuration was invisible to the
 * product, it was not tenant-scoped in any way, and a typo in the JSON logged
 * a parse error and silently polled nothing.
 *
 * The database is now the source of truth. Env support is kept as a fallback
 * (see `ModbusAdapter.loadEnvDeviceConfigs`) so existing deployments do not
 * break on upgrade, but anything in this table wins.
 *
 * ─── `deviceId` is required ───────────────────────────────────────────────
 * A Modbus endpoint is not itself a platform device — it is a transport for
 * one. Telemetry has to land on a real `devices` row to be stored, charted and
 * alarmed, and that row is also where `tenantId` and `deviceKey` come from.
 * The env format carried a bare `deviceKey` string that was never checked
 * against anything, so a mistyped key produced readings that were quietly
 * dropped downstream.
 */
@Entity('modbus_devices')
@Index(['tenantId', 'enabled'])
@Index(['tenantId', 'deviceId'])
@Unique('UQ_modbus_devices_tenant_name', ['tenantId', 'name'])
export class ModbusDevice extends BaseEntity {
  @Column({ type: 'uuid' })
  tenantId: string;

  @ManyToOne('Tenant')
  @JoinColumn({ name: 'tenantId' })
  tenant: Relation<Tenant>;

  /** The platform device this endpoint feeds. */
  @Column({ type: 'uuid' })
  deviceId: string;

  @ManyToOne('Device', { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'deviceId' })
  device: Relation<Device>;

  /** Operator-facing name, unique per tenant. */
  @Column({ type: 'varchar', length: 120 })
  name: string;

  @Column({ type: 'text', nullable: true })
  description?: string | null;

  // ══════════════════════════════════════════════════════════════════════════
  // TRANSPORT
  // ══════════════════════════════════════════════════════════════════════════

  @Column({ type: 'varchar', length: 8, default: 'TCP' })
  connectionType: ModbusConnectionType;

  /** TCP: hostname or IP. Null for an RTU (serial) device. */
  @Column({ type: 'varchar', length: 255, nullable: true })
  host?: string | null;

  @Column({ type: 'int', default: 502 })
  port: number;

  /** RTU: serial device path, e.g. /dev/ttyUSB0. */
  @Column({ type: 'varchar', length: 255, nullable: true })
  serialPort?: string | null;

  @Column({ type: 'int', nullable: true })
  baudRate?: number | null;

  @Column({ type: 'varchar', length: 8, nullable: true })
  parity?: 'none' | 'even' | 'odd' | null;

  @Column({ type: 'int', nullable: true })
  dataBits?: number | null;

  @Column({ type: 'int', nullable: true })
  stopBits?: number | null;

  /** Modbus unit / slave id (1–247; 0 is the broadcast address). */
  @Column({ type: 'int', default: 1 })
  unitId: number;

  @Column({ type: 'int', default: 5000 })
  pollIntervalMs: number;

  @Column({ type: 'int', default: 5000 })
  timeoutMs: number;

  // ══════════════════════════════════════════════════════════════════════════
  // REGISTER MAP
  // ══════════════════════════════════════════════════════════════════════════

  /**
   * jsonb, with a `[]` default: a device with no registers is valid (it has
   * been created but not mapped yet) and the poller skips it, which is better
   * than a null that every reader has to guard.
   */
  @Column({ type: 'jsonb', default: () => "'[]'::jsonb" })
  registers: ModbusRegisterDefinition[];

  // ══════════════════════════════════════════════════════════════════════════
  // STATE
  // ══════════════════════════════════════════════════════════════════════════

  @Column({ type: 'boolean', default: true })
  enabled: boolean;

  /** Result of the last poll cycle, for the management screen. */
  @Column({ type: 'varchar', length: 16, nullable: true })
  lastPollStatus?: 'ok' | 'error' | null;

  @Column({ type: 'text', nullable: true })
  lastPollError?: string | null;

  @Column({ type: 'timestamp', nullable: true })
  lastPollAt?: Date | null;

  @Column({ type: 'bigint', default: 0 })
  pollCount: string;

  @Column({ type: 'bigint', default: 0 })
  errorCount: string;

  /** True when the poller has everything it needs to connect. */
  isPollable(): boolean {
    if (!this.enabled) return false;
    if (!Array.isArray(this.registers) || this.registers.length === 0) {
      return false;
    }
    return this.connectionType === 'TCP' ? !!this.host : !!this.serialPort;
  }
}
