import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Telemetry } from './entities/telemetry.entity';
import { Subscription } from '@modules/subscriptions/entities/subscription.entity';
import { TelemetryRollupService } from './telemetry-rollup.service';
import {
  resolveTelemetryMaintenanceConfig,
  TelemetryMaintenanceConfig,
} from './telemetry-maintenance.config';

export type RetentionSource = 'subscription' | 'fallback' | 'unset';

export interface ResolvedRetention {
  tenantId: string;
  /** Effective days to keep, or null when the tenant must not be swept. */
  days: number | null;
  source: RetentionSource;
  plan?: string;
  /** Present when `days` is null — why the tenant is being left alone. */
  reason?: string;
}

export interface RetentionSweepResult {
  tenantId: string;
  retentionDays: number | null;
  deleted: number;
  batches: number;
  /** True when the batch cap was reached and rows older than the cutoff remain. */
  moreRemaining: boolean;
  rollupsPruned: { hour: number; coarse: number };
  skipped?: string;
}

/**
 * The retention sweep: deletes telemetry a tenant is no longer entitled to
 * keep, and only that.
 *
 * ── Where the number comes from ──────────────────────────────────────────
 * `Subscription.limits.dataRetentionDays`, which already exists on every plan
 * (FREE 7 / STARTER 30 / PROFESSIONAL 90 / ENTERPRISE 365). Because `limits` is
 * a per-tenant jsonb column, raising one tenant's retention without moving them
 * to another plan is already supported — that is the per-tenant override, and
 * `TelemetryRetentionService` deliberately adds no second place to configure
 * the same thing.
 *
 * ── Why "unset" means "do not delete" ───────────────────────────────────
 * A tenant with no subscription row, or a `limits` blob with no
 * `dataRetentionDays`, has never been told how long to keep data. Deleting
 * telemetry is irreversible, so the only safe reading of "unset" is "leave it
 * alone". `TELEMETRY_RETENTION_FALLBACK_DAYS` exists for operators who want a
 * platform default, and defaults to 0, meaning skip. A configured 0 or a
 * negative number is likewise a skip, not "delete everything" —
 * `TELEMETRY_RETENTION_MIN_DAYS` (default 1) is the floor and anything under it
 * is refused and logged.
 *
 * ── Why batches ─────────────────────────────────────────────────────────
 * A single `DELETE FROM telemetry WHERE timestamp < cutoff` — which is what
 * `TelemetryService.deleteOldData()` and the old `cleanup-telemetry` processor
 * both did — is one transaction over every expired row of every tenant. On a
 * table that this module exists because it grows without bound, that is a
 * multi-million-row write holding row locks and bloating WAL, and it is
 * all-or-nothing: killed halfway, it rolls back and has achieved nothing.
 * Here each batch is its own autocommitted statement, so progress survives,
 * and `FOR UPDATE SKIP LOCKED` means two sweeps running at once simply divide
 * the work rather than blocking on each other.
 */
@Injectable()
export class TelemetryRetentionService {
  private readonly logger = new Logger(TelemetryRetentionService.name);
  private readonly config: TelemetryMaintenanceConfig;

  constructor(
    @InjectRepository(Telemetry)
    private readonly telemetryRepository: Repository<Telemetry>,
    // Read-only, and registered via TypeOrmModule.forFeature rather than by
    // importing SubscriptionsModule — the same way FloorPlansService reads
    // subscription limits without creating a module cycle.
    @InjectRepository(Subscription)
    private readonly subscriptionRepository: Repository<Subscription>,
    private readonly rollupService: TelemetryRollupService,
    configService: ConfigService,
  ) {
    this.config = resolveTelemetryMaintenanceConfig((key) =>
      configService.get(key),
    );
  }

  get settings(): TelemetryMaintenanceConfig {
    return this.config;
  }

  // ════════════════════════════════════════════════════════════════════════
  // RESOLUTION
  // ════════════════════════════════════════════════════════════════════════

  async resolveRetention(tenantId: string): Promise<ResolvedRetention> {
    const subscription = await this.subscriptionRepository.findOne({
      where: { tenantId },
      select: ['id', 'tenantId', 'plan', 'limits'],
    });

    const configured = Number(subscription?.limits?.dataRetentionDays);
    const hasConfigured = Number.isFinite(configured);

    // -1 is this codebase's "unlimited" for every other limit key
    // (SubscriptionLimits documents it that way). For retention, unlimited
    // means never delete.
    if (hasConfigured && configured < 0) {
      return {
        tenantId,
        days: null,
        source: 'subscription',
        plan: subscription?.plan,
        reason: 'retention is unlimited (-1)',
      };
    }

    const days =
      hasConfigured && configured > 0
        ? configured
        : this.config.fallbackRetentionDays;
    const source: RetentionSource =
      hasConfigured && configured > 0
        ? 'subscription'
        : this.config.fallbackRetentionDays > 0
          ? 'fallback'
          : 'unset';

    if (!days || days <= 0) {
      return {
        tenantId,
        days: null,
        source: 'unset',
        plan: subscription?.plan,
        reason: subscription
          ? 'subscription limits have no positive dataRetentionDays and no fallback is configured'
          : 'tenant has no subscription row and no fallback is configured',
      };
    }

    if (days < this.config.minRetentionDays) {
      return {
        tenantId,
        days: null,
        source,
        plan: subscription?.plan,
        reason: `configured retention ${days}d is below TELEMETRY_RETENTION_MIN_DAYS (${this.config.minRetentionDays})`,
      };
    }

    return { tenantId, days, source, plan: subscription?.plan };
  }

  /**
   * Tenants worth considering for a sweep.
   *
   * Subscriptions are the authoritative list: a tenant with no subscription row
   * is skipped anyway, so enumerating a (small, one-row-per-tenant) table beats
   * a `DISTINCT tenantId` over the telemetry table. The telemetry side is only
   * consulted when an operator has set a platform fallback, which is the one
   * case where a subscription-less tenant can be swept — and even then it is an
   * indexed range scan over rows already past the fallback cutoff, not a full
   * table scan.
   */
  async candidateTenantIds(): Promise<string[]> {
    const fromSubscriptions: Array<{ tenantId: string }> =
      await this.subscriptionRepository.query(
        `SELECT DISTINCT "tenantId" FROM subscriptions WHERE "deleted_at" IS NULL`,
      );
    const ids = new Set(
      fromSubscriptions.map((r) => r.tenantId).filter(Boolean),
    );

    if (this.config.fallbackRetentionDays > 0) {
      const fromTelemetry: Array<{ tenantId: string }> =
        await this.telemetryRepository.query(
          `SELECT DISTINCT "tenantId"
             FROM telemetry
            WHERE "timestamp" < now()::timestamp - ($1 || ' days')::interval`,
          [String(this.config.fallbackRetentionDays)],
        );
      fromTelemetry.forEach((r) => r.tenantId && ids.add(r.tenantId));
    }

    return [...ids];
  }

  // ════════════════════════════════════════════════════════════════════════
  // SWEEP
  // ════════════════════════════════════════════════════════════════════════

  async sweepTenant(tenantId: string): Promise<RetentionSweepResult> {
    const empty: RetentionSweepResult = {
      tenantId,
      retentionDays: null,
      deleted: 0,
      batches: 0,
      moreRemaining: false,
      rollupsPruned: { hour: 0, coarse: 0 },
    };

    if (!this.config.retentionEnabled) {
      return { ...empty, skipped: 'TELEMETRY_RETENTION_ENABLED=false' };
    }

    const resolved = await this.resolveRetention(tenantId);
    if (resolved.days === null) {
      this.logger.debug(
        `Retention sweep skipped for tenant ${tenantId}: ${resolved.reason}`,
      );
      return { ...empty, skipped: resolved.reason };
    }

    const retentionDays = resolved.days;
    let deleted = 0;
    let batches = 0;
    let moreRemaining = false;

    for (let i = 0; i < this.config.retentionMaxBatches; i++) {
      const affected = await this.deleteBatch(tenantId, retentionDays);
      batches++;
      deleted += affected;

      if (affected < this.config.retentionBatchSize) {
        moreRemaining = false;
        break;
      }
      // A full batch means there is very probably more; if this was the last
      // permitted batch, say so rather than pretending the sweep finished.
      moreRemaining = i === this.config.retentionMaxBatches - 1;
    }

    const rollupsPruned = await this.rollupService.pruneRollups(
      tenantId,
      retentionDays,
    );

    if (deleted > 0 || rollupsPruned.hour > 0 || rollupsPruned.coarse > 0) {
      this.logger.log(
        `Retention sweep tenant=${tenantId} plan=${resolved.plan ?? 'none'} ` +
          `keep=${retentionDays}d (${resolved.source}) ` +
          `deleted=${deleted} rows in ${batches} batch(es) ` +
          `rollups=-${rollupsPruned.hour}h/-${rollupsPruned.coarse}coarse` +
          (moreRemaining ? ' — batch cap reached, continuing next run' : ''),
      );
    }

    return {
      tenantId,
      retentionDays,
      deleted,
      batches,
      moreRemaining,
      rollupsPruned,
    };
  }

  /**
   * One bounded delete.
   *
   * The cutoff is computed by Postgres, from the same clock and the same
   * `timestamp without time zone` domain the rows were written in. Subtracting
   * days in Node and comparing against these columns is off by the server's UTC
   * offset — harmless for a 90-day cutoff, not harmless for a 1-day one.
   */
  private async deleteBatch(
    tenantId: string,
    retentionDays: number,
  ): Promise<number> {
    const result = await this.telemetryRepository.query(
      `DELETE FROM telemetry
        WHERE id IN (
          SELECT id FROM telemetry
           WHERE "tenantId" = $1
             AND "timestamp" < now()::timestamp - ($2 || ' days')::interval
           ORDER BY "timestamp" ASC
           LIMIT $3
           FOR UPDATE SKIP LOCKED
        )`,
      [tenantId, String(retentionDays), this.config.retentionBatchSize],
    );
    return Array.isArray(result) ? Number(result[1] ?? 0) : 0;
  }

  /**
   * What a sweep would do, without doing it. Backs
   * `GET /telemetry/maintenance/status`.
   */
  async preview(tenantId: string): Promise<{
    retention: ResolvedRetention;
    totalRows: number;
    expiredRows: number;
    oldest: string | null;
    newest: string | null;
    cutoff: string | null;
    batchSize: number;
    maxBatches: number;
    enabled: boolean;
  }> {
    const retention = await this.resolveRetention(tenantId);

    // `::text`, not a JS Date: `telemetry.timestamp` is `timestamp without time
    // zone`, and node-postgres parses it in the process's local zone — so a
    // Date here would be reported to the operator shifted by the server's UTC
    // offset, against a cutoff that Postgres computes in its own.
    const [counts] = await this.telemetryRepository.query(
      `SELECT count(*)::bigint        AS total,
              min("timestamp")::text  AS oldest,
              max("timestamp")::text  AS newest
         FROM telemetry WHERE "tenantId" = $1`,
      [tenantId],
    );

    let expiredRows = 0;
    let cutoff: string | null = null;
    if (retention.days !== null) {
      const [expired] = await this.telemetryRepository.query(
        `SELECT count(*)::bigint AS expired,
                (now()::timestamp - ($2 || ' days')::interval)::text AS cutoff
           FROM telemetry
          WHERE "tenantId" = $1
            AND "timestamp" < now()::timestamp - ($2 || ' days')::interval`,
        [tenantId, String(retention.days)],
      );
      expiredRows = Number(expired?.expired) || 0;
      cutoff = expired?.cutoff ?? null;
    }

    return {
      retention,
      totalRows: Number(counts?.total) || 0,
      expiredRows,
      oldest: counts?.oldest ?? null,
      newest: counts?.newest ?? null,
      cutoff,
      batchSize: this.config.retentionBatchSize,
      maxBatches: this.config.retentionMaxBatches,
      enabled: this.config.retentionEnabled,
    };
  }
}
