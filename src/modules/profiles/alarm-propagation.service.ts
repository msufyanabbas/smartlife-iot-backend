// src/modules/profiles/alarm-propagation.service.ts
import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { EventEmitter2, OnEvent } from '@nestjs/event-emitter';
import { Alarm, Asset, Device } from '@modules/index.entities';
import { AlarmStatus } from '@common/enums/index.enum';
import type { DeviceProfileAlarmRule } from '@common/interfaces/index.interface';

/**
 * Where a propagated copy of an alarm lives.
 *
 *   ASSET    — one per asset in the device's ancestor chain (room → floor →
 *              building), driven by `rule.propagate`.
 *   CUSTOMER — the owning customer, driven by `rule.propagateToOwner`. An
 *              unassigned device has no customer owner; its owner is the
 *              tenant, so the target collapses onto TENANT (ThingsBoard does
 *              the same).
 *   TENANT   — tenant-wide, driven by `rule.propagateToTenant`.
 */
export type PropagationScope = 'ASSET' | 'CUSTOMER' | 'TENANT';

export interface PropagationTarget {
  scope: PropagationScope;
  /** assetId / customerId / tenantId — whichever identifies this target. */
  scopeKey: string;
  /** Human label for logs and for the mirror's generated message. */
  label: string;
  /** 0 = the device's own asset, 1 = its parent, … (ASSET scope only). */
  depth: number;
  assetId?: string;
  customerId?: string;
}

interface AncestorRow {
  id: string;
  name: string;
  customerId: string | null;
  depth: number;
}

/** `metadata.propagation` on a mirror row. */
export interface AlarmPropagationMetadata {
  isMirror: true;
  originAlarmId: string;
  originDeviceId?: string;
  originDeviceKey?: string;
  profileRuleId?: string;
  scope: PropagationScope;
  scopeKey: string;
  depth: number;
  label: string;
}

/**
 * Propagates a device alarm up the real entity hierarchy.
 *
 * ── Why mirror ROWS and not a visibility flag ──────────────────────────────
 * Every read path in AlarmsService is a plain predicate over the `alarms`
 * table — `WHERE tenantId = … [AND customerId = …] [AND deviceId = …]` —
 * served by the composite indexes on the entity. `Alarm` already carries a
 * nullable `assetId` with a real FK and a `@ManyToOne('Asset')`; the column
 * was built for asset-level alarms and was simply never written by the
 * profile engine.
 *
 * So propagation writes one additional Alarm row per target, with `assetId`
 * (or `customerId`, or neither for a tenant-wide row) set and `deviceId`
 * LEFT NULL. Consequences, all of them wanted:
 *
 *   • GET /alarms, /alarms/active, /alarms/critical, /alarms/counts and
 *     /alarms/statistics are tenant- (and optionally customer-) scoped, so
 *     they pick the mirrors up with no query change at all.
 *   • GET /alarms/device/:id filters on `deviceId`, so a mirror never
 *     duplicates the originating device's own list.
 *   • A building-level view is `WHERE tenantId = … AND assetId = …`, which is
 *     already an indexable predicate on an existing column.
 *   • AlarmsService.checkAlarmConditions{,Batch}() select on
 *     `alarm.deviceId = :deviceId`, so a mirror is never re-evaluated against
 *     telemetry and cannot drift from its origin.
 *
 * The alternative — keep one row and record the ancestors it should be
 * visible at in `metadata` — would force every one of those queries to grow a
 * JSONB containment OR-branch, i.e. rewrite exactly the endpoints that are
 * supposed to benefit untouched, and none of the existing composite indexes
 * would serve it.
 *
 * Price paid, stated plainly: mirrors are rows, so tenant-wide `total` counts
 * include them. Every mirror carries `metadata.propagation.isMirror = true`,
 * so a caller that wants physical-event counts excludes them with
 * `AND (metadata->'propagation'->>'isMirror') IS NULL`.
 *
 * ── Lifecycle ──────────────────────────────────────────────────────────────
 * Mirrors are projections, not independent alarms:
 *   • they are written only on a state EDGE, never on every telemetry sample;
 *   • they emit no `alarm.*` events, so one physical fire triggers automation
 *     rules, notifications and escalation ladders exactly once;
 *   • clear / acknowledge / resolve are located by `originAlarmId`, not by
 *     re-walking the hierarchy, so an alarm clears at every level it was
 *     raised at even if the asset tree was re-parented in between.
 */
@Injectable()
export class AlarmPropagationService {
  private readonly logger = new Logger(AlarmPropagationService.name);

  /** `metadata.source` on a mirror row. */
  static readonly SOURCE = 'ALARM_PROPAGATION';

  /**
   * Hard ceiling on how far up the asset tree a single alarm travels.
   * `assets.parentAssetId` is a self-referencing adjacency list with no
   * constraint preventing A → B → A, so both a cycle guard and a depth cap
   * are needed; this is the cap. Override with ALARM_PROPAGATION_MAX_DEPTH.
   */
  private readonly maxDepth: number;

  constructor(
    @InjectRepository(Alarm)
    private readonly alarmRepository: Repository<Alarm>,
    @InjectRepository(Asset)
    private readonly assetRepository: Repository<Asset>,
    private readonly eventEmitter: EventEmitter2,
  ) {
    const configured = Number(process.env.ALARM_PROPAGATION_MAX_DEPTH);
    this.maxDepth =
      Number.isFinite(configured) && configured > 0 ? Math.floor(configured) : 10;
  }

  // ══════════════════════════════════════════════════════════════════════════
  // PUBLIC: RAISE / CLEAR, CALLED FROM ProfileAlarmService ON STATE EDGES
  // ══════════════════════════════════════════════════════════════════════════

  /**
   * Mirror a freshly raised alarm onto every target the rule asks for.
   * Idempotent: an existing mirror already in the right state is left alone.
   *
   * Never throws — propagation is a projection and must not fail the alarm
   * that has already been persisted.
   */
  async propagateTrigger(
    origin: Alarm,
    device: Device,
    rule: DeviceProfileAlarmRule,
  ): Promise<Alarm[]> {
    try {
      const targets = await this.resolveTargets(device, rule);
      if (targets.length === 0) return [];

      const written: Alarm[] = [];

      for (const target of targets) {
        const mirror =
          (await this.findMirror(origin, target)) ??
          this.buildMirror(origin, device, rule, target);

        if (this.applyTriggerTo(mirror, origin)) {
          written.push(await this.alarmRepository.save(mirror));
        }
      }

      if (written.length > 0) {
        this.logger.log(
          `Propagated alarm "${origin.name}" from device ${device.deviceKey} to ` +
            `${written.length} level(s): ${targets
              .map((t) => `${t.scope}:${t.label}`)
              .join(', ')}`,
        );
      }

      return written;
    } catch (err) {
      this.logger.error(
        `Propagating alarm ${origin.id} failed: ${(err as Error).message}`,
      );
      return [];
    }
  }

  /**
   * Clear every mirror of an alarm. Located by origin id rather than by
   * re-resolving targets: an alarm must clear at exactly the levels it was
   * raised at, whatever the hierarchy looks like now.
   */
  async propagateClear(origin: Alarm, userId?: string): Promise<Alarm[]> {
    if (!this.couldHaveMirrors(origin)) return [];

    return this.fanOut(origin, (mirror) => {
      if (
        mirror.status === AlarmStatus.CLEARED ||
        mirror.status === AlarmStatus.RESOLVED
      ) {
        return false;
      }
      mirror.clear(userId ?? undefined);
      return true;
    });
  }

  // Acknowledge and resolve have no equivalent here on purpose: they are
  // operator actions that only ever arrive through AlarmsService, so they are
  // handled by the listeners below rather than by a second entry point that
  // could drift from them.

  // ══════════════════════════════════════════════════════════════════════════
  // EVENT HANDLERS — operator actions arriving through AlarmsService
  // ══════════════════════════════════════════════════════════════════════════
  //
  // AlarmsService.acknowledge/clear/resolve know nothing about propagation and
  // are not ours to change, but they do emit. Listening is what makes an
  // operator action on one level reach the others, in both directions:
  //
  //   origin acted on  → fan out to its mirrors
  //   mirror acted on  → apply to the origin, then fan out to the siblings
  //
  // Every write below is skipped when the row is already in the target state,
  // so the handlers are idempotent and the mirror→origin→siblings hop cannot
  // loop: the second pass finds nothing to change.

  @OnEvent('alarm.cleared', { async: true })
  async onAlarmCleared(payload: { alarm?: Alarm }): Promise<void> {
    await this.onOperatorAction(payload?.alarm, 'cleared', (target, userId) => {
      if (
        target.status === AlarmStatus.CLEARED ||
        target.status === AlarmStatus.RESOLVED
      ) {
        return false;
      }
      target.clear(userId ?? undefined);
      return true;
    });
  }

  @OnEvent('alarm.acknowledged', { async: true })
  async onAlarmAcknowledged(payload: {
    alarm?: Alarm;
    userId?: string;
  }): Promise<void> {
    await this.onOperatorAction(
      payload?.alarm,
      'acknowledged',
      (target, userId) => {
        if (target.acknowledgedAt) return false;
        target.acknowledge(userId ?? payload?.userId ?? '');
        return true;
      },
      payload?.userId,
    );
  }

  @OnEvent('alarm.resolved', { async: true })
  async onAlarmResolved(payload: {
    alarm?: Alarm;
    userId?: string;
  }): Promise<void> {
    await this.onOperatorAction(
      payload?.alarm,
      'resolved',
      (target, userId) => {
        if (target.status === AlarmStatus.RESOLVED) return false;
        target.resolve(userId ?? payload?.userId ?? '', target.resolutionNote);
        return true;
      },
      payload?.userId,
    );
  }

  /**
   * Shared body of the three handlers. `apply` mutates one row and returns
   * whether anything actually changed.
   */
  private async onOperatorAction(
    subject: Alarm | undefined,
    verb: string,
    apply: (target: Alarm, userId?: string) => boolean,
    userId?: string,
  ): Promise<void> {
    if (!subject?.id) return;

    // These three events fire for every alarm in the platform, including the
    // auto-clears AlarmsService.checkAlarmConditionsBatch() issues on the
    // telemetry hot path. Deciding from metadata already in hand, before any
    // query, keeps a non-propagating alarm's clear free.
    const propagation = this.propagationOf(subject);
    if (!propagation && !this.couldHaveMirrors(subject)) return;

    try {

      // The event's own row is already in its new state; what needs syncing is
      // the origin (when a mirror was acted on) and every other mirror.
      let origin = subject;

      if (propagation) {
        const found = await this.alarmRepository.findOne({
          where: { id: propagation.originAlarmId },
        });
        if (!found) return;
        origin = found;

        if (apply(origin, userId ?? origin.clearedBy ?? undefined)) {
          const saved = await this.alarmRepository.save(origin);
          this.logger.log(
            `Alarm ${verb} on a propagated copy — applied to origin ${origin.id}`,
          );
          // Re-emit for the origin so audit/automation see the real alarm
          // change state. Our own handler will receive it, find everything
          // already synced, and stop.
          this.eventEmitter.emit(`alarm.${verb}`, { alarm: saved, userId });
        }
      }

      await this.fanOut(origin, apply, userId, subject.id);
    } catch (err) {
      this.logger.error(
        `Propagating "${verb}" for alarm ${subject.id} failed: ${
          (err as Error).message
        }`,
      );
    }
  }

  // ══════════════════════════════════════════════════════════════════════════
  // PUBLIC: QUERY HELPERS
  // ══════════════════════════════════════════════════════════════════════════

  /** Every mirror of an alarm, ordered asset-first then by depth. */
  async findMirrors(origin: Alarm): Promise<Alarm[]> {
    if (!origin?.id) return [];

    return this.alarmRepository
      .createQueryBuilder('alarm')
      .where('alarm.tenantId = :tenantId', { tenantId: origin.tenantId })
      .andWhere("alarm.metadata->>'source' = :source", {
        source: AlarmPropagationService.SOURCE,
      })
      .andWhere("alarm.metadata->'propagation'->>'originAlarmId' = :originId", {
        originId: origin.id,
      })
      .orderBy("(alarm.metadata->'propagation'->>'depth')::int", 'ASC')
      .getMany();
  }

  /** True when this row is a propagated copy rather than a real alarm. */
  isMirror(alarm?: Alarm | null): boolean {
    return !!this.propagationOf(alarm);
  }

  /**
   * Whether this row's rule asked for propagation at all, decided from the
   * metadata the profile engine wrote — no query. False for a hand-created
   * alarm or one from the rule engine's action node, which never propagate.
   */
  couldHaveMirrors(alarm?: Alarm | null): boolean {
    const metadata = alarm?.metadata;
    if (!metadata) return false;
    return !!(
      metadata.propagate ||
      metadata.propagateToOwner ||
      metadata.propagateToTenant
    );
  }

  propagationOf(alarm?: Alarm | null): AlarmPropagationMetadata | null {
    const propagation = alarm?.metadata?.propagation;
    if (
      propagation &&
      propagation.isMirror === true &&
      typeof propagation.originAlarmId === 'string'
    ) {
      return propagation as AlarmPropagationMetadata;
    }
    return null;
  }

  // ══════════════════════════════════════════════════════════════════════════
  // PRIVATE: TARGET RESOLUTION
  // ══════════════════════════════════════════════════════════════════════════

  /**
   * Turn the rule's three propagation flags into concrete targets by walking
   * the real hierarchy: `device.assetId` → `assets.parentAssetId` chain →
   * owning customer → tenant.
   */
  async resolveTargets(
    device: Device,
    rule: DeviceProfileAlarmRule,
  ): Promise<PropagationTarget[]> {
    const targets: PropagationTarget[] = [];
    const seen = new Set<string>();

    const push = (target: PropagationTarget) => {
      const key = `${target.scope}:${target.scopeKey}`;
      if (seen.has(key)) return;
      seen.add(key);
      targets.push(target);
    };

    // ── rule.propagate: up the asset chain ─────────────────────────────────
    let ownerCustomerId = device.customerId ?? null;

    if (device.assetId) {
      const chain = await this.ancestorChain(device.tenantId, device.assetId);

      // The nearest asset that names a customer is the owner when the device
      // itself does not.
      if (!ownerCustomerId) {
        ownerCustomerId = chain.find((a) => a.customerId)?.customerId ?? null;
      }

      if (rule.propagate) {
        for (const asset of chain) {
          push({
            scope: 'ASSET',
            scopeKey: asset.id,
            label: asset.name,
            depth: asset.depth,
            assetId: asset.id,
            customerId: asset.customerId ?? device.customerId ?? undefined,
          });
        }
      }
    } else if (rule.propagate) {
      this.logger.debug(
        `Rule "${rule.alarmType}" asks for asset propagation but device ` +
          `${device.deviceKey} is not linked to an asset — nothing to walk.`,
      );
    }

    // ── rule.propagateToOwner: the owning customer ─────────────────────────
    // An unowned device's owner IS the tenant, so the flag degrades to a
    // tenant-level copy rather than being silently dropped.
    if (rule.propagateToOwner) {
      if (ownerCustomerId) {
        push({
          scope: 'CUSTOMER',
          scopeKey: ownerCustomerId,
          label: `customer ${ownerCustomerId}`,
          depth: 100,
          customerId: ownerCustomerId,
        });
      } else {
        push({
          scope: 'TENANT',
          scopeKey: device.tenantId,
          label: `tenant ${device.tenantId}`,
          depth: 200,
        });
      }
    }

    // ── rule.propagateToTenant ─────────────────────────────────────────────
    if (rule.propagateToTenant) {
      push({
        scope: 'TENANT',
        scopeKey: device.tenantId,
        label: `tenant ${device.tenantId}`,
        depth: 200,
      });
    }

    return targets;
  }

  /**
   * The asset the device sits on, then its parents, nearest first.
   *
   * One recursive CTE rather than a loop of findOne() calls, with two guards
   * baked into the SQL:
   *   • `NOT id = ANY(path)` — a cycle in `parentAssetId` terminates the walk
   *     instead of spinning forever;
   *   • `depth < :maxDepth` — a pathological but acyclic tree is still bounded.
   * Soft-deleted assets are excluded, and every row is pinned to the tenant,
   * so a mis-parented cross-tenant asset cannot leak an alarm sideways.
   */
  private async ancestorChain(
    tenantId: string,
    assetId: string,
  ): Promise<AncestorRow[]> {
    const rows: Array<{
      id: string;
      name: string;
      customerId: string | null;
      depth: string | number;
    }> = await this.assetRepository.query(
      `
      WITH RECURSIVE chain AS (
        SELECT a.id,
               a.name,
               a."customerId",
               a."parentAssetId",
               0 AS depth,
               ARRAY[a.id] AS path
          FROM assets a
         WHERE a.id = $1
           AND a."tenantId" = $2
           AND a.deleted_at IS NULL
        UNION ALL
        SELECT p.id,
               p.name,
               p."customerId",
               p."parentAssetId",
               c.depth + 1,
               c.path || p.id
          FROM assets p
          JOIN chain c ON p.id = c."parentAssetId"
         WHERE p."tenantId" = $2
           AND p.deleted_at IS NULL
           AND c.depth + 1 <= $3
           AND NOT p.id = ANY(c.path)
      )
      SELECT id, name, "customerId", depth FROM chain ORDER BY depth ASC
      `,
      [assetId, tenantId, this.maxDepth],
    );

    // Belt and braces: the CTE already dedupes via `path`, but a second guard
    // in TS means a future rewrite of the SQL cannot reintroduce a loop.
    const seen = new Set<string>();
    const chain: AncestorRow[] = [];

    for (const row of rows) {
      if (seen.has(row.id)) continue;
      seen.add(row.id);
      chain.push({
        id: row.id,
        name: row.name,
        customerId: row.customerId,
        depth: Number(row.depth),
      });
      if (chain.length > this.maxDepth) break;
    }

    if (rows.length > this.maxDepth) {
      this.logger.warn(
        `Asset chain from ${assetId} hit the depth cap (${this.maxDepth}); ` +
          `higher levels were not notified.`,
      );
    }

    return chain;
  }

  // ══════════════════════════════════════════════════════════════════════════
  // PRIVATE: MIRROR ROWS
  // ══════════════════════════════════════════════════════════════════════════

  private async findMirror(
    origin: Alarm,
    target: PropagationTarget,
  ): Promise<Alarm | null> {
    return this.alarmRepository
      .createQueryBuilder('alarm')
      .where('alarm.tenantId = :tenantId', { tenantId: origin.tenantId })
      .andWhere("alarm.metadata->>'source' = :source", {
        source: AlarmPropagationService.SOURCE,
      })
      .andWhere("alarm.metadata->'propagation'->>'originAlarmId' = :originId", {
        originId: origin.id,
      })
      .andWhere("alarm.metadata->'propagation'->>'scope' = :scope", {
        scope: target.scope,
      })
      .andWhere("alarm.metadata->'propagation'->>'scopeKey' = :scopeKey", {
        scopeKey: target.scopeKey,
      })
      .getOne();
  }

  private buildMirror(
    origin: Alarm,
    device: Device,
    rule: DeviceProfileAlarmRule,
    target: PropagationTarget,
  ): Alarm {
    const propagation: AlarmPropagationMetadata = {
      isMirror: true,
      originAlarmId: origin.id,
      originDeviceId: device.id,
      originDeviceKey: device.deviceKey,
      profileRuleId: rule.id,
      scope: target.scope,
      scopeKey: target.scopeKey,
      depth: target.depth,
      label: target.label,
    };

    return this.alarmRepository.create({
      tenantId: origin.tenantId,
      // deviceId is deliberately NOT set — that is what keeps a mirror out of
      // GET /alarms/device/:id and out of checkAlarmConditions().
      deviceId: undefined,
      assetId: target.scope === 'ASSET' ? target.assetId : undefined,
      customerId: target.scope === 'TENANT' ? undefined : target.customerId,
      name: origin.name,
      description: origin.description,
      severity: origin.severity,
      status: AlarmStatus.INACTIVE,
      // NOT NULL on the table; the origin's flat rule is reused verbatim so
      // Alarm.generateMessage() renders the same text at every level.
      rule: origin.rule,
      isEnabled: true,
      autoClear: false,
      triggerCount: 0,
      metadata: {
        source: AlarmPropagationService.SOURCE,
        propagation,
        profileRuleId: rule.id,
        profileRule: rule.condition,
      },
    });
  }

  /**
   * Bring a mirror into line with a just-raised origin.
   * Returns false when nothing changed, so an unchanged mirror costs no write.
   */
  private applyTriggerTo(mirror: Alarm, origin: Alarm): boolean {
    const alreadyCurrent =
      mirror.status === AlarmStatus.ACTIVE &&
      mirror.triggerCount === origin.triggerCount &&
      String(mirror.currentValue ?? '') === String(origin.currentValue ?? '');

    if (alreadyCurrent) return false;

    mirror.severity = origin.severity;
    mirror.rule = origin.rule;
    mirror.status = AlarmStatus.ACTIVE;
    mirror.currentValue = origin.currentValue ?? null;
    mirror.message = origin.message;
    mirror.triggeredAt = origin.triggeredAt ?? new Date();
    mirror.lastTriggeredAt = origin.lastTriggeredAt ?? new Date();
    mirror.triggerCount = origin.triggerCount;
    // A fresh occurrence at the origin is a fresh occurrence here too.
    mirror.acknowledgedAt = null;
    mirror.acknowledgedBy = null;
    mirror.clearedAt = null;
    mirror.clearedBy = null;
    mirror.computeTbStatus();

    return true;
  }

  /**
   * Apply `mutate` to every mirror of `origin`, skipping rows that need no
   * change and optionally one row that the caller has already handled.
   */
  private async fanOut(
    origin: Alarm,
    mutate: (mirror: Alarm, userId?: string) => boolean,
    userId?: string,
    skipId?: string,
  ): Promise<Alarm[]> {
    const mirrors = await this.findMirrors(origin);
    const written: Alarm[] = [];

    for (const mirror of mirrors) {
      if (skipId && mirror.id === skipId) continue;
      if (!mutate(mirror, userId)) continue;
      // No event is emitted for a mirror: it is a projection of one physical
      // alarm, and emitting would multiply notifications and escalations by
      // the depth of the hierarchy.
      written.push(await this.alarmRepository.save(mirror));
    }

    return written;
  }
}
