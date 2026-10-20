// src/modules/protocols/bacnet/entities/bacnet-device.entity.ts
import { Entity, Column, Index, ManyToOne, JoinColumn, Unique } from 'typeorm';
import type { Relation } from 'typeorm';
import { BaseEntity } from '@common/entities/base.entity';
import type { Tenant } from '@modules/tenants/entities/tenant.entity';
import type { Device } from '@modules/devices/entities/device.entity';

/**
 * The BACnet object types this platform reads.
 *
 * Deliberately a short list. These five cover essentially every point a BMS
 * exposes for monitoring; the remaining ~50 object types are schedules,
 * trend logs, calendars and notification classes, which are configuration
 * rather than telemetry and would need a different screen entirely.
 */
export type BacnetObjectTypeName =
  | 'analogInput'
  | 'analogOutput'
  | 'analogValue'
  | 'binaryInput'
  | 'binaryOutput'
  | 'binaryValue'
  | 'multiStateInput'
  | 'multiStateValue';

/** One BACnet object/property → telemetry key mapping. */
export interface BacnetObjectMapping {
  objectType: BacnetObjectTypeName;
  objectInstance: number;
  /**
   * Property name. `presentValue` for all but the rarest case — a mapping that
   * reads `statusFlags` or `reliability` is how you chart a sensor's health
   * rather than its value.
   */
  property?: 'presentValue' | 'statusFlags' | 'reliability' | 'outOfService';
  /** Telemetry key the value is stored under. */
  telemetryKey: string;
  dataType?: 'string' | 'number' | 'boolean';
  scale?: number;
  unit?: string;
}

/**
 * ─────────────────────────────────────────────────────────────────────────────
 * A BACnet/IP device this tenant polls
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * BACnet addresses a device by its **device instance number** — a 22-bit
 * integer unique on the internetwork — and not by IP. The IP address is only
 * how the datagram is routed. Both are stored because both are needed and
 * neither can be derived from the other: discovery (Who-Is → I-Am) is how an
 * operator learns the instance number, which is why the discovery route
 * exists. Nobody reads an instance number off a chiller's nameplate.
 *
 * `deviceInstance` is unique per tenant: two rows claiming the same instance
 * means one of them is addressing the wrong controller, and a poll would read
 * the same points twice into two different devices.
 */
@Entity('bacnet_devices')
@Index(['tenantId', 'enabled'])
@Index(['tenantId', 'deviceId'])
@Unique('UQ_bacnet_devices_tenant_instance', ['tenantId', 'deviceInstance'])
export class BacnetDevice extends BaseEntity {
  @Column({ type: 'uuid' })
  tenantId: string;

  @ManyToOne('Tenant')
  @JoinColumn({ name: 'tenantId' })
  tenant: Relation<Tenant>;

  @Column({ type: 'varchar', length: 120 })
  name: string;

  @Column({ type: 'text', nullable: true })
  description?: string | null;

  /**
   * Platform device the points report as. Nullable for the same reason as
   * `OpcuaServer.deviceId`: a controller can be discovered and its objects
   * mapped before anyone decides which device row it belongs to, and the
   * adapter reports a row with no device as not ingesting rather than
   * inventing one.
   */
  @Column({ type: 'uuid', nullable: true })
  deviceId?: string | null;

  @ManyToOne('Device', { nullable: true, onDelete: 'SET NULL' })
  @JoinColumn({ name: 'deviceId' })
  device?: Relation<Device> | null;

  // ══════════════════════════════════════════════════════════════════════════
  // ADDRESSING
  // ══════════════════════════════════════════════════════════════════════════

  /**
   * Unicast IP (or `host:port`) the requests are sent to.
   *
   * Not a broadcast address: discovery broadcasts, polling does not. A poll
   * sent to 255.255.255.255 is answered by every controller on the subnet,
   * which is how you flood a BMS network.
   */
  @Column({ type: 'varchar', length: 200 })
  address: string;

  /** BACnet/IP UDP port on the target. 47808 (0xBAC0) is standard. */
  @Column({ type: 'int', default: 47808 })
  port: number;

  /** The device-instance number from its I-Am. 0 … 4194302. */
  @Column({ type: 'int' })
  deviceInstance: number;

  /** Vendor id from the I-Am, when discovery supplied it. */
  @Column({ type: 'int', nullable: true })
  vendorId?: number | null;

  /** Max APDU the controller said it accepts, from the I-Am. */
  @Column({ type: 'int', nullable: true })
  maxApdu?: number | null;

  // ══════════════════════════════════════════════════════════════════════════
  // WHAT TO READ
  // ══════════════════════════════════════════════════════════════════════════

  @Column({ type: 'jsonb', default: () => "'[]'::jsonb" })
  objects: BacnetObjectMapping[];

  @Column({ type: 'int', default: 30000 })
  pollIntervalMs: number;

  /**
   * One ReadPropertyMultiple for the whole object list, rather than a
   * ReadProperty per object.
   *
   * On by default because it is one datagram instead of N. Switchable because
   * plenty of field controllers advertise RPM in their services-supported
   * bitstring and then answer it with a reject or a truncated APDU, and the
   * only way through that is to fall back to single reads.
   */
  @Column({ type: 'boolean', default: true })
  useReadPropertyMultiple: boolean;

  @Column({ type: 'int', default: 6000 })
  apduTimeoutMs: number;

  @Column({ type: 'boolean', default: true })
  enabled: boolean;

  // ══════════════════════════════════════════════════════════════════════════
  // OBSERVED STATE
  // ══════════════════════════════════════════════════════════════════════════

  @Column({ type: 'varchar', length: 32, nullable: true })
  lastStatus?: 'ok' | 'error' | null;

  @Column({ type: 'text', nullable: true })
  lastMessage?: string | null;

  @Column({ type: 'timestamp', nullable: true })
  lastReadingAt?: Date | null;

  @Column({ type: 'bigint', default: 0 })
  readingCount: string;
}
