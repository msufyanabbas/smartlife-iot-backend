// src/modules/edge/entities/edge-instance.entity.ts
import {
  Entity,
  Column,
  Index,
  ManyToOne,
  JoinColumn,
  OneToMany,
} from 'typeorm';
import { BaseEntity } from '@common/entities/base.entity';
import type { Relation } from 'typeorm';
import type { Tenant } from '../../tenants/entities/tenant.entity';
import type { Customer } from '../../customers/entities/customers.entity';
import type { User } from '../../users/entities/user.entity';
import { EdgeStatus } from '@common/enums/edge.enum';
import type { EdgeCommand } from './edge-command.entity';
import type { EdgeMetricsSnapshot } from './edge-metrics-snapshot.entity';

@Entity('edge_instances')
@Index(['tenantId', 'status'])
@Index(['tenantId', 'userId'])
@Index(['tenantId', 'customerId'])
@Index(['status'])
@Index(['edgeToken'], { unique: true })
export class EdgeInstance extends BaseEntity {
  // ══════════════════════════════════════════════════════════════════════════
  // TENANT SCOPING (REQUIRED)
  // ══════════════════════════════════════════════════════════════════════════

  @Column()
  tenantId: string;

  @ManyToOne('Tenant')
  @JoinColumn({ name: 'tenantId' })
  tenant: Relation<Tenant>;

  // ══════════════════════════════════════════════════════════════════════════
  // CUSTOMER SCOPING (OPTIONAL)
  // ══════════════════════════════════════════════════════════════════════════

  @Column({ nullable: true })
  customerId?: string;

  @ManyToOne('Customer', { nullable: true })
  @JoinColumn({ name: 'customerId' })
  customer?: Relation<Customer>;

  // ══════════════════════════════════════════════════════════════════════════
  // OWNERSHIP
  // ══════════════════════════════════════════════════════════════════════════

  @Column()
  userId: string;

  @ManyToOne('User')
  @JoinColumn({ name: 'userId' })
  user: Relation<User>;

  // ══════════════════════════════════════════════════════════════════════════
  // BASIC INFO
  // ══════════════════════════════════════════════════════════════════════════

  @Column()
  name: string;

  @Column({ type: 'text', nullable: true })
  description?: string;

  @Column({ nullable: true })
  location?: string;

  @Column({ type: 'enum', enum: EdgeStatus, default: EdgeStatus.OFFLINE })
  status: EdgeStatus;

  @Column()
  version: string;

  // ══════════════════════════════════════════════════════════════════════════
  // NETWORK INFO
  // ══════════════════════════════════════════════════════════════════════════

  @Column({ nullable: true })
  ipAddress?: string;

  @Column({ nullable: true })
  macAddress?: string;

  @Column({ nullable: true })
  hostname?: string;

  @Column({ type: 'timestamp', nullable: true })
  lastSeen?: Date;

  // ══════════════════════════════════════════════════════════════════════════
  // EDGE TOKEN — used by the physical agent to authenticate without a JWT
  // ══════════════════════════════════════════════════════════════════════════

  @Column({ unique: true })
  edgeToken: string;

  // ══════════════════════════════════════════════════════════════════════════
  // DEVICE COUNT
  // ══════════════════════════════════════════════════════════════════════════

  @Column({ type: 'int', default: 0 })
  deviceCount: number;

  // ══════════════════════════════════════════════════════════════════════════
  // SYSTEM METRICS
  // ══════════════════════════════════════════════════════════════════════════

  @Column({ type: 'jsonb', nullable: true })
  metrics?: {
    cpu: number;
    memory: number;
    storage: number;
    uptime: number;
    temperature?: number;
    networkIn?: number;
    networkOut?: number;
  };

  // ══════════════════════════════════════════════════════════════════════════
  // DATA SYNCHRONIZATION
  // ══════════════════════════════════════════════════════════════════════════

  @Column({ type: 'jsonb', nullable: true })
  dataSync?: {
    pending: number;
    lastSync?: Date;
    syncInterval?: number;
    failedAttempts?: number;
    totalSynced?: number;
  };

  // ══════════════════════════════════════════════════════════════════════════
  // CONFIGURATION
  // ══════════════════════════════════════════════════════════════════════════

  @Column({ type: 'jsonb', nullable: true })
  config?: {
    enabled: boolean;
    autoSync: boolean;
    maxDevices?: number;
    protocols?: string[];
    storageLimit?: number;
    retentionDays?: number;
  };

  // ══════════════════════════════════════════════════════════════════════════
  // METADATA
  // ══════════════════════════════════════════════════════════════════════════

  @Column({ type: 'simple-array', nullable: true })
  tags?: string[];

  @Column({ type: 'jsonb', nullable: true })
  additionalInfo?: Record<string, any>;

  // ══════════════════════════════════════════════════════════════════════════
  // RELATIONS
  // ══════════════════════════════════════════════════════════════════════════

  @OneToMany('EdgeCommand', 'edge')
  commands: Relation<EdgeCommand>[];

  @OneToMany('EdgeMetricsSnapshot', 'edge')
  metricsSnapshots: Relation<EdgeMetricsSnapshot>[];

  // ══════════════════════════════════════════════════════════════════════════
  // HELPER METHODS
  // ══════════════════════════════════════════════════════════════════════════

  isOnline(): boolean {
    return this.status === EdgeStatus.ONLINE;
  }

  isOffline(): boolean {
    return this.status === EdgeStatus.OFFLINE;
  }

  hasPendingSync(): boolean {
    return (this.dataSync?.pending ?? 0) > 0;
  }

  isHealthy(): boolean {
    return (
      this.status === EdgeStatus.ONLINE &&
      (this.dataSync?.pending ?? 0) < 100 &&
      (this.metrics?.cpu ?? 0) < 80 &&
      (this.metrics?.memory ?? 0) < 80
    );
  }

  getUptimeFormatted(): string {
    if (!this.metrics?.uptime) return 'N/A';
    const seconds = this.metrics.uptime;
    const days = Math.floor(seconds / 86400);
    const hours = Math.floor((seconds % 86400) / 3600);
    const minutes = Math.floor((seconds % 3600) / 60);
    return `${days}d ${hours}h ${minutes}m`;
  }

  wasSeenRecently(): boolean {
    if (!this.lastSeen) return false;
    return this.lastSeen.getTime() > Date.now() - 5 * 60 * 1000;
  }

  updateMetrics(metrics: Partial<NonNullable<EdgeInstance['metrics']>>): void {
    this.metrics = { ...this.metrics, ...metrics } as EdgeInstance['metrics'];
    this.lastSeen = new Date();
  }

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