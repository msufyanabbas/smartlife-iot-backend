// src/modules/converters/entities/converter.entity.ts
import { Entity, Column, Index, ManyToOne, JoinColumn } from 'typeorm';
import { BaseEntity } from '@common/entities/base.entity';
import type { Relation } from 'typeorm';
import type { Tenant } from '../../tenants/entities/tenant.entity';
import type { Customer } from '../../customers/entities/customers.entity';
import {
  ConverterDirection,
  ConverterHealth,
  ConverterType,
} from '../converter.enums';

/**
 * A data converter: the step that turns a raw device payload into the
 * platform's telemetry shape (uplink), or a platform command into a device
 * payload (downlink).
 *
 * Counters and `lastError` are modelled on `RuleChain` — same column names,
 * same `recordExecution()` semantics — because the converters list page and the
 * rule chains list page show the same health badge, and two different shapes
 * for "has this thing been failing" is how one of them ends up wrong.
 *
 * ── Column types that matter ─────────────────────────────────────────────────
 * `tenantId` declares `@ManyToOne('Tenant')`, which makes it a join column: it
 * takes the referenced key's type (`uuid`) and gets a real FK whether or not
 * the hand-written migration says so. The migration writes `uuid` + FK to
 * match. Contrast `integration_events.tenantId`, correctly `character varying`
 * with no FK *because it has no relation*.
 *
 * `userId` is deliberately the other way round — `character varying`, no FK. A
 * converter is tenant infrastructure that outlives whoever created it, exactly
 * as `rule_chain_templates.userId` does.
 *
 * `direction` and `type` are **varchar, not PG enums**. See converter.enums.ts.
 */
@Entity('converters')
@Index(['tenantId', 'direction'])
@Index(['tenantId', 'type'])
@Index(['tenantId', 'enabled'])
export class Converter extends BaseEntity {
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

  @Column({ type: 'uuid', nullable: true })
  customerId?: string;

  @ManyToOne('Customer', { nullable: true })
  @JoinColumn({ name: 'customerId' })
  customer?: Relation<Customer>;

  // ══════════════════════════════════════════════════════════════════════════
  // OWNERSHIP — a record of who created the row, not a scoping key.
  // ══════════════════════════════════════════════════════════════════════════

  @Column({ type: 'varchar', nullable: true })
  userId?: string;

  // ══════════════════════════════════════════════════════════════════════════
  // BASIC INFO
  // ══════════════════════════════════════════════════════════════════════════

  @Column()
  name: string;

  @Column({ type: 'text', nullable: true })
  description?: string;

  /** `uplink` | `downlink` — see ConverterDirection. */
  @Column({ type: 'varchar', default: ConverterDirection.UPLINK })
  direction: ConverterDirection;

  /** `json` | `script` | `codec` — one manifest per value in the catalogue. */
  @Column({ type: 'varchar', default: ConverterType.JSON })
  type: ConverterType;

  /** Presentation/filtering only; nothing in execution branches on it. */
  @Column({ type: 'varchar', nullable: true })
  protocol?: string;

  // ══════════════════════════════════════════════════════════════════════════
  // CONFIGURATION — free jsonb, validated against the type's manifest.
  // ══════════════════════════════════════════════════════════════════════════

  @Column({ type: 'jsonb', default: () => "'{}'::jsonb" })
  configuration: Record<string, any>;

  @Column({ default: true })
  enabled: boolean;

  /** When on, `convert()` keeps the per-step trace in the returned result. */
  @Column({ default: false })
  debugMode: boolean;

  // ══════════════════════════════════════════════════════════════════════════
  // EXECUTION STATISTICS (same shape as RuleChain)
  // ══════════════════════════════════════════════════════════════════════════

  @Column({ type: 'int', default: 0 })
  executionCount: number;

  @Column({ type: 'int', default: 0 })
  successCount: number;

  @Column({ type: 'int', default: 0 })
  failureCount: number;

  @Column({ type: 'timestamp', nullable: true })
  lastExecuted?: Date;

  /** Milliseconds. */
  @Column({ type: 'int', default: 0 })
  averageExecutionTime: number;

  // ══════════════════════════════════════════════════════════════════════════
  // ERROR TRACKING
  // ══════════════════════════════════════════════════════════════════════════

  @Column({ type: 'text', nullable: true })
  lastError?: string;

  @Column({ type: 'jsonb', nullable: true })
  errorHistory?: Array<{
    timestamp: Date;
    error: string;
  }>;

  // ══════════════════════════════════════════════════════════════════════════
  // METADATA
  // ══════════════════════════════════════════════════════════════════════════

  @Column({ type: 'simple-array', nullable: true })
  tags?: string[];

  @Column({ type: 'jsonb', nullable: true })
  additionalInfo?: Record<string, any>;

  // ══════════════════════════════════════════════════════════════════════════
  // HELPER METHODS
  // ══════════════════════════════════════════════════════════════════════════

  isUplink(): boolean {
    return this.direction === ConverterDirection.UPLINK;
  }

  /**
   * Record one run. Mirrors `RuleChain.recordExecution()` — including keeping
   * only the last 10 errors, so the jsonb column cannot grow without bound at
   * telemetry rate.
   */
  recordExecution(success: boolean, executionTime: number, error?: string): void {
    this.executionCount++;
    this.lastExecuted = new Date();

    if (success) {
      this.successCount++;
      this.lastError = undefined;
    } else {
      this.failureCount++;
      this.lastError = error;

      if (!this.errorHistory) this.errorHistory = [];
      this.errorHistory.unshift({
        timestamp: new Date(),
        error: error || 'Unknown error',
      });
      this.errorHistory = this.errorHistory.slice(0, 10);
    }

    this.averageExecutionTime = Math.round(
      (this.averageExecutionTime * (this.executionCount - 1) + executionTime) /
        this.executionCount,
    );
  }

  getSuccessRate(): number {
    if (this.executionCount === 0) return 0;
    return (this.successCount / this.executionCount) * 100;
  }

  isHealthy(): boolean {
    return this.executionCount === 0 || this.getSuccessRate() > 90;
  }

  /**
   * The badge the list page draws. Derived rather than stored — a `status`
   * column would be a third source of truth next to `enabled` and `lastError`.
   */
  health(): ConverterHealth {
    if (!this.enabled) return ConverterHealth.DISABLED;
    if (this.executionCount === 0) return ConverterHealth.PENDING;
    if (this.lastError) return ConverterHealth.ERROR;
    return ConverterHealth.ACTIVE;
  }

  resetStats(): void {
    this.executionCount = 0;
    this.successCount = 0;
    this.failureCount = 0;
    this.averageExecutionTime = 0;
    this.errorHistory = [];
    this.lastError = undefined;
  }
}
