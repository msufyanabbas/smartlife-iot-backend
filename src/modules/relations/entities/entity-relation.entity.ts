// src/modules/relations/entities/entity-relation.entity.ts
import { Column, Entity, Index, JoinColumn, ManyToOne, Unique } from 'typeorm';
import type { Relation } from 'typeorm';
import { BaseEntity } from '@common/entities/base.entity';
import {
  RelationEntityType,
  RelationTypeGroup,
} from '@common/enums/relation.enum';
import type { Tenant } from '../../tenants/entities/tenant.entity';

/**
 * One typed, directed edge between any two entities in a tenant.
 *
 * This is the primitive every "digital twin" feature needs and that the
 * platform did not have. `assets.parentAssetId` gives exactly one shape of
 * relationship — strict containment, assets only, one parent — so "pump
 * **feeds** tank", "panel **powers** circuit" and "technician **manages**
 * building" had nowhere to live. Modelling each of them as another nullable
 * FK column is how a schema ends up with fifteen of them and still cannot
 * express the sixteenth.
 *
 * Both endpoints are stored as a (type, id) pair rather than as real foreign
 * keys. That is the whole point — a single table cannot hold an FK to eight
 * others — and it is also the cost: nothing in the database stops a row from
 * pointing at an id that does not exist. `RelationsService.create()` therefore
 * resolves **both** endpoints against their own table, pinned to the tenant,
 * before inserting. Skip that and relations silently become dangling, which
 * shows up much later as a graph full of nodes named "Unknown".
 *
 * Directionality is real and load bearing. `A feeds B` is not `B feeds A`, so
 * the pair is ordered and the UI labels each row Outbound or Inbound. Reading
 * the graph "upstream" is a traversal with `direction=TO`, not a second row.
 */
@Entity('entity_relations')
// The uniqueness the whole table turns on: the same typed edge between the
// same two endpoints cannot exist twice in one tenant. Without it a double
// click on "Add" produces two identical rows and every traversal counts the
// edge twice.
@Unique('UQ_entity_relations_edge', [
  'tenantId',
  'fromEntityType',
  'fromEntityId',
  'relationType',
  'toEntityType',
  'toEntityId',
])
// Both directions are hot, and they are genuinely different queries: a device
// page asks "what does this feed?" (from) and "what feeds this?" (to) on the
// same render, and the recursive traversal re-asks one of them once per level.
// A single index on the `from` columns would leave every inbound lookup and
// every `direction=TO` walk on a sequential scan of the tenant's whole graph.
@Index('IDX_entity_relations_from', [
  'tenantId',
  'fromEntityType',
  'fromEntityId',
  'relationType',
])
@Index('IDX_entity_relations_to', [
  'tenantId',
  'toEntityType',
  'toEntityId',
  'relationType',
])
// Answers "where is Feeds used?" without scanning, and is what
// `findByType()` and the group sweeps read.
@Index('IDX_entity_relations_type', ['tenantId', 'relationType', 'relationGroup'])
export class EntityRelation extends BaseEntity {
  /**
   * `uuid` with a real FK, because of the `@ManyToOne('Tenant')` below: a join
   * column takes the referenced key's type and gets a constraint whether the
   * hand-written migration says so or not (§4f). Declaring it `varchar` here
   * and `uuid` in the migration is how a migration ends up permanently at odds
   * with the schema `synchronize` builds.
   */
  @Column({ type: 'uuid' })
  tenantId: string;

  @ManyToOne('Tenant')
  @JoinColumn({ name: 'tenantId' })
  tenant?: Relation<Tenant>;

  // ── The `from` endpoint ────────────────────────────────────────────────────

  /**
   * Varchar, not a PG enum — the §4e lesson. A new `RelationEntityType` member
   * passes `@IsEnum` and the INSERT then fails with
   * `invalid input value for enum`, which reads as a frontend bug for a day.
   */
  @Column({ type: 'varchar', length: 32 })
  fromEntityType: RelationEntityType;

  @Column({ type: 'uuid' })
  fromEntityId: string;

  // ── The `to` endpoint ──────────────────────────────────────────────────────

  @Column({ type: 'varchar', length: 32 })
  toEntityType: RelationEntityType;

  @Column({ type: 'uuid' })
  toEntityId: string;

  // ── The edge itself ────────────────────────────────────────────────────────

  /**
   * Free text: `Contains`, `Manages`, `Feeds`, `Powers`, or whatever a tenant's
   * own domain needs. `COMMON_RELATION_TYPES` is the palette the UI offers, not
   * a constraint — a chilled-water loop should not need a migration to write
   * `Chills`.
   */
  @Column({ type: 'varchar', length: 255 })
  relationType: string;

  /**
   * Partitions the graph so a subsystem's machine-written edges do not appear
   * in a user's traversal. Defaults to COMMON, which is the only group the UI
   * writes.
   */
  @Column({ type: 'varchar', length: 32, default: RelationTypeGroup.COMMON })
  relationGroup: string;

  /** Off-schema extras — a label, a flow rate, a drawing reference. */
  @Column({ type: 'jsonb', nullable: true })
  additionalInfo?: Record<string, unknown> | null;

  // ── Helpers ────────────────────────────────────────────────────────────────

  /** `DEVICE:uuid` — the node key traversals and the cycle guard dedupe on. */
  static nodeKey(type: RelationEntityType | string, id: string): string {
    return `${type}:${id}`;
  }

  get fromKey(): string {
    return EntityRelation.nodeKey(this.fromEntityType, this.fromEntityId);
  }

  get toKey(): string {
    return EntityRelation.nodeKey(this.toEntityType, this.toEntityId);
  }

  /** True when this edge touches the given entity in either direction. */
  touches(type: RelationEntityType | string, id: string): boolean {
    const key = EntityRelation.nodeKey(type, id);
    return this.fromKey === key || this.toKey === key;
  }
}
