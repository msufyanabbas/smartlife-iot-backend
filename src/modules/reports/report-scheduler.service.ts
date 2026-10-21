import { Injectable, Logger } from '@nestjs/common';
import { CronExpression } from '@nestjs/schedule';
import { DistributedCron } from '@/lib/cluster/distributed-cron.decorator';
import { InjectRepository } from '@nestjs/typeorm';
import { LessThanOrEqual, Repository } from 'typeorm';
import { MailService } from '@modules/mail/mail.service';
import type { EmailAttachment } from '@modules/mail/interfaces/mail.interface';
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
 * With several application instances, each would tick and each would run the
 * same due template — duplicate generation AND duplicate emails. The tick is
 * now wrapped in a Redis lock (`@DistributedCron`), so one replica runs it and
 * the others skip. `REPORT_SCHEDULER_ENABLED` (default `true`) is retained as
 * the blunt per-instance off switch; it is no longer required for correctness
 * on a scaled deploy.
 *
 * ── Delivery ──────────────────────────────────────────────────────────────
 * The generated artefact IS attached. `MailService.sendEmail()` now takes an
 * `attachments` array (nodemailer handles the MIME multipart itself), so the
 * recipient gets the CSV / XLSX / PDF / JSON file rather than a link they have
 * to be logged in to follow.
 *
 * It is attached only while it fits under `MailService.maxAttachmentBytes()`
 * (`MAIL_MAX_ATTACHMENT_BYTES`, default 10 MB). Past that the email falls back
 * to the download link and SAYS the file was too large. That fallback is not
 * decoration: a report is a tenant-defined query with a 50,000-row ceiling, and
 * handing a multi-tens-of-megabyte message to an SMTP relay — base64 inflates
 * it a further ~37% — either gets rejected after the whole transfer, times out
 * mid-socket, or queues every other email on the platform (verification,
 * password reset, alarm notification) behind a report nobody is watching.
 *
 * Either way the email still carries the summary and the first 20 rows inline,
 * and `execution.delivery.note` records which of the two happened.
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

  // Locked across replicas: the `running` Set above is per-process, so it stops
  // one instance overlapping itself and does nothing about three instances
  // generating and emailing the same report at the same second.
  // 300s because generating a report is a real query plus a file write plus one
  // SMTP send per recipient; the holder renews the TTL past that if needed.
  @DistributedCron(CronExpression.EVERY_MINUTE, {
    name: 'report-schedule-tick',
    lockTtl: 300,
  })
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
        // The rendered bytes are already in hand from the run — `deliver()`
        // attaches these rather than reading the artefact back off disk, so a
        // storage volume that has rotated the file cannot turn a successful
        // run into a failed delivery.
        await this.deliver(template, result.execution, result.rowSet, {
          content: result.content,
          fileName: result.fileName,
          mimeType: result.mimeType,
        });
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
    artefact: { content: Buffer; fileName: string; mimeType: string },
  ): Promise<void> {
    const recipients = template.schedule?.recipients ?? [];
    if (recipients.length === 0) return;

    const attachment: EmailAttachment = {
      filename: artefact.fileName,
      content: artefact.content,
      contentType: artefact.mimeType,
    };

    // Decided ONCE, before the body is built, so the email text and what is
    // actually attached can never disagree. Asking the mail service rather
    // than hardcoding a number keeps the cap in one place.
    const cap = this.mailService.maxAttachmentBytes();
    const bytes = artefact.content.byteLength;
    const attach = bytes <= cap;

    if (!attach) {
      this.logger.warn(
        `Report "${template.name}" is ${bytes} bytes, over the ${cap}-byte ` +
          'email attachment cap — sending the download link instead. Raise ' +
          'MAIL_MAX_ATTACHMENT_BYTES if the relay accepts more, or narrow the ' +
          'report with a device filter or a lower row limit.',
      );
    }

    const subject = `${template.name} — ${execution.rowCount} row(s)`;
    const html = this.buildEmail(template, execution, rowSet, {
      attached: attach,
      bytes,
      cap,
    });

    const sent: string[] = [];
    const failed: string[] = [];

    for (const to of recipients) {
      // sendEmail() returns false (and logs) when SMTP is not configured, the
      // send fails, or the attachment is over its own cap; it does not throw.
      // Recording both lists means "the report ran but nobody received it" is
      // visible on the execution row.
      const ok = await this.mailService
        .sendEmail({
          to,
          subject,
          html,
          ...(attach && { attachments: [attachment] }),
        })
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
          attached: attach,
          attachmentBytes: attach ? bytes : 0,
          note: attach
            ? `${artefact.fileName} (${bytes} bytes, ${artefact.mimeType}) was ` +
              'attached to each email. It is also at ' +
              `/reports/executions/${execution.id}/download.`
            : `The file was NOT attached: ${bytes} bytes exceeds the ` +
              `${cap}-byte cap (MAIL_MAX_ATTACHMENT_BYTES). Download it from ` +
              `/reports/executions/${execution.id}/download.`,
        },
      },
    );

    this.logger.log(
      `Report "${template.name}" delivered to ${sent.length}/${recipients.length} recipient(s)` +
        (attach ? ` with ${artefact.fileName} attached` : ' as a link only') +
        (failed.length ? ` — failed: ${failed.join(', ')}` : ''),
    );
  }

  private buildEmail(
    template: ReportTemplate,
    execution: ReportExecution,
    rowSet: ReportRowSet,
    delivery: { attached: boolean; bytes: number; cap: number },
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
          ${
            delivery.attached
              ? `<code>${escape(execution.fileName)}</code> is attached to this email ` +
                `(${delivery.bytes} bytes). It is also available from ` +
                `<code>/reports/executions/${execution.id}/download</code>.`
              : `<strong>The file is not attached:</strong> it is ${delivery.bytes} bytes, ` +
                `over this platform's ${delivery.cap}-byte email attachment limit. ` +
                `Download <code>${escape(execution.fileName)}</code> from ` +
                `<code>/reports/executions/${execution.id}/download</code>.`
          }
        </p>
      </div>`;
  }
}
