// src/modules/audit/audit-retention.service.ts
import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { LessThan, Repository } from 'typeorm';
import { Cron } from '@nestjs/schedule';
import { AuditLog } from './entities/audit-log.entity';

/**
 * ─────────────────────────────────────────────────────────────────────────────
 * Audit log retention
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * `audit_logs` had no retention of any kind. The only way to remove a row was
 * `DELETE /audit/cleanup/:daysOld`, a manual SUPER_ADMIN call, so the table
 * grew at the rate state-changing requests arrive — forever. With `@Audit()`
 * now on ~380 routes that rate is far higher than it was, which makes a sweep
 * a prerequisite for the coverage rather than a nice-to-have.
 *
 * `AUDIT_RETENTION_DAYS` defaults to **365**, deliberately much longer than
 * `INTEGRATION_EVENT_RETENTION_DAYS` (14): an integration event answers "did
 * the 14:03 reading reach AWS", while an audit row answers "who deleted this
 * tenant", and the second question is asked months later. A year also clears
 * the usual twelve-month window a compliance review asks for.
 *
 * `0` disables the sweep entirely, for a deployment that ships rows to an
 * external SIEM and wants the table immutable.
 *
 * ── Note for the distributed-lock work ──────────────────────────────────────
 *
 * **This cron is safe to run unlocked on every replica and does not need to be
 * on the lock allow-list.** `prune()` is a single
 * `DELETE FROM audit_logs WHERE timestamp < :cutoff` with no read-then-write
 * step and no per-row side effects, so it is idempotent: N replicas firing at
 * 03:30 produce one effective delete, and the losers report
 * `affected: 0`. Taking a lock here would be correct but pointless. If the
 * sweep ever grows a second step — archiving rows before deleting them, or
 * emitting a notification — that stops being true and it must be locked.
 */
@Injectable()
export class AuditRetentionService {
  private readonly logger = new Logger(AuditRetentionService.name);

  private readonly retentionDays: number;

  constructor(
    @InjectRepository(AuditLog)
    private readonly auditRepository: Repository<AuditLog>,
    private readonly configService: ConfigService,
  ) {
    const raw = this.configService.get<string | number>(
      'AUDIT_RETENTION_DAYS',
    );
    const parsed = Number(raw ?? 365);
    // A non-numeric or negative value falls back to the default rather than
    // becoming a cutoff in the future, which would delete the whole table.
    this.retentionDays =
      Number.isFinite(parsed) && parsed >= 0 ? Math.floor(parsed) : 365;
  }

  /** Exposed for the coverage guard and for operational reporting. */
  getRetentionDays(): number {
    return this.retentionDays;
  }

  /**
   * Delete audit rows older than the retention window.
   *
   * Runs at 03:30 rather than on the hour: `IntegrationEventsService.prune()`
   * already holds 03:00 and two unbounded DELETEs on the same connection pool
   * at the same minute is a self-inflicted latency spike.
   */
  @Cron('30 3 * * *')
  async prune(): Promise<void> {
    if (this.retentionDays === 0) {
      return; // retention disabled — see the class comment
    }

    const cutoff = new Date(
      Date.now() - this.retentionDays * 24 * 60 * 60 * 1000,
    );

    try {
      // Filtered on `timestamp`, the column every audit query and index uses
      // (@Index(['tenantId', 'timestamp'])), not on BaseEntity's `createdAt` —
      // `deleteOld()` already uses `timestamp` and the two must agree, or a
      // manual cleanup and the cron would disagree about a row's age.
      const result = await this.auditRepository.delete({
        timestamp: LessThan(cutoff),
      });

      if (result.affected) {
        this.logger.log(
          `Pruned ${result.affected} audit log row(s) older than ${this.retentionDays} day(s)`,
        );
      }
    } catch (error: any) {
      // A failed sweep must not crash the scheduler; the next run retries and
      // the only cost of a miss is a day of extra rows.
      this.logger.warn(`Audit log prune failed: ${error.message}`);
    }
  }
}
