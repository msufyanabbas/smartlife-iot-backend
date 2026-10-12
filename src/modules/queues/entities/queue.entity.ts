import { Entity, Column, Index, ManyToOne, JoinColumn } from 'typeorm';
import { BaseEntity } from '@common/entities/base.entity';
import type { Relation } from 'typeorm';
import type { Tenant } from '../../tenants/entities/tenant.entity';
import {
  QueueProcessingStrategy,
  QueueSubmitStrategy,
} from '../queue.enum';

/**
 * A named processing lane.
 *
 * A rule chain names one (`RuleChain.configuration.queueName`) and
 * `RuleEngineConsumer` then executes that chain under this row's submit
 * strategy, processing strategy, pack timeout and retry settings. Which fields
 * are honoured and which are stored only is listed in `queue.enum.ts`
 * (`QUEUE_HONOURED_FIELDS` / `QUEUE_STORED_ONLY_FIELDS`) and served by
 * `GET /queues/capabilities` — the configuration screen is meant to say so
 * rather than leave an operator tuning a number nothing reads.
 *
 * Column types: `tenantId` is `uuid` with a real FK to `tenants(id)` because
 * the `@ManyToOne('Tenant')` below makes it a join column — a join column takes
 * the referenced key's type and gets the constraint whatever the migration
 * says (CLAUDE.md §4f). `userId` is deliberately varchar with no relation: a
 * queue is tenant configuration that must outlive whoever created it.
 */
@Entity('queues')
@Index(['tenantId', 'name'], { unique: true })
@Index(['tenantId', 'enabled'])
export class Queue extends BaseEntity {
  @Column({ type: 'uuid' })
  tenantId: string;

  @ManyToOne('Tenant')
  @JoinColumn({ name: 'tenantId' })
  tenant: Relation<Tenant>;

  /** Who created it. No relation, no FK — see the class comment. */
  @Column({ type: 'varchar', nullable: true })
  userId?: string | null;

  /**
   * The name a rule chain references. Unique per tenant, which is what makes
   * `configuration.queueName` on a chain resolvable without an id.
   */
  @Column()
  name: string;

  @Column({ type: 'text', nullable: true })
  description?: string;

  // ── Transport shape (stored; see QUEUE_STORED_ONLY_FIELDS) ────────────────

  /**
   * Kafka topic this lane would consume. Defaults to null, meaning "the
   * platform's own `rules.input`". Stored only.
   */
  @Column({ type: 'varchar', nullable: true })
  topic?: string | null;

  @Column({ type: 'int', default: 10 })
  partitions: number;

  @Column({ default: false })
  consumerPerPartition: boolean;

  /** Milliseconds between polls. Stored only. */
  @Column({ type: 'int', default: 25 })
  pollInterval: number;

  @Column({ type: 'int', default: 1000 })
  maxPollRecords: number;

  @Column({ type: 'int', default: 300000 })
  maxPollInterval: number;

  @Column({ type: 'int', default: 1048576 })
  maxRequestSize: number;

  @Column({ type: 'int', default: 10000 })
  maxPendingMessages: number;

  // ── Processing semantics (honoured) ───────────────────────────────────────

  @Column({ type: 'varchar', default: QueueSubmitStrategy.BURST })
  submitStrategy: QueueSubmitStrategy;

  @Column({
    type: 'varchar',
    default: QueueProcessingStrategy.SKIP_ALL_FAILURES,
  })
  processingStrategy: QueueProcessingStrategy;

  /**
   * Milliseconds a single chain execution may take before it is abandoned.
   *
   * Honoured: `QueueExecutionService` races the execution against this timer.
   * The rule engine has its own `MAX_NODE_HOPS` guard but no wall-clock bound,
   * so a node making a slow outbound HTTP call can hold a Kafka partition
   * indefinitely — which is the problem this field exists to solve.
   */
  @Column({ type: 'int', default: 2000 })
  packProcessingTimeout: number;

  /** Attempts after the first, used by the RETRY_* strategies. */
  @Column({ type: 'int', default: 0 })
  retries: number;

  @Column({ type: 'int', default: 100 })
  retryFailedBackoff: number;

  @Column({ type: 'int', default: 100 })
  retryTimedOutBackoff: number;

  // ── Lifecycle ─────────────────────────────────────────────────────────────

  @Column({ default: true })
  enabled: boolean;

  /**
   * Marks the lane a chain gets when it names no queue at all.
   *
   * Nothing reads it today — the consumer applies queue semantics only to a
   * chain that explicitly names a queue, and falls back to running the chain
   * directly otherwise. Listed in `GET /queues/capabilities` as stored-only so
   * the screen does not imply a tenant-wide default is in force.
   */
  @Column({ default: false })
  isDefault: boolean;

  @Column({ type: 'jsonb', nullable: true })
  additionalInfo?: Record<string, any>;

  // ── Observed usage (written by QueueExecutionService) ─────────────────────

  @Column({ type: 'bigint', default: 0 })
  processedCount: string;

  @Column({ type: 'bigint', default: 0 })
  failedCount: string;

  @Column({ type: 'bigint', default: 0 })
  timedOutCount: string;

  @Column({ type: 'timestamp', nullable: true })
  lastUsedAt?: Date | null;
}
