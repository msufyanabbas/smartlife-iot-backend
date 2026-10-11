import { Entity, Column, Index, ManyToOne, JoinColumn } from 'typeorm';
import { BaseEntity } from '@common/entities/base.entity';
import type { Relation } from 'typeorm';
import type { Tenant } from '../../tenants/entities/tenant.entity';

/**
 * One node inside a template definition.
 *
 * Deliberately the same shape `RulesService.exportChain()` produces and
 * `importChain()` consumes — edges are expressed against each node's **index**
 * in the array, not an id. A template therefore survives being instantiated
 * into any tenant, any number of times, with no id collisions and nothing
 * pointing at rows the new tenant does not own.
 */
export interface RuleChainTemplateNode {
  name: string;
  description?: string;
  type: string;
  enabled?: boolean;
  debugMode?: boolean;
  configuration?: Record<string, any>;
  position?: { x: number; y: number };
  connections?: Array<{
    targetNodeIndex: number;
    connectionType: string;
    label?: string;
  }>;
}

export interface RuleChainTemplateDefinition {
  formatVersion?: number;
  name?: string;
  description?: string;
  configuration?: Record<string, any>;
  tags?: string[];
  rootNodeIndex?: number | null;
  nodes: RuleChainTemplateNode[];
}

/**
 * A reusable rule-chain definition — the thing "Use" stamps out into a real
 * `RuleChain`.
 *
 * Two kinds of row live here:
 *
 * - **Built-in** (`isBuiltIn: true`, `tenantId: null`): shipped with the
 *   platform, visible to every tenant, read-only. Upserted from
 *   `rule-chain-template-catalogue.ts` at boot and keyed by `slug`, so the
 *   definitions stay in version control and a deploy can correct one.
 * - **Tenant** (`isBuiltIn: false`, `tenantId` set): saved by a user, either
 *   authored directly or captured from an existing chain.
 *
 * `tenantId` being nullable is what makes one table serve both; every read
 * filters `tenantId = :tenantId OR tenantId IS NULL`.
 */
@Entity('rule_chain_templates')
@Index(['tenantId', 'category'])
@Index(['isBuiltIn'])
export class RuleChainTemplate extends BaseEntity {
  /**
   * NULL for a built-in template — it belongs to the platform, not a tenant.
   *
   * Explicitly typed for two reasons. A nullable column whose property is a
   * union reflects as `Object` and refuses to initialise (the
   * `IntegrationEvent.deviceKey` note in CLAUDE.md §4e — it takes the whole
   * application down, not just the entity). And it has to be `uuid`: the
   * `@ManyToOne('Tenant')` below makes this a join column, so the schema gets
   * the referenced key's type and a real foreign key to `tenants(id)`.
   * Declaring `varchar` here does not change that — it only makes a
   * hand-written migration disagree with the schema `synchronize` builds, and
   * `integration_events.tenantId` IS varchar precisely because it has no such
   * relation.
   */
  @Column({ type: 'uuid', nullable: true })
  tenantId?: string | null;

  @ManyToOne('Tenant', { nullable: true })
  @JoinColumn({ name: 'tenantId' })
  tenant?: Relation<Tenant>;

  /**
   * Who saved it. NULL for built-ins.
   *
   * No relation and no foreign key, unlike `RuleChain.userId`: a template is a
   * tenant asset that must outlive the person who saved it, and an FK would
   * make removing that user either fail or take their colleagues' templates
   * with it.
   */
  @Column({ type: 'varchar', nullable: true })
  userId?: string | null;

  @Column()
  name: string;

  @Column({ type: 'text', nullable: true })
  description?: string;

  /**
   * Free text rather than an enum, so a tenant can file a template under a
   * heading the platform never anticipated without a migration. The category
   * list the UI offers is `DISTINCT category` plus the built-in ones.
   */
  @Column({ type: 'varchar', default: 'General' })
  category: string;

  /** Lucide icon name, so a card can show something other than a generic box. */
  @Column({ type: 'varchar', nullable: true })
  icon?: string | null;

  /**
   * Stable identifier for a built-in, e.g. `telemetry-threshold-alarm`. The
   * boot-time upsert matches on this, so editing a definition in the catalogue
   * updates the existing row instead of adding a duplicate. NULL for tenant
   * templates.
   */
  @Column({ type: 'varchar', nullable: true, unique: true })
  slug?: string | null;

  @Column({ default: false })
  isBuiltIn: boolean;

  /** The graph itself. */
  @Column({ type: 'jsonb' })
  definition: RuleChainTemplateDefinition;

  /**
   * How many chains have been created from this template. Incremented by
   * `instantiate()`, which is the only thing that writes it — a template's
   * popularity is a count of real chains, not of page views.
   */
  @Column({ type: 'int', default: 0 })
  usageCount: number;

  @Column({ type: 'timestamp', nullable: true })
  lastUsedAt?: Date | null;

  /** Convenience for the card grid; derived, not authoritative. */
  get nodeCount(): number {
    return Array.isArray(this.definition?.nodes)
      ? this.definition.nodes.length
      : 0;
  }
}
