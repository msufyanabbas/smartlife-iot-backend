// src/modules/protocols/opcua/entities/opcua-server.entity.ts
import { Entity, Column, Index, ManyToOne, JoinColumn, Unique } from 'typeorm';
import type { Relation } from 'typeorm';
import { BaseEntity } from '@common/entities/base.entity';
import type { Tenant } from '@modules/tenants/entities/tenant.entity';
import type { Device } from '@modules/devices/entities/device.entity';
import type { Asset } from '@modules/assets/entities/asset.entity';

/** OPC-UA message security mode, mirroring `MessageSecurityMode`. */
export type OpcuaSecurityMode = 'None' | 'Sign' | 'SignAndEncrypt';

/**
 * Security policy URIs, by their short names in `SecurityPolicy`.
 *
 * Basic128Rsa15 and Basic256 are deprecated by the OPC Foundation but are
 * still what most installed PLCs offer, so they are listed rather than
 * withheld — refusing to connect to the hardware that exists is not a
 * security win, and the UI says which are deprecated.
 */
export type OpcuaSecurityPolicy =
  | 'None'
  | 'Basic128Rsa15'
  | 'Basic256'
  | 'Basic256Sha256'
  | 'Aes128_Sha256_RsaOaep'
  | 'Aes256_Sha256_RsaPss';

/**
 * One NodeId → telemetry key mapping.
 *
 * `dataType` is the telemetry type to coerce INTO, not the OPC-UA type of the
 * node: an OPC-UA server can legitimately serve a boolean as a UInt16, and the
 * dashboard needs to know which of those the series is.
 */
export interface OpcuaNodeMapping {
  /** e.g. `ns=2;s=Boiler1.Temperature` or `ns=3;i=1005`. */
  nodeId: string;
  /** Telemetry key the value is stored under. */
  key: string;
  dataType?: 'string' | 'number' | 'boolean';
  /** Multiplier applied before storing — for raw counts that mean 0.1 °C. */
  scale?: number;
  /** Unit label, carried into telemetry metadata. Not used in arithmetic. */
  unit?: string;
}

/**
 * ─────────────────────────────────────────────────────────────────────────────
 * An OPC-UA server this tenant reads from
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * The row is the SERVER, not the device, because that is how OPC-UA is shaped:
 * one endpoint, one session, one set of credentials, and tens to thousands of
 * nodes behind it. Modelling it per-device would open a TCP session and a
 * subscription per device against the same PLC, which is exactly what an
 * OPC-UA server's session limit (often 10) is there to stop.
 *
 * `deviceId` therefore says where the readings LAND, not what is connected to:
 * every node in `nodes` becomes a telemetry key on that one device. A
 * multi-device PLC gets one row per device with the same `endpointUrl` and
 * different `nodes` — the adapter notices the shared endpoint and does not
 * open a second session for it.
 *
 * `assetId` is an alternative landing place for installations where the points
 * belong to a building rather than a device. It is recorded for the operator's
 * benefit; telemetry always needs a device, so a row with only an asset is
 * stored and reported as not ingesting.
 */
@Entity('opcua_servers')
@Index(['tenantId', 'enabled'])
@Index(['tenantId', 'deviceId'])
@Index(['tenantId', 'endpointUrl'])
@Unique('UQ_opcua_servers_tenant_name', ['tenantId', 'name'])
export class OpcuaServer extends BaseEntity {
  @Column({ type: 'uuid' })
  tenantId: string;

  @ManyToOne('Tenant')
  @JoinColumn({ name: 'tenantId' })
  tenant: Relation<Tenant>;

  /** Operator-facing name, unique per tenant. */
  @Column({ type: 'varchar', length: 120 })
  name: string;

  @Column({ type: 'text', nullable: true })
  description?: string | null;

  // ══════════════════════════════════════════════════════════════════════════
  // WHERE THE READINGS LAND
  // ══════════════════════════════════════════════════════════════════════════

  /**
   * The device every node on this server reports as.
   *
   * Nullable so a server can be configured and connection-tested before the
   * device exists, and so a row can be kept after its device is deleted rather
   * than cascading away the node map someone spent an afternoon building. The
   * adapter skips a row with no device and says so.
   */
  @Column({ type: 'uuid', nullable: true })
  deviceId?: string | null;

  @ManyToOne('Device', { nullable: true, onDelete: 'SET NULL' })
  @JoinColumn({ name: 'deviceId' })
  device?: Relation<Device> | null;

  /** Optional asset the points belong to. Informational — see the class doc. */
  @Column({ type: 'uuid', nullable: true })
  assetId?: string | null;

  @ManyToOne('Asset', { nullable: true, onDelete: 'SET NULL' })
  @JoinColumn({ name: 'assetId' })
  asset?: Relation<Asset> | null;

  // ══════════════════════════════════════════════════════════════════════════
  // CONNECTION
  // ══════════════════════════════════════════════════════════════════════════

  /** `opc.tcp://host:4840/path`. */
  @Column({ type: 'varchar', length: 500 })
  endpointUrl: string;

  @Column({ type: 'varchar', length: 32, default: 'None' })
  securityMode: OpcuaSecurityMode;

  @Column({ type: 'varchar', length: 64, default: 'None' })
  securityPolicy: OpcuaSecurityPolicy;

  /**
   * Username for user-name identity. Empty/null means ANONYMOUS, which is what
   * most engineering-workstation endpoints are left on.
   */
  @Column({ type: 'varchar', length: 200, nullable: true })
  username?: string | null;

  /**
   * AES-256-GCM ciphertext of the password — never the password.
   *
   * `select: false` so it cannot leave through a careless `find()`; the
   * adapter and the connection test ask for it explicitly. Same pattern as
   * `AiModel.apiKeyEncrypted`, and deliberately NOT the weaker
   * `integrations.configuration` pattern, which keeps cloud credentials in
   * plaintext jsonb (CLAUDE.md §4l).
   */
  @Column({ type: 'text', nullable: true, select: false })
  passwordEncrypted?: string | null;

  // ══════════════════════════════════════════════════════════════════════════
  // WHAT TO READ
  // ══════════════════════════════════════════════════════════════════════════

  @Column({ type: 'jsonb', default: () => "'[]'::jsonb" })
  nodes: OpcuaNodeMapping[];

  /**
   * `true` → a real OPC-UA subscription with monitored items: the server
   * reports a node only when it changes, which is the entire point of the
   * protocol. `false` → a timed `session.read()` of every node, for servers
   * whose subscription support is broken or whose session limit forbids one.
   */
  @Column({ type: 'boolean', default: true })
  useSubscription: boolean;

  /** Subscription publishing interval (ms). */
  @Column({ type: 'int', default: 1000 })
  publishingIntervalMs: number;

  /** Requested per-item sampling interval (ms). */
  @Column({ type: 'int', default: 1000 })
  samplingIntervalMs: number;

  /** Read period (ms) when `useSubscription` is false. */
  @Column({ type: 'int', default: 10000 })
  pollIntervalMs: number;

  /**
   * How long changed values are coalesced before one telemetry message is
   * emitted.
   *
   * Without this, a subscription over 40 nodes that all change on the same
   * server scan produces 40 `handleTelemetry()` calls — 40 telemetry rows, 40
   * Kafka messages and 40 alarm evaluations for one instant of plant state.
   * One flush window turns that back into one reading with 40 keys.
   */
  @Column({ type: 'int', default: 1000 })
  flushWindowMs: number;

  @Column({ type: 'boolean', default: true })
  enabled: boolean;

  // ══════════════════════════════════════════════════════════════════════════
  // OBSERVED STATE — written by the adapter and the test route
  // ══════════════════════════════════════════════════════════════════════════

  @Column({ type: 'varchar', length: 32, nullable: true })
  lastStatus?: 'connected' | 'error' | 'disconnected' | null;

  @Column({ type: 'text', nullable: true })
  lastMessage?: string | null;

  @Column({ type: 'timestamp', nullable: true })
  lastConnectedAt?: Date | null;

  @Column({ type: 'timestamp', nullable: true })
  lastReadingAt?: Date | null;

  /** Readings handed to DeviceListenerService from this server. */
  @Column({ type: 'bigint', default: 0 })
  readingCount: string;
}
