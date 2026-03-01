// src/modules/edge/entities/edge-instance.entity.ts
import { Entity, Column, Index, ManyToOne, JoinColumn } from 'typeorm';
import { BaseEntity } from '@common/entities/base.entity';
import { Tenant, Customer, User } from '@modules/index.entities';
import { EdgeStatus } from '@common/enums/index.enum';

@Entity('edge_instances')
@Index(['tenantId', 'status'])
@Index(['tenantId', 'userId'])
@Index(['tenantId', 'customerId'])
@Index(['status'])
export class EdgeInstance extends BaseEntity {
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
  // OWNERSHIP
  // ══════════════════════════════════════════════════════════════════════════
  
  @Column()
  @Index()
  userId: string;

  @ManyToOne(() => User)
  @JoinColumn({ name: 'userId' })
  user: User;

  // ══════════════════════════════════════════════════════════════════════════
  // BASIC INFO
  // ══════════════════════════════════════════════════════════════════════════
  
  @Column()
  name: string;  // "Edge Gateway 1", "Factory Floor Edge"

  @Column({ type: 'text', nullable: true })
  description?: string;

  @Column({ nullable: true })
  location?: string;  // "Building A - Floor 3", "Warehouse 2"

  @Column({ type: 'enum', enum: EdgeStatus, default: EdgeStatus.OFFLINE })
  @Index()
  status: EdgeStatus;

  @Column()
  version: string;  // "1.2.5"

  // ══════════════════════════════════════════════════════════════════════════
  // NETWORK INFO
  // ══════════════════════════════════════════════════════════════════════════
  
  @Column({ nullable: true })
  ipAddress?: string;  // "192.168.1.100"

  @Column({ nullable: true })
  macAddress?: string;  // "00:1B:44:11:3A:B7"

  @Column({ nullable: true })
  hostname?: string;  // "edge-gateway-001"

  @Column({ type: 'timestamp', nullable: true })
  lastSeen?: Date;

  // ══════════════════════════════════════════════════════════════════════════
  // DEVICE COUNT
  // ══════════════════════════════════════════════════════════════════════════
  
  @Column({ type: 'int', default: 0 })
  deviceCount: number;  // How many devices connected to this edge

  // ══════════════════════════════════════════════════════════════════════════
  // SYSTEM METRICS
  // ══════════════════════════════════════════════════════════════════════════
  
  @Column({ type: 'jsonb', nullable: true })
  metrics?: {
    cpu: number;              // Percentage (0-100)
    memory: number;           // Percentage (0-100)
    storage: number;          // Percentage (0-100)
    uptime: number;           // Seconds
    temperature?: number;     // Celsius
    networkIn?: number;       // Bytes per second
    networkOut?: number;      // Bytes per second
  };
  // Example:
  // metrics: {
  //   cpu: 45.2,
  //   memory: 62.8,
  //   storage: 38.5,
  //   uptime: 864000,  // 10 days
  //   temperature: 42,
  //   networkIn: 1024000,
  //   networkOut: 512000
  // }

  // ══════════════════════════════════════════════════════════════════════════
  // DATA SYNCHRONIZATION
  // ══════════════════════════════════════════════════════════════════════════
  
  @Column({ type: 'jsonb', nullable: true })
  dataSync?: {
    pending: number;          // Messages pending sync
    lastSync?: Date;          // Last successful sync
    syncInterval?: number;    // Seconds between syncs
    failedAttempts?: number;  // Consecutive failed sync attempts
    totalSynced?: number;     // Total messages synced
  };
  // Example:
  // dataSync: {
  //   pending: 42,
  //   lastSync: new Date('2024-03-01T10:30:00Z'),
  //   syncInterval: 60,
  //   failedAttempts: 0,
  //   totalSynced: 15420
  // }

  // ══════════════════════════════════════════════════════════════════════════
  // CONFIGURATION
  // ══════════════════════════════════════════════════════════════════════════
  
  @Column({ type: 'jsonb', nullable: true })
  config?: {
    enabled: boolean;
    autoSync: boolean;
    maxDevices?: number;
    protocols?: string[];     // ['MQTT', 'HTTP', 'Modbus']
    storageLimit?: number;    // GB
    retentionDays?: number;   // Days to keep data locally
  };
  // Example:
  // config: {
  //   enabled: true,
  //   autoSync: true,
  //   maxDevices: 100,
  //   protocols: ['MQTT', 'HTTP', 'Modbus'],
  //   storageLimit: 50,
  //   retentionDays: 7
  // }

  // ══════════════════════════════════════════════════════════════════════════
  // METADATA
  // ══════════════════════════════════════════════════════════════════════════
  
  @Column({ type: 'simple-array', nullable: true })
  tags?: string[];  // ['production', 'critical', 'factory-floor']

  @Column({ type: 'jsonb', nullable: true })
  additionalInfo?: Record<string, any>;

  // ══════════════════════════════════════════════════════════════════════════
  // HELPER METHODS
  // ══════════════════════════════════════════════════════════════════════════

  /**
   * Check if edge instance is online
   */
  isOnline(): boolean {
    return this.status === EdgeStatus.ONLINE;
  }

  /**
   * Check if edge instance is offline
   */
  isOffline(): boolean {
    return this.status === EdgeStatus.OFFLINE;
  }

  /**
   * Check if edge instance has pending sync
   */
  hasPendingSync(): boolean {
    return (this.dataSync?.pending ?? 0) > 0;
  }

  /**
   * Check if edge instance is healthy (online and low pending)
   */
  isHealthy(): boolean {
    return (
      this.status === EdgeStatus.ONLINE &&
      (this.dataSync?.pending ?? 0) < 100 &&
      (this.metrics?.cpu ?? 0) < 80 &&
      (this.metrics?.memory ?? 0) < 80
    );
  }

  /**
   * Get uptime in human-readable format
   */
  getUptimeFormatted(): string {
    if (!this.metrics?.uptime) return 'N/A';
    
    const seconds = this.metrics.uptime;
    const days = Math.floor(seconds / 86400);
    const hours = Math.floor((seconds % 86400) / 3600);
    const minutes = Math.floor((seconds % 3600) / 60);
    
    return `${days}d ${hours}h ${minutes}m`;
  }

  /**
   * Check if edge was seen recently (within last 5 minutes)
   */
  wasSeenRecently(): boolean {
    if (!this.lastSeen) return false;
    const fiveMinutesAgo = Date.now() - 5 * 60 * 1000;
    return this.lastSeen.getTime() > fiveMinutesAgo;
  }

  /**
   * Update metrics
   */
  updateMetrics(metrics: Partial<EdgeInstance['metrics']>): void {
    this.metrics = {
      ...this.metrics,
      ...metrics,
    } as EdgeInstance['metrics'];
    this.lastSeen = new Date();
  }

  /**
   * Update sync status
   */
  updateSyncStatus(pending: number, success: boolean = true): void {
    if (!this.dataSync) {
      this.dataSync = { pending };
    } else {
      this.dataSync.pending = pending;
      if (success) {
        this.dataSync.lastSync = new Date();
        this.dataSync.failedAttempts = 0;
      } else {
        this.dataSync.failedAttempts = (this.dataSync.failedAttempts ?? 0) + 1;
      }
    }
  }
}