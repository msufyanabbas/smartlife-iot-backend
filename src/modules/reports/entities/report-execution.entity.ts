import { Entity, Column, Index, ManyToOne, JoinColumn } from 'typeorm';
import { BaseEntity } from '@common/entities/base.entity';
import type { Relation } from 'typeorm';
import type { Tenant } from '../../tenants/entities/tenant.entity';
import type { ReportTemplate } from './report-template.entity';
import {
  ReportExecutionStatus,
  ReportFormat,
  ReportTrigger,
} from '../report.enum';

/**
 * One generated report.
 *
 * This is what backs the "Recent Exports" list, and it is the reason a
 * scheduled report can be delivered as a link rather than nothing: the
 * artefact is written to disk and `GET /reports/executions/:id/download`
 * serves it back.
 *
 * Failures are recorded as rows too, with `status: FAILED` and `error` set. A
 * scheduled report that silently stopped producing output is the failure mode
 * worth being able to see.
 */
@Entity('report_executions')
@Index(['tenantId', 'createdAt'])
@Index(['reportTemplateId', 'createdAt'])
export class ReportExecution extends BaseEntity {
  @Column({ type: 'uuid' })
  tenantId: string;

  @ManyToOne('Tenant')
  @JoinColumn({ name: 'tenantId' })
  tenant: Relation<Tenant>;

  /**
   * `onDelete: 'CASCADE'` so deleting a template takes its execution rows with
   * it. Template deletion is a SOFT delete, so the cascade only fires on a hard
   * delete; `ReportsService.remove()` therefore deletes the artefact files and
   * soft-removes the executions itself.
   */
  @Column({ type: 'uuid' })
  reportTemplateId: string;

  @ManyToOne('ReportTemplate', { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'reportTemplateId' })
  reportTemplate?: Relation<ReportTemplate>;

  /** Copied, not joined: a template can be renamed and the history should still read. */
  @Column({ type: 'varchar' })
  reportName: string;

  @Column({ type: 'varchar' })
  trigger: ReportTrigger;

  @Column({ type: 'varchar' })
  format: ReportFormat;

  @Column({ type: 'varchar' })
  status: ReportExecutionStatus;

  /**
   * Who or what the run was attributed to. For a MANUAL run the caller; for a
   * SCHEDULE run the template's `userId`, which is the identity the AUDIT_LOG
   * source's role-based filtering was applied with.
   */
  @Column({ type: 'varchar', nullable: true })
  runAsUserId?: string | null;

  @Column({ type: 'int', default: 0 })
  rowCount: number;

  @Column({ type: 'int', default: 0 })
  byteSize: number;

  @Column({ type: 'int', default: 0 })
  durationMs: number;

  /** Download file name offered to the browser. */
  @Column({ type: 'varchar', nullable: true })
  fileName?: string | null;

  /**
   * Path on disk, relative to the uploads root. NULL for a failed run, and for
   * a preview, which is never stored.
   */
  @Column({ type: 'varchar', nullable: true })
  filePath?: string | null;

  @Column({ type: 'text', nullable: true })
  error?: string | null;

  /** Addresses a scheduled run actually sent to, and whether each send succeeded. */
  @Column({ type: 'jsonb', nullable: true })
  delivery?: {
    recipients: string[];
    sent: string[];
    failed: string[];
    /** Stated because MailService's EmailOptions has no attachment support. */
    note: string;
  } | null;

  /**
   * The resolved window and any snapping the source imposed, so a reader can
   * tell what period the numbers describe without re-deriving it from a
   * relative definition.
   */
  @Column({ type: 'jsonb', nullable: true })
  period?: {
    from: string;
    to: string;
    requestedHours?: number;
    snappedTo?: string;
  } | null;
}
