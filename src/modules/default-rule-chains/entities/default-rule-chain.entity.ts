import { Entity, Column, Index, ManyToOne, JoinColumn } from 'typeorm';
import { BaseEntity } from '@common/entities/base.entity';
import type { Relation } from 'typeorm';
import type { Tenant } from '../../tenants/entities/tenant.entity';
import type { RuleChain } from '../../rules/entities/rule-chain.entity';
import type { DeviceProfile } from '../../profiles/entities/device-profile.entity';
import {
  DEFAULT_RULE_CHAIN_ANY,
  DefaultRuleChainOriginatorType,
} from '../default-rule-chain.enum';

/**
 * "Which rule chain handles this kind of incoming message for this tenant?"
 *
 * One row is one routing rule. The resolver picks the most specific matching
 * row; when nothing matches, the rule-engine consumer keeps doing exactly what
 * it did before this table existed (see `DefaultRuleChainResolverService`).
 *
 * ── Why three match columns and not one ────────────────────────────────────
 * The three axes answer different questions and a real deployment needs them
 * combined, not chosen between: "all telemetry goes to chain X" is a
 * messageType rule, "everything from this sensor model goes to chain Y" is a
 * deviceProfile rule, and "edge-originated messages go to chain Z" is an
 * originatorType rule. `NULL` in a match column means "any", which is what
 * makes a coarse rule and a narrow one coexist in the same table.
 *
 * ── Uniqueness ─────────────────────────────────────────────────────────────
 * The logical key is (tenantId, originatorType, messageType, deviceProfileId),
 * but PostgreSQL treats NULLs as distinct, so a plain UNIQUE constraint would
 * let two rows with a NULL messageType and the same originatorType both exist
 * and race. The migration therefore builds the unique index over
 * `COALESCE(...)` expressions, and `DefaultRuleChainsService` checks for a
 * clash before insert so the user gets a 409 with a readable message rather
 * than a driver error.
 *
 * ── Column types ───────────────────────────────────────────────────────────
 * `tenantId`, `ruleChainId` and `deviceProfileId` are `uuid` with real foreign
 * keys, because each is a `@ManyToOne` join column — such a column takes the
 * referenced key's type and gets the constraint whatever a hand-written
 * migration says (CLAUDE.md §4f). `deviceProfileId`'s property is a
 * `string | null` union, so its `@Column` carries an explicit `type`: without
 * one TypeORM reflects `Object` and `DataSource.initialize` throws, taking the
 * whole application down rather than just this entity.
 */
@Entity('default_rule_chains')
@Index(['tenantId', 'enabled'])
@Index(['tenantId', 'originatorType', 'messageType'])
@Index(['tenantId', 'deviceProfileId'])
@Index(['ruleChainId'])
export class DefaultRuleChain extends BaseEntity {
  @Column({ type: 'uuid' })
  tenantId: string;

  @ManyToOne('Tenant')
  @JoinColumn({ name: 'tenantId' })
  tenant: Relation<Tenant>;

  /** Who created it. Deliberately no relation and no FK — a routing rule outlives its author. */
  @Column({ type: 'varchar', nullable: true })
  userId?: string | null;

  /** Operator-facing label, e.g. "Telemetry → Threshold alarms". */
  @Column()
  name: string;

  @Column({ type: 'text', nullable: true })
  description?: string;

  // ── Match axes ────────────────────────────────────────────────────────────

  /**
   * `'*'` means any originator. Not nullable, because every row has to declare
   * an answer here — a NULL would be indistinguishable from "not yet set" in a
   * form that posts partial updates.
   */
  @Column({ type: 'varchar', default: DEFAULT_RULE_CHAIN_ANY })
  originatorType: DefaultRuleChainOriginatorType | string;

  /**
   * NULL (or `'*'`, normalised to NULL on write) means any message type.
   * Free text: the consumer forwards `payload.eventType` verbatim, so an
   * integration emitting its own event name must be routable without a
   * migration.
   */
  @Column({ type: 'varchar', nullable: true })
  messageType?: string | null;

  /** NULL means any device profile. */
  @Column({ type: 'uuid', nullable: true })
  deviceProfileId?: string | null;

  @ManyToOne('DeviceProfile', { nullable: true })
  @JoinColumn({ name: 'deviceProfileId' })
  deviceProfile?: Relation<DeviceProfile>;

  // ── Target ────────────────────────────────────────────────────────────────

  @Column({ type: 'uuid' })
  ruleChainId: string;

  @ManyToOne('RuleChain')
  @JoinColumn({ name: 'ruleChainId' })
  ruleChain: Relation<RuleChain>;

  // ── Control ───────────────────────────────────────────────────────────────

  /**
   * Tie-break between two rows of equal specificity. Higher wins; equal
   * priority falls back to the newer row, so the ordering is total and the
   * resolver is deterministic.
   */
  @Column({ type: 'int', default: 0 })
  priority: number;

  @Column({ default: true })
  enabled: boolean;

  @Column({ type: 'jsonb', nullable: true })
  additionalInfo?: Record<string, any>;

  // ── Observed usage ────────────────────────────────────────────────────────

  @Column({ type: 'bigint', default: 0 })
  matchCount: string;

  @Column({ type: 'timestamp', nullable: true })
  lastMatchedAt?: Date | null;

  /**
   * How narrow this rule is. Used to order candidates: a device-profile rule
   * beats a message-type rule, which beats an originator-type rule, which
   * beats the catch-all.
   */
  specificity(): number {
    let score = 0;
    if (this.deviceProfileId) score += 4;
    if (this.messageType) score += 2;
    if (this.originatorType && this.originatorType !== DEFAULT_RULE_CHAIN_ANY) {
      score += 1;
    }
    return score;
  }
}
