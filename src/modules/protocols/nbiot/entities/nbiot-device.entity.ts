// src/modules/protocols/nbiot/entities/nbiot-device.entity.ts
import { Entity, Column, Index, ManyToOne, JoinColumn, Unique } from 'typeorm';
import type { Relation } from 'typeorm';
import { BaseEntity } from '@common/entities/base.entity';
import type { Tenant } from '@modules/tenants/entities/tenant.entity';
import type { Device } from '@modules/devices/entities/device.entity';

/** Which application protocol the device speaks over the NB-IoT bearer. */
export type NbIotAppProtocol = 'coap' | 'mqtt' | 'mqtt_sn' | 'http';

/**
 * ─────────────────────────────────────────────────────────────────────────────
 * The SIM-and-radio half of an NB-IoT device
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * NB-IoT is a BEARER. There is no NB-IoT application protocol to implement:
 * the device sends CoAP, MQTT-SN or HTTP, and this platform already ingests
 * all three. So what is genuinely missing without this table is not a codec —
 * it is the identity an NB-IoT fault is diagnosed from.
 *
 * When an NB-IoT device goes quiet, the question is never "what did the last
 * payload say". It is: is the SIM still active (ICCID, to the carrier), is it
 * attached (IMSI), is it the right box (IMEI), on which APN, and what was the
 * last RSRP. None of that fits in `devices.metadata` in a way anything can
 * query or chart, and none of it is per-reading, so it is a row, not telemetry.
 *
 * The radio metrics here are a **cache of the last uplink's** values, kept so
 * the list screen can show signal without a telemetry query. The authoritative
 * history is the telemetry series `nbiotRsrp`, `nbiotRsrq`, `nbiotSinr`,
 * `nbiotEcl` and `nbiotCoverageClass`, written through
 * `DeviceListenerService.handleTelemetry()` like any other series so they
 * chart, alarm and export identically.
 */
@Entity('nbiot_devices')
@Index(['tenantId', 'enabled'])
@Index(['tenantId', 'deviceId'])
@Index(['tenantId', 'imei'])
@Index(['tenantId', 'imsi'])
@Unique('UQ_nbiot_devices_tenant_device', ['tenantId', 'deviceId'])
export class NbIotDevice extends BaseEntity {
  @Column({ type: 'uuid' })
  tenantId: string;

  @ManyToOne('Tenant')
  @JoinColumn({ name: 'tenantId' })
  tenant: Relation<Tenant>;

  /**
   * The platform device this SIM belongs to. Required, unlike the OPC-UA and
   * BACnet rows: an NB-IoT record with no device is a SIM in a drawer, and the
   * uplink route has nowhere to put its telemetry.
   */
  @Column({ type: 'uuid' })
  deviceId: string;

  @ManyToOne('Device', { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'deviceId' })
  device: Relation<Device>;

  // ══════════════════════════════════════════════════════════════════════════
  // SIM AND MODULE IDENTITY
  //
  // All nullable and all varchar. A commissioning engineer rarely has every
  // identifier at once — the ICCID is printed on the SIM, the IMEI on the
  // module, and the IMSI usually has to be asked for — so requiring all three
  // would stop the row being created at the only moment someone is standing in
  // front of the hardware. They are varchar rather than numeric because an
  // ICCID can be 20 digits with a check digit and leading zeros matter.
  // ══════════════════════════════════════════════════════════════════════════

  /** International Mobile Subscriber Identity — 14–15 digits, identifies the subscription. */
  @Column({ type: 'varchar', length: 32, nullable: true })
  imsi?: string | null;

  /** International Mobile Equipment Identity — 15 digits, identifies the module. */
  @Column({ type: 'varchar', length: 32, nullable: true })
  imei?: string | null;

  /** Integrated Circuit Card ID — 19–20 digits, identifies the physical SIM. */
  @Column({ type: 'varchar', length: 32, nullable: true })
  iccid?: string | null;

  /** The SIM's number, where the carrier issues one. */
  @Column({ type: 'varchar', length: 32, nullable: true })
  msisdn?: string | null;

  // ══════════════════════════════════════════════════════════════════════════
  // NETWORK
  // ══════════════════════════════════════════════════════════════════════════

  /** Carrier / MNO name, e.g. `STC`, `Zain KSA`, `Mobily`. */
  @Column({ type: 'varchar', length: 120, nullable: true })
  carrier?: string | null;

  /** APN the device attaches with, e.g. `nbiot.zain.sa`. */
  @Column({ type: 'varchar', length: 200, nullable: true })
  apn?: string | null;

  /** PLMN (MCC+MNC), e.g. `42001`. Narrows which network a roaming SIM is on. */
  @Column({ type: 'varchar', length: 16, nullable: true })
  plmn?: string | null;

  /** 3GPP band, e.g. 8, 20, 28. */
  @Column({ type: 'int', nullable: true })
  band?: number | null;

  @Column({ type: 'varchar', length: 16, default: 'coap' })
  appProtocol: NbIotAppProtocol;

  /**
   * Seconds the device may legitimately stay silent.
   *
   * A PSM device that reports once a day is NOT offline at minute six, which
   * is what `Device.isOnline()`'s fixed five-minute window says about it. This
   * is the honest window for THIS device, recorded so a screen can say
   * "overdue" instead of the generic status lying.
   */
  @Column({ type: 'int', nullable: true })
  expectedReportIntervalSeconds?: number | null;

  @Column({ type: 'boolean', default: true })
  enabled: boolean;

  // ══════════════════════════════════════════════════════════════════════════
  // LAST-KNOWN RADIO METRICS (a cache — telemetry is the record)
  //
  // Doubles rather than ints: RSRQ and SINR are routinely fractional
  // (-10.5 dB), and rounding them loses the only thing that distinguishes a
  // marginal cell from a dead one.
  // ══════════════════════════════════════════════════════════════════════════

  /** Reference Signal Received Power, dBm. Roughly -44 (excellent) … -140 (lost). */
  @Column({ type: 'double precision', nullable: true })
  lastRsrp?: number | null;

  /** Reference Signal Received Quality, dB. -3 (excellent) … -20 (unusable). */
  @Column({ type: 'double precision', nullable: true })
  lastRsrq?: number | null;

  /** Signal-to-Interference-plus-Noise Ratio, dB. */
  @Column({ type: 'double precision', nullable: true })
  lastSinr?: number | null;

  /**
   * Coverage Enhancement Level, 0–2.
   *
   * The one metric that is NB-IoT specific and the one that matters most for
   * battery life: ECL 2 means the modem is repeating every transmission to be
   * heard at all, which can cost an order of magnitude more energy per uplink
   * than ECL 0 at the same payload size.
   */
  @Column({ type: 'int', nullable: true })
  lastEcl?: number | null;

  /** Coverage class as the carrier reports it, where it differs from ECL. */
  @Column({ type: 'int', nullable: true })
  lastCoverageClass?: number | null;

  /** Serving cell id. */
  @Column({ type: 'varchar', length: 32, nullable: true })
  lastCellId?: string | null;

  /** Tracking Area Code. */
  @Column({ type: 'varchar', length: 32, nullable: true })
  lastTac?: string | null;

  @Column({ type: 'timestamp', nullable: true })
  lastUplinkAt?: Date | null;

  @Column({ type: 'bigint', default: 0 })
  uplinkCount: string;
}
