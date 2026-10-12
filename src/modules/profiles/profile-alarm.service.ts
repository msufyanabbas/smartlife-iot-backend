// src/modules/profiles/profile-alarm.service.ts
import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { Alarm, Attribute, Device } from '@modules/index.entities';
import {
  AlarmCondition,
  AlarmConditionSpecType,
  AlarmConditionTimeUnit,
  AlarmPredicateOperation,
  AlarmSeverity,
  AlarmStatus,
} from '@common/enums/index.enum';
import type {
  AlarmConditionFilter,
  AlarmRule,
  DeviceProfileAlarmRule,
} from '@common/interfaces/index.interface';
import { AlarmPropagationService } from './alarm-propagation.service';

/**
 * Per-device, per-rule progress towards a sustained condition.
 *
 * Lives in `alarms.metadata.conditionState` on the row the rule already owns
 * (located by `metadata.profileRuleId`). See the note on `readState()` for
 * why there, and not in Redis or a table of its own.
 */
export interface AlarmConditionRuntimeState {
  /** The spec this progress was accumulated under. */
  specType: string;
  /** Start of the current unbroken run of matching samples (ISO), or null. */
  firstMatchAt: string | null;
  /** Most recent matching sample (ISO), or null. */
  lastMatchAt: string | null;
  /** Consecutive matching samples. Reset to 0 by any breaking sample. */
  matchCount: number;
  /** When the sustained condition was last satisfied and the alarm fired. */
  firedAt: string | null;
  /** DURATION only: the window the rule asks for, in ms (for diagnostics). */
  windowMs?: number;
  /** REPEATING only: how many consecutive matches the rule asks for. */
  requiredCount?: number;
}

/** The sustain requirement, parsed once per evaluation. */
interface SustainSpec {
  type: AlarmConditionSpecType;
  windowMs: number;
  requiredCount: number;
}

/** A filter's thresholds after any `dynamicValue` has been resolved. */
interface ResolvedThreshold {
  value: unknown;
  value2?: unknown;
}

const MILLIS_PER_UNIT: Record<string, number> = {
  [AlarmConditionTimeUnit.SECONDS]: 1_000,
  [AlarmConditionTimeUnit.MINUTES]: 60_000,
  [AlarmConditionTimeUnit.HOURS]: 3_600_000,
  [AlarmConditionTimeUnit.DAYS]: 86_400_000,
};

const EMPTY_STATE = (specType: string): AlarmConditionRuntimeState => ({
  specType,
  firstMatchAt: null,
  lastMatchAt: null,
  matchCount: 0,
  firedAt: null,
});

/**
 * Evaluates the alarm rule templates declared on a DeviceProfile.
 *
 * Where AlarmsService handles per-device alarms (one Alarm row configured by
 * hand, matched on `rule.telemetryKey`), this service handles alarms declared
 * once on the *profile* and applied to every device using it.
 *
 * Lifecycle of a profile alarm:
 *   1. Device is created with a deviceProfileId → materialiseProfileAlarms()
 *      writes one INACTIVE Alarm row per enabled rule, so the device's alarm
 *      list shows what is being watched before anything fires.
 *   2. Telemetry arrives → evaluateProfileAlarmRules() tests each rule.
 *      SIMPLE fires on the first match; DURATION and REPEATING accumulate
 *      progress in `metadata.conditionState` and fire only once the rule's
 *      window or repeat count is satisfied.
 *   3. A matching `clearRule` returns the row to CLEARED and discards progress.
 *   4. Each raise and clear is mirrored up the asset/customer/tenant hierarchy
 *      by AlarmPropagationService when the rule's propagation flags ask for it.
 *
 * Rows are keyed on `metadata.profileRuleId` so a rule never duplicates.
 */
@Injectable()
export class ProfileAlarmService {
  private readonly logger = new Logger(ProfileAlarmService.name);

  constructor(
    @InjectRepository(Device)
    private readonly deviceRepository: Repository<Device>,
    @InjectRepository(Alarm)
    private readonly alarmRepository: Repository<Alarm>,
    // Read-only: resolves `predicate.value.dynamicValue` thresholds.
    @InjectRepository(Attribute)
    private readonly attributeRepository: Repository<Attribute>,
    private readonly eventEmitter: EventEmitter2,
    private readonly propagation: AlarmPropagationService,
  ) {}

  // ══════════════════════════════════════════════════════════════════════════
  // PUBLIC ENTRY POINTS
  // ══════════════════════════════════════════════════════════════════════════

  /**
   * Evaluate every enabled alarm rule on the device's profile against a
   * telemetry payload. Called from TelemetryConsumer after persistence.
   *
   * Never throws — a bad rule must not stop telemetry ingestion.
   */
  async evaluateProfileAlarmRules(
    deviceId: string,
    rawTelemetry: Record<string, any>,
  ): Promise<void> {
    const device = await this.deviceRepository.findOne({
      where: { id: deviceId },
      relations: ['deviceProfile'],
    });

    const rules = device?.deviceProfile?.alarmRules;
    if (!device || !rules?.length) return;

    const telemetry = this.normaliseTelemetry(rawTelemetry);

    // One cache per payload: a profile with five rules all bounded by the same
    // `maxTemperature` attribute resolves it once, not five times.
    const thresholdCache = new Map<string, unknown>();

    for (const rule of rules) {
      if (!rule?.enabled) continue;

      try {
        await this.evaluateRule(device, rule, telemetry, thresholdCache);
      } catch (err) {
        this.logger.error(
          `Alarm rule "${rule.alarmType}" (${rule.id}) failed for device ${deviceId}: ${
            (err as Error).message
          }`,
        );
      }
    }
  }

  /**
   * Create the dormant Alarm rows for a device that has just been linked to a
   * profile carrying alarm rules. Idempotent — existing rows are left alone.
   *
   * Propagated copies are NOT materialised here: a dormant row per rule per
   * ancestor asset would multiply the device's watch list by the depth of the
   * hierarchy for alarms that have never fired. Mirrors are created on the
   * first real raise — see AlarmPropagationService.
   *
   * Returns the number of rows created.
   */
  async materialiseProfileAlarms(device: Device): Promise<number> {
    const rules = device.deviceProfile?.alarmRules;
    if (!rules?.length) return 0;

    let created = 0;

    for (const rule of rules) {
      if (!rule?.enabled) continue;

      const existing = await this.findProfileAlarm(device.id, rule);
      if (existing) continue;

      await this.alarmRepository.save(
        this.buildAlarm(device, rule, AlarmStatus.INACTIVE),
      );
      created++;
    }

    if (created > 0) {
      this.logger.log(
        `Materialised ${created} profile alarm(s) for device ${device.deviceKey}`,
      );
    }

    return created;
  }

  // ══════════════════════════════════════════════════════════════════════════
  // PRIVATE: ONE RULE, ONE SAMPLE
  // ══════════════════════════════════════════════════════════════════════════

  /**
   * Evaluate a single rule against a single sample.
   *
   * The row this rule owns is loaded once, every decision is applied to it in
   * memory, and it is written at most once — so a clear and the progress reset
   * that must accompany it are one atomic UPDATE and cannot disagree.
   */
  private async evaluateRule(
    device: Device,
    rule: DeviceProfileAlarmRule,
    telemetry: Record<string, any>,
    thresholdCache: Map<string, unknown>,
  ): Promise<void> {
    const filters = rule.condition?.condition ?? [];
    if (filters.length === 0) return;

    const thresholds = await this.resolveThresholds(
      device,
      filters,
      thresholdCache,
      rule,
    );
    // An unresolvable dynamicValue still skips the rule — comparing against a
    // stale literal would fire on the wrong bound — but it is now only
    // unresolvable when the attribute genuinely does not exist.
    if (!thresholds) return;

    const spec = this.sustainSpec(rule);
    const isMatch = this.matches(filters, telemetry, thresholds);

    const existing = await this.findProfileAlarm(device.id, rule);
    const alarm = existing ?? this.buildAlarm(device, rule, AlarmStatus.INACTIVE);

    const state = this.readState(alarm, spec);
    const before = this.stateSignature(alarm, state);
    const now = Date.now();

    let decision: 'none' | 'trigger' | 'clear' = 'none';

    if (isMatch) {
      state.lastMatchAt = new Date(now).toISOString();
      state.matchCount += 1;
      if (!state.firstMatchAt) state.firstMatchAt = new Date(now).toISOString();

      if (this.sustained(spec, state, now)) {
        decision = 'trigger';
        state.firedAt = new Date(now).toISOString();
      } else {
        this.logger.debug(
          `Rule "${rule.alarmType}" matched but is not yet sustained ` +
            `(${spec.type}: ${this.progressText(spec, state, now)}) on device ` +
            `${device.deviceKey}`,
        );
      }
    } else {
      // A sample that breaks the condition discards all progress — this is
      // what makes DURATION mean "continuously" and REPEATING mean
      // "consecutively" rather than "ever".
      state.firstMatchAt = null;
      state.matchCount = 0;

      // Only an explicit clearRule clears a profile alarm. Absent one, the
      // alarm stays active until a user acknowledges/resolves it.
      const clearFilters = rule.clearRule?.condition ?? [];
      if (clearFilters.length > 0) {
        const clearThresholds = await this.resolveThresholds(
          device,
          clearFilters,
          thresholdCache,
          rule,
        );
        if (
          clearThresholds &&
          this.matches(clearFilters, telemetry, clearThresholds)
        ) {
          decision = 'clear';
        }
      }
    }

    // ── Apply ───────────────────────────────────────────────────────────────
    const wasActive = alarm.status === AlarmStatus.ACTIVE;

    if (decision === 'trigger') {
      alarm.rule = this.toAlarmRule(rule, thresholds);
      alarm.severity = this.toSeverity(rule.severity);
      alarm.metadata = this.buildMetadata(rule, alarm, telemetry);
      alarm.trigger(
        this.firstObservedValue(rule, telemetry) as number,
        rule.alarmDetails,
      );
    } else if (decision === 'clear') {
      if (alarm.status !== AlarmStatus.ACTIVE) {
        // Nothing raised to clear; still persist the progress reset.
        decision = 'none';
      } else {
        // A clear ends the occurrence, so the next one starts from scratch.
        Object.assign(state, EMPTY_STATE(spec.type));
        alarm.clear();
      }
    }

    this.writeState(alarm, state, spec);

    if (decision === 'none' && existing && before === this.stateSignature(alarm, state)) {
      // Nothing to say and nothing to persist — do not write on every sample.
      return;
    }

    const saved = await this.alarmRepository.save(alarm);

    // ── Announce / propagate, on edges only ─────────────────────────────────
    if (decision === 'trigger' && !wasActive) {
      this.eventEmitter.emit('alarm.triggered', { alarm: saved });
      this.logger.log(
        `Profile alarm "${rule.alarmType}" triggered for device ${device.deviceKey}` +
          (spec.type === AlarmConditionSpecType.SIMPLE
            ? ''
            : ` after ${this.progressText(spec, state, now)}`),
      );
      await this.propagation.propagateTrigger(saved, device, rule);
    } else if (decision === 'clear') {
      this.eventEmitter.emit('alarm.cleared', { alarm: saved });
      this.logger.log(
        `Profile alarm "${rule.alarmType}" cleared for device ${device.deviceKey}`,
      );
      // Clearing must reach every level the raise reached, or a building
      // dashboard keeps showing a fire that is already out.
      await this.propagation.propagateClear(saved);
    }
  }

  // ══════════════════════════════════════════════════════════════════════════
  // PRIVATE: SUSTAINED-CONDITION STATE
  // ══════════════════════════════════════════════════════════════════════════

  /**
   * Parse `condition.spec` into a concrete sustain requirement.
   *
   * Field names come from `AlarmConditionSpec` in
   * common/interfaces/device-profile.interface.ts: `{ type, unit, value }`.
   * `spec.predicate.defaultValue` is also read, because ThingsBoard-shaped
   * payloads carry the magnitude there and profiles imported from one would
   * otherwise silently behave as SIMPLE.
   */
  private sustainSpec(rule: DeviceProfileAlarmRule): SustainSpec {
    const spec = rule.condition?.spec as any;
    const rawType = String(spec?.type ?? AlarmConditionSpecType.SIMPLE).toUpperCase();

    const type =
      (Object.values(AlarmConditionSpecType) as string[]).includes(rawType)
        ? (rawType as AlarmConditionSpecType)
        : AlarmConditionSpecType.SIMPLE;

    const magnitude = Number(
      spec?.value ?? spec?.predicate?.defaultValue ?? spec?.predicate ?? 0,
    );

    if (type === AlarmConditionSpecType.DURATION) {
      const unit = String(spec?.unit ?? AlarmConditionTimeUnit.SECONDS).toUpperCase();
      const perUnit = MILLIS_PER_UNIT[unit];

      if (!perUnit) {
        this.logger.warn(
          `Rule "${rule.alarmType}" has DURATION unit "${spec?.unit}", which is ` +
            `not an AlarmConditionTimeUnit — reading the value as SECONDS.`,
        );
      }

      const windowMs =
        Number.isFinite(magnitude) && magnitude > 0
          ? magnitude * (perUnit ?? MILLIS_PER_UNIT[AlarmConditionTimeUnit.SECONDS])
          : 0;

      if (windowMs <= 0) {
        this.logger.warn(
          `Rule "${rule.alarmType}" is DURATION but declares no positive ` +
            `spec.value — treated as SIMPLE.`,
        );
      }

      return { type, windowMs, requiredCount: 1 };
    }

    if (type === AlarmConditionSpecType.REPEATING) {
      const requiredCount =
        Number.isFinite(magnitude) && magnitude >= 1 ? Math.floor(magnitude) : 1;

      if (requiredCount === 1 && magnitude !== 1) {
        this.logger.warn(
          `Rule "${rule.alarmType}" is REPEATING but declares no count >= 1 ` +
            `(spec.value = ${spec?.value}) — treated as SIMPLE.`,
        );
      }

      return { type, windowMs: 0, requiredCount };
    }

    return { type: AlarmConditionSpecType.SIMPLE, windowMs: 0, requiredCount: 1 };
  }

  /**
   * Has the rule's sustain requirement been met by the run of matches that
   * `state` describes?
   *
   * DURATION is judged across *samples*: any sample that fails the condition
   * resets `firstMatchAt`, so firing means every sample since then matched and
   * the window has elapsed. A silent device cannot be judged either way — a
   * gap in telemetry neither resets nor advances the window, so the alarm
   * fires on the first matching sample that arrives after the window is up.
   */
  private sustained(
    spec: SustainSpec,
    state: AlarmConditionRuntimeState,
    now: number,
  ): boolean {
    switch (spec.type) {
      case AlarmConditionSpecType.DURATION: {
        if (spec.windowMs <= 0) return true;
        if (!state.firstMatchAt) return false;
        const since = Date.parse(state.firstMatchAt);
        if (!Number.isFinite(since)) return false;
        return now - since >= spec.windowMs;
      }
      case AlarmConditionSpecType.REPEATING:
        return state.matchCount >= spec.requiredCount;
      case AlarmConditionSpecType.SIMPLE:
      default:
        return true;
    }
  }

  /**
   * Read the rule's progress off the row it already owns.
   *
   * ── Why `alarms.metadata.conditionState` and not Redis or a new table ────
   * The requirement that decides it is restart survival: a 10-minute DURATION
   * rule whose progress lives in memory silently resets on every deploy and
   * never fires. That rules out an in-process Map, and it argues against
   * Redis here — this deployment's Redis is configured as a cache
   * (`keyPrefix`, shared with Bull and the HTTP cache), so a flush or an
   * eviction would quietly reset every in-flight window, and ProfilesModule
   * would have to take a dependency on RedisModule to reach it.
   *
   * Postgres survives both. Of the two Postgres options, a dedicated table
   * would need a migration — and `migration:run` is blocked in this repo
   * (CLAUDE.md §11), so every environment would need a bespoke runner before
   * alarms worked at all. The materialised Alarm row, by contrast:
   *   • already exists, one per (device, rule), created by
   *     materialiseProfileAlarms() and located by `metadata.profileRuleId`;
   *   • is already read and written on this exact code path, so tracking adds
   *     no round trip;
   *   • mutates in the same UPDATE as the alarm's own status, so a clear can
   *     never land without its progress reset.
   *
   * The cost is one UPDATE per sample per DURATION/REPEATING rule while a run
   * of matches is building — `evaluateRule()` skips the write when nothing
   * changed, so an idle device costs nothing, and SIMPLE rules are unaffected.
   */
  private readState(
    alarm: Alarm,
    spec: SustainSpec,
  ): AlarmConditionRuntimeState {
    const stored = alarm.metadata?.conditionState as
      | AlarmConditionRuntimeState
      | undefined;

    // Progress accumulated under a different spec is meaningless: if the rule
    // was edited from REPEATING(5) to DURATION(10m), four past matches must
    // not count towards the new window.
    if (!stored || stored.specType !== spec.type) {
      return EMPTY_STATE(spec.type);
    }

    return {
      specType: spec.type,
      firstMatchAt: stored.firstMatchAt ?? null,
      lastMatchAt: stored.lastMatchAt ?? null,
      matchCount: Number(stored.matchCount ?? 0),
      firedAt: stored.firedAt ?? null,
    };
  }

  private writeState(
    alarm: Alarm,
    state: AlarmConditionRuntimeState,
    spec: SustainSpec,
  ): void {
    alarm.metadata = {
      ...(alarm.metadata ?? {}),
      conditionState: {
        ...state,
        ...(spec.type === AlarmConditionSpecType.DURATION
          ? { windowMs: spec.windowMs }
          : {}),
        ...(spec.type === AlarmConditionSpecType.REPEATING
          ? { requiredCount: spec.requiredCount }
          : {}),
      },
    };
  }

  /** Cheap change detector, so an unchanged row is not rewritten. */
  private stateSignature(
    alarm: Alarm,
    state: AlarmConditionRuntimeState,
  ): string {
    return [
      alarm.status,
      state.specType,
      state.firstMatchAt ?? '-',
      state.matchCount,
      state.firedAt ?? '-',
    ].join('|');
  }

  private progressText(
    spec: SustainSpec,
    state: AlarmConditionRuntimeState,
    now: number,
  ): string {
    if (spec.type === AlarmConditionSpecType.DURATION) {
      const since = state.firstMatchAt ? Date.parse(state.firstMatchAt) : now;
      return `${Math.max(0, now - since)}ms of ${spec.windowMs}ms`;
    }
    if (spec.type === AlarmConditionSpecType.REPEATING) {
      return `${state.matchCount} of ${spec.requiredCount} matches`;
    }
    return 'immediate';
  }

  // ══════════════════════════════════════════════════════════════════════════
  // PRIVATE: CONDITION EVALUATION
  // ══════════════════════════════════════════════════════════════════════════

  /**
   * Flatten a telemetry payload into the key space alarm rules are written in.
   *
   * Rules name a bare key ("temperature"), but payloads reach the consumer in
   * the ThingsBoard envelope `{ ts, values: { temperature: 45 } }` — and codec
   * output can nest further. This produces every addressable form:
   *
   *   { ts: …, temperature: 45, humidity: 50,
   *     'values.temperature': 45, 'values.humidity': 50 }
   *
   * Envelope-hoisted keys are written first so a genuine top-level key of the
   * same name wins over the `values` copy.
   */
  private normaliseTelemetry(data: Record<string, any>): Record<string, any> {
    if (!data || typeof data !== 'object') return {};

    const out: Record<string, any> = {};

    // 1. Hoist the `values` envelope, if present.
    const values = (data as any).values;
    if (values && typeof values === 'object' && !Array.isArray(values)) {
      Object.assign(out, this.flatten(values));
    }

    // 2. Overlay the payload itself (dotted paths included).
    Object.assign(out, this.flatten(data));

    return out;
  }

  /** Depth-first flatten producing dotted paths for nested objects. */
  private flatten(
    obj: Record<string, any>,
    prefix = '',
  ): Record<string, any> {
    const out: Record<string, any> = {};

    for (const [key, value] of Object.entries(obj ?? {})) {
      const path = prefix ? `${prefix}.${key}` : key;
      if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
        Object.assign(out, this.flatten(value, path));
      } else {
        out[path] = value;
      }
    }

    return out;
  }

  /**
   * Resolve each filter's thresholds, following `predicate.value.dynamicValue`
   * to the attribute it names.
   *
   * Returns null when any threshold cannot be resolved — the rule is then
   * skipped for this sample rather than compared against a stale literal,
   * which is the behaviour the old code had for *every* dynamicValue.
   */
  private async resolveThresholds(
    device: Device,
    filters: AlarmConditionFilter[],
    cache: Map<string, unknown>,
    rule: DeviceProfileAlarmRule,
  ): Promise<ResolvedThreshold[] | null> {
    const resolved: ResolvedThreshold[] = [];

    for (const filter of filters) {
      const predicate = filter?.predicate;
      if (!predicate) return null;

      const value = await this.resolveValue(device, predicate.value, cache, rule, filter);
      if (value === undefined || value === null) return null;

      const upper =
        predicate.value2 !== undefined
          ? await this.resolveValue(device, predicate.value2, cache, rule, filter)
          : undefined;

      resolved.push({ value, value2: upper ?? undefined });
    }

    return resolved;
  }

  private async resolveValue(
    device: Device,
    predicateValue: { defaultValue?: unknown; dynamicValue?: any } | undefined,
    cache: Map<string, unknown>,
    rule: DeviceProfileAlarmRule,
    filter: AlarmConditionFilter,
  ): Promise<unknown> {
    if (!predicateValue) return undefined;

    const dynamic = predicateValue.dynamicValue;
    if (!dynamic?.sourceAttribute) {
      return predicateValue.defaultValue;
    }

    const entity = this.dynamicSource(device, dynamic.sourceType);
    if (!entity) {
      this.logger.warn(
        `Rule "${rule.alarmType}" filter on "${filter.key}" uses dynamicValue ` +
          `sourceType "${dynamic.sourceType}", which does not resolve for device ` +
          `${device.deviceKey} — rule skipped for this sample.`,
      );
      return undefined;
    }

    const cacheKey = `${entity.entityType}:${entity.entityId}:${dynamic.sourceAttribute}`;
    if (cache.has(cacheKey)) return cache.get(cacheKey);

    const row = await this.attributeRepository
      .createQueryBuilder('attr')
      .where('attr.tenantId = :tenantId', { tenantId: device.tenantId })
      // entityType is a free-form varchar and is written both as 'device'
      // (AttributesService callers) and 'DEVICE' (TelemetryConsumer).
      .andWhere('LOWER(attr.entityType) = :entityType', {
        entityType: entity.entityType,
      })
      .andWhere('attr.entityId = :entityId', { entityId: entity.entityId })
      .andWhere('attr.attributeKey = :key', { key: dynamic.sourceAttribute })
      .orderBy('attr.lastUpdateTs', 'DESC')
      .getOne();

    // `numberValue` is a DECIMAL, so pg hands it back as a string; coerce it
    // or an EQUAL predicate would compare "30.000000" against "30".
    const raw = row?.getValue();
    const value =
      raw !== null && raw !== undefined && !Number.isNaN(Number(raw)) && raw !== ''
        ? Number(raw)
        : raw;

    if (value === undefined || value === null) {
      this.logger.warn(
        `Rule "${rule.alarmType}" filter on "${filter.key}" needs attribute ` +
          `"${dynamic.sourceAttribute}" on ${entity.entityType} ` +
          `${entity.entityId}, which is not set — rule skipped for this sample.`,
      );
      return undefined;
    }

    cache.set(cacheKey, value);
    return value;
  }

  /**
   * Which entity a `dynamicValue.sourceType` points at. Both the ThingsBoard
   * spellings (`CURRENT_DEVICE`) and the bare ones (`DEVICE`) are accepted.
   */
  private dynamicSource(
    device: Device,
    sourceType?: string,
  ): { entityType: string; entityId: string } | null {
    switch (String(sourceType ?? '').toUpperCase()) {
      case 'CURRENT_DEVICE':
      case 'DEVICE':
        return { entityType: 'device', entityId: device.id };
      case 'CURRENT_ASSET':
      case 'ASSET':
      case 'CURRENT_RELATED_ASSET':
        return device.assetId
          ? { entityType: 'asset', entityId: device.assetId }
          : null;
      case 'CURRENT_CUSTOMER':
      case 'CUSTOMER':
        return device.customerId
          ? { entityType: 'customer', entityId: device.customerId }
          : null;
      case 'CURRENT_TENANT':
      case 'TENANT':
        return { entityType: 'tenant', entityId: device.tenantId };
      default:
        return null;
    }
  }

  /** ALL filters must match (AND semantics), mirroring ThingsBoard. */
  private matches(
    filters: AlarmConditionFilter[],
    telemetry: Record<string, any>,
    thresholds: ResolvedThreshold[],
  ): boolean {
    return filters.every((filter, index) => {
      const value = telemetry?.[filter.key];
      if (value === undefined || value === null) return false;
      return this.evaluatePredicate(filter, value, thresholds[index]);
    });
  }

  private evaluatePredicate(
    filter: AlarmConditionFilter,
    value: any,
    resolved?: ResolvedThreshold,
  ): boolean {
    const predicate = filter?.predicate;
    if (!predicate) return false;

    const threshold = resolved?.value ?? predicate.value?.defaultValue;
    if (threshold === undefined || threshold === null) return false;

    switch (predicate.operation) {
      case AlarmPredicateOperation.GREATER:
        return Number(value) > Number(threshold);
      case AlarmPredicateOperation.LESS:
        return Number(value) < Number(threshold);
      case AlarmPredicateOperation.EQUAL:
        return String(value) === String(threshold);
      case AlarmPredicateOperation.NOT_EQUAL:
        return String(value) !== String(threshold);
      case AlarmPredicateOperation.GREATER_OR_EQUAL:
        return Number(value) >= Number(threshold);
      case AlarmPredicateOperation.LESS_OR_EQUAL:
        return Number(value) <= Number(threshold);
      case AlarmPredicateOperation.BETWEEN: {
        const upper =
          resolved?.value2 ?? predicate.value2?.defaultValue ?? threshold;
        return Number(value) >= Number(threshold) && Number(value) <= Number(upper);
      }
      default:
        return false;
    }
  }

  // ══════════════════════════════════════════════════════════════════════════
  // PRIVATE: MAPPING PROFILE RULE → ALARM ENTITY
  // ══════════════════════════════════════════════════════════════════════════

  /**
   * Locate the Alarm row belonging to a specific profile rule.
   *
   * Matched on `metadata.profileRuleId`, NOT on name: other producers (the
   * rule engine's action node, hand-created alarms) can and do create rows
   * with the same `name` on the same device, and matching by name would let
   * this service hijack or duplicate them.
   */
  private async findProfileAlarm(
    deviceId: string,
    rule: DeviceProfileAlarmRule,
  ): Promise<Alarm | null> {
    return this.alarmRepository
      .createQueryBuilder('alarm')
      .where('alarm.deviceId = :deviceId', { deviceId })
      .andWhere("alarm.metadata->>'source' = :source", {
        source: 'DEVICE_PROFILE',
      })
      .andWhere("alarm.metadata->>'profileRuleId' = :ruleId", {
        ruleId: rule.id,
      })
      .getOne();
  }

  private buildAlarm(
    device: Device,
    rule: DeviceProfileAlarmRule,
    status: AlarmStatus,
  ): Alarm {
    return this.alarmRepository.create({
      tenantId: device.tenantId,
      // Denormalised from the device so customer-scoped alarm queries work.
      customerId: device.customerId ?? undefined,
      deviceId: device.id,
      name: rule.alarmType,
      description: rule.alarmDetails,
      severity: this.toSeverity(rule.severity),
      status,
      // `rule` is NOT NULL on the alarms table and drives Alarm.generateMessage()
      rule: this.toAlarmRule(rule),
      isEnabled: true,
      // Cleared only by an explicit clearRule — see evaluateProfileAlarmRules.
      autoClear: false,
      triggerCount: 0,
      metadata: this.buildMetadata(rule),
    });
  }

  /**
   * Collapse the profile rule's first filter into the flat AlarmRule shape the
   * alarms table stores. Multi-filter rules keep their full definition in
   * `metadata.profileRule`; the flat copy exists so Alarm.generateMessage()
   * and the existing alarm UI render something meaningful.
   *
   * `resolved` is supplied at trigger time so a dynamicValue threshold shows
   * the number it was actually compared against, not an empty literal.
   */
  private toAlarmRule(
    rule: DeviceProfileAlarmRule,
    resolved?: ResolvedThreshold[],
  ): AlarmRule {
    const filter = rule.condition?.condition?.[0];
    const predicate = filter?.predicate;
    const first = resolved?.[0];

    return {
      telemetryKey: filter?.key ?? 'unknown',
      condition: this.toAlarmCondition(predicate?.operation),
      value: Number(first?.value ?? predicate?.value?.defaultValue ?? 0),
      value2:
        first?.value2 !== undefined
          ? Number(first.value2)
          : predicate?.value2?.defaultValue !== undefined
            ? Number(predicate.value2.defaultValue)
            : undefined,
    };
  }

  /**
   * `existing` is passed on a re-trigger so the sustained-condition state and
   * any propagation bookkeeping already on the row survive — this used to
   * replace `metadata` wholesale, which would wipe progress on every fire.
   */
  private buildMetadata(
    rule: DeviceProfileAlarmRule,
    existing?: Alarm,
    telemetry?: Record<string, any>,
  ): Record<string, any> {
    const spec = rule.condition?.spec;

    return {
      ...(existing?.metadata ?? {}),
      source: 'DEVICE_PROFILE',
      profileRuleId: rule.id,
      // Read by AlarmPropagationService.resolveTargets().
      propagate: rule.propagate ?? false,
      propagateToOwner: rule.propagateToOwner ?? false,
      propagateToTenant: rule.propagateToTenant ?? false,
      dashboardId: rule.dashboardId,
      profileRule: rule.condition,
      ...(spec ? { profileRuleSpec: spec } : {}),
      ...(telemetry ? { lastTelemetry: telemetry } : {}),
    };
  }

  /** The value that tripped the rule, used as Alarm.currentValue. */
  private firstObservedValue(
    rule: DeviceProfileAlarmRule,
    telemetry: Record<string, any>,
  ): unknown {
    const key = rule.condition?.condition?.[0]?.key;
    return key ? telemetry?.[key] : undefined;
  }

  private toAlarmCondition(
    operation?: AlarmPredicateOperation,
  ): AlarmCondition {
    switch (operation) {
      case AlarmPredicateOperation.GREATER:
        return AlarmCondition.GREATER_THAN;
      case AlarmPredicateOperation.LESS:
        return AlarmCondition.LESS_THAN;
      case AlarmPredicateOperation.NOT_EQUAL:
        return AlarmCondition.NOT_EQUAL;
      case AlarmPredicateOperation.GREATER_OR_EQUAL:
        return AlarmCondition.GREATER_THAN_OR_EQUAL;
      case AlarmPredicateOperation.LESS_OR_EQUAL:
        return AlarmCondition.LESS_THAN_OR_EQUAL;
      case AlarmPredicateOperation.BETWEEN:
        return AlarmCondition.BETWEEN;
      case AlarmPredicateOperation.EQUAL:
      default:
        return AlarmCondition.EQUAL;
    }
  }

  /** Profile rule severities are already the AlarmSeverity vocabulary. */
  private toSeverity(severity?: string): AlarmSeverity {
    const normalised = String(severity ?? '').toLowerCase();
    const match = Object.values(AlarmSeverity).find((s) => s === normalised);
    return (match as AlarmSeverity) ?? AlarmSeverity.WARNING;
  }
}
