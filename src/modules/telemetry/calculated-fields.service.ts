// src/modules/telemetry/calculated-fields.service.ts
import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Device } from '@modules/devices/entities/device.entity';
import { Asset } from '@modules/assets/entities/asset.entity';
import { Attribute } from '@modules/attributes/entities/attribute.entity';
import type { AssetProfile } from '@modules/profiles/entities/asset-profile.entity';
import { AssetProfilesService } from '@modules/profiles/asset-profiles.service';

/**
 * What a device's calculated-field plan resolves to, cached per device.
 *
 * `profile: null` is a real, cached answer meaning "this device has no asset,
 * or its asset has no profile, or that profile declares no calculated fields".
 * Caching the negative is the whole point: most devices on a tenant have no
 * calculated fields, and without it every reading from every one of them would
 * re-walk device → asset → profile to learn that again.
 */
interface CalculationPlan {
  expiresAt: number;
  profile: AssetProfile | null;
  assetId: string | null;
}

interface AttributeSnapshot {
  expiresAt: number;
  values: Record<string, unknown>;
}

const number = (raw: string | undefined, fallback: number): number => {
  const value = Number(raw);
  return Number.isFinite(value) && value > 0 ? value : fallback;
};

/**
 * Computes an asset profile's calculated fields from arriving telemetry.
 *
 * ── What was broken ─────────────────────────────────────────────────────────
 * `AssetProfilesService.calculateFields()` is a real sandboxed evaluator, and
 * its only caller was `POST /profiles/asset/:id/calculate`, which takes the
 * input values **in the request body** and returns the results in the
 * response. Nothing read telemetry and nothing stored a result, so a profile's
 * "calculated fields" computed nothing on their own: they were a calculator
 * you could type numbers into, not a derived series.
 *
 * This service closes that. When telemetry arrives, the device's asset
 * profile's calculated fields are evaluated against that reading plus the
 * device's and asset's attributes, and the results are merged into the
 * telemetry row **before it is persisted**.
 *
 * ── Why merge into the row rather than write a second one ───────────────────
 * Merging is what makes the result behave "like any other series", which is
 * the requirement:
 *
 *   · `GET /telemetry/devices/:id/timeseries?key=…` reads `data->>key`, so a
 *     calculated field charts with no query change.
 *   · `AlarmsService.checkAlarmConditionsBatch()` and
 *     `ProfileAlarmService.evaluateProfileAlarmRules()` both run on
 *     `payload.data` in `TelemetryConsumer` step 2 — AFTER this — so an alarm
 *     rule can name a calculated field as its key.
 *   · The WebSocket broadcast, the integration fan-out, the
 *     `telemetry.device.validated` topic that drives automations and
 *     `rules.input` all carry the same object, so every consumer sees the
 *     derived value without being taught about it.
 *
 * A separate row would need all five of those paths changed, and would make
 * every chart that joins a raw key to a derived one a two-query problem.
 *
 * ── Three things it will not do ─────────────────────────────────────────────
 *  1. **It never overwrites a key the device reported.** A calculated field
 *     named `temperature` is skipped, not applied. Letting a tenant-authored
 *     formula shadow a real reading would corrupt the measurement history
 *     irreversibly, and it is a mistake that would be invisible afterwards.
 *  2. **It cannot read another calculated field.** All fields are evaluated
 *     against the same input snapshot, so the order they are declared in does
 *     not change the answer. Chaining would need a dependency graph and a
 *     cycle check; without one, two fields referring to each other would
 *     produce a different result depending on declaration order.
 *  3. **It never throws.** A broken expression, a missing asset or a dead
 *     database connection logs and returns nothing. Telemetry ingestion must
 *     not stop because a formula is wrong — the same rule
 *     `ProfileAlarmService` follows.
 *
 * ── Caching ─────────────────────────────────────────────────────────────────
 * This runs once per telemetry message, which on a busy tenant is thousands of
 * times a minute, so an uncached `device → asset → profile` walk plus an
 * attribute read would be four queries per reading. Two TTL caches, both
 * bounded:
 *
 *   · the plan (device → profile) for `CALCULATED_FIELDS_PLAN_TTL_MS`, 60s
 *     default. The cost of staleness is that a profile edit takes up to a
 *     minute to take effect, which for a formula is not a meaningful delay.
 *   · the attribute snapshot for `CALCULATED_FIELDS_ATTRIBUTE_TTL_MS`, 30s
 *     default. Attributes are configuration, not measurements — a capacity or
 *     a floor area, changed by hand.
 *
 * Both are capped at `CALCULATED_FIELDS_CACHE_MAX_ENTRIES` (5,000) and evict
 * oldest-first. An unbounded Map keyed by device id is a slow memory leak on a
 * platform where devices are created and deleted — the same bound
 * `IntegrationMqttInboundService` puts on its device lookup cache.
 *
 * The caches are per process. With several replicas each keeps its own, which
 * is correct for a read-through cache of immutable-ish configuration; nothing
 * here is shared state.
 */
@Injectable()
export class CalculatedFieldsService {
  private readonly logger = new Logger(CalculatedFieldsService.name);

  private readonly plans = new Map<string, CalculationPlan>();
  private readonly attributes = new Map<string, AttributeSnapshot>();

  private readonly planTtlMs = number(
    process.env.CALCULATED_FIELDS_PLAN_TTL_MS,
    60_000,
  );
  private readonly attributeTtlMs = number(
    process.env.CALCULATED_FIELDS_ATTRIBUTE_TTL_MS,
    30_000,
  );
  private readonly maxEntries = number(
    process.env.CALCULATED_FIELDS_CACHE_MAX_ENTRIES,
    5_000,
  );

  /** Names already reported as colliding, so the warning is not per message. */
  private readonly warnedCollisions = new Set<string>();

  private readonly enabled =
    (process.env.CALCULATED_FIELDS_ENABLED ?? 'true').toLowerCase() !== 'false';

  constructor(
    @InjectRepository(Device)
    private readonly deviceRepository: Repository<Device>,
    @InjectRepository(Asset)
    private readonly assetRepository: Repository<Asset>,
    @InjectRepository(Attribute)
    private readonly attributeRepository: Repository<Attribute>,
    // The evaluator lives in ProfilesModule (already imported by
    // TelemetryModule for ProfileAlarmService) and is called, not
    // reimplemented: it is the one sandboxed place user-authored expressions
    // are compiled, and a second copy of that sandbox is a second place for it
    // to be got wrong. CLAUDE.md §4g.
    private readonly assetProfiles: AssetProfilesService,
  ) {}

  // ══════════════════════════════════════════════════════════════════════════
  // PUBLIC ENTRY POINT
  // ══════════════════════════════════════════════════════════════════════════

  /**
   * Values to merge into this reading, or `{}` when there is nothing to add.
   *
   * Called from `TelemetryConsumer` before persistence. Never throws.
   */
  async computeForTelemetry(
    deviceId: string,
    tenantId: string,
    rawData: Record<string, any>,
  ): Promise<Record<string, any>> {
    if (!this.enabled) return {};

    try {
      const plan = await this.resolvePlan(deviceId, tenantId);
      if (!plan?.profile) return {};

      const reading = this.normaliseTelemetry(rawData);
      const context = await this.buildContext(plan, reading, tenantId);

      const calculated = this.assetProfiles.computeCalculatedFields(
        plan.profile,
        context,
      );

      return this.applyCollisionPolicy(calculated, reading, deviceId);
    } catch (error) {
      this.logger.error(
        `Calculated fields failed for device ${deviceId}: ${(error as Error).message}`,
      );
      return {};
    }
  }

  /** Drop cached plans — for a verification script, or after a profile edit. */
  invalidate(deviceId?: string): void {
    if (deviceId) {
      this.plans.delete(deviceId);
      return;
    }
    this.plans.clear();
    this.attributes.clear();
  }

  // ══════════════════════════════════════════════════════════════════════════
  // PLAN RESOLUTION
  // ══════════════════════════════════════════════════════════════════════════

  /**
   * `device → asset → assetProfile.calculatedFields`, cached.
   *
   * Two queries on a cache miss and none on a hit. The device row is read
   * rather than taken from the Kafka payload because the payload carries no
   * `assetId` on every path, and a device moved between assets must stop
   * computing the old asset's fields.
   */
  private async resolvePlan(
    deviceId: string,
    tenantId: string,
  ): Promise<CalculationPlan | null> {
    const cached = this.plans.get(deviceId);
    if (cached && cached.expiresAt > Date.now()) return cached;

    const device = await this.deviceRepository.findOne({
      where: { id: deviceId, tenantId },
      select: ['id', 'assetId', 'tenantId'],
    });

    let profile: AssetProfile | null = null;
    let assetId: string | null = null;

    if (device?.assetId) {
      assetId = device.assetId;
      const asset = await this.assetRepository.findOne({
        // Pinned to the tenant: the asset id comes off a device row, but a
        // predicate that resolves a row by id alone is the shape §4g exists
        // to warn about, and this one would read another tenant's profile.
        where: { id: device.assetId, tenantId },
        relations: ['assetProfile'],
      });
      const candidate = asset?.assetProfile ?? null;
      // A profile with no calculated fields is cached as `null` so the next
      // reading skips the context build entirely, not just the evaluation.
      profile = candidate?.calculatedFields?.length ? candidate : null;
    }

    const plan: CalculationPlan = {
      expiresAt: Date.now() + this.planTtlMs,
      profile,
      assetId,
    };

    this.remember(this.plans, deviceId, plan);
    return plan;
  }

  // ══════════════════════════════════════════════════════════════════════════
  // CONTEXT
  // ══════════════════════════════════════════════════════════════════════════

  /**
   * What an expression can see.
   *
   * Flat telemetry keys sit at the top level, so a formula reads
   * `temperature * 1.8 + 32` — the same spelling an alarm rule's `key` uses,
   * which is what makes the two features consistent to configure. Alongside
   * them, four namespaces for when a name would otherwise clash or is not a
   * valid identifier:
   *
   *   `telemetry.<key>`     this reading
   *   `attributes.<key>`    asset attributes, overlaid with the device's own
   *   `configuration.<key>` the asset's profile-schema values (§4a) — this is
   *                         where `capacity`, `totalFloors` and `area` live,
   *                         and the entity's own example formula
   *                         `(devices.active / attributes.capacity) * 100`
   *                         is really asking for one of these
   *   `asset.<key>`         the asset's legacy free-form `attributes` blob
   *
   * `AssetProfilesService.evaluateExpression()` JSON-clones everything into a
   * fresh vm context, so passing nested objects is safe — only plain data
   * crosses, never a live reference with a prototype chain back to this realm.
   */
  private async buildContext(
    plan: CalculationPlan,
    reading: Record<string, any>,
    tenantId: string,
  ): Promise<Record<string, any>> {
    const assetAttributes = plan.assetId
      ? await this.readAttributes(tenantId, 'asset', plan.assetId)
      : {};
    const asset = plan.assetId
      ? await this.assetRepository.findOne({
          where: { id: plan.assetId, tenantId },
          select: ['id', 'configuration', 'attributes'],
        })
      : null;

    return {
      ...reading,
      telemetry: reading,
      attributes: assetAttributes,
      configuration: (asset?.configuration ?? {}) as Record<string, unknown>,
      asset: (asset?.attributes ?? {}) as Record<string, unknown>,
    };
  }

  /**
   * One entity's attributes as a flat `{key: value}` map, cached.
   *
   * `entityType` is a free-form varchar written both as `'asset'` and
   * `'ASSET'` depending on which service wrote the row, so the comparison is
   * case-insensitive — the same correction `ProfileAlarmService.resolveValue()`
   * carries. `numberValue` is a DECIMAL and comes back from pg as a string, so
   * numerics are coerced; without that a formula would be doing string
   * arithmetic and `"30.000000" * 2` is `NaN`.
   */
  private async readAttributes(
    tenantId: string,
    entityType: string,
    entityId: string,
  ): Promise<Record<string, unknown>> {
    const cacheKey = `${tenantId}:${entityType}:${entityId}`;
    const cached = this.attributes.get(cacheKey);
    if (cached && cached.expiresAt > Date.now()) return cached.values;

    const rows = await this.attributeRepository
      .createQueryBuilder('attr')
      .where('attr.tenantId = :tenantId', { tenantId })
      .andWhere('LOWER(attr.entityType) = :entityType', { entityType })
      .andWhere('attr.entityId = :entityId', { entityId })
      .getMany();

    const values: Record<string, unknown> = {};
    for (const row of rows) {
      const raw = row.getValue();
      values[row.attributeKey] =
        raw !== null &&
        raw !== undefined &&
        raw !== '' &&
        !Number.isNaN(Number(raw))
          ? Number(raw)
          : raw;
    }

    this.remember(this.attributes, cacheKey, {
      expiresAt: Date.now() + this.attributeTtlMs,
      values,
    });
    return values;
  }

  // ══════════════════════════════════════════════════════════════════════════
  // HELPERS
  // ══════════════════════════════════════════════════════════════════════════

  /**
   * Drop any calculated field that would overwrite a reported key, and any
   * that evaluated to nothing.
   *
   * A `null` result is what `computeCalculatedFields()` returns for an
   * expression that threw — a typo, a missing attribute, a division by an
   * undefined name. Storing it would write a null into the series on every
   * reading and draw a chart of gaps that looks like a device fault rather
   * than a configuration error. The profile editor is where a broken formula
   * should be visible; `POST /profiles/asset/:id/calculate` still returns the
   * nulls so it can be.
   */
  private applyCollisionPolicy(
    calculated: Record<string, any>,
    reading: Record<string, any>,
    deviceId: string,
  ): Record<string, any> {
    const safe: Record<string, any> = {};

    for (const [name, value] of Object.entries(calculated)) {
      if (value === null || value === undefined) continue;

      if (Object.prototype.hasOwnProperty.call(reading, name)) {
        const warnKey = `${deviceId}:${name}`;
        if (!this.warnedCollisions.has(warnKey)) {
          this.warnedCollisions.add(warnKey);
          this.logger.warn(
            `Calculated field "${name}" on device ${deviceId} collides with a ` +
              'key the device itself reported — the measured value is kept and ' +
              'the calculated one is discarded. Rename the calculated field.',
          );
        }
        continue;
      }

      safe[name] = value;
    }

    return safe;
  }

  /**
   * Flatten a reading to the spelling an expression names.
   *
   * The ThingsBoard envelope `{ts, values:{temperature: 45}}` is hoisted so a
   * formula can say `temperature`, exactly as
   * `ProfileAlarmService.normaliseTelemetry()` does for alarm rule keys — if
   * the two disagreed, an alarm and a calculated field reading "the same" key
   * would be reading different things.
   *
   * Nested objects also appear under their dotted path, so `values.temperature`
   * resolves. A dotted key is not a valid identifier in an expression, but it
   * is reachable through the `telemetry` namespace as `telemetry['a.b']`.
   */
  private normaliseTelemetry(raw: Record<string, any>): Record<string, any> {
    const source =
      raw && typeof raw.values === 'object' && raw.values !== null
        ? { ...raw, ...raw.values }
        : (raw ?? {});

    const flat: Record<string, any> = {};
    const walk = (object: Record<string, any>, prefix: string): void => {
      for (const [key, value] of Object.entries(object)) {
        const path = prefix ? `${prefix}.${key}` : key;
        if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
          flat[path] = value;
          walk(value as Record<string, any>, path);
        } else {
          flat[path] = value;
        }
      }
    };
    walk(source, '');
    return flat;
  }

  /**
   * Insert with an oldest-first bound.
   *
   * `Map` iterates in insertion order, so the first keys are the least
   * recently *added* — not the least recently used. That is a deliberate
   * simplification: entries expire on a 30–60s TTL anyway, so true LRU
   * accounting would cost more than it saves. The bound is there to stop the
   * Map growing without limit as devices come and go, not to maximise hits.
   */
  private remember<T>(cache: Map<string, T>, key: string, value: T): void {
    if (cache.size >= this.maxEntries && !cache.has(key)) {
      const evict = Math.max(1, Math.floor(this.maxEntries * 0.1));
      let removed = 0;
      for (const existing of cache.keys()) {
        cache.delete(existing);
        if (++removed >= evict) break;
      }
    }
    cache.set(key, value);
  }
}
