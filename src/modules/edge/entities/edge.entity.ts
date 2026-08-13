// src/modules/edge/entities/edge.entity.ts
import { Entity, Column, Index, ManyToOne, JoinColumn, OneToMany } from 'typeorm';
import type { Relation } from 'typeorm';
import { BaseEntity } from '@common/entities/base.entity';
import type { Tenant } from '../../tenants/entities/tenant.entity';
import type { Customer } from '../../customers/entities/customers.entity';
import type { User } from '../../users/entities/user.entity';
import type { EdgeEvent } from './edge-event.entity';
import type { EdgeCommand } from './edge-command.entity';
import type { EdgeMetricsSnapshot } from './edge-metrics-snapshot.entity';

export type EdgeType =
  | 'GATEWAY' | 'INDUSTRIAL' | 'RETAIL' | 'AGRICULTURE' | 'SMART_HOME' | 'CUSTOM';

export type EdgeStatusValue = 'active' | 'inactive' | 'offline' | 'error';

export type EdgeSyncStatus = 'success' | 'failed' | 'partial';

export interface EdgeSyncConfig {
  syncRules: boolean;
  syncDashboards: boolean;
  syncDevices: boolean;
  syncInterval: number;
  offlineBufferHours: number;
}

/**
 * A physical gateway appliance running the edge agent.
 *
 * Replaces the previous `EdgeInstance` / `edge_instances` pair. The rename is
 * safe because all three edge tables were empty, and `devices.edgeId` carries no
 * foreign key, so nothing pointed at the old table.
 *
 * `status` and `type` are varchar rather than PG enums, so adding a new edge
 * type or state needs no migration.
 */
@Entity('edge_devices')
@Index(['tenantId', 'status'])
@Index(['tenantId', 'customerId'])
@Index(['status'])
export class Edge extends BaseEntity {
  @Column({ type: 'uuid' })
  tenantId: string;

  @ManyToOne('Tenant')
  @JoinColumn({ name: 'tenantId' })
  tenant: Relation<Tenant>;

  @Column({ type: 'uuid', nullable: true })
  customerId: string | null;

  @ManyToOne('Customer', { nullable: true })
  @JoinColumn({ name: 'customerId' })
  customer?: Relation<Customer>;

  /**
   * Owner / creator. Not in the original specification, but NotificationsService
   * refuses to create a notification without a user context, so the offline and
   * reconnect alerts need someone to address them to.
   */
  @Column({ type: 'uuid', nullable: true })
  userId: string | null;

  @ManyToOne('User', { nullable: true })
  @JoinColumn({ name: 'userId' })
  user?: Relation<User>;

  // ── Basic info ─────────────────────────────────────────────────────────────

  @Column({ type: 'varchar' })
  name: string;

  @Column({ type: 'text', nullable: true })
  description: string | null;

  @Column({ type: 'varchar', default: 'GATEWAY' })
  type: EdgeType;

  // ── Credentials ────────────────────────────────────────────────────────────

  /** Public identifier the agent presents. Unique across the platform. */
  @Column({ type: 'varchar', unique: true, nullable: true })
  edgeKey: string | null;

  /**
   * SHA-256 of the secret. `select: false` so it never leaves the database on an
   * ordinary read — the raw value is shown exactly once, at activation.
   */
  @Column({ type: 'varchar', nullable: true, select: false })
  edgeSecret: string | null;

  // ── Status ─────────────────────────────────────────────────────────────────

  @Column({ type: 'varchar', default: 'inactive' })
  status: EdgeStatusValue;

  @Column({ type: 'timestamp', nullable: true })
  lastSeenAt: Date | null;

  @Column({ type: 'timestamp', nullable: true })
  lastSyncAt: Date | null;

  @Column({ type: 'varchar', nullable: true })
  lastSyncStatus: EdgeSyncStatus | null;

  // ── Connection info ────────────────────────────────────────────────────────

  @Column({ type: 'varchar', nullable: true })
  ipAddress: string | null;

  @Column({ type: 'varchar', nullable: true })
  macAddress: string | null;

  @Column({ type: 'varchar', nullable: true })
  firmwareVersion: string | null;

  @Column({ type: 'varchar', nullable: true })
  agentVersion: string | null;

  @Column({ type: 'varchar', nullable: true })
  osInfo: string | null;

  // ── Location ───────────────────────────────────────────────────────────────

  @Column({ type: 'varchar', nullable: true })
  location: string | null;

  @Column({ type: 'float', nullable: true })
  latitude: number | null;

  @Column({ type: 'float', nullable: true })
  longitude: number | null;

  // ── Configuration sync ─────────────────────────────────────────────────────

  @Column({ type: 'jsonb', nullable: true })
  syncConfig: EdgeSyncConfig | null;

  // ── Assigned resources ─────────────────────────────────────────────────────

  @Column({ type: 'jsonb', nullable: true })
  assignedRuleChainIds: string[] | null;

  @Column({ type: 'jsonb', nullable: true })
  assignedDashboardIds: string[] | null;

  // ── Metrics ────────────────────────────────────────────────────────────────

  @Column({ type: 'int', default: 0 })
  connectedDeviceCount: number;

  @Column({ type: 'int', default: 0 })
  messagesPerMinute: number;

  @Column({ type: 'float', default: 0 })
  uptimePercentage: number;

  @Column({ type: 'int', default: 0 })
  totalMessagesProcessed: number;

  @Column({ type: 'jsonb', nullable: true })
  systemMetrics: {
    cpuUsage?: number;
    memoryUsage?: number;
    diskUsage?: number;
    networkIn?: number;
    networkOut?: number;
    temperature?: number;
  } | null;

  // ── Tags ───────────────────────────────────────────────────────────────────

  @Column({ type: 'jsonb', nullable: true })
  tags: string[] | null;

  @Column({ type: 'jsonb', nullable: true })
  additionalInfo: Record<string, any> | null;

  // ── Relations ──────────────────────────────────────────────────────────────

  @OneToMany('EdgeEvent', 'edge')
  events: Relation<EdgeEvent>[];

  @OneToMany('EdgeCommand', 'edge')
  commands: Relation<EdgeCommand>[];

  @OneToMany('EdgeMetricsSnapshot', 'edge')
  metricsSnapshots: Relation<EdgeMetricsSnapshot>[];

  // ── Helpers ────────────────────────────────────────────────────────────────

  isOnline(): boolean {
    return this.status === 'active';
  }

  wasSeenRecently(withinMs = 2 * 60 * 1000): boolean {
    if (!this.lastSeenAt) return false;
    return new Date(this.lastSeenAt).getTime() > Date.now() - withinMs;
  }
}
