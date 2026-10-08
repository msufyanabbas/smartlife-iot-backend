import { Entity, Column, Index, ManyToOne, JoinColumn } from 'typeorm';
import type { Relation } from 'typeorm';
import { BaseEntity } from '@common/entities/base.entity';
import type { Integration } from './integration.entity';

export enum IntegrationEventDirection {
  INBOUND = 'inbound',
  OUTBOUND = 'outbound',
  /** Neither — created, enabled, tested, configuration changed. */
  LIFECYCLE = 'lifecycle',
}

export enum IntegrationEventType {
  UPLINK = 'uplink',
  DOWNLINK = 'downlink',
  TEST = 'test',
  CREATED = 'created',
  UPDATED = 'updated',
  ENABLED = 'enabled',
  DISABLED = 'disabled',
  SYNC = 'sync',
  ERROR = 'error',
}

/**
 * ─────────────────────────────────────────────────────────────────────────────
 * An append-only record of what an integration actually did.
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * Before this table, "what has this integration been doing?" could only be
 * answered from the integration row itself:
 *
 *   · `errorHistory` — a jsonb array capped at the last 10 FAILURES, so
 *     successes left no trace and the 11th failure erased the first.
 *   · `GET /integrations/recent-activity` — which synthesises one entry per
 *     integration from its current column values. Two failures an hour apart
 *     were indistinguishable from one, because it is a decorated list of
 *     integrations, not a feed.
 *
 * Neither could answer "did the 14:03 reading reach AWS?", which is the
 * question an operator actually has.
 *
 * ON DELETE CASCADE: events are meaningless without their integration, and a
 * tenant deleting one should not leave orphaned rows behind.
 */
@Entity('integration_events')
@Index(['integrationId', 'createdAt'])
@Index(['tenantId', 'createdAt'])
export class IntegrationEvent extends BaseEntity {
  @Column({ type: 'uuid' })
  integrationId: string;

  @ManyToOne('Integration', { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'integrationId' })
  integration?: Relation<Integration>;

  /**
   * Denormalised so the tenant-wide feed needs no join.
   *
   * varchar, not uuid, to match `integrations.tenantId` and every other
   * tenantId column in the schema. Declaring it uuid here would make each join
   * or comparison against them an implicit cast, which Postgres can do but
   * which also stops it using an index on the other side.
   */
  @Column()
  tenantId: string;

  @Column({ type: 'varchar' })
  direction: IntegrationEventDirection;

  @Column({ type: 'varchar' })
  eventType: IntegrationEventType;

  @Column({ default: true })
  success: boolean;

  @Column({ type: 'text', nullable: true })
  message?: string | null;

  /** Which device the event concerned, when it concerned one. */
  @Column({ type: 'uuid', nullable: true })
  deviceId?: string | null;

  /**
   * `type` is explicit because the property is `string | null`.
   *
   * TypeORM infers the column type from the reflected TypeScript type when one
   * is not given, and a union reflects as `Object` — which it then rejects with
   * `Data type "Object" in "IntegrationEvent.deviceKey" is not supported by
   * "postgres"` at DataSource.initialize, before anything else runs. The whole
   * application fails to boot, not just this entity.
   */
  @Column({ type: 'varchar', nullable: true })
  deviceKey?: string | null;

  @Column({ type: 'int', nullable: true })
  statusCode?: number | null;

  @Column({ type: 'int', nullable: true })
  durationMs?: number | null;

  /**
   * A trimmed copy of what was sent or received.
   *
   * Deliberately NOT the whole payload: these rows are written on every
   * message, and storing full telemetry here would duplicate the telemetry
   * table at a much worse write rate. IntegrationEventsService truncates it.
   */
  @Column({ type: 'jsonb', nullable: true })
  payload?: Record<string, unknown> | null;
}
