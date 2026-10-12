import { Entity, Column, Index, ManyToOne, JoinColumn } from 'typeorm';
import { BaseEntity } from '@common/entities/base.entity';
import type { Relation } from 'typeorm';
import type { Group } from './group.entity';
import { GroupEntityType } from '../group.enum';

/**
 * One entity's membership of one group.
 *
 * ── Why a join table and not an array column on `entity_groups` ────────────
 * Both directions of the question have to be fast, and an array answers only
 * one of them:
 *
 * - "members of this group, page 3" — an array column means reading the whole
 *   array into the application and slicing it. A join table is
 *   `WHERE "groupId" = $1 ORDER BY ... LIMIT/OFFSET` against a B-tree index,
 *   and the COUNT is a index-only scan.
 * - "which groups is this device in?" — with an array this is a GIN index and
 *   an `@>` containment scan over every group in the tenant. Here it is a
 *   B-tree lookup on `(tenantId, entityType, entityId)`, which is the index
 *   declared below precisely for that query.
 * - bulk add/remove — an array is a read-modify-write of the whole row, so two
 *   concurrent "add 50 devices" calls lose one of the two sets outright. Here
 *   each membership is its own row, the unique constraint makes adding
 *   idempotent, and the two calls simply both succeed.
 *
 * The cost of the join table is one extra row per membership and a join to get
 * member names, which is what `GET /groups/:id/members` pays — on one page of
 * results, not on the whole group.
 *
 * ── Deletes are HARD here, unlike everywhere else in this codebase ─────────
 * `(groupId, entityId)` is unique and `deleted_at` is not part of it, so a
 * soft-deleted membership would permanently block re-adding that entity to
 * that group. A membership is a pure association with no history worth
 * keeping; the audit trail for "who removed this device from that group" is
 * `audit_logs`, not a tombstone row. `GroupsService.removeMembers()` therefore
 * calls `delete()`, never `softRemove()`. The inherited soft-delete columns are
 * left in place only so the entity matches the `BaseEntity` shape every other
 * table has.
 */
@Entity('entity_group_members')
// "Members of this group" — also the FK target for cascade delete.
@Index(['groupId', 'entityId'], { unique: true })
// "Which groups is this entity in?" — tenant first so the index is usable for
// a tenant-scoped scan, and entityType included because an id is only unique
// within its own table.
@Index(['tenantId', 'entityType', 'entityId'])
export class GroupMember extends BaseEntity {
  /**
   * Denormalised from the group.
   *
   * It is what makes the reverse lookup a single index seek instead of a join
   * back to `entity_groups` for the tenant predicate — and the reverse lookup
   * is the one on the read path of every device detail page.
   */
  @Column({ type: 'uuid' })
  tenantId: string;

  @Column({ type: 'uuid' })
  groupId: string;

  /**
   * `onDelete: 'CASCADE'` so deleting a group takes its memberships with it.
   * Group deletion is a soft delete, so the cascade only fires on a hard
   * delete — `GroupsService.remove()` therefore deletes the membership rows
   * explicitly in the same transaction rather than relying on it.
   */
  @ManyToOne('Group', { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'groupId' })
  group: Relation<Group>;

  /**
   * The member's id, in the table `GROUP_MEMBER_SOURCES[entityType]` names.
   *
   * No foreign key, and that is a deliberate trade-off: an FK cannot be
   * polymorphic, so the alternatives are four nullable columns with four
   * constraints, or one column validated in the service. The validation is
   * `GroupsService.verifyMembers()`, which checks every id against the
   * caller's tenant before a row is written — the check an FK would not have
   * made anyway, since an FK proves existence and says nothing about tenancy.
   * The cost is that deleting a device leaves its memberships behind;
   * `listMembers()` marks those rows `missing: true` rather than hiding them,
   * and `pruneMissing()` removes them on request.
   */
  @Column({ type: 'uuid' })
  entityId: string;

  /** Denormalised from the group, for the reverse-lookup index above. */
  @Column({ type: 'varchar' })
  entityType: GroupEntityType;

  /** Who added it, for the audit trail. No relation, no FK. */
  @Column({ type: 'varchar', nullable: true })
  addedBy?: string | null;
}
