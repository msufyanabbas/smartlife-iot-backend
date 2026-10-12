import { Entity, Column, Index, ManyToOne, JoinColumn } from 'typeorm';
import { BaseEntity } from '@common/entities/base.entity';
import type { Relation } from 'typeorm';
import type { Tenant } from '../../tenants/entities/tenant.entity';
import type { Customer } from '../../customers/entities/customers.entity';
import { GroupEntityType } from '../group.enum';

/**
 * A named collection of entities of ONE kind, used for assignment and
 * filtering.
 *
 * `entityType` is immutable after creation (`GroupsService.update()` refuses to
 * change it): the members already in the group are ids in another table
 * entirely, so flipping a device group to an asset group would leave every
 * existing row pointing at the wrong table — and the membership validation
 * that would have caught it only runs on insert.
 *
 * ── Uniqueness ─────────────────────────────────────────────────────────────
 * `(tenantId, entityType, name)` is unique. Note that soft-deleted rows still
 * occupy their slot: `deleted_at` is not part of the index, so re-creating a
 * group with the name of a deleted one needs the old row hard-deleted first.
 * That is the same trade-off `floor_plans` makes for `(assetId, floorNumber)`
 * (CLAUDE.md §4a) and is called out here for the same reason.
 */
@Entity('entity_groups')
@Index(['tenantId', 'entityType'])
@Index(['tenantId', 'entityType', 'name'], { unique: true })
export class Group extends BaseEntity {
  @Column({ type: 'uuid' })
  tenantId: string;

  @ManyToOne('Tenant')
  @JoinColumn({ name: 'tenantId' })
  tenant: Relation<Tenant>;

  /** Optional customer scoping, consistent with Device/Asset/Alarm. */
  @Column({ type: 'uuid', nullable: true })
  customerId?: string | null;

  @ManyToOne('Customer', { nullable: true })
  @JoinColumn({ name: 'customerId' })
  customer?: Relation<Customer>;

  /** Who created it. Deliberately no relation and no FK — a group outlives its author. */
  @Column({ type: 'varchar', nullable: true })
  userId?: string | null;

  @Column()
  name: string;

  @Column({ type: 'text', nullable: true })
  description?: string;

  /** Which kind of entity this group holds. Immutable after creation. */
  @Column({ type: 'varchar' })
  entityType: GroupEntityType;

  /** Lucide icon name, so a card shows something other than a generic box. */
  @Column({ type: 'varchar', nullable: true })
  icon?: string | null;

  /** Hex colour, validated by the DTO as `#rgb` or `#rrggbb`. */
  @Column({ type: 'varchar', nullable: true })
  color?: string | null;

  /**
   * Denormalised member count.
   *
   * Maintained by `GroupsService` inside the same transaction as the membership
   * write, so it cannot drift from a successful add or remove. It exists
   * because the group LIST page shows a count per row: computing it live is a
   * `GROUP BY` over the membership table per page, which is fine at ten groups
   * and not at a thousand. `GET /groups/:id` returns the counted value
   * alongside it so a mismatch is visible rather than silent.
   */
  @Column({ type: 'int', default: 0 })
  memberCount: number;

  @Column({ type: 'jsonb', nullable: true })
  additionalInfo?: Record<string, any>;
}
