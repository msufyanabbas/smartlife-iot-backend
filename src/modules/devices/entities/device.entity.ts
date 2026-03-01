// src/modules/devices/entities/device.entity.ts
import { Entity, Column, ManyToOne, OneToMany, JoinColumn, Index, OneToOne } from 'typeorm';
import { BaseEntity } from '@common/entities/base.entity';
import { User, Tenant, Customer, Asset, DeviceProfile, DeviceCredentials } from '@modules/index.entities';
import { DeviceType, DeviceStatus, DeviceConnectionType } from '@common/enums/index.enum';


@Entity('devices')
@Index(['tenantId', 'status'])
@Index(['tenantId', 'customerId'])
@Index(['tenantId', 'assetId'])
@Index(['tenantId', 'deviceProfileId'])
@Index(['deviceKey'], { unique: true })
export class Device extends BaseEntity {
  // ══════════════════════════════════════════════════════════════════════════
  // TENANT SCOPING (REQUIRED)
  // ══════════════════════════════════════════════════════════════════════════

  @Column()
  @Index()
  tenantId: string;

  @ManyToOne(() => Tenant)
  @JoinColumn({ name: 'tenantId' })
  tenant: Tenant;

  // ══════════════════════════════════════════════════════════════════════════
  // CUSTOMER SCOPING (OPTIONAL)
  // ══════════════════════════════════════════════════════════════════════════

  @Column({ nullable: true })
  @Index()
  customerId?: string;

  @ManyToOne(() => Customer, { nullable: true })
  @JoinColumn({ name: 'customerId' })
  customer?: Customer;

  // ══════════════════════════════════════════════════════════════════════════
  // BASIC INFO
  // ══════════════════════════════════════════════════════════════════════════

  @Column({ unique: true })
  @Index()
  deviceKey: string;  // Unique identifier (MAC address, IMEI, UUID)

  @Column()
  name: string;

  @Column({ type: 'text', nullable: true })
  description?: string;

  @Column({ type: 'enum', enum: DeviceType, default: DeviceType.SENSOR })
  type: DeviceType;

  @Column({ type: 'enum', enum: DeviceStatus, default: DeviceStatus.INACTIVE })
  @Index()
  status: DeviceStatus;

  @Column({ type: 'enum', enum: DeviceConnectionType, default: DeviceConnectionType.WIFI })
  connectionType: DeviceConnectionType;

  // ══════════════════════════════════════════════════════════════════════════
  // OWNERSHIP
  // ══════════════════════════════════════════════════════════════════════════

  @Column()
  @Index()
  userId: string;  // Who created this device

  @ManyToOne(() => User)
  @JoinColumn({ name: 'userId' })
  user: User;

  // ══════════════════════════════════════════════════════════════════════════
  // DEVICE PROFILE (Configuration Template)
  // ══════════════════════════════════════════════════════════════════════════

  @Column({ nullable: true })
  @Index()
  deviceProfileId?: string;

  @ManyToOne(() => DeviceProfile, { nullable: true })
  @JoinColumn({ name: 'deviceProfileId' })
  deviceProfile?: DeviceProfile;

  // ══════════════════════════════════════════════════════════════════════════
  // ASSET ASSOCIATION (1 Device → 1 Asset)
  // ══════════════════════════════════════════════════════════════════════════

  @Column({ nullable: true })
  @Index()
  assetId?: string;

  @ManyToOne(() => Asset, asset => asset.devices, { nullable: true })
  @JoinColumn({ name: 'assetId' })
  asset?: Asset;

  // ══════════════════════════════════════════════════════════════════════════
  // NETWORK INFO (Physical connectivity)
  // ══════════════════════════════════════════════════════════════════════════

  @Column({ nullable: true })
  ipAddress?: string;  // Current IP: "192.168.1.42"

  @Column({ nullable: true })
  macAddress?: string;  // MAC address: "00:1A:2B:3C:4D:5E"

  @Column({ nullable: true })
  firmwareVersion?: string;  // "v1.2.3"

  @Column({ nullable: true })
  hardwareVersion?: string;  // "HW-Rev-2.0"

  // ══════════════════════════════════════════════════════════════════════════
  // LOCATION (GPS coordinates + human-readable)
  // ══════════════════════════════════════════════════════════════════════════

  @Column({ type: 'decimal', precision: 10, scale: 7, nullable: true })
  latitude?: number;  // 24.7136

  @Column({ type: 'decimal', precision: 10, scale: 7, nullable: true })
  longitude?: number;  // 46.6753

  @Column({ nullable: true })
  location?: string;  // "Building A, Floor 3, Room 301"

  // ══════════════════════════════════════════════════════════════════════════
  // CONFIGURATION (Device-specific settings)
  // ══════════════════════════════════════════════════════════════════════════

  @Column({ type: 'jsonb', nullable: true })
  configuration?: Record<string, any>;
  // Example for Temperature Sensor:
  // configuration: {
  //   reportingInterval: 60,          // Send data every 60 seconds
  //   sensorCalibration: {
  //     offset: -0.5,                 // Adjust readings by -0.5°C
  //     multiplier: 1.0
  //   },
  //   sleepMode: true,
  //   wakeupInterval: 300,            // Wake every 5 minutes
  //   temperatureUnit: 'celsius',
  //   thresholds: {
  //     highTemp: 35,
  //     lowTemp: 10
  //   }
  // }
  //
  // Example for Gateway:
  // configuration: {
  //   maxConnectedDevices: 100,
  //   protocol: 'lorawan',
  //   frequencyBand: 'EU868',
  //   dataRate: 'SF7BW125',
  //   txPower: 14
  // }

  // ══════════════════════════════════════════════════════════════════════════
  // METADATA (Static info about the device)
  // ══════════════════════════════════════════════════════════════════════════

  @Column({ type: 'jsonb', nullable: true })
  metadata?: Record<string, any>;
  // Example:
  // metadata: {
  //   manufacturer: 'Milesight',
  //   model: 'WS202',
  //   serialNumber: 'SN-20240115-001',
  //   installationDate: '2024-01-15',
  //   installedBy: 'John Doe',
  //   warrantyExpiry: '2027-01-15',
  //   purchasePrice: 150,
  //   vendor: 'ABC IoT Supplies'
  // }

  // ══════════════════════════════════════════════════════════════════════════
  // TAGS (For filtering/grouping)
  // ══════════════════════════════════════════════════════════════════════════

  @Column({ type: 'simple-array', nullable: true })
  tags?: string[];
  // Example: ['critical', 'hvac', 'monitored', 'building-a', 'floor-3']

  // ══════════════════════════════════════════════════════════════════════════
  // ACTIVITY TRACKING
  // ══════════════════════════════════════════════════════════════════════════

  @Column({ type: 'timestamp', nullable: true })
  @Index()
  lastSeenAt?: Date;  // Last time device was seen (heartbeat)

  @OneToOne(() => DeviceCredentials, credentials => credentials.device, {
    nullable: true,
    cascade: true
  })
  credentials?: DeviceCredentials;

  @Column({ type: 'timestamp', nullable: true })
  lastActivityAt?: Date;  // Last time device sent data

  @Column({ type: 'timestamp', nullable: true })
  activatedAt?: Date;  // When device was first activated

  // ══════════════════════════════════════════════════════════════════════════
  // STATISTICS
  // ══════════════════════════════════════════════════════════════════════════

  @Column({ type: 'int', default: 0 })
  messageCount: number;  // Total messages sent by device

  @Column({ type: 'int', default: 0 })
  errorCount: number;  // Total errors encountered

  // ══════════════════════════════════════════════════════════════════════════
  // HELPER METHODS
  // ══════════════════════════════════════════════════════════════════════════

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
