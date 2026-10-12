import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Put,
  Query,
  Res,
} from '@nestjs/common';
import type { Response } from 'express';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { CurrentUser } from '@common/decorators/current-user.decorator';
import {
  SwaggerAuth,
  TenantAdminOnly,
  TenantOrCustomerAdmin,
} from '@common/decorators/access-control.decorator';
import type { User } from '@modules/users/entities/user.entity';
import { ReportsService } from './reports.service';
import {
  CreateReportTemplateDto,
  GenerateReportDto,
  ReportExecutionQueryDto,
  ReportTemplateQueryDto,
  UpdateReportTemplateDto,
} from './dto/report.dto';

/**
 * Report templates and generation.
 *
 * Every handler carries an explicit roles decorator. `RolesGuard` returns TRUE
 * for a handler with no `@Roles` metadata, so an undecorated route here would
 * let any authenticated user define a report over the tenant's telemetry,
 * alarms and audit trail and have it emailed wherever they liked. Writes and
 * generation are TENANT_ADMIN and above; the list/read routes stay open to
 * CUSTOMER.
 *
 * ── What is actually wired ─────────────────────────────────────────────────
 * Generation is real: `GET /reports/sources` names the existing service behind
 * each row source, and nothing here reimplements a query engine. CSV, JSON and
 * PDF all render.
 *
 * Scheduling is real too: `ReportSchedulerService` ticks every minute, runs due
 * templates and emails the recipients. The one thing it cannot do is ATTACH the
 * file — `MailService.sendEmail()` takes `{to, subject, html, text}` and
 * MailModule is not this module's to change — so the email carries a summary,
 * the first rows inline, and the download path.
 */
@ApiTags('Reports')
@Controller('reports')
export class ReportsController {
  constructor(private readonly reportsService: ReportsService) {}

  @Get()
  @TenantOrCustomerAdmin()
  @ApiOperation({ summary: 'List report templates' })
  @SwaggerAuth('List report templates', 'Paginated templates')
  findAll(
    @CurrentUser('tenantId') tenantId: string,
    @Query() query: ReportTemplateQueryDto,
  ) {
    return this.reportsService.findAll(tenantId, query);
  }

  // All of the literal paths must precede `:id`, or they are parsed as ids.
  @Get('sources')
  @TenantOrCustomerAdmin()
  @ApiOperation({
    summary: 'The row sources a report can be built from',
    description:
      'The declarative catalogue the report builder renders itself from: per ' +
      'source, the service that answers it, its columns, the filters it ' +
      'honours, and whether its date range is exact or snapped. Also states ' +
      'what scheduling and delivery do and do not do.',
  })
  @SwaggerAuth('Report sources', 'Source catalogue')
  getSources() {
    return this.reportsService.getSources();
  }

  @Get('statistics')
  @TenantOrCustomerAdmin()
  @ApiOperation({ summary: 'Template counts, recent failures and the next scheduled run' })
  @SwaggerAuth('Report statistics', 'Counts')
  getStatistics(@CurrentUser('tenantId') tenantId: string) {
    return this.reportsService.getStatistics(tenantId);
  }

  @Get('executions')
  @TenantOrCustomerAdmin()
  @ApiOperation({
    summary: 'Generated reports, newest first',
    description:
      'What backs a "Recent Exports" list. Failed runs are rows here too, with ' +
      '`status: FAILED` and `error` set — a scheduled report that quietly ' +
      'stopped producing output is the failure worth seeing.',
  })
  @SwaggerAuth('List report executions', 'Paginated executions')
  findExecutions(
    @CurrentUser('tenantId') tenantId: string,
    @Query() query: ReportExecutionQueryDto,
  ) {
    return this.reportsService.findExecutions(tenantId, query);
  }

  @Get('executions/:executionId')
  @TenantOrCustomerAdmin()
  @ApiOperation({ summary: 'One generated report’s metadata' })
  @SwaggerAuth('Get a report execution', 'The execution')
  findExecution(
    @CurrentUser('tenantId') tenantId: string,
    @Param('executionId', ParseUUIDPipe) executionId: string,
  ) {
    return this.reportsService.findExecution(tenantId, executionId);
  }

  /**
   * Streams the stored artefact.
   *
   * `@Res()` without `passthrough` deliberately bypasses `TransformInterceptor`
   * — a CSV or PDF wrapped in `{success, data, timestamp}` is not a file the
   * browser can save.
   */
  @Get('executions/:executionId/download')
  @TenantOrCustomerAdmin()
  @ApiOperation({
    summary: 'Download a generated report',
    description:
      'Returns the raw file, not the usual {success, data} envelope. 404 when ' +
      'the run failed or the file is no longer on the uploads volume.',
  })
  @SwaggerAuth('Download a report', 'The file')
  async download(
    @CurrentUser('tenantId') tenantId: string,
    @Param('executionId', ParseUUIDPipe) executionId: string,
    @Res() res: Response,
  ): Promise<void> {
    const { content, fileName, mimeType } =
      await this.reportsService.readArtefact(tenantId, executionId);

    res.setHeader('Content-Type', mimeType);
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="${fileName.replace(/"/g, '')}"`,
    );
    res.setHeader('Content-Length', String(content.byteLength));
    res.send(content);
  }

  @Get(':id')
  @TenantOrCustomerAdmin()
  @ApiOperation({ summary: 'One report template' })
  @SwaggerAuth('Get a report template', 'The template')
  findOne(
    @CurrentUser('tenantId') tenantId: string,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.reportsService.findOne(tenantId, id);
  }

  @Post()
  @TenantAdminOnly()
  @ApiOperation({
    summary: 'Create a report template',
    description:
      'The definition is checked against the source catalogue, so a column the ' +
      'source cannot produce or a filter it ignores is a 400 with a per-problem ' +
      'errors array rather than a report that fails every Monday at 07:00.',
  })
  @SwaggerAuth('Create a report template', 'Template created')
  create(
    @CurrentUser('tenantId') tenantId: string,
    @CurrentUser('id') userId: string,
    @Body() dto: CreateReportTemplateDto,
  ) {
    return this.reportsService.create(tenantId, userId, dto);
  }

  @Post(':id/generate')
  @TenantAdminOnly()
  @ApiOperation({
    summary: 'Generate the report now',
    description:
      'Runs the definition against real data through the platform’s existing ' +
      'query services, stores the artefact and records an execution. CSV and ' +
      'JSON come back inline as well as on disk; a PDF is download-only, ' +
      'because base64 in a JSON envelope triples a multi-megabyte file. Pass ' +
      '`preview: true` to try a definition without storing anything (100 rows).',
  })
  @SwaggerAuth('Generate a report', 'The generated report')
  generate(
    @CurrentUser('tenantId') tenantId: string,
    @CurrentUser() user: User,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: GenerateReportDto,
  ) {
    return this.reportsService.generate(tenantId, id, user, dto);
  }

  @Put(':id')
  @TenantAdminOnly()
  @ApiOperation({
    summary: 'Update a report template',
    description:
      '`nextRunAt` is recomputed from the schedule on every write — it is ' +
      'derived and never accepted from the client.',
  })
  @SwaggerAuth('Update a report template', 'Template updated')
  update(
    @CurrentUser('tenantId') tenantId: string,
    @CurrentUser('id') userId: string,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateReportTemplateDto,
  ) {
    return this.reportsService.update(tenantId, id, userId, dto);
  }

  @Patch(':id')
  @TenantAdminOnly()
  @ApiOperation({ summary: 'Update a report template (alias of PUT)' })
  @SwaggerAuth('Update a report template', 'Template updated')
  patch(
    @CurrentUser('tenantId') tenantId: string,
    @CurrentUser('id') userId: string,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateReportTemplateDto,
  ) {
    return this.reportsService.update(tenantId, id, userId, dto);
  }

  @Delete(':id')
  @TenantAdminOnly()
  @ApiOperation({
    summary: 'Delete a report template',
    description:
      'Its execution rows are soft-removed and their stored files are deleted ' +
      'from the uploads volume in the same call; the count is in the response.',
  })
  @SwaggerAuth('Delete a report template', 'Template deleted')
  remove(
    @CurrentUser('tenantId') tenantId: string,
    @CurrentUser('id') userId: string,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.reportsService.remove(tenantId, id, userId);
  }
}
