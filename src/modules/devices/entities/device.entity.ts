import {
  Entity,
  Column,
  ManyToOne,
  OneToMany,
  JoinColumn,
  Index,
  OneToOne,
} from 'typeorm';
import type { Relation } from 'typeorm';
import { BaseEntity } from '@common/entities/base.entity';
import type { User } from '../../users/entities/user.entity';
import type { Tenant } from '../../tenants/entities/tenant.entity';
import type { Customer } from '../../customers/entities/customers.entity';
import type { Asset } from '../../assets/entities/asset.entity';
import type { DeviceProfile } from '../../profiles/entities/device-profile.entity';
import type { DeviceCredentials } from './device-credentials.entity';
import type { EdgeInstance } from '../../edge/entities/edge-instance.entity';
import {
  DeviceType,
  DeviceStatus,
  DeviceConnectionType,
} from '@common/enums/index.enum';

// ─── Protocol enum used for topic strategy selection ────────────────────────
// Stored on the device so we never guess from metadata.gatewayType strings.
export enum DeviceProtocol {
  GENERIC_MQTT = 'generic_mqtt',
  LORAWAN_MILESIGHT = 'lorawan_milesight',
  LORAWAN_CHIRPSTACK = 'lorawan_chirpstack',
  HTTP = 'http',
  COAP = 'coap',
}

@Entity('devices')
@Index(['tenantId', 'status'])
@Index(['tenantId', 'customerId'])
@Index(['tenantId', 'assetId'])
@Index(['tenantId', 'deviceProfileId'])
 @Index(['manufacturer', 'model'])
@Index(['deviceKey'], { unique: true })
export class Device extends BaseEntity {
  // ── Tenant scoping ────────────────────────────────────────────────────────

  @Column()
  tenantId: string;

  @ManyToOne('Tenant')
  @JoinColumn({ name: 'tenantId' })
  tenant: Relation<Tenant>;

  // ── Customer scoping (optional) ──────────────────────────────────────────

  @Column({ nullable: true })
  customerId?: string;

  @ManyToOne('Customer', { nullable: true })
  @JoinColumn({ name: 'customerId' })
  customer?: Relation<Customer>;

  // ── Basic info ────────────────────────────────────────────────────────────

  @Column({ unique: true })
  deviceKey: string;

  @Column()
  name: string;

  @Column({ type: 'text', nullable: true })
  description?: string;

  @Column({ type: 'enum', enum: DeviceType, default: DeviceType.SENSOR })
  type: DeviceType;

  @Column({ type: 'enum', enum: DeviceStatus, default: DeviceStatus.INACTIVE })
  status: DeviceStatus;

  @Column({
    type: 'enum',
    enum: DeviceConnectionType,
    default: DeviceConnectionType.WIFI,
  })
  connectionType: DeviceConnectionType;

  // ── Protocol — drives topic strategy & codec selection ───────────────────
  // Set at creation time from CreateDeviceDto; never changed after provisioning.
  @Column({
    type: 'enum',
    enum: DeviceProtocol,
    default: DeviceProtocol.GENERIC_MQTT,
  })
  protocol: DeviceProtocol;

  // ── Ownership ─────────────────────────────────────────────────────────────

  @Column()
  userId: string;

  @ManyToOne('User')
  @JoinColumn({ name: 'userId' })
  user: Relation<User>;

  // ── Device profile ────────────────────────────────────────────────────────

  @Column({ nullable: true })
  deviceProfileId?: string;

  @ManyToOne('DeviceProfile', { nullable: true })
  @JoinColumn({ name: 'deviceProfileId' })
  deviceProfile?: Relation<DeviceProfile>;

  // ── Asset association ─────────────────────────────────────────────────────

  @Column({ nullable: true })
  assetId?: string;

  @ManyToOne('Asset', 'devices', { nullable: true })
  @JoinColumn({ name: 'assetId' })
  asset?: Relation<Asset>;

  // ── Network info ──────────────────────────────────────────────────────────

  @Column({ nullable: true })
  ipAddress?: string;

  @Column({ nullable: true })
  macAddress?: string;

  @Column({ nullable: true })
  firmwareVersion?: string;

  @Column({ nullable: true })
  hardwareVersion?: string;

  // ── Location ──────────────────────────────────────────────────────────────

  @Column({ type: 'decimal', precision: 10, scale: 7, nullable: true })
  latitude?: number;

  @Column({ type: 'decimal', precision: 10, scale: 7, nullable: true })
  longitude?: number;

  @Column({ nullable: true })
  location?: string;

  // ── Configuration (device-specific settings, e.g. reporting interval) ────

  @Column({ type: 'jsonb', nullable: true })
  configuration?: Record<string, any>;

  // ── Metadata (static info: manufacturer, model, devEUI, codecId, etc.) ───
  // codecId   — which codec to use for decoding (e.g. 'milesight-ws558')
  // devEUI    — required for LoRaWAN devices
  // manufacturer / model — used for codec auto-detection fallback
  @Column({ type: 'jsonb', nullable: true })
  metadata?: Record<string, any>;

  @Column({ nullable: true })
  manufacturer?: string;
 
  @Column({ nullable: true })
  model?: string;

  // ══════════════════════════════════════════════════════════════════════════
  // EDGE ASSOCIATION (OPTIONAL)
  // ══════════════════════════════════════════════════════════════════════════

  @Column({ nullable: true })
  edgeId?: string;

  @ManyToOne('EdgeInstance', { nullable: true, onDelete: 'SET NULL' })
  @JoinColumn({ name: 'edgeId' })
  edge?: Relation<EdgeInstance>;


  // ── Tags ──────────────────────────────────────────────────────────────────

  @Column({ type: 'simple-array', nullable: true })
  tags?: string[];

  // ── Activity tracking ─────────────────────────────────────────────────────

  @Column({ type: 'timestamp', nullable: true })
  lastSeenAt?: Date;

  @Column({ type: 'timestamp', nullable: true })
  lastActivityAt?: Date;

  @Column({ type: 'timestamp', nullable: true })
  activatedAt?: Date;

  // ── Credentials (1:1) — cascade handled by FK, not by TypeORM cascade ────

  @OneToOne('DeviceCredentials', 'device', {
    nullable: true,
  })
  credentials?: Relation<DeviceCredentials>;

  // ── Statistics ────────────────────────────────────────────────────────────

  @Column({ type: 'int', default: 0 })
  messageCount: number;

  @Column({ type: 'int', default: 0 })
  errorCount: number;

  // ── Helper methods ────────────────────────────────────────────────────────

  isOnline(): boolean {
    if (!this.lastSeenAt) return false;
    const fiveMinutesAgo = new Date(Date.now() - 5 * 60 * 1000);
    return this.lastSeenAt > fiveMinutesAgo;
  }

  updateLastSeen(): void {
    this.lastSeenAt = new Date();
    if (this.status === DeviceStatus.OFFLINE) {
      this.status = DeviceStatus.ACTIVE;
    }
  }

  updateActivity(): void {
    this.lastActivityAt = new Date();
    this.messageCount++;
    this.updateLastSeen();
  }

  markOffline(): void {
    this.status = DeviceStatus.OFFLINE;
  }

  recordError(): void {
    this.errorCount++;
  }
}