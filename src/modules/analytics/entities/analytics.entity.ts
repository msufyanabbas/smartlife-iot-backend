import { Entity, Column, Index, ManyToOne, JoinColumn } from 'typeorm';
import { BaseEntity } from '@common/entities/base.entity';
import { Tenant, Customer, Device, User } from '@modules/index.entities';
import { AnalyticsType, AnalyticsPeriod } from '@common/enums/index.enum';

@Entity('analytics')
// ── Composite indexes for common query patterns ────────────────────────────
@Index(['tenantId', 'type', 'period', 'timestamp'])  // Most queries filter by tenant first
@Index(['tenantId', 'customerId', 'timestamp'])       // Customer-level analytics
@Index(['tenantId', 'entityId', 'timestamp'])         // Device/user-specific analytics
@Index(['type', 'period', 'timestamp'])               // System-wide rollups (SUPER_ADMIN)
export class Analytics extends BaseEntity {
  // ══════════════════════════════════════════════════════════════════════════
  // TENANT SCOPING (REQUIRED)
  // ══════════════════════════════════════════════════════════════════════════
  @Column()
  // Critical for tenant isolation queries
  tenantId: string;  // ✅ Required, not nullable

  @ManyToOne(() => Tenant)
  @JoinColumn({ name: 'tenantId' })
  tenant: Tenant;

  // ══════════════════════════════════════════════════════════════════════════
  // CUSTOMER SCOPING (OPTIONAL - for B2B2C)
  // ══════════════════════════════════════════════════════════════════════════

  @Column({ nullable: true })

  customerId?: string;

  @ManyToOne(() => Customer, { nullable: true })
  @JoinColumn({ name: 'customerId' })
  customer?: Customer;

  // ══════════════════════════════════════════════════════════════════════════
  // ANALYTICS TYPE & PERIOD
  // ══════════════════════════════════════════════════════════════════════════

  @Column({ type: 'enum', enum: AnalyticsType })

  type: AnalyticsType;

  @Column({ type: 'enum', enum: AnalyticsPeriod })
  period: AnalyticsPeriod;

  // ══════════════════════════════════════════════════════════════════════════
  // ENTITY REFERENCE (What is this analytics record about?)
  // ══════════════════════════════════════════════════════════════════════════

  @Column({ nullable: true })

  entityId?: string;  // Device ID, User ID, Asset ID, etc.

  @Column({ nullable: true })
  entityType?: string;  // 'device', 'user', 'alarm', 'asset', 'dashboard'

  // Optional: Polymorphic relations (uncomment if needed)
  // @ManyToOne(() => Device, { nullable: true })
  // @JoinColumn({ name: 'entityId' })
  // device?: Device;

  // @ManyToOne(() => User, { nullable: true })
  // @JoinColumn({ name: 'entityId' })
  // user?: User;

  // ══════════════════════════════════════════════════════════════════════════
  // METRICS DATA
  // ══════════════════════════════════════════════════════════════════════════

  @Column({ type: 'jsonb' })
  metrics: Record<string, any>;
  // Example structure:
  // {
  //   deviceCount: 150,
  //   activeDevices: 142,
  //   totalTelemetryPoints: 45231,
  //   avgTemperature: 23.5,
  //   avgHumidity: 58.2,
  //   alarmsTriggered: 5,
  //   apiCalls: 12450,
  //   storageUsedMB: 523.4
  // }

  // ══════════════════════════════════════════════════════════════════════════
  // TIMESTAMP
  // ══════════════════════════════════════════════════════════════════════════

  @Column({ type: 'timestamp' })

  timestamp: Date;  // The time bucket this analytics record represents

  // ══════════════════════════════════════════════════════════════════════════
  // METADATA
  // ══════════════════════════════════════════════════════════════════════════

  @Column({ type: 'jsonb', nullable: true })
  metadata?: {
    calculatedAt?: Date;      // When these analytics were computed
    dataPoints?: number;       // How many data points went into this
    sources?: string[];        // Which data sources were used
    aggregations?: string[];   // Which aggregations were applied
    [key: string]: any;
  };

  // ══════════════════════════════════════════════════════════════════════════
  // HELPER METHODS
  // ══════════════════════════════════════════════════════════════════════════

  /**
   * Get a specific metric value
   */
  getMetric(key: string): any {
    return this.metrics?.[key];
  }

  /**
   * Check if this analytics record is stale (older than expected)
   */
  isStale(maxAgeHours: number = 24): boolean {
    const ageMs = Date.now() - this.timestamp.getTime();
    return ageMs > maxAgeHours * 60 * 60 * 1000;
  }

  /**
   * Get human-readable timestamp range
   */
  getTimestampRange(): { start: Date; end: Date } {
    const start = new Date(this.timestamp);
    const end = new Date(this.timestamp);

    switch (this.period) {
      case AnalyticsPeriod.HOURLY:
        end.setHours(end.getHours() + 1);
        break;
      case AnalyticsPeriod.DAILY:
        end.setDate(end.getDate() + 1);
        break;
      case AnalyticsPeriod.WEEKLY:
        end.setDate(end.getDate() + 7);
        break;
      case AnalyticsPeriod.MONTHLY:
        end.setMonth(end.getMonth() + 1);
        break;
    }

    return { start, end };
  }
}
