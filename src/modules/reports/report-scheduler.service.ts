import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { InjectRepository } from '@nestjs/typeorm';
import { LessThanOrEqual, Repository } from 'typeorm';
import { MailService } from '@modules/mail/mail.service';
import { ReportTemplate } from './entities/report-template.entity';
import { ReportExecution } from './entities/report-execution.entity';
import { ReportsService } from './reports.service';
import { ReportTrigger } from './report.enum';
import type { ReportRowSet } from './report-generator.service';

/** Rows embedded in the notification email. Beyond this, read the file. */
const EMAIL_PREVIEW_ROWS = 20;

/**
 * Runs scheduled reports.
 *
 * ── Why a due-time tick and not one CronJob per template ──────────────────
 * `ScheduleCronService` registers a live `CronJob` per schedule row, which
 * needs a registry, a boot-time reconciliation and an invalidation hook on
 * every write. A report runs at most a few times a day, so the cheaper and
 * harder-to-break design is a single per-minute tick over
 * `WHERE enabled AND nextRunAt <= now()`, with `nextRunAt` recomputed by
 * `ReportsService` on every write and here after every run. The index
 * `(enabled, nextRunAt)` on `report_templates` exists for exactly this query.
 *
 * A consequence worth stating: with several application instances, each would
 * tick and each would run the same due template. `REPORT_SCHEDULER_ENABLED`
 * (default `true`) is the switch that makes a multi-instance deploy able to
 * nominate one runner, and the log line on startup says which it is. There is
 * no distributed lock here.
 *
 * ── Delivery ──────────────────────────────────────────────────────────────
 * `MailService.sendEmail()` takes `{to, subject, html, text}` and has no
 * attachment field, so the artefact is NOT attached. The email carries the
 * summary, the first 20 rows as a table, and the download path. That is stated
 * on `GET /reports/sources` too, rather than letting a user assume a file will
 * arrive.
 */
@Injectable()
export class ReportSchedulerService {
  private readonly logger = new Logger(ReportSchedulerService.name);

  /** Templates mid-run, so a slow report cannot pile ticks on top of itself. */
  private readonly running = new Set<string>();

  private readonly enabled =
    (process.env.REPORT_SCHEDULER_ENABLED ?? 'true').toLowerCase() !== 'false';

  constructor(
    @InjectRepository(ReportTemplate)
    private readonly templateRepo: Repository<ReportTemplate>,
    @InjectRepository(ReportExecution)
    private readonly executionRepo: Repository<ReportExecution>,
    private readonly reportsService: ReportsService,
    private readonly mailService: MailService,
  ) {
    this.logger.log(
      this.enabled
        ? 'Report scheduler enabled — ticking every minute'
        : 'Report scheduler DISABLED by REPORT_SCHEDULER_ENABLED=false',
    );
  }

  @Cron(CronExpression.EVERY_MINUTE, { name: 'report-schedule-tick' })
  async tick(): Promise<void> {
    if (!this.enabled) return;

    let due: ReportTemplate[];
    try {
      due = await this.templateRepo.find({
        where: { enabled: true, nextRunAt: LessThanOrEqual(new Date()) },
        order: { nextRunAt: 'ASC' },
        take: 25,
      });
    } catch (err) {
      // A tick must never throw out of the scheduler: @nestjs/schedule logs it
      // and carries on, but an unhandled rejection here is a process-level risk.
      this.logger.error(`Report scheduler tick query failed: ${(err as Error).message}`);
      return;
    }

    for (const template of due) {
      if (this.running.has(template.id)) {
        this.logger.warn(
          `Report "${template.name}" (${template.id}) is still running from a ` +
            'previous tick — skipping this one rather than overlapping',
        );
        continue;
      }
      await this.runOne(template);
    }
  }

  /** Public so a verification script can fire a run without waiting for the minute. */
  async runOne(template: ReportTemplate): Promise<void> {
    this.running.add(template.id);
    try {
      // Re-armed BEFORE the run, so a report that throws does not stay due and
      // get retried every minute until someone notices.
      await this.rearm(template);

      const result = await this.reportsService.run(template.tenantId, template, {
        trigger: ReportTrigger.SCHEDULE,
        format: template.schedule?.format ?? template.format,
      });

      if (result.execution) {
        await this.deliver(template, result.execution, result.rowSet);
      }
    } catch (err) {
      // `ReportsService.run()` has already written a FAILED execution row and
      // set `lastError`, so there is nothing to record here beyond the log.
      this.logger.error(
        `Scheduled report "${template.name}" (${template.id}) failed: ${(err as Error).message}`,
      );
    } finally {
      this.running.delete(template.id);
    }
  }

  private async rearm(template: ReportTemplate): Promise<void> {
    const nextRunAt = this.reportsService.computeNextRun(
      template.schedule,
      template.enabled,
    );
    await this.templateRepo.update({ id: template.id }, { nextRunAt });

    if (!nextRunAt) {
      this.logger.warn(
        `Report "${template.name}" (${template.id}) has no next run — its ` +
          'schedule is disabled or its cron no longer parses. It will not fire again.',
      );
    }
  }

  private async deliver(
    template: ReportTemplate,
    execution: ReportExecution,
    rowSet: ReportRowSet,
  ): Promise<void> {
    const recipients = template.schedule?.recipients ?? [];
    if (recipients.length === 0) return;

    const subject = `${template.name} — ${execution.rowCount} row(s)`;
    const html = this.buildEmail(template, execution, rowSet);

    const sent: string[] = [];
    const failed: string[] = [];

    for (const to of recipients) {
      // sendEmail() returns false (and logs) when SMTP is not configured or the
      // send fails; it does not throw. Recording both lists means "the report
      // ran but nobody received it" is visible on the execution row.
      const ok = await this.mailService
        .sendEmail({ to, subject, html })
        .catch(() => false);
      (ok ? sent : failed).push(to);
    }

    await this.executionRepo.update(
      { id: execution.id },
      {
        delivery: {
          recipients,
          sent,
          failed,
          note:
            'The report file is not attached — MailService.sendEmail() accepts ' +
            `{to, subject, html, text} only. Download it from /reports/executions/${execution.id}/download.`,
        },
      },
    );

    this.logger.log(
      `Report "${template.name}" delivered to ${sent.length}/${recipients.length} recipient(s)` +
        (failed.length ? ` — failed: ${failed.join(', ')}` : ''),
    );
  }

  private buildEmail(
    template: ReportTemplate,
    execution: ReportExecution,
    rowSet: ReportRowSet,
  ): string {
    const escape = (value: unknown): string =>
      String(value ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');

    const preview = rowSet.rows.slice(0, EMAIL_PREVIEW_ROWS);
    const header = rowSet.columns
      .map(
        (c) =>
          `<th style="text-align:left;padding:6px 10px;border-bottom:1px solid #e5e7eb;font-size:12px;color:#374151">${escape(c.label)}</th>`,
      )
      .join('');
    const body = preview
      .map(
        (row) =>
          '<tr>' +
          rowSet.columns
            .map(
              (c) =>
                `<td style="padding:6px 10px;border-bottom:1px solid #f3f4f6;font-size:12px;color:#1a1a2e">${escape(row[c.key])}</td>`,
            )
            .join('') +
          '</tr>',
      )
      .join('');

    const remaining = Math.max(0, execution.rowCount - preview.length);

    return `
      <div style="font-family:Helvetica,Arial,sans-serif;color:#1a1a2e">
        <h2 style="margin:0 0 4px">${escape(template.name)}</h2>
        <p style="margin:0 0 16px;color:#6b7280;font-size:13px">
          ${escape(template.description ?? '')}
        </p>
        <p style="font-size:13px;color:#374151">
          Period ${escape(execution.period?.from)} → ${escape(execution.period?.to)}
          ${execution.period?.snappedTo ? ` (analytics window snapped to ${escape(execution.period.snappedTo)})` : ''}<br/>
          ${execution.rowCount} row(s), ${execution.byteSize} bytes, ${escape(execution.format)}
          ${rowSet.truncated ? '<strong> — truncated at the row limit</strong>' : ''}
        </p>
        ${
          preview.length
            ? `<table style="border-collapse:collapse;width:100%"><thead><tr>${header}</tr></thead><tbody>${body}</tbody></table>`
            : '<p style="font-size:13px;color:#9ca3af">No rows matched this report.</p>'
        }
        ${remaining ? `<p style="font-size:12px;color:#6b7280">…and ${remaining} more row(s) in the full file.</p>` : ''}
        <p style="font-size:12px;color:#6b7280;margin-top:16px">
          The file is not attached to this email. Download
          <code>${escape(execution.fileName)}</code> from
          <code>/reports/executions/${execution.id}/download</code>.
        </p>
      </div>`;
  }
}
