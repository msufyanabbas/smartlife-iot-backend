import { Entity, Column, Index, ManyToOne, JoinColumn } from 'typeorm';
import { BaseEntity } from '@common/entities/base.entity';
import type { Relation } from 'typeorm';
import type { Tenant } from '../../tenants/entities/tenant.entity';
import {
  ReportDateRangeMode,
  ReportEntityKind,
  ReportFormat,
  ReportGroupingInterval,
} from '../report.enum';

/**
 * What a report covers. Validated against `REPORT_SOURCES[entity]` on write, so
 * a saved template cannot name a column its source does not produce or a
 * filter it does not apply.
 */
export interface ReportDefinition {
  /** Which row source answers this report. */
  entity: ReportEntityKind;

  dateRange: {
    mode: ReportDateRangeMode;
    /** RELATIVE: hours back from the moment of generation. */
    lastHours?: number;
    /** ABSOLUTE: ISO instants. */
    from?: string;
    to?: string;
  };

  /**
   * Column keys, in output order. Omitted means the source's
   * `defaultColumns`. Every key must exist in the source manifest.
   */
  columns?: string[];

  filters?: {
    deviceIds?: string[];
    deviceStatus?: string[];
    deviceType?: string[];
    assetIds?: string[];
    customerId?: string;
    /** Required by DEVICE_TELEMETRY — one series per (device, key). */
    telemetryKeys?: string[];
    alarmSeverity?: string[];
    alarmStatus?: string[];
    auditAction?: string;
    auditEntityType?: string;
    auditSuccess?: boolean;
    search?: string;
  };

  grouping?: {
    interval: ReportGroupingInterval;
  };

  /**
   * Hard row cap. Defaults to `REPORT_DEFAULT_ROW_LIMIT`; a report is a file a
   * human opens, and an uncapped telemetry report over 90 days is a
   * multi-gigabyte response that also pins a connection for minutes.
   */
  limit?: number;
}

export interface ReportSchedule {
  enabled: boolean;
  /** Standard 5-field cron, parsed by `cron-parser` — same library SchedulesModule uses. */
  cron: string;
  /** IANA zone, e.g. `Asia/Riyadh`. Defaults to UTC. */
  timezone?: string;
  /** Email addresses. An enabled schedule with no recipients is refused. */
  recipients: string[];
  /** Format for scheduled runs; falls back to the template's own `format`. */
  format?: ReportFormat;
}

/**
 * A saved report definition.
 *
 * `POST /reports/:id/generate` runs it against real data through the platform's
 * existing query services (see `REPORT_SOURCES`), stores the artefact and
 * records a `ReportExecution`. A template whose `schedule.enabled` is true is
 * also picked up by `ReportSchedulerService` on its per-minute tick and
 * emailed to `schedule.recipients` — that path is wired and does fire; see the
 * `nextRunAt` note below.
 */
@Entity('report_templates')
@Index(['tenantId', 'type'])
@Index(['tenantId', 'enabled'])
// Every scoped read is (tenantId, customerId) — the list, the detail, the
// statistics and the execution join all narrow on both.
@Index(['tenantId', 'customerId'])
// The scheduler's only query is "which templates are due?", which is this
// index: a partial-free composite on (enabled, nextRunAt) ordered by due time.
@Index(['enabled', 'nextRunAt'])
export class ReportTemplate extends BaseEntity {
  @Column({ type: 'uuid' })
  tenantId: string;

  @ManyToOne('Tenant')
  @JoinColumn({ name: 'tenantId' })
  tenant: Relation<Tenant>;

  /**
   * Which customer the template belongs to, or NULL for a tenant-wide one.
   *
   * The module had no customer dimension at all, so every customer-scoped
   * caller of `GET /reports` saw every template of its tenant — including
   * templates written for a sibling customer, whose `definition.filters`
   * carry that customer's device and asset ids.
   *
   * NULL is a real and common value, not a gap: a template saved by a tenant
   * admin with no customer named is tenant-wide, and every customer of the
   * tenant may run it. That is why the read path asks for
   * `includeUnassigned: true` — the one place in the codebase that does.
   *
   * No FK. The column is nullable and set by hand on a write; a hard-deleted
   * customer must not take the tenant's templates with it, and the read is a
   * plain predicate either way.
   */
  @Column({ type: 'uuid', nullable: true })
  customerId?: string | null;

  /**
   * Who saved it. No relation and no foreign key: a report template is a
   * tenant asset that outlives whoever created it, and an FK would make
   * removing that user either fail or take their colleagues' templates with
   * it — the same call `rule_chain_templates.userId` makes.
   *
   * It is also the identity a SCHEDULED run uses for the AUDIT_LOG source,
   * whose backing service applies role-based filtering from the caller. That
   * is recorded on each execution row so a scheduled report's scope is never
   * a mystery.
   */
  @Column({ type: 'varchar', nullable: true })
  userId?: string | null;

  @Column()
  name: string;

  @Column({ type: 'text', nullable: true })
  description?: string;

  /**
   * Free-text grouping for the template gallery ("Operations", "Compliance").
   * Not an enum, so a tenant can file a report under a heading the platform
   * never anticipated without a migration.
   */
  @Column({ type: 'varchar', default: 'General' })
  type: string;

  /** The declarative query. Validated against the source catalogue on write. */
  @Column({ type: 'jsonb' })
  definition: ReportDefinition;

  @Column({ type: 'varchar', default: ReportFormat.CSV })
  format: ReportFormat;

  /**
   * NULL means "not scheduled". A nullable column whose property is a union
   * needs an explicit `type` or TypeORM reflects `Object` and
   * `DataSource.initialize` throws — which takes the whole application down,
   * not just this entity (CLAUDE.md §4e).
   */
  @Column({ type: 'jsonb', nullable: true })
  schedule?: ReportSchedule | null;

  /**
   * When the scheduler will next run this template, derived from
   * `schedule.cron` on every write and after every scheduled run.
   *
   * Derived, never client-supplied — the same contract `Schedule.nextRunAt`
   * has. NULL means "nothing scheduled", which is also what an invalid cron
   * leaves behind, so `ReportsService` rejects an unparseable expression at
   * write time rather than letting a template sit silently never firing.
   */
  @Column({ type: 'timestamp', nullable: true })
  nextRunAt?: Date | null;

  @Column({ default: true })
  enabled: boolean;

  @Column({ type: 'timestamp', nullable: true })
  lastGeneratedAt?: Date | null;

  @Column({ type: 'int', default: 0 })
  generationCount: number;

  @Column({ type: 'text', nullable: true })
  lastError?: string | null;

  @Column({ type: 'jsonb', nullable: true })
  additionalInfo?: Record<string, any>;
}
