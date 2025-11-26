import { Entity, Column, ManyToOne, JoinColumn, Index } from 'typeorm';
import { BaseEntity } from '../../../common/entities/base.entity';
import { User } from '../../users/entities/user.entity';

export enum DeviceType {
  SENSOR = 'sensor',
  ACTUATOR = 'actuator',
  GATEWAY = 'gateway',
  CONTROLLER = 'controller',
  CAMERA = 'camera',
  TRACKER = 'tracker',
}

export enum DeviceStatus {
  ACTIVE = 'active',
  INACTIVE = 'inactive',
  OFFLINE = 'offline',
  MAINTENANCE = 'maintenance',
  ERROR = 'error',
}

export enum DeviceConnectionType {
  WIFI = 'wifi',
  ETHERNET = 'ethernet',
  CELLULAR = 'cellular',
  BLUETOOTH = 'bluetooth',
  ZIGBEE = 'zigbee',
  LORA = 'lora',
}

@Entity('devices')
@Index(['tenantId', 'status'])
@Index(['userId'])
@Index(['deviceKey'], { unique: true })
export class Device extends BaseEntity {
  @Column({ unique: true })
  deviceKey: string; // Unique device identifier

  @Column()
  name: string;

  @Column({ nullable: true })
  deviceProfileId: string; // device Profile association

  @Column({ nullable: true })
  assetId: string; // Asset association

  @Column({ type: 'text', nullable: true })
  description?: string;

  @Column({
    type: 'enum',
    enum: DeviceType,
    default: DeviceType.SENSOR,
  })
  type: DeviceType;

  @Column({
    type: 'enum',
    enum: DeviceStatus,
    default: DeviceStatus.INACTIVE,
  })
  status: DeviceStatus;

  @Column({
    type: 'enum',
    enum: DeviceConnectionType,
    default: DeviceConnectionType.WIFI,
  })
  connectionType: DeviceConnectionType;

  // Tenant/User ownership
  @Column({ nullable: true })
  tenantId?: string;

  @Column()
  userId: string;

  @ManyToOne(() => User)
  @JoinColumn({ name: 'userId' })
  user: User;

  // Device credentials
  @Column({ nullable: true, select: false })
  accessToken?: string;

  @Column({ nullable: true })
  secretKey?: string;

  // Network information
  @Column({ nullable: true })
  ipAddress?: string;

  @Column({ nullable: true })
  macAddress?: string;

  @Column({ nullable: true })
  firmwareVersion?: string;

  @Column({ nullable: true })
  hardwareVersion?: string;

  // Location
  @Column({ type: 'decimal', precision: 10, scale: 7, nullable: true })
  latitude?: number;

  @Column({ type: 'decimal', precision: 10, scale: 7, nullable: true })
  longitude?: number;

  @Column({ nullable: true })
  location?: string; // Human-readable location

  // Metadata
  @Column({ type: 'jsonb', nullable: true })
  metadata?: Record<string, any>;

  @Column({ type: 'jsonb', nullable: true })
  configuration?: Record<string, any>;

  // Activity tracking
  @Column({ type: 'timestamp', nullable: true })
  lastSeenAt?: Date;

  @Column({ type: 'timestamp', nullable: true })
  lastActivityAt?: Date;

  @Column({ type: 'timestamp', nullable: true })
  activatedAt?: Date;

  // Statistics
  @Column({ type: 'int', default: 0 })
  messageCount: number;

  @Column({ type: 'int', default: 0 })
  errorCount: number;

  @Column({ type: 'jsonb', nullable: true })
  tags?: string[];

  // Check if device is online (seen in last 5 minutes)
  isOnline(): boolean {
    if (!this.lastSeenAt) return false;
    const fiveMinutesAgo = new Date(Date.now() - 5 * 60 * 1000);
    return this.lastSeenAt > fiveMinutesAgo;
  }

  // Update last seen timestamp
  updateLastSeen(): void {
    this.lastSeenAt = new Date();
  }

  // Update activity
  updateActivity(): void {
    this.lastActivityAt = new Date();
    this.messageCount++;
  }
}
