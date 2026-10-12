import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Device } from '@modules/devices/entities/device.entity';
import { RuleChain } from '@modules/rules/entities/rule-chain.entity';
import { DefaultRuleChain } from './entities/default-rule-chain.entity';
import {
  DEFAULT_RULE_CHAIN_ANY,
  DefaultRuleChainMatchKind,
} from './default-rule-chain.enum';

export interface ResolveInput {
  /** `NodeMessage.type` — what the consumer took from `payload.eventType`. */
  messageType: string;
  /** `NodeMessage.originator.type` — `payload.entityType`, default DEVICE. */
  originatorType: string;
  /** `NodeMessage.originator.id`. Used only to look a device profile up. */
  originatorId?: string;
  /** Supply it directly to skip the device lookup entirely. */
  deviceProfileId?: string | null;
}

export interface ResolvedDefaultRuleChain {
  ruleChainId: string;
  /** The `default_rule_chains` row that matched. */
  ruleId: string;
  ruleName: string;
  matchedBy: DefaultRuleChainMatchKind;
  specificity: number;
}

const RULES_TTL_MS = 30_000;
const PROFILE_TTL_MS = 60_000;
const PROFILE_CACHE_MAX = 5_000;
const COUNTER_FLUSH_MS = 10_000;

/**
 * Resolves the rule chain that should handle a message.
 *
 * ── Why this is cached the way it is ───────────────────────────────────────
 * `resolve()` runs once per message on `rules.input`, i.e. at telemetry rate.
 * A per-message `SELECT` over `default_rule_chains` would add a round trip to
 * the hot path for a table that changes a few times a month, so the tenant's
 * whole enabled rule set is held in process for 30 seconds and dropped
 * outright by `DefaultRuleChainsService` on every write.
 *
 * The TTL is not redundant with the invalidation: a second application
 * instance cannot have its map cleared by a write served here, so the TTL is
 * what bounds how long it can route on a stale rule. Immediate on the writing
 * instance, within 30s everywhere.
 *
 * ── The device-profile lookup is conditional ───────────────────────────────
 * Matching on a device profile needs the originator's `deviceProfileId`, which
 * the Kafka payload does not carry. Rather than add a device lookup to every
 * message, the cached rule set records whether ANY of the tenant's rules names
 * a profile at all; only then is the device read (and that read is itself
 * cached for 60s, bounded at 5000 entries). A tenant routing purely on message
 * type pays nothing.
 */
@Injectable()
export class DefaultRuleChainResolverService implements OnModuleDestroy {
  private readonly logger = new Logger(DefaultRuleChainResolverService.name);

  /** tenantId → the tenant's enabled rules, pre-sorted most specific first. */
  private readonly rulesCache = new Map<
    string,
    { rules: DefaultRuleChain[]; needsProfile: boolean; at: number }
  >();

  /** deviceId → its deviceProfileId (or null), for profile-scoped rules only. */
  private readonly profileCache = new Map<
    string,
    { profileId: string | null; at: number }
  >();

  /** Buffered match counters; see `flushCounters()`. */
  private readonly counters = new Map<string, { matches: number; at: Date }>();

  private flushTimer: NodeJS.Timeout | null = null;

  constructor(
    @InjectRepository(DefaultRuleChain)
    private readonly mappingRepo: Repository<DefaultRuleChain>,
    @InjectRepository(Device)
    private readonly deviceRepo: Repository<Device>,
    @InjectRepository(RuleChain)
    private readonly ruleChainRepo: Repository<RuleChain>,
  ) {
    this.flushTimer = setInterval(() => {
      void this.flushCounters();
    }, COUNTER_FLUSH_MS);
    this.flushTimer.unref?.();
  }

  async onModuleDestroy(): Promise<void> {
    if (this.flushTimer) clearInterval(this.flushTimer);
    this.flushTimer = null;
    await this.flushCounters();
  }

  // ══════════════════════════════════════════════════════════════════════════
  // CACHE
  // ══════════════════════════════════════════════════════════════════════════

  /** Called by `DefaultRuleChainsService` after every create/update/delete. */
  invalidate(tenantId?: string): void {
    if (!tenantId) {
      this.rulesCache.clear();
      return;
    }
    this.rulesCache.delete(tenantId);
  }

  /** Called when a device's profile changes under us. Not wired to DevicesService. */
  invalidateDevice(deviceId: string): void {
    this.profileCache.delete(deviceId);
  }

  private async loadRules(tenantId: string) {
    const hit = this.rulesCache.get(tenantId);
    if (hit && Date.now() - hit.at < RULES_TTL_MS) return hit;

    const rules = await this.mappingRepo.find({
      where: { tenantId, enabled: true },
    });

    // Sorted once, on load, rather than per message: most specific first, then
    // highest priority, then newest. A total order is what makes resolution
    // deterministic when two rules both match.
    rules.sort((a, b) => {
      const bySpecificity = b.specificity() - a.specificity();
      if (bySpecificity !== 0) return bySpecificity;
      const byPriority = (b.priority ?? 0) - (a.priority ?? 0);
      if (byPriority !== 0) return byPriority;
      return (
        new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
      );
    });

    const entry = {
      rules,
      needsProfile: rules.some((r) => !!r.deviceProfileId),
      at: Date.now(),
    };
    this.rulesCache.set(tenantId, entry);
    return entry;
  }

  private async deviceProfileIdFor(deviceId: string): Promise<string | null> {
    const hit = this.profileCache.get(deviceId);
    if (hit && Date.now() - hit.at < PROFILE_TTL_MS) return hit.profileId;

    const device = await this.deviceRepo.findOne({
      where: { id: deviceId },
      select: ['id', 'deviceProfileId'],
    });
    const profileId = device?.deviceProfileId ?? null;

    // Bounded: a tenant with a large fleet must not turn this into a leak.
    if (this.profileCache.size >= PROFILE_CACHE_MAX) {
      const oldest = this.profileCache.keys().next().value;
      if (oldest) this.profileCache.delete(oldest);
    }
    this.profileCache.set(deviceId, { profileId, at: Date.now() });
    return profileId;
  }

  // ══════════════════════════════════════════════════════════════════════════
  // RESOLUTION
  // ══════════════════════════════════════════════════════════════════════════

  /**
   * The hot-path call. Returns the mapped chain, or `null` when no rule
   * matches — at which point the caller must keep doing whatever it did before
   * this table existed. It deliberately does NOT fall back to the tenant's
   * root chain: that would change the rule engine's behaviour for every tenant
   * that has configured no mappings. `resolveWithRootFallback()` is the
   * diagnostic variant that shows the root chain.
   */
  async resolve(
    tenantId: string,
    input: ResolveInput,
  ): Promise<ResolvedDefaultRuleChain | null> {
    const { rules, needsProfile } = await this.loadRules(tenantId);
    if (rules.length === 0) return null;

    let profileId = input.deviceProfileId ?? null;
    if (needsProfile && !profileId && input.originatorId) {
      profileId = await this.deviceProfileIdFor(input.originatorId);
    }

    const match = rules.find((rule) => this.matches(rule, input, profileId));
    if (!match) return null;

    this.countMatch(match.id);

    return {
      ruleChainId: match.ruleChainId,
      ruleId: match.id,
      ruleName: match.name,
      matchedBy: this.describeMatch(match),
      specificity: match.specificity(),
    };
  }

  private matches(
    rule: DefaultRuleChain,
    input: ResolveInput,
    profileId: string | null,
  ): boolean {
    if (
      rule.originatorType &&
      rule.originatorType !== DEFAULT_RULE_CHAIN_ANY &&
      rule.originatorType !== input.originatorType
    ) {
      return false;
    }
    if (rule.messageType && rule.messageType !== input.messageType) {
      return false;
    }
    if (rule.deviceProfileId && rule.deviceProfileId !== profileId) {
      return false;
    }
    return true;
  }

  private describeMatch(rule: DefaultRuleChain): DefaultRuleChainMatchKind {
    if (rule.deviceProfileId) return 'deviceProfile';
    if (rule.messageType) return 'messageType';
    if (rule.originatorType && rule.originatorType !== DEFAULT_RULE_CHAIN_ANY) {
      return 'originatorType';
    }
    return 'wildcard';
  }

  /**
   * Diagnostic variant behind `GET /default-rule-chains/resolve`.
   *
   * When no mapping matches it reports the tenant's root chain with
   * `matchedBy: 'rootFallback'` and `appliedByConsumer: false` — because the
   * consumer does NOT execute only the root chain in that case. See the note on
   * `fanOut` in the return value.
   */
  async resolveWithRootFallback(tenantId: string, input: ResolveInput) {
    const resolved = await this.resolve(tenantId, input);
    if (resolved) {
      return {
        ...resolved,
        appliedByConsumer: true,
        fanOut: false,
        explanation:
          `Rule "${resolved.ruleName}" matched on ${resolved.matchedBy}. ` +
          'RuleEngineConsumer will execute exactly this chain.',
      };
    }

    const root = await this.ruleChainRepo.findOne({
      where: { tenantId, isRoot: true },
    });

    return {
      ruleChainId: root?.id ?? null,
      ruleId: null,
      ruleName: null,
      matchedBy: 'rootFallback' as DefaultRuleChainMatchKind,
      specificity: 0,
      appliedByConsumer: false,
      // Stated rather than implied: CLAUDE.md §4f calls this a root-chain
      // fallback, but RuleEngineService.loadMatchingChains() actually fans a
      // message out to EVERY active chain whose configuration.messageTypes
      // accepts it, root or not. That pre-existing behaviour is preserved
      // untouched when no mapping matches.
      fanOut: true,
      explanation:
        'No mapping matched. RuleEngineConsumer falls through to ' +
        'RuleEngineService.execute(), which runs every active chain whose ' +
        'configuration accepts this message type — not only the root chain. ' +
        (root
          ? `The tenant's root chain is "${root.name}" (${root.id}).`
          : 'This tenant has no root chain.'),
    };
  }

  // ══════════════════════════════════════════════════════════════════════════
  // MATCH COUNTERS
  // ══════════════════════════════════════════════════════════════════════════

  private countMatch(ruleId: string): void {
    const current = this.counters.get(ruleId) ?? { matches: 0, at: new Date() };
    current.matches += 1;
    current.at = new Date();
    this.counters.set(ruleId, current);
  }

  /**
   * Flushed on a timer rather than written per message: resolution happens at
   * telemetry rate and `matchCount` is an observability figure, not accounting.
   * Public so a verification script can force a flush without waiting.
   */
  async flushCounters(): Promise<void> {
    if (this.counters.size === 0) return;
    const pending = [...this.counters.entries()];
    this.counters.clear();

    for (const [ruleId, c] of pending) {
      try {
        await this.mappingRepo
          .createQueryBuilder()
          .update(DefaultRuleChain)
          .set({
            matchCount: () => `"matchCount" + ${c.matches}`,
            lastMatchedAt: c.at,
          })
          .where('id = :ruleId', { ruleId })
          .execute();
      } catch (err) {
        this.logger.error(
          `Failed to flush match counters for default rule chain ${ruleId}: ${(err as Error).message}`,
        );
      }
    }
  }
}
