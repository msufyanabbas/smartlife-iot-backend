import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, Not, Repository } from 'typeorm';
import { randomUUID } from 'crypto';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as cronParser from 'cron-parser';
import { PaginatedResponseDto } from '@common/dto/pagination.dto';
import { XLSX_MIME_TYPE } from '@common/utils/xlsx.util';
import { User } from '@modules/users/entities/user.entity';
import {
  ReportDefinition,
  ReportSchedule,
  ReportTemplate,
} from './entities/report-template.entity';
import { ReportExecution } from './entities/report-execution.entity';
import {
  CreateReportTemplateDto,
  GenerateReportDto,
  ReportExecutionQueryDto,
  ReportTemplateQueryDto,
  UpdateReportTemplateDto,
} from './dto/report.dto';
import {
  REPORT_FILTER_KEYS,
  REPORT_SOURCES,
  ReportEntityKind,
  ReportExecutionStatus,
  ReportFormat,
  ReportTrigger,
} from './report.enum';
import {
  REPORT_PREVIEW_ROW_LIMIT,
  ReportGeneratorService,
  ReportRowSet,
} from './report-generator.service';

const DEFAULT_TIMEZONE = 'UTC';

export interface RunReportOptions {
  trigger: ReportTrigger;
  /** Identity the AUDIT_LOG source's role-based filtering is applied with. */
  runAs?: User | null;
  format?: ReportFormat;
  preview?: boolean;
  dateRange?: ReportDefinition['dateRange'];
}

export interface RunReportResult {
  execution: ReportExecution | null;
  rowSet: ReportRowSet;
  content: Buffer;
  mimeType: string;
  fileName: string;
}

@Injectable()
export class ReportsService {
  private readonly logger = new Logger(ReportsService.name);

  /**
   * Artefacts live beside the other uploads, under the same `UPLOAD_PATH` root
   * `ImagesService` uses, so one volume mount covers everything a deploy has
   * to persist.
   */
  private readonly storageRoot = path.resolve(
    process.env.UPLOAD_PATH || './uploads',
    'reports',
  );

  constructor(
    @InjectRepository(ReportTemplate)
    private readonly templateRepo: Repository<ReportTemplate>,
    @InjectRepository(ReportExecution)
    private readonly executionRepo: Repository<ReportExecution>,
    @InjectRepository(User)
    private readonly userRepo: Repository<User>,
    private readonly generator: ReportGeneratorService,
    private readonly dataSource: DataSource,
  ) {}

  // ══════════════════════════════════════════════════════════════════════════
  // CRUD
  // ══════════════════════════════════════════════════════════════════════════

  async create(
    tenantId: string,
    userId: string,
    dto: CreateReportTemplateDto,
  ): Promise<ReportTemplate> {
    const name = dto.name.trim();
    await this.assertNameFree(tenantId, name);

    const definition = this.validateDefinition(
      dto.definition as unknown as ReportDefinition,
    );
    const schedule = this.validateSchedule(dto.schedule as ReportSchedule | undefined);

    const template = this.templateRepo.create({
      tenantId,
      userId,
      createdBy: userId,
      name,
      description: dto.description,
      type: dto.type ?? 'General',
      definition,
      format: dto.format ?? ReportFormat.CSV,
      schedule: schedule ?? null,
      enabled: dto.enabled ?? true,
      additionalInfo: dto.additionalInfo,
      nextRunAt: this.computeNextRun(schedule, dto.enabled ?? true),
    });

    const saved = await this.templateRepo.save(template);
    this.logger.log(
      `Report template "${saved.name}" (${saved.id}) created — ${saved.definition.entity}` +
        (saved.nextRunAt
          ? `, next scheduled run ${saved.nextRunAt.toISOString()}`
          : ', not scheduled'),
    );
    return saved;
  }

  async findAll(
    tenantId: string,
    query: ReportTemplateQueryDto,
  ): Promise<PaginatedResponseDto<ReportTemplate>> {
    const page = query.page ?? 1;
    const limit = query.limit ?? 10;

    const qb = this.templateRepo
      .createQueryBuilder('r')
      .where('r.tenantId = :tenantId', { tenantId });

    if (query.type) qb.andWhere('r.type = :type', { type: query.type });
    if (query.entity) {
      qb.andWhere(`r.definition ->> 'entity' = :entity`, {
        entity: query.entity,
      });
    }
    if (query.scheduled !== undefined) {
      qb.andWhere(
        query.scheduled
          ? `(r.schedule ->> 'enabled')::boolean IS TRUE`
          : `(r.schedule IS NULL OR (r.schedule ->> 'enabled')::boolean IS NOT TRUE)`,
      );
    }
    if (query.search) {
      qb.andWhere('(r.name ILIKE :search OR r.description ILIKE :search)', {
        search: `%${query.search}%`,
      });
    }

    const sortable = new Set([
      'name',
      'type',
      'createdAt',
      'updatedAt',
      'lastGeneratedAt',
      'generationCount',
    ]);
    const sortBy = sortable.has(query.sortBy ?? '') ? query.sortBy! : 'name';

    const [rows, total] = await qb
      .orderBy(`r.${sortBy}`, query.sortOrder ?? 'ASC', 'NULLS LAST')
      .skip((page - 1) * limit)
      .take(limit)
      .getManyAndCount();

    return PaginatedResponseDto.create(rows, page, limit, total);
  }

  async findOne(tenantId: string, id: string): Promise<ReportTemplate> {
    const template = await this.templateRepo.findOne({
      where: { id, tenantId },
    });
    if (!template) throw new NotFoundException(`Report template ${id} not found`);
    return template;
  }

  async update(
    tenantId: string,
    id: string,
    userId: string,
    dto: UpdateReportTemplateDto,
  ): Promise<ReportTemplate> {
    const template = await this.findOne(tenantId, id);

    if (dto.name !== undefined) {
      const name = dto.name.trim();
      if (name !== template.name) await this.assertNameFree(tenantId, name, id);
      template.name = name;
    }
    if (dto.description !== undefined) template.description = dto.description;
    if (dto.type !== undefined) template.type = dto.type;
    if (dto.definition !== undefined) {
      template.definition = this.validateDefinition(
        dto.definition as unknown as ReportDefinition,
      );
    }
    if (dto.format !== undefined) template.format = dto.format;
    if (dto.schedule !== undefined) {
      template.schedule =
        this.validateSchedule(dto.schedule as ReportSchedule | undefined) ?? null;
    }
    if (dto.enabled !== undefined) template.enabled = dto.enabled;
    if (dto.additionalInfo !== undefined) {
      template.additionalInfo = dto.additionalInfo;
    }
    template.updatedBy = userId;

    // Recomputed from the timing fields on every write, never pushed by the
    // client — the same contract `Schedule.nextRunAt` has. Without this a
    // template whose cron was corrected would keep firing on the old one.
    template.nextRunAt = this.computeNextRun(
      template.schedule ?? undefined,
      template.enabled,
    );

    return this.templateRepo.save(template);
  }

  async remove(
    tenantId: string,
    id: string,
    userId: string,
  ): Promise<{ message: string; artefactsDeleted: number }> {
    const template = await this.findOne(tenantId, id);
    const executions = await this.executionRepo.find({
      where: { reportTemplateId: template.id, tenantId },
    });

    let artefactsDeleted = 0;
    for (const execution of executions) {
      if (await this.deleteArtefact(execution)) artefactsDeleted += 1;
    }

    await this.dataSource.transaction(async (manager) => {
      // The FK carries ON DELETE CASCADE, but this is a SOFT delete so the
      // cascade never fires — the execution rows are removed explicitly or they
      // would outlive the template and show up in the export history forever.
      if (executions.length) await manager.softRemove(executions);
      template.deletedBy = userId;
      await manager.softRemove(template);
    });

    return {
      message: `Report template "${template.name}" deleted`,
      artefactsDeleted,
    };
  }

  // ══════════════════════════════════════════════════════════════════════════
  // GENERATION
  // ══════════════════════════════════════════════════════════════════════════

  /**
   * Generate a report from real data, store the artefact, and record the run.
   *
   * A failure is recorded as an execution row with `status: FAILED` rather than
   * only thrown — a scheduled report that quietly stopped producing output is
   * the failure worth being able to see in a list.
   */
  async run(
    tenantId: string,
    template: ReportTemplate,
    options: RunReportOptions,
  ): Promise<RunReportResult> {
    const startedAt = Date.now();
    const generatedAt = new Date();
    const format = options.format ?? template.format ?? ReportFormat.CSV;

    const definition: ReportDefinition = options.dateRange
      ? { ...template.definition, dateRange: options.dateRange }
      : template.definition;

    const runAs =
      options.runAs ?? (await this.resolveRunAsUser(tenantId, template));

    try {
      const rowSet = await this.generator.buildRowSet(tenantId, definition, {
        runAs,
        rowLimit: options.preview ? REPORT_PREVIEW_ROW_LIMIT : undefined,
      });

      const rendered = await this.generator.render(rowSet, format, {
        name: template.name,
        generatedAt,
        tenantId,
      });

      const fileName = this.fileNameFor(template.name, generatedAt, rendered.extension);

      // A preview is never stored: trying a definition must not clutter the
      // export history, and nothing is going to download it later.
      if (options.preview) {
        return {
          execution: null,
          rowSet,
          content: rendered.content,
          mimeType: rendered.mimeType,
          fileName,
        };
      }

      const relativePath = await this.writeArtefact(
        tenantId,
        rendered.extension,
        rendered.content,
      );

      const execution = await this.executionRepo.save(
        this.executionRepo.create({
          tenantId,
          reportTemplateId: template.id,
          reportName: template.name,
          trigger: options.trigger,
          format,
          status: ReportExecutionStatus.SUCCESS,
          runAsUserId: runAs?.id ?? template.userId ?? null,
          rowCount: rowSet.rows.length,
          byteSize: rendered.content.byteLength,
          durationMs: Date.now() - startedAt,
          fileName,
          filePath: relativePath,
          period: {
            from: rowSet.period.from.toISOString(),
            to: rowSet.period.to.toISOString(),
            requestedHours: rowSet.period.requestedHours,
            snappedTo: rowSet.period.snappedTo,
          },
        }),
      );

      await this.templateRepo.update(
        { id: template.id },
        {
          lastGeneratedAt: generatedAt,
          generationCount: () => '"generationCount" + 1',
          lastError: null,
        },
      );

      this.logger.log(
        `Report "${template.name}" generated — ${rowSet.rows.length} row(s), ` +
          `${rendered.content.byteLength} bytes, ${format}, ${Date.now() - startedAt}ms` +
          (rowSet.truncated ? ' (TRUNCATED at the row limit)' : ''),
      );

      return {
        execution,
        rowSet,
        content: rendered.content,
        mimeType: rendered.mimeType,
        fileName,
      };
    } catch (err) {
      const message = (err as Error).message;

      if (!options.preview) {
        await this.executionRepo.save(
          this.executionRepo.create({
            tenantId,
            reportTemplateId: template.id,
            reportName: template.name,
            trigger: options.trigger,
            format,
            status: ReportExecutionStatus.FAILED,
            runAsUserId: runAs?.id ?? template.userId ?? null,
            durationMs: Date.now() - startedAt,
            error: message,
          }),
        );
        await this.templateRepo.update(
          { id: template.id },
          { lastError: message },
        );
      }

      this.logger.error(
        `Report "${template.name}" (${template.id}) failed: ${message}`,
      );
      throw err;
    }
  }

  async generate(
    tenantId: string,
    id: string,
    user: User,
    dto: GenerateReportDto,
  ) {
    const template = await this.findOne(tenantId, id);
    const result = await this.run(tenantId, template, {
      trigger: ReportTrigger.MANUAL,
      runAs: user,
      format: dto.format,
      preview: dto.preview,
      dateRange: dto.dateRange as ReportDefinition['dateRange'] | undefined,
    });

    const includeContent = dto.includeContent ?? true;
    const isText = result.mimeType.startsWith('text/') ||
      result.mimeType.startsWith('application/json');

    return {
      execution: result.execution,
      preview: dto.preview ?? false,
      period: {
        from: result.rowSet.period.from.toISOString(),
        to: result.rowSet.period.to.toISOString(),
        snappedTo: result.rowSet.period.snappedTo ?? null,
      },
      columns: result.rowSet.columns,
      rowCount: result.rowSet.rows.length,
      truncated: result.rowSet.truncated,
      fileName: result.fileName,
      mimeType: result.mimeType,
      byteSize: result.content.byteLength,
      downloadPath: result.execution
        ? `/reports/executions/${result.execution.id}/download`
        : null,
      // CSV and JSON come back inline so the UI can show the result without a
      // second request. A PDF is binary — base64 in a JSON envelope would
      // triple a multi-megabyte file, so it is download-only and this says so.
      content: includeContent && isText ? result.content.toString('utf8') : null,
      contentOmittedReason:
        includeContent && !isText
          ? 'Binary format — fetch it from downloadPath instead.'
          : !includeContent
            ? 'includeContent was false.'
            : null,
    };
  }

  // ══════════════════════════════════════════════════════════════════════════
  // EXECUTIONS
  // ══════════════════════════════════════════════════════════════════════════

  async findExecutions(
    tenantId: string,
    query: ReportExecutionQueryDto,
  ): Promise<PaginatedResponseDto<ReportExecution>> {
    const page = query.page ?? 1;
    const limit = query.limit ?? 10;

    const where: Record<string, unknown> = { tenantId };
    if (query.reportTemplateId) {
      where.reportTemplateId = query.reportTemplateId;
    }

    const [rows, total] = await this.executionRepo.findAndCount({
      where: where as any,
      order: { createdAt: 'DESC' },
      skip: (page - 1) * limit,
      take: limit,
    });

    return PaginatedResponseDto.create(rows, page, limit, total);
  }

  async findExecution(
    tenantId: string,
    id: string,
  ): Promise<ReportExecution> {
    const execution = await this.executionRepo.findOne({
      where: { id, tenantId },
    });
    if (!execution) {
      throw new NotFoundException(`Report execution ${id} not found`);
    }
    return execution;
  }

  /** The stored artefact, for `GET /reports/executions/:id/download`. */
  async readArtefact(
    tenantId: string,
    id: string,
  ): Promise<{ content: Buffer; fileName: string; mimeType: string }> {
    const execution = await this.findExecution(tenantId, id);
    if (!execution.filePath) {
      throw new NotFoundException(
        execution.status === ReportExecutionStatus.FAILED
          ? `That run failed and produced no file: ${execution.error ?? 'no detail'}`
          : 'That run has no stored file',
      );
    }

    const absolute = this.resolveStoredPath(execution.filePath);
    let content: Buffer;
    try {
      content = await fs.readFile(absolute);
    } catch {
      throw new NotFoundException(
        'The stored report file is no longer on disk — it may have been removed ' +
          'from the uploads volume. Regenerate the report.',
      );
    }

    return {
      content,
      fileName: execution.fileName ?? path.basename(absolute),
      mimeType: this.mimeForExtension(path.extname(absolute)),
    };
  }

  // ══════════════════════════════════════════════════════════════════════════
  // READ-ONLY SURFACES
  // ══════════════════════════════════════════════════════════════════════════

  /** The declarative catalogue the report builder renders itself from. */
  getSources() {
    return {
      sources: Object.values(REPORT_SOURCES),
      formats: Object.values(ReportFormat),
      filterKeys: [...REPORT_FILTER_KEYS],
      scheduling: {
        wired: true,
        tick: 'every minute',
        cronFields: 5,
        delivery: 'email',
        deliveryNote:
          'A scheduled run emails a summary with the first rows inline AND ' +
          'attaches the generated file, while it fits under the platform’s ' +
          'attachment cap (MAIL_MAX_ATTACHMENT_BYTES, default 10 MB). A larger ' +
          'artefact is not attached — the email says so and carries the ' +
          'download link instead, and execution.delivery.attached records ' +
          'which happened. Either way the file is at ' +
          'GET /reports/executions/:id/download.',
      },
    };
  }

  async getStatistics(tenantId: string) {
    const [templates, executions] = await Promise.all([
      this.templateRepo.find({ where: { tenantId } }),
      this.executionRepo.find({
        where: { tenantId },
        order: { createdAt: 'DESC' },
        take: 500,
      }),
    ]);

    return {
      templates: templates.length,
      scheduled: templates.filter((t) => t.schedule?.enabled).length,
      generatedTotal: templates.reduce(
        (sum, t) => sum + (t.generationCount ?? 0),
        0,
      ),
      recentFailures: executions.filter(
        (e) => e.status === ReportExecutionStatus.FAILED,
      ).length,
      byEntity: templates.reduce<Record<string, number>>((acc, t) => {
        const entity = t.definition?.entity ?? 'UNKNOWN';
        acc[entity] = (acc[entity] ?? 0) + 1;
        return acc;
      }, {}),
      nextScheduledRun:
        templates
          .filter((t) => t.nextRunAt)
          .sort(
            (a, b) =>
              new Date(a.nextRunAt!).getTime() - new Date(b.nextRunAt!).getTime(),
          )[0]?.nextRunAt ?? null,
    };
  }

  // ══════════════════════════════════════════════════════════════════════════
  // VALIDATION
  // ══════════════════════════════════════════════════════════════════════════

  /**
   * Checked against `REPORT_SOURCES`, so a template cannot be saved naming a
   * column its source does not produce or a filter it does not apply. Catching
   * it here rather than at generation time is the difference between a 400 on
   * the form and a scheduled report that fails silently every Monday.
   */
  validateDefinition(definition: ReportDefinition): ReportDefinition {
    const manifest = REPORT_SOURCES[definition?.entity];
    if (!manifest) {
      throw new BadRequestException({
        message: `Unknown report entity "${definition?.entity}"`,
        errors: [`valid entities: ${Object.keys(REPORT_SOURCES).join(', ')}`],
      });
    }

    const errors: string[] = [];
    const validColumns = new Set(manifest.columns.map((c) => c.key));

    for (const key of definition.columns ?? []) {
      if (!validColumns.has(key)) {
        errors.push(
          `column "${key}" is not produced by ${definition.entity} ` +
            `(valid: ${[...validColumns].join(', ')})`,
        );
      }
    }

    const declaredFilters = Object.entries(definition.filters ?? {}).filter(
      ([, value]) =>
        value !== undefined &&
        value !== null &&
        !(Array.isArray(value) && value.length === 0),
    );
    for (const [key] of declaredFilters) {
      if (!manifest.filters.includes(key)) {
        errors.push(
          `filter "${key}" is ignored by ${definition.entity} ` +
            `(honoured: ${manifest.filters.join(', ') || 'none'})`,
        );
      }
    }

    if (
      definition.entity === ReportEntityKind.DEVICE_TELEMETRY &&
      !definition.filters?.telemetryKeys?.length
    ) {
      errors.push(
        'DEVICE_TELEMETRY needs filters.telemetryKeys — the raw source reads one ' +
          'series per (device, key)',
      );
    }

    if (
      definition.grouping &&
      definition.grouping.interval !== 'NONE' &&
      !manifest.supportsGrouping
    ) {
      errors.push(
        `${definition.entity} does not support grouping — drop definition.grouping`,
      );
    }

    if (errors.length) {
      throw new BadRequestException({
        message: `The report definition does not match what ${definition.entity} can produce`,
        errors,
      });
    }

    // Resolving the period here rejects an impossible window (from >= to,
    // unparseable instants) at save time rather than at 07:00 on a Monday.
    this.generator.resolvePeriod(definition);

    return definition;
  }

  private validateSchedule(
    schedule: ReportSchedule | undefined,
  ): ReportSchedule | undefined {
    if (!schedule) return undefined;

    const errors: string[] = [];

    if (schedule.enabled && schedule.recipients?.length === 0) {
      errors.push(
        'an enabled schedule needs at least one recipient — otherwise it ' +
          'generates reports nobody is told about',
      );
    }

    const timezone = schedule.timezone?.trim() || DEFAULT_TIMEZONE;
    const cron = schedule.cron?.trim() ?? '';
    const fields = cron.split(/\s+/).filter(Boolean).length;
    if (fields !== 5) {
      // cron-parser accepts a 6-field expression with seconds, which would make
      // a report fire up to 60 times in the minute the scheduler ticks.
      errors.push(
        `cron must have exactly 5 fields (minute hour day-of-month month day-of-week); got ${fields}`,
      );
    } else {
      try {
        cronParser.parseExpression(cron, { tz: timezone });
      } catch (err) {
        errors.push(
          `cron "${cron}" is not parseable in timezone "${timezone}": ${(err as Error).message}`,
        );
      }
    }

    if (errors.length) {
      throw new BadRequestException({
        message: 'The report schedule is not usable',
        errors,
      });
    }

    return { ...schedule, cron, timezone };
  }

  /** Public so `ReportSchedulerService` can re-arm a template after a run. */
  computeNextRun(
    schedule: ReportSchedule | undefined | null,
    enabled: boolean,
  ): Date | null {
    if (!enabled || !schedule?.enabled || !schedule.cron) return null;
    try {
      return cronParser
        .parseExpression(schedule.cron, {
          tz: schedule.timezone || DEFAULT_TIMEZONE,
          currentDate: new Date(),
        })
        .next()
        .toDate();
    } catch (err) {
      // Unreachable from the HTTP path — validateSchedule() rejects first — but
      // a row written before that validation existed must not crash the tick.
      this.logger.error(
        `Cannot compute next run for cron "${schedule.cron}": ${(err as Error).message}`,
      );
      return null;
    }
  }

  // ══════════════════════════════════════════════════════════════════════════
  // HELPERS
  // ══════════════════════════════════════════════════════════════════════════

  /**
   * The user a run is attributed to.
   *
   * It matters for the AUDIT_LOG source only, whose backing service filters by
   * the caller's role — a scheduled run with no resolvable user would otherwise
   * either throw deep inside AuditService or, worse, be given a fabricated
   * SUPER_ADMIN and return the whole platform's audit trail.
   */
  private async resolveRunAsUser(
    tenantId: string,
    template: ReportTemplate,
  ): Promise<User | null> {
    if (!template.userId) return null;
    return this.userRepo.findOne({
      where: { id: template.userId, tenantId },
    });
  }

  private fileNameFor(
    name: string,
    generatedAt: Date,
    extension: string,
  ): string {
    const slug =
      name
        .trim()
        .replace(/[^A-Za-z0-9]+/g, '_')
        .replace(/^_+|_+$/g, '')
        .slice(0, 60) || 'report';
    const stamp = generatedAt.toISOString().slice(0, 19).replace(/[:T]/g, '-');
    return `${slug}_${stamp}.${extension}`;
  }

  /**
   * Written under `<uploads>/reports/<tenantId>/<uuid>.<ext>` and recorded as a
   * path RELATIVE to the reports root.
   *
   * The stored name is a uuid, not the download name: the download name comes
   * from the template's title and would otherwise let a template called
   * `../../etc/passwd` decide a path. The relative form also means moving the
   * uploads volume does not invalidate every row.
   */
  private async writeArtefact(
    tenantId: string,
    extension: string,
    content: Buffer,
  ): Promise<string> {
    const relative = path.join(tenantId, `${randomUUID()}.${extension}`);
    const absolute = path.join(this.storageRoot, relative);
    await fs.mkdir(path.dirname(absolute), { recursive: true });
    await fs.writeFile(absolute, content);
    return relative;
  }

  private async deleteArtefact(execution: ReportExecution): Promise<boolean> {
    if (!execution.filePath) return false;
    try {
      await fs.unlink(this.resolveStoredPath(execution.filePath));
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Resolve a stored relative path and refuse anything that escapes the reports
   * root. The values in `filePath` are server-generated, so this is defence in
   * depth rather than the primary control — but it is the check that makes a
   * future bug in artefact naming a 400 instead of an arbitrary file read.
   */
  private resolveStoredPath(relative: string): string {
    const absolute = path.resolve(this.storageRoot, relative);
    const root = this.storageRoot.endsWith(path.sep)
      ? this.storageRoot
      : this.storageRoot + path.sep;
    if (!absolute.startsWith(root)) {
      throw new BadRequestException('Stored report path is outside the reports directory');
    }
    return absolute;
  }

  private mimeForExtension(extension: string): string {
    switch (extension.toLowerCase()) {
      case '.json':
        return 'application/json';
      case '.pdf':
        return 'application/pdf';
      case '.xlsx':
        return XLSX_MIME_TYPE;
      case '.csv':
      default:
        return 'text/csv; charset=utf-8';
    }
  }

  private async assertNameFree(
    tenantId: string,
    name: string,
    exceptId?: string,
  ): Promise<void> {
    const clash = await this.templateRepo.findOne({
      where: exceptId ? { tenantId, name, id: Not(exceptId) } : { tenantId, name },
    });
    if (clash) {
      throw new ConflictException(
        `A report template named "${name}" already exists in this tenant`,
      );
    }
  }
}
