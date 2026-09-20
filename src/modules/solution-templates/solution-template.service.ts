import {
  Injectable,
  Logger,
  NotFoundException,
  ForbiddenException,
  BadRequestException,
  ConflictException,
  InternalServerErrorException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Brackets, DataSource, In, IsNull, Repository } from 'typeorm';
import * as crypto from 'crypto';
import * as path from 'path';
import { promises as fs } from 'fs';
import type { File as MulterFile } from 'multer';

import { SolutionTemplate } from './entities/solution-template.entity';
import { TemplateInstallation } from './entities/template-installation.entity';
import { Device, DeviceProtocol } from '../devices/entities/device.entity';
import { DeviceCredentials, CredentialsType } from '../devices/entities/device-credentials.entity';
import { DeviceProfile } from '../profiles/entities/device-profile.entity';
import { Dashboard } from '../dashboards/entities/dashboard.entity';
import type { DashboardWidgetConfig } from '../dashboards/interfaces/dashboard-widget.interface';
import { WidgetType } from '../widgets/entities/widget-type.entity';
import { RuleChain } from '../rules/entities/rule-chain.entity';
import { Node } from '../nodes/entities/node.entity';
import { Alarm } from '../alarms/entities/alarm.entity';

import {
  SolutionTemplateCategory as TemplateCategory,
  DeviceStatus,
  DeviceType,
  RuleChainStatus,
  UserRole,
} from '@common/enums/index.enum';
import { SubscriptionsService } from '../subscriptions/subscriptions.service';
import type { SubscriptionLimits } from '@common/interfaces/index.interface';
import { PaginatedResponseDto } from '@common/dto/pagination.dto';

import {
  CreateSolutionTemplateDto,
  InstallTemplateDto,
} from './dto/create-solution-template.dto';
import { UpdateSolutionTemplateDto } from './dto/update-solution-template.dto';
import { FindAllTemplatesDto } from './dto/find-all-templates.dto';
import {
  InstallationStatus,
  type TemplateConfiguration,
  type InstallResult,
  type WidgetSpec,
  type AlarmSpec,
} from './interfaces/template-configuration.interface';
import { AlarmCondition } from '@common/enums/index.enum';

/** An entity's data properties, without its instance methods. */
type PlainEntity<T> = {
  [K in keyof T as T[K] extends (...args: any[]) => any ? never : K]: T[K];
};

/**
 * A template as returned by the catalogue listing: the entity's data plus this
 * tenant's ACTIVE installation, so a card can render "Installed / Uninstall"
 * without a follow-up request.
 *
 * Spread from the entity, so instance methods (isUserTemplate, save, …) are
 * intentionally absent.
 */
/** Image formats accepted by POST /solution-templates/:id/image. */
export const ALLOWED_IMAGE_EXTENSIONS = [
  'jpg',
  'jpeg',
  'png',
  'webp',
  'svg',
] as const;

/** 5 MB — also enforced by the controller's FileInterceptor limit. */
export const MAX_IMAGE_BYTES = 5 * 1024 * 1024;

const IMAGE_CONTENT_TYPES: Record<string, string> = {
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  png: 'image/png',
  webp: 'image/webp',
  svg: 'image/svg+xml',
};

export type CatalogueTemplate = PlainEntity<SolutionTemplate> & {
  myInstallation: Pick<
    TemplateInstallation,
    'id' | 'templateId' | 'installationName' | 'installedAt'
  > | null;
  isInstalled: boolean;
};

@Injectable()
export class SolutionTemplatesService {
  private readonly logger = new Logger(SolutionTemplatesService.name);

  constructor(
    @InjectRepository(SolutionTemplate)
    private readonly templateRepository: Repository<SolutionTemplate>,
    @InjectRepository(TemplateInstallation)
    private readonly installationRepo: Repository<TemplateInstallation>,
    private readonly subscriptionsService: SubscriptionsService,
    private readonly dataSource: DataSource,
  ) {}

  // ══════════════════════════════════════════════════════════════════════════
  // VISIBILITY
  //
  // A template is visible to a tenant when it is a system template
  // (isSystem = true, tenantId IS NULL) or it belongs to that tenant.
  // Every read path funnels through this so no tenant can see another's
  // user-created templates.
  // ══════════════════════════════════════════════════════════════════════════

  private applyVisibility(
    qb: ReturnType<Repository<SolutionTemplate>['createQueryBuilder']>,
    tenantId: string,
  ) {
    return qb.andWhere(
      new Brackets((w) => {
        w.where('template.isSystem = true').orWhere(
          new Brackets((c) => {
            c.where('template.tenantId = :tenantId', { tenantId }).andWhere(
              'template.isSystem = false',
            );
          }),
        );
      }),
    );
  }

  // ══════════════════════════════════════════════════════════════════════════
  // PLAN LIMITS
  //
  // Solution-template ceilings live in Subscription.limits (jsonb), alongside
  // devices/dashboards/etc. A missing key is treated as unlimited so that
  // tenants seeded before these limits existed are not retroactively locked out.
  // ══════════════════════════════════════════════════════════════════════════

  private async getPlanLimits(tenantId: string): Promise<SubscriptionLimits> {
    const subscription = await this.subscriptionsService
      .findByTenantId(tenantId)
      .catch(() => null);

    if (!subscription) {
      throw new BadRequestException(
        'No active subscription found for this tenant',
      );
    }
    return subscription.limits ?? {};
  }

  /** -1 or an absent key means unlimited. */
  private isUnlimited(limit: number | undefined): boolean {
    return limit === undefined || limit === null || limit === -1;
  }

  // ── Create ────────────────────────────────────────────────────────────────

  async create(
    userId: string,
    tenantId: string,
    createDto: CreateSolutionTemplateDto,
  ): Promise<SolutionTemplate> {
    // Custom-template quota. Templates created through this endpoint are always
    // isSystem: false, so the ceiling always applies. Soft-deleted templates do
    // not count — deleting one frees a slot.
    const limits = await this.getPlanLimits(tenantId);
    if (!this.isUnlimited(limits.maxCustomTemplates)) {
      const customTemplates = await this.templateRepository.count({
        where: { tenantId, isSystem: false, deletedAt: IsNull() },
      });
      if (customTemplates >= limits.maxCustomTemplates!) {
        throw new ForbiddenException(
          `Your plan allows a maximum of ${limits.maxCustomTemplates} custom templates.`,
        );
      }
    }

    const template = this.templateRepository.create({
      ...createDto,
      tenantId, // ← from JWT, never from the body
      userId,
      createdBy: userId,
      isSystem: false, // user-created templates are never system templates
      rating: 0,
      ratings: {},
      ratingCount: 0,
      installs: 0,
    });

    const saved = await this.templateRepository.save(template);
    this.logger.log(`Solution template created: ${saved.id} by user ${userId}`);
    return saved;
  }

  // ── Read ──────────────────────────────────────────────────────────────────

  async findAll(
    tenantId: string,
    filters?: FindAllTemplatesDto,
  ): Promise<PaginatedResponseDto<CatalogueTemplate>> {
    const { page = 1, limit = 12, search, category, isPremium } = filters || {};
    const skip = (page - 1) * limit;

    const qb = this.templateRepository.createQueryBuilder('template');
    this.applyVisibility(qb, tenantId);

    if (category) {
      qb.andWhere('template.category = :category', { category });
    }

    if (isPremium !== undefined) {
      qb.andWhere('template.isPremium = :isPremium', { isPremium });
    }

    if (search) {
      qb.andWhere(
        '(template.name ILIKE :search OR template.description ILIKE :search OR template.tags::text ILIKE :search)',
        { search: `%${search}%` },
      );
    }

    qb.orderBy('template.installs', 'DESC')
      .addOrderBy('template.rating', 'DESC')
      .skip(skip)
      .take(limit);

    const [templates, total] = await qb.getManyAndCount();

    // Decorate each template with this tenant's ACTIVE installation, if any, so
    // the catalogue can render an "Installed / Uninstall" state without a
    // follow-up request per card. One extra query for the whole page.
    //
    // Only SUCCESS rows count as installed — a ROLLED_BACK row means the
    // template was uninstalled and is installable again, which is exactly what
    // install()'s idempotency check enforces.
    const activeInstallations = await this.installationRepo.find({
      where: { tenantId, status: InstallationStatus.SUCCESS },
      select: ['id', 'templateId', 'installationName', 'installedAt'],
    });
    const installMap = new Map(
      activeInstallations.map((i) => [i.templateId, i]),
    );

    const data: CatalogueTemplate[] = templates.map((template) => ({
      ...template,
      myInstallation: installMap.get(template.id) ?? null,
      isInstalled: installMap.has(template.id),
    }));

    return PaginatedResponseDto.create(data, page, limit, total);
  }

  async findOne(id: string, tenantId: string): Promise<SolutionTemplate> {
    const qb = this.templateRepository
      .createQueryBuilder('template')
      .where('template.id = :id', { id });
    this.applyVisibility(qb, tenantId);

    const template = await qb.getOne();
    if (!template) {
      throw new NotFoundException('Solution template not found');
    }
    return template;
  }

  // ══════════════════════════════════════════════════════════════════════════
  // PREVIEW — dry run of install()
  //
  // Answers "what would happen if I installed this?" without provisioning
  // anything: the exact resources that would be created, whether this tenant
  // already has it installed, and any quota that would block the install.
  //
  // Reuses checkQuotas() rather than duplicating the limit logic, so preview
  // and install can never disagree about whether an install is possible.
  // ══════════════════════════════════════════════════════════════════════════

  /**
   * Presentation metadata for a WidgetSpec.type, so a preview screen can render
   * each widget as a labelled tile before anything is provisioned.
   *
   * Keyed by the same loose type strings templates author (`WidgetSpec.type`),
   * not by WidgetType.descriptor.alias — a template may say 'timeseries' where
   * the widget library calls it 'timeseries-chart', so both spellings map to the
   * same entry. This is display-only; what actually gets created is still
   * decided by resolveWidgetType() at install time.
   */
  private static readonly WIDGET_META: Record<
    string,
    { icon: string; description: string }
  > = {
    gauge: { icon: '🕐', description: 'Circular gauge for current value' },
    timeseries: { icon: '📈', description: 'Line chart for historical trend' },
    'timeseries-chart': {
      icon: '📈',
      description: 'Line chart for historical trend',
    },
    'bar-chart': { icon: '📊', description: 'Bar chart for comparison' },
    'value-card': { icon: '🔢', description: 'Card showing latest value' },
    'pie-chart': { icon: '🥧', description: 'Pie chart for distribution' },
    map: { icon: '🗺️', description: 'Map showing device location' },
    status: { icon: '🔴', description: 'Device online/offline status' },
    'status-widget': { icon: '🔴', description: 'Device online/offline status' },
    'alarm-list': { icon: '🚨', description: 'Active alarm feed' },
    'alarm-widget': { icon: '🚨', description: 'Active alarm feed' },
    switch: { icon: '🔘', description: 'Toggle control for device' },
    'progress-bar': {
      icon: '▬',
      description: 'Progress bar showing percentage',
    },
  };

  /** Shown for a widget type with no entry in WIDGET_META. */
  private static readonly DEFAULT_WIDGET_META = {
    icon: '📱',
    description: 'Widget',
  };

  private static readonly DEVICE_ICON = '📱';
  private static readonly ALARM_ICON = '🚨';

  /** Dashboard grid width the widget row/col/width/height values are laid out on. */
  private static readonly DASHBOARD_GRID_COLUMNS = 12;

  /**
   * Every template widget is rendered at this multiple of its authored height.
   *
   * Applied in both places a height is produced — preview() and
   * buildDashboardWidgets() — so what the preview draws is what install()
   * creates. Change it here, not at either call site.
   *
   * NOTE: only heights scale, not `row`. Templates authored their rows against
   * the original heights (row 0 h4, row 4 h4, row 8 h3), so at 2× the widgets
   * overlap vertically — see the report accompanying this change.
   */
  private static readonly WIDGET_HEIGHT_MULTIPLIER = 2;

  /** Fallback height for a widget spec that does not declare one. */
  private static readonly DEFAULT_WIDGET_HEIGHT = 3;

  /** Fallback width for a widget spec that does not declare one. */
  private static readonly DEFAULT_WIDGET_WIDTH = 4;

  /**
   * The identity and geometry of one template widget — the single place either
   * code path derives them.
   *
   * preview() and install() previously computed these separately and disagreed
   * in three ways: preview echoed `w.width`/`w.row` raw (undefined when the
   * spec omitted them) where install fell back to the widget type's natural
   * size, and their height fallbacks differed (a flat 3 vs descriptor.sizeY).
   * Both now call this, so a preview cannot promise geometry install won't
   * produce.
   *
   * `widgetType` is undefined when the spec's type resolves to nothing — the
   * caller decides what that means (install skips the widget, preview flags it).
   */
  private buildWidgetSpec(spec: WidgetSpec, widgetType?: WidgetType) {
    const descriptor = widgetType?.descriptor ?? ({} as WidgetType['descriptor']);

    return {
      widgetTypeId: widgetType?.id,
      widgetTypeAlias: widgetType
        ? descriptor.alias ?? widgetType.name
        : undefined,
      title: spec.title,
      row: spec.row ?? 0,
      col: spec.col ?? 0,
      // Fall back to the widget type's natural size, as addWidget() does.
      width:
        spec.width ??
        descriptor.sizeX ??
        SolutionTemplatesService.DEFAULT_WIDGET_WIDTH,
      height:
        (spec.height ??
          descriptor.sizeY ??
          SolutionTemplatesService.DEFAULT_WIDGET_HEIGHT) *
        SolutionTemplatesService.WIDGET_HEIGHT_MULTIPLIER,
      // defaultConfig first so the template's overrides win, key by key
      config: {
        ...(descriptor.defaultConfig ?? {}),
        ...(spec.config ?? {}),
      },
    };
  }

  /**
   * Operator symbols for rendering an AlarmSpec as a readable expression
   * ("soc < 20") instead of echoing the enum name ("soc LESS_THAN 20").
   */
  private static readonly CONDITION_SYMBOLS: Partial<
    Record<AlarmCondition, string>
  > = {
    [AlarmCondition.GREATER_THAN]: '>',
    [AlarmCondition.LESS_THAN]: '<',
    [AlarmCondition.EQUAL]: '==',
    [AlarmCondition.NOT_EQUAL]: '!=',
    [AlarmCondition.GREATER_THAN_OR_EQUAL]: '>=',
    [AlarmCondition.LESS_THAN_OR_EQUAL]: '<=',
    [AlarmCondition.CONTAINS]: 'contains',
    [AlarmCondition.NOT_CONTAINS]: 'not contains',
  };

  private getWidgetMeta(type: string): { icon: string; description: string } {
    // Templates spell types loosely — 'status_widget', 'Bar Chart', 'bar-chart'
    // all reach the same entry. The raw key is tried too so an exactly-matching
    // type still resolves if normalising ever mangles it.
    const normalized = (type ?? '').toLowerCase().replace(/[-_\s]/g, '-');
    return (
      SolutionTemplatesService.WIDGET_META[normalized] ??
      SolutionTemplatesService.WIDGET_META[type] ??
      SolutionTemplatesService.DEFAULT_WIDGET_META
    );
  }

  /** An AlarmSpec as a human-readable expression, e.g. "soc < 20". */
  private formatAlarmCondition(spec: AlarmSpec): string {
    const { telemetryKey, condition, value, value2 } = spec;

    // BETWEEN/OUTSIDE read as a range, and EXISTS takes no operand at all —
    // "soc BETWEEN 20" would be wrong on both counts.
    if (condition === AlarmCondition.BETWEEN) {
      return `${telemetryKey} between ${value} and ${value2}`;
    }
    if (condition === AlarmCondition.OUTSIDE) {
      return `${telemetryKey} outside ${value} and ${value2}`;
    }
    if (condition === AlarmCondition.EXISTS) {
      return `${telemetryKey} exists`;
    }

    const symbol =
      SolutionTemplatesService.CONDITION_SYMBOLS[condition] ?? condition;
    return `${telemetryKey} ${symbol} ${value}`;
  }

  async preview(id: string, tenantId: string) {
    // findOne() applies tenant visibility — a template this tenant cannot see
    // is a 404 here just as it is everywhere else.
    const template = await this.findOne(id, tenantId);
    const config = (template.configuration ?? {}) as TemplateConfiguration;

    const existingInstall = await this.installationRepo.findOne({
      where: { tenantId, templateId: id, status: InstallationStatus.SUCCESS },
    });

    // checkQuotas() throws on the first ceiling it hits; a preview should
    // report that as a warning rather than fail.
    const quotaWarnings: string[] = [];
    try {
      await this.checkQuotas(tenantId, config);
    } catch (error) {
      quotaWarnings.push(
        error instanceof Error ? error.message : String(error),
      );
    }

    const totalDevices =
      config.devices?.reduce((sum, d) => sum + (d.count ?? 0), 0) ?? 0;

    // Resolve widget types exactly as install() does. Without this a preview
    // could only echo the template's raw spec: it would list a widget install
    // is going to skip, and fall back to different sizes when the spec omits
    // them. Loaded on the same condition install() uses, so a template with no
    // widgets costs no extra query.
    const widgetTypeIndex = (config.dashboards ?? []).some(
      (d) => (d.widgets ?? []).length > 0,
    )
      ? await this.loadWidgetTypeIndex(this.dataSource.manager, tenantId)
      : null;

    const dashboards = (config.dashboards ?? []).map((d) => {
      // The full spec of every widget, so a preview can draw the grid rather
      // than just state a count.
      const widgets = (d.widgets ?? []).map((w) => {
        const widgetType = widgetTypeIndex
          ? this.resolveWidgetType(w.type, widgetTypeIndex)
          : undefined;
        const meta = this.getWidgetMeta(w.type);
        const shared = this.buildWidgetSpec(w, widgetType);

        return {
          type: w.type,
          title: shared.title,
          width: shared.width,
          height: shared.height,
          row: shared.row,
          col: shared.col,
          icon: meta.icon,
          description: meta.description,
          // install() skips a widget whose type matches no widget type. Saying
          // so here keeps the preview honest instead of promising a tile that
          // will never be created.
          willBeCreated: !!widgetType,
        };
      });

      const created = widgets.filter((w) => w.willBeCreated);

      return {
        name: d.name,
        // The number install() will actually create — `skippedWidgetCount`
        // accounts for any difference from the template's spec list.
        widgetCount: created.length,
        skippedWidgetCount: widgets.length - created.length,
        widgets,
        layout: {
          totalColumns: SolutionTemplatesService.DASHBOARD_GRID_COLUMNS,
          // Lowest edge any widget reaches — the grid height needed to show the
          // whole dashboard, not the widget count. Read off the widgets that
          // will exist, at the sizes they will have.
          estimatedRows: created.reduce(
            (rows, w) => Math.max(rows, (w.row ?? 0) + (w.height ?? 0)),
            0,
          ),
        },
      };
    });

    return {
      templateId: id,
      templateName: template.name,
      category: template.category,
      hasConfiguration: Object.keys(config).length > 0,
      alreadyInstalled: !!existingInstall,
      installationId: existingInstall?.id ?? null,
      canInstall: !existingInstall && quotaWarnings.length === 0,
      quotaWarnings,
      willCreate: {
        devices:
          config.devices?.map((d) => ({
            namePattern: d.name,
            type: d.type,
            count: d.count ?? 0,
            protocol: d.protocol ?? DeviceProtocol.GENERIC_MQTT,
            telemetryKeys: d.defaultTelemetryKeys ?? [],
            icon: SolutionTemplatesService.DEVICE_ICON,
          })) ?? [],
        dashboards,
        ruleChains:
          config.ruleChains?.map((r) => ({
            name: r.name,
            nodeCount: r.nodes?.length ?? 0,
            connectionCount: r.connections?.length ?? 0,
          })) ?? [],
        alarms:
          config.alarms?.map((a) => ({
            name: a.name,
            severity: a.severity,
            condition: this.formatAlarmCondition(a),
            deviceSelector: a.deviceSelector,
            icon: SolutionTemplatesService.ALARM_ICON,
          })) ?? [],
        summary: {
          totalDevices,
          totalDashboards: config.dashboards?.length ?? 0,
          totalRuleChains: config.ruleChains?.length ?? 0,
          // install() creates one alarm row per (spec × selected device), and
          // every seeded template uses deviceSelector 'all'.
          totalAlarms: (config.alarms?.length ?? 0) * totalDevices,
        },
      },
    };
  }

  // ── Update / Delete ───────────────────────────────────────────────────────

  async update(
    id: string,
    userId: string,
    tenantId: string,
    role: UserRole,
    updateDto: UpdateSolutionTemplateDto,
  ): Promise<SolutionTemplate> {
    const template = await this.findOne(id, tenantId);

    // System templates are code-owned: they are defined by the seeder and
    // refreshed on every seed run, so any API edit would be silently reverted.
    // Immutable for everyone, SUPER_ADMIN included.
    if (template.isSystem) {
      throw new ForbiddenException('System templates cannot be modified');
    }

    if (template.userId !== userId && role !== UserRole.SUPER_ADMIN) {
      throw new ForbiddenException(
        'You do not have permission to update this template',
      );
    }

    Object.assign(template, updateDto);
    template.updatedBy = userId;
    template.lastUpdated = new Date();

    return await this.templateRepository.save(template);
  }

  async remove(
    id: string,
    userId: string,
    tenantId: string,
    role: UserRole,
  ): Promise<void> {
    const template = await this.findOne(id, tenantId);

    // See update(): system templates are seeder-owned and immutable via the API.
    if (template.isSystem) {
      throw new ForbiddenException('System templates cannot be deleted');
    }

    if (template.userId !== userId && role !== UserRole.SUPER_ADMIN) {
      throw new ForbiddenException(
        'You do not have permission to delete this template',
      );
    }

    await this.templateRepository.softRemove(template);
    this.logger.log(`Solution template deleted: ${id} by user ${userId}`);
  }

  // ══════════════════════════════════════════════════════════════════════════
  // TEMPLATE IMAGE
  //
  // Files land in ./uploads/solution-templates/<templateId>.<ext>. That path is
  // NOT statically served, so `imageUrl` for an uploaded file is read back
  // through GET /solution-templates/:id/image, which streams it.
  //
  // System templates are seeder-owned (see update()/remove()), so only a
  // SUPER_ADMIN may replace their image. The seeder deliberately preserves an
  // uploaded /uploads/... image on re-seed so that override is not reverted.
  // ══════════════════════════════════════════════════════════════════════════

  private readonly imageDir =
    process.env.UPLOAD_PATH_TEMPLATES ||
    path.join(process.env.UPLOAD_PATH || './uploads', 'solution-templates');

  async uploadImage(
    id: string,
    tenantId: string,
    userId: string,
    role: UserRole,
    file: MulterFile,
  ): Promise<SolutionTemplate> {
    const template = await this.findOne(id, tenantId);
    this.assertCanModifyImage(template, userId, role);

    const ext = path.extname(file.originalname).toLowerCase().replace('.', '');
    if (!(ALLOWED_IMAGE_EXTENSIONS as readonly string[]).includes(ext)) {
      throw new BadRequestException(
        `Unsupported image format '${ext || file.originalname}'. ` +
          `Allowed: ${ALLOWED_IMAGE_EXTENSIONS.join(', ')}`,
      );
    }

    // FileInterceptor already caps this; re-checked here so the service is safe
    // to call from anywhere, not just that one route.
    if (file.size > MAX_IMAGE_BYTES) {
      throw new BadRequestException(
        `Image exceeds the ${MAX_IMAGE_BYTES / (1024 * 1024)}MB limit`,
      );
    }

    await fs.mkdir(this.imageDir, { recursive: true });

    // Filename is derived from the template id, never from client input.
    const fileName = `${template.id}.${ext}`;
    const filePath = path.join(this.imageDir, fileName);
    await fs.writeFile(filePath, file.buffer);

    // Drop a previously uploaded image that used a different extension.
    const previous = template.imageUrl;
    if (previous?.startsWith('/uploads/') && !previous.endsWith(`.${ext}`)) {
      await this.deleteImageFile(previous);
    }

    template.imageUrl = `/uploads/solution-templates/${fileName}`;
    template.imageAlt = template.imageAlt || template.name;
    template.updatedBy = userId;

    const saved = await this.templateRepository.save(template);
    this.logger.log(`Template image uploaded: ${id} (${fileName})`);
    return saved;
  }

  async removeImage(
    id: string,
    tenantId: string,
    userId: string,
    role: UserRole,
  ): Promise<{ removed: boolean }> {
    const template = await this.findOne(id, tenantId);
    this.assertCanModifyImage(template, userId, role);

    // Only locally-stored files are unlinked; a seeded remote URL has nothing
    // on disk to remove.
    if (template.imageUrl?.startsWith('/uploads/')) {
      await this.deleteImageFile(template.imageUrl);
    }

    template.imageUrl = null;
    template.imageAlt = null;
    template.updatedBy = userId;
    await this.templateRepository.save(template);

    this.logger.log(`Template image removed: ${id}`);
    return { removed: true };
  }

  /**
   * Resolve an uploaded image for streaming.
   * Throws NotFound when the template has no image or it is a remote URL —
   * remote URLs are fetched by the client directly, not proxied.
   */
  async getImageFile(
    id: string,
    tenantId: string,
  ): Promise<{ path: string; contentType: string; fileName: string }> {
    const template = await this.findOne(id, tenantId);

    if (!template.imageUrl) {
      throw new NotFoundException('This template has no image');
    }

    if (!template.imageUrl.startsWith('/uploads/')) {
      throw new NotFoundException(
        'This template uses a remote image URL — fetch it directly',
      );
    }

    const filePath = path.join(process.cwd(), template.imageUrl);
    try {
      await fs.access(filePath);
    } catch {
      throw new NotFoundException('Image file is missing from disk');
    }

    const ext = path.extname(filePath).toLowerCase().replace('.', '');
    return {
      path: filePath,
      contentType: IMAGE_CONTENT_TYPES[ext] ?? 'application/octet-stream',
      fileName: path.basename(filePath),
    };
  }

  /**
   * System templates are refreshed by the seeder, so they are immutable via the
   * API for everyone except SUPER_ADMIN — mirroring update()/remove(), which
   * block them outright. The image is the one field a SUPER_ADMIN may override,
   * and the seeder preserves that override.
   */
  private assertCanModifyImage(
    template: SolutionTemplate,
    userId: string,
    role: UserRole,
  ): void {
    if (template.isSystem) {
      if (role !== UserRole.SUPER_ADMIN) {
        throw new ForbiddenException(
          'System template images can only be changed by a super admin',
        );
      }
      return;
    }

    if (template.userId !== userId && role !== UserRole.SUPER_ADMIN) {
      throw new ForbiddenException(
        'You do not have permission to change this template image',
      );
    }
  }

  private async deleteImageFile(imageUrl: string): Promise<void> {
    try {
      await fs.unlink(path.join(process.cwd(), imageUrl));
    } catch (error: any) {
      // Missing file is not an error worth failing the request over.
      this.logger.warn(
        `Failed to delete template image ${imageUrl}: ${error.message}`,
      );
    }
  }

  // ══════════════════════════════════════════════════════════════════════════
  // PRE-FLIGHT QUOTA CHECK
  //
  // Uses Subscription.getRemainingCapacity(), which reads the denormalised
  // usage counters and understands -1 = unlimited. Checked BEFORE the
  // transaction opens so we fail fast rather than rolling back work.
  // ══════════════════════════════════════════════════════════════════════════

  private async checkQuotas(
    tenantId: string,
    config: TemplateConfiguration,
  ): Promise<void> {
    const subscription = await this.subscriptionsService
      .findByTenantId(tenantId)
      .catch(() => null);

    if (!subscription) {
      throw new BadRequestException(
        'No active subscription found for this tenant — cannot install a template',
      );
    }

    const limits = subscription.limits ?? {};

    // ── Lifetime install budget ───────────────────────────────────────────
    // Counts only INTENTIONAL installs — SUCCESS (still active) and
    // ROLLED_BACK (installed, then deliberately uninstalled).
    //
    // FAILED and INSTALLING are deliberately excluded: a FAILED attempt is
    // rolled back and provisions nothing, so charging lifetime budget for it
    // would let a malformed template configuration permanently burn a tenant's
    // only install slot (on FREE, templateInstallsLifetime is 1). INSTALLING
    // rows are in flight or orphaned by a crash and have likewise created
    // nothing that survived.
    //
    // Uninstalling still does NOT return lifetime budget — ROLLED_BACK counts.
    if (!this.isUnlimited(limits.templateInstallsLifetime)) {
      const lifetimeInstalls = await this.installationRepo.count({
        where: {
          tenantId,
          status: In([
            InstallationStatus.SUCCESS,
            InstallationStatus.ROLLED_BACK,
          ]),
        },
      });
      if (lifetimeInstalls >= limits.templateInstallsLifetime!) {
        throw new ForbiddenException(
          `Your plan allows a maximum of ${limits.templateInstallsLifetime} total template installs. Please upgrade your plan.`,
        );
      }
    }

    // ── Concurrent install budget ─────────────────────────────────────────
    // Only SUCCESS rows occupy a slot, so uninstalling does free one of these.
    if (!this.isUnlimited(limits.maxTemplateInstalls)) {
      const activeInstalls = await this.installationRepo.count({
        where: { tenantId, status: InstallationStatus.SUCCESS },
      });
      if (activeInstalls >= limits.maxTemplateInstalls!) {
        throw new ForbiddenException(
          `Your plan allows a maximum of ${limits.maxTemplateInstalls} active template installations. Uninstall one to install another.`,
        );
      }
    }

    // ── Resource capacity ─────────────────────────────────────────────────
    const totalDevices =
      config.devices?.reduce((sum, d) => sum + (d.count ?? 0), 0) ?? 0;
    const totalDashboards = config.dashboards?.length ?? 0;

    if (totalDevices === 0 && totalDashboards === 0) return;

    const checks: Array<[number, 'devices' | 'dashboards', string]> = [
      [totalDevices, 'devices', 'devices'],
      [totalDashboards, 'dashboards', 'dashboards'],
    ];

    for (const [required, resource, label] of checks) {
      if (required <= 0) continue;
      const remaining = subscription.getRemainingCapacity(resource);
      if (required > remaining) {
        throw new BadRequestException(
          `Installing this template would create ${required} ${label}, ` +
            `but your plan has only ${remaining === Infinity ? 'unlimited' : remaining} remaining. ` +
            `Upgrade your plan or free up capacity first.`,
        );
      }
    }
  }

  // ══════════════════════════════════════════════════════════════════════════
  // DASHBOARD WIDGETS
  //
  // A template's WidgetSpec is a display-level description ('a timeseries chart
  // called Solar Generation, 6×4 at row 0'). What a dashboard actually stores in
  // its `widgets` jsonb column is a DashboardWidgetConfig — the same record
  // POST /dashboards/:id/widgets writes, carrying a real widgetTypeId, the
  // denormalised alias, a flat row/col/width/height and a datasource.
  //
  // install() used to write the WidgetSpec almost verbatim (nested `position`,
  // no widgetTypeId, no datasource). Those rows are unusable to every reader:
  // GET /dashboards/:id/widgets resolves widgetType by widgetTypeId, so it came
  // back null, and getUsedDevices() found nothing to subscribe to. The helpers
  // below reproduce DashboardsService.addWidget()'s output instead.
  // ══════════════════════════════════════════════════════════════════════════

  /**
   * WidgetSpec.type → WidgetType.descriptor.alias.
   *
   * Templates are authored against display names ('status-widget'), the widget
   * library against renderer aliases ('status'). Only entries that cannot be
   * derived mechanically need to be listed here; resolveWidgetType() also tries
   * the raw type, the type minus a '-widget' suffix, '<type>-chart', and the
   * widget type's own name.
   */
  private static readonly WIDGET_TYPE_ALIASES: Record<string, string> = {
    // → timeseries-chart
    timeseries: 'timeseries-chart',
    chart: 'timeseries-chart',
    line: 'timeseries-chart',
    'line-chart': 'timeseries-chart',
    // → value-card
    card: 'value-card',
    stat: 'value-card',
    value: 'value-card',
    // → bar-chart
    bar: 'bar-chart',
    // → pie-chart
    pie: 'pie-chart',
    donut: 'pie-chart',
    // → status
    'status-widget': 'status',
    // → alarm-list
    alarm: 'alarm-list',
    alarms: 'alarm-list',
    'alarm-widget': 'alarm-list',
    // → progress-bar
    progress: 'progress-bar',
    // → switch
    control: 'switch',
  };

  /**
   * Every widget type this tenant may instantiate: the system library
   * (tenantId IS NULL) plus its own. Loaded once per install rather than once
   * per widget.
   */
  private async loadWidgetTypeIndex(
    manager: DataSource['manager'],
    tenantId: string,
  ): Promise<{ byAlias: Map<string, WidgetType>; byName: Map<string, WidgetType> }> {
    const widgetTypes = await manager.find(WidgetType, {
      where: [{ tenantId: IsNull() }, { tenantId }],
    });

    const byAlias = new Map<string, WidgetType>();
    const byName = new Map<string, WidgetType>();

    for (const widgetType of widgetTypes) {
      const alias = widgetType.descriptor?.alias?.trim().toLowerCase();
      if (alias && !byAlias.has(alias)) byAlias.set(alias, widgetType);

      const name = widgetType.name.trim().toLowerCase();
      // 'Timeseries Chart' is reachable as both 'timeseries chart' and
      // 'timeseries-chart', so a template may name either form.
      for (const key of [name, name.replace(/\s+/g, '-')]) {
        if (!byName.has(key)) byName.set(key, widgetType);
      }
    }

    return { byAlias, byName };
  }

  private resolveWidgetType(
    rawType: string,
    index: { byAlias: Map<string, WidgetType>; byName: Map<string, WidgetType> },
  ): WidgetType | undefined {
    const type = (rawType ?? '').trim().toLowerCase();
    if (!type) return undefined;

    const candidates = [
      SolutionTemplatesService.WIDGET_TYPE_ALIASES[type],
      type,
      type.replace(/-widget$/, ''),
      `${type}-chart`,
    ].filter(Boolean) as string[];

    for (const candidate of candidates) {
      const hit = index.byAlias.get(candidate) ?? index.byName.get(candidate);
      if (hit) return hit;
    }
    return undefined;
  }

  /**
   * Which of the devices this installation created a widget should read from.
   *
   * Explicit wins: `deviceName` (matched against the DeviceSpec name the device
   * came from, so a template can say "Battery Storage {n}" without knowing how
   * many were created) then `deviceIndex`. Failing that the widget title is
   * matched against device names — template titles name the thing they show
   * ("Battery State of Charge" → "Battery Storage 1") — and the first created
   * device is the last resort so a widget is never left unbound by accident.
   */
  private resolveWidgetDevice(
    spec: WidgetSpec,
    devices: Array<{ id: string; name: string; specName: string; telemetryKeys: string[] }>,
  ): (typeof devices)[number] | undefined {
    if (!devices.length) return undefined;

    if (spec.deviceName) {
      const wanted = spec.deviceName.trim().toLowerCase();
      const match = devices.find(
        (d) =>
          d.specName.trim().toLowerCase() === wanted ||
          d.name.trim().toLowerCase() === wanted,
      );
      if (match) return match;
    }

    if (typeof spec.deviceIndex === 'number' && devices[spec.deviceIndex]) {
      return devices[spec.deviceIndex];
    }

    const title = (spec.title ?? '').toLowerCase();
    let best: (typeof devices)[number] | undefined;
    let bestScore = 0;
    for (const device of devices) {
      // Score on the device's own name words — trailing {n} indices and short
      // filler words carry no signal.
      const words = device.name
        .toLowerCase()
        .split(/[^a-z]+/)
        .filter((w) => w.length > 2);
      const score = words.filter((w) => title.includes(w)).length;
      if (score > bestScore) {
        best = device;
        bestScore = score;
      }
    }

    return best ?? devices[0];
  }

  /**
   * Turn a dashboard spec's widgets into stored DashboardWidgetConfig records —
   * the same shape DashboardsService.addWidget() produces.
   */
  private buildDashboardWidgets(
    specs: WidgetSpec[],
    index: { byAlias: Map<string, WidgetType>; byName: Map<string, WidgetType> },
    devices: Array<{ id: string; name: string; specName: string; telemetryKeys: string[] }>,
    context: { dashboardName: string; templateId: string },
  ): DashboardWidgetConfig[] {
    const now = new Date().toISOString();
    const widgets: DashboardWidgetConfig[] = [];

    for (const spec of specs) {
      const widgetType = this.resolveWidgetType(spec.type, index);
      if (!widgetType) {
        // Consistent with the rest of install(): an unresolvable reference is
        // warned about and skipped, never a reason to roll back the install.
        this.logger.warn(
          `Template ${context.templateId}: widget type "${spec.type}" ` +
            `("${spec.title}" on dashboard "${context.dashboardName}") matched no ` +
            `widget type — widget skipped`,
        );
        continue;
      }

      const descriptor = widgetType.descriptor ?? ({} as WidgetType['descriptor']);

      // Alarm and static widgets read the tenant, not one device; anything that
      // declares requiresDevice: false opts out the same way.
      const needsDevice =
        spec.bindDevice !== false &&
        descriptor.dataConfig?.requiresDevice !== false &&
        descriptor.type !== 'alarm' &&
        descriptor.type !== 'static';

      const device = needsDevice ? this.resolveWidgetDevice(spec, devices) : undefined;

      const datasource: DashboardWidgetConfig['datasource'] = device
        ? {
            deviceId: device.id,
            // Denormalised at write time, exactly as addWidget() does it.
            deviceName: device.name,
            entityType: 'DEVICE',
            telemetryKeys: spec.telemetryKeys ?? device.telemetryKeys,
            ...(spec.timeWindow ? { timeWindow: spec.timeWindow } : {}),
            ...(spec.aggregation ? { aggregation: spec.aggregation } : {}),
          }
        : {};

      // Identity, geometry and config come from the shared helper — the same
      // call preview() makes — so the two can never drift apart. Only the
      // datasource is install-only: it binds to a device that does not exist
      // until this transaction created it.
      const shared = this.buildWidgetSpec(spec, widgetType);

      widgets.push({
        ...shared,
        widgetTypeId: widgetType.id,
        widgetTypeAlias: shared.widgetTypeAlias!,
        id: crypto.randomUUID(),
        datasource,
        createdAt: now,
        updatedAt: now,
      });
    }

    return widgets;
  }

  // ══════════════════════════════════════════════════════════════════════════
  // INSTALL — real transactional provisioning
  // ══════════════════════════════════════════════════════════════════════════

  async install(
    id: string,
    userId: string,
    tenantId: string,
    customerId: string | undefined,
    dto: InstallTemplateDto,
  ): Promise<InstallResult> {
    const template = await this.findOne(id, tenantId);
    const config = (template.configuration ?? {}) as TemplateConfiguration;

    if (!config || Object.keys(config).length === 0) {
      throw new BadRequestException(
        'This template has no configuration to install',
      );
    }

    // 1. Idempotency — one successful install per template per tenant.
    //    MUST precede the quota check: a repeat install has already consumed
    //    its quota, so checking quota first reports a misleading
    //    "limit exceeded" instead of "already installed".
    const existing = await this.installationRepo.findOne({
      where: { tenantId, templateId: id, status: InstallationStatus.SUCCESS },
    });
    if (existing) {
      throw new ConflictException(
        `Template "${template.name}" is already installed. Installation ID: ${existing.id}`,
      );
    }

    // 2. Pre-flight quota check
    await this.checkQuotas(tenantId, config);

    const installName = dto.installationName ?? template.name;
    const customization = dto.customization ?? {};

    // 3. Installation record (outside the transaction so it survives a rollback)
    const installation = this.installationRepo.create({
      tenantId,
      customerId,
      templateId: id,
      userId,
      createdBy: userId,
      installationName: installName,
      status: InstallationStatus.INSTALLING,
      installedAt: new Date(),
      configuration: config,
      customization,
      createdDeviceIds: [],
      createdDashboardIds: [],
      createdRuleChainIds: [],
      createdAlarmIds: [],
    });
    await this.installationRepo.save(installation);

    // 4. Transactional provisioning
    const queryRunner = this.dataSource.createQueryRunner();
    await queryRunner.connect();
    await queryRunner.startTransaction();

    const createdDeviceIds: string[] = [];
    // Same devices as createdDeviceIds, carrying the name and telemetry keys the
    // dashboard widgets need to bind to them. `specName` is the un-substituted
    // DeviceSpec name, so a WidgetSpec can target "Battery Storage {n}".
    const createdDevices: Array<{
      id: string;
      name: string;
      specName: string;
      telemetryKeys: string[];
    }> = [];
    const createdDashboardIds: string[] = [];
    const createdRuleChainIds: string[] = [];
    const createdAlarmIds: string[] = [];

    const applyPlaceholders = (value: string, index?: number): string =>
      value
        .replace(/\{n\}/g, index === undefined ? '' : String(index + 1))
        .replace(/\{installName\}/g, installName);

    try {
      // ── DEVICES ───────────────────────────────────────────────────────────
      for (const spec of config.devices ?? []) {
        if (!spec.count || spec.count < 1) continue;

        // Resolve the device profile once per spec, not once per device
        let deviceProfileId: string | undefined;
        if (spec.profileName) {
          const profile = await queryRunner.manager.findOne(DeviceProfile, {
            where: { name: spec.profileName, tenantId },
          });
          if (!profile) {
            this.logger.warn(
              `Device profile "${spec.profileName}" not found for tenant ${tenantId} — devices will be created without a profile`,
            );
          }
          deviceProfileId = profile?.id;
        }

        for (let i = 0; i < spec.count; i++) {
          const device = queryRunner.manager.create(Device, {
            // deviceKey is UNIQUE and NOT NULL — mirrors DevicesService.create()
            deviceKey: `dev_${crypto.randomBytes(8).toString('hex')}`,
            name: applyPlaceholders(spec.name, i),
            type: spec.type ?? DeviceType.SENSOR,
            status: spec.status ?? DeviceStatus.INACTIVE,
            protocol: spec.protocol ?? DeviceProtocol.GENERIC_MQTT,
            tenantId,
            userId,
            ...(customerId ? { customerId } : {}),
            ...(deviceProfileId ? { deviceProfileId } : {}),
            metadata: {
              ...(spec.codecId ? { codecId: spec.codecId } : {}),
              ...(spec.label
                ? { label: applyPlaceholders(spec.label, i) }
                : {}),
              ...(spec.defaultTelemetryKeys
                ? { defaultTelemetryKeys: spec.defaultTelemetryKeys }
                : {}),
              installedFromTemplate: id,
              templateName: template.name,
              installationId: installation.id,
            },
          });
          const savedDevice = await queryRunner.manager.save(device);

          const credentials = queryRunner.manager.create(DeviceCredentials, {
            deviceId: savedDevice.id,
            credentialsType: CredentialsType.ACCESS_TOKEN,
            credentialsId: crypto.randomBytes(20).toString('hex'),
            isActive: true,
          });
          await queryRunner.manager.save(credentials);

          createdDeviceIds.push(savedDevice.id);
          createdDevices.push({
            id: savedDevice.id,
            name: savedDevice.name,
            specName: spec.name,
            telemetryKeys: spec.defaultTelemetryKeys ?? [],
          });
        }
      }

      // ── DASHBOARDS ────────────────────────────────────────────────────────
      // The widget library is only read when a dashboard actually declares
      // widgets, so a template without dashboards costs no extra query.
      const widgetTypeIndex = (config.dashboards ?? []).some(
        (d) => (d.widgets ?? []).length > 0,
      )
        ? await this.loadWidgetTypeIndex(queryRunner.manager, tenantId)
        : null;

      for (const dashSpec of config.dashboards ?? []) {
        const dashboardName = applyPlaceholders(dashSpec.name);
        const widgets = widgetTypeIndex
          ? this.buildDashboardWidgets(
              dashSpec.widgets ?? [],
              widgetTypeIndex,
              createdDevices,
              { dashboardName, templateId: id },
            )
          : [];

        const dashboard = queryRunner.manager.create(Dashboard, {
          // Dashboard's column is `name`, not `title`
          name: dashboardName,
          description: dashSpec.description,
          tenantId,
          userId,
          ...(customerId ? { customerId } : {}),
          // Widgets live in their own top-level jsonb column, in the same
          // DashboardWidgetConfig shape POST /dashboards/:id/widgets writes.
          widgets: widgets as any,
          settings: {
            installedFromTemplate: id,
            installationId: installation.id,
          } as any,
          createdBy: userId,
        });
        const savedDash = await queryRunner.manager.save(dashboard);
        createdDashboardIds.push(savedDash.id);
      }

      // ── RULE CHAINS + NODES ───────────────────────────────────────────────
      for (const chainSpec of config.ruleChains ?? []) {
        const chain = queryRunner.manager.create(RuleChain, {
          name: applyPlaceholders(chainSpec.name),
          description: chainSpec.description,
          tenantId,
          userId,
          ...(customerId ? { customerId } : {}),
          status: RuleChainStatus.ACTIVE,
          enabled: true,
          configuration: { messageTypes: chainSpec.messageTypes ?? [] },
          additionalInfo: {
            installedFromTemplate: id,
            installationId: installation.id,
          },
          createdBy: userId,
        });
        const savedChain = await queryRunner.manager.save(chain);
        createdRuleChainIds.push(savedChain.id);

        const nodeIds: string[] = [];
        for (const nodeSpec of chainSpec.nodes ?? []) {
          const node = queryRunner.manager.create(Node, {
            name: nodeSpec.name,
            type: nodeSpec.type,
            ruleChainId: savedChain.id,
            tenantId,
            userId, // Node.userId is NOT NULL
            ...(customerId ? { customerId } : {}),
            configuration: nodeSpec.configuration ?? {}, // NOT NULL
            position: nodeSpec.position ?? { x: 0, y: 0 },
            connections: [],
            createdBy: userId,
          });
          const savedNode = await queryRunner.manager.save(node);
          nodeIds.push(savedNode.id);
        }

        // Wire connections — group by source so a node with several outgoing
        // edges keeps all of them (a per-connection update would overwrite).
        const bySource = new Map<
          number,
          Array<{ targetNodeId: string; connectionType: string }>
        >();
        for (const conn of chainSpec.connections ?? []) {
          const from = nodeIds[conn.fromNodeIndex];
          const to = nodeIds[conn.toNodeIndex];
          if (!from || !to) {
            this.logger.warn(
              `Skipping invalid connection ${conn.fromNodeIndex}->${conn.toNodeIndex} in rule chain "${chainSpec.name}"`,
            );
            continue;
          }
          const list = bySource.get(conn.fromNodeIndex) ?? [];
          list.push({ targetNodeId: to, connectionType: conn.connectionType });
          bySource.set(conn.fromNodeIndex, list);
        }
        for (const [fromIndex, connections] of bySource) {
          await queryRunner.manager.update(
            Node,
            { id: nodeIds[fromIndex] },
            { connections: connections as any },
          );
        }

        if (nodeIds.length > 0) {
          await queryRunner.manager.update(
            RuleChain,
            { id: savedChain.id },
            { rootNodeId: nodeIds[0] },
          );
        }
      }

      // ── ALARMS ────────────────────────────────────────────────────────────
      if ((config.alarms ?? []).length > 0 && createdDeviceIds.length === 0) {
        this.logger.warn(
          `Template ${id} declares alarms but created no devices — alarms skipped`,
        );
      }

      for (const alarmSpec of config.alarms ?? []) {
        let targetDeviceIds: string[] = [];
        if (alarmSpec.deviceSelector === 'all') {
          targetDeviceIds = createdDeviceIds;
        } else if (alarmSpec.deviceSelector === 'first') {
          targetDeviceIds = createdDeviceIds.slice(0, 1);
        } else if (typeof alarmSpec.deviceSelector === 'number') {
          targetDeviceIds = createdDeviceIds.slice(0, alarmSpec.deviceSelector);
        }

        for (const deviceId of targetDeviceIds) {
          // NOTE: Alarm has no userId / additionalInfo columns — provenance
          // goes in `metadata`, ownership in `createdBy` (from BaseEntity).
          const alarm = queryRunner.manager.create(Alarm, {
            name: alarmSpec.name,
            tenantId,
            ...(customerId ? { customerId } : {}),
            deviceId,
            severity: alarmSpec.severity,
            rule: {
              telemetryKey: alarmSpec.telemetryKey,
              condition: alarmSpec.condition,
              value: alarmSpec.value,
              ...(alarmSpec.value2 !== undefined
                ? { value2: alarmSpec.value2 }
                : {}),
            },
            isEnabled: true,
            metadata: {
              installedFromTemplate: id,
              installationId: installation.id,
            },
            createdBy: userId,
          });
          const savedAlarm = await queryRunner.manager.save(alarm);
          createdAlarmIds.push(savedAlarm.id);
        }
      }

      await queryRunner.commitTransaction();
    } catch (error) {
      await queryRunner.rollbackTransaction();

      installation.status = InstallationStatus.FAILED;
      installation.error =
        error instanceof Error ? error.message : String(error);
      installation.completedAt = new Date();
      await this.installationRepo.save(installation);

      this.logger.error(
        `Template installation ${installation.id} failed and was rolled back: ${installation.error}`,
      );

      throw new InternalServerErrorException(
        `Template installation failed and was rolled back: ${installation.error}`,
      );
    } finally {
      await queryRunner.release();
    }

    // 5. Post-commit bookkeeping
    installation.status = InstallationStatus.SUCCESS;
    installation.completedAt = new Date();
    installation.createdDeviceIds = createdDeviceIds;
    installation.createdDashboardIds = createdDashboardIds;
    installation.createdRuleChainIds = createdRuleChainIds;
    installation.createdAlarmIds = createdAlarmIds;
    await this.installationRepo.save(installation);

    // Keep the denormalised quota counters honest — checkQuotas() reads these.
    if (createdDeviceIds.length) {
      await this.subscriptionsService.incrementTenantUsage(
        tenantId,
        'devices',
        createdDeviceIds.length,
      );
    }
    if (createdDashboardIds.length) {
      await this.subscriptionsService.incrementTenantUsage(
        tenantId,
        'dashboards',
        createdDashboardIds.length,
      );
    }

    template.installs += 1;
    await this.templateRepository.save(template);

    this.logger.log(
      `Template ${template.name} installed (${installation.id}): ` +
        `${createdDeviceIds.length} devices, ${createdDashboardIds.length} dashboards, ` +
        `${createdRuleChainIds.length} rule chains, ${createdAlarmIds.length} alarms`,
    );

    return {
      success: true,
      installationId: installation.id,
      installationName: installation.installationName,
      templateName: template.name,
      devicesCreated: createdDeviceIds.length,
      dashboardsCreated: createdDashboardIds.length,
      ruleChainsCreated: createdRuleChainIds.length,
      alarmsCreated: createdAlarmIds.length,
      deviceIds: createdDeviceIds,
      dashboardIds: createdDashboardIds,
      ruleChainIds: createdRuleChainIds,
      alarmIds: createdAlarmIds,
    };
  }

  // ══════════════════════════════════════════════════════════════════════════
  // UNINSTALL — best-effort teardown of everything an installation created
  //
  // Runs inside one transaction, but each resource group gets its own SAVEPOINT
  // so a failure in one group does not poison the rest. A plain try/catch would
  // not be enough here: in Postgres the first error aborts the whole
  // transaction and every subsequent statement fails with
  // "current transaction is aborted" — which would turn "best-effort" into
  // "all-or-nothing" without the savepoints.
  //
  // Deletes are soft (deleted_at), matching the platform-wide convention.
  // The installation is marked ROLLED_BACK whether or not every group
  // succeeded; any failures are recorded on `error` for later inspection.
  // ══════════════════════════════════════════════════════════════════════════

  async uninstall(
    installationId: string,
    tenantId: string,
  ): Promise<{ success: boolean; message: string; resourcesRemoved: number }> {
    // 1. Locate the installation — tenant-scoped, and only a successful install
    //    can be torn down (an INSTALLING/FAILED/ROLLED_BACK row has nothing to
    //    remove, or is already gone).
    const installation = await this.installationRepo.findOne({
      where: {
        id: installationId,
        tenantId,
        status: InstallationStatus.SUCCESS,
      },
    });

    if (!installation) {
      throw new NotFoundException(
        'Installation not found or already uninstalled',
      );
    }

    const deviceIds = installation.createdDeviceIds ?? [];
    const dashboardIds = installation.createdDashboardIds ?? [];
    const ruleChainIds = installation.createdRuleChainIds ?? [];
    const alarmIds = installation.createdAlarmIds ?? [];

    const queryRunner = this.dataSource.createQueryRunner();
    await queryRunner.connect();
    await queryRunner.startTransaction();

    let resourcesRemoved = 0;
    let devicesRemoved = 0;
    let dashboardsRemoved = 0;
    const failures: string[] = [];
    let savepointSeq = 0;

    /**
     * Runs one deletion group under its own savepoint.
     * Returns the number of rows affected, or 0 if the group failed.
     */
    const step = async (
      label: string,
      fn: () => Promise<number>,
    ): Promise<number> => {
      const savepoint = `sp_uninstall_${++savepointSeq}`;
      await queryRunner.query(`SAVEPOINT ${savepoint}`);
      try {
        const affected = await fn();
        await queryRunner.query(`RELEASE SAVEPOINT ${savepoint}`);
        return affected;
      } catch (error) {
        await queryRunner.query(`ROLLBACK TO SAVEPOINT ${savepoint}`);
        const message = error instanceof Error ? error.message : String(error);
        failures.push(`${label}: ${message}`);
        this.logger.error(
          `Uninstall ${installationId} — failed to remove ${label}: ${message}`,
        );
        return 0;
      }
    };

    try {
      // ── DEVICES (+ their credentials) ─────────────────────────────────────
      if (deviceIds.length) {
        // Credentials first — they are dependents of the device and carry no
        // tenantId of their own, so they are scoped via deviceId.
        await step('device credentials', async () => {
          const result = await queryRunner.manager.softDelete(
            DeviceCredentials,
            { deviceId: In(deviceIds) },
          );
          return result.affected ?? 0;
        });

        devicesRemoved = await step('devices', async () => {
          const result = await queryRunner.manager.softDelete(Device, {
            id: In(deviceIds),
            tenantId,
          });
          return result.affected ?? 0;
        });
        resourcesRemoved += devicesRemoved;
      }

      // ── DASHBOARDS ────────────────────────────────────────────────────────
      if (dashboardIds.length) {
        dashboardsRemoved = await step('dashboards', async () => {
          const result = await queryRunner.manager.softDelete(Dashboard, {
            id: In(dashboardIds),
            tenantId,
          });
          return result.affected ?? 0;
        });
        resourcesRemoved += dashboardsRemoved;
      }

      // ── RULE CHAINS (+ their nodes) ───────────────────────────────────────
      if (ruleChainIds.length) {
        // Nodes are children of the chain; install() never records their ids
        // individually, so they are removed by ruleChainId.
        await step('rule nodes', async () => {
          const result = await queryRunner.manager.softDelete(Node, {
            ruleChainId: In(ruleChainIds),
            tenantId,
          });
          return result.affected ?? 0;
        });

        resourcesRemoved += await step('rule chains', async () => {
          const result = await queryRunner.manager.softDelete(RuleChain, {
            id: In(ruleChainIds),
            tenantId,
          });
          return result.affected ?? 0;
        });
      }

      // ── ALARMS ────────────────────────────────────────────────────────────
      if (alarmIds.length) {
        resourcesRemoved += await step('alarms', async () => {
          const result = await queryRunner.manager.softDelete(Alarm, {
            id: In(alarmIds),
            tenantId,
          });
          return result.affected ?? 0;
        });
      }

      await queryRunner.commitTransaction();
    } catch (error) {
      // Only reached if the transaction machinery itself fails — the per-group
      // savepoints already absorb individual deletion errors.
      await queryRunner.rollbackTransaction();
      const message = error instanceof Error ? error.message : String(error);
      this.logger.error(
        `Uninstall ${installationId} aborted before commit: ${message}`,
      );
      throw new InternalServerErrorException(
        `Uninstall failed: ${message}`,
      );
    } finally {
      await queryRunner.release();
    }

    // 3. Mark the installation ROLLED_BACK regardless of partial failures —
    //    the resources it owned are gone (or unrecoverable), so it must not be
    //    uninstallable a second time, and the template becomes installable again.
    installation.status = InstallationStatus.ROLLED_BACK;
    installation.completedAt = new Date();
    installation.error = failures.length
      ? `Uninstalled with errors: ${failures.join('; ')}`
      : undefined;
    await this.installationRepo.save(installation);

    // 4. Give the quota back. Uses the counts actually soft-deleted rather than
    //    the recorded id counts, so a partial teardown does not over-credit.
    if (devicesRemoved > 0) {
      await this.subscriptionsService.decrementTenantUsage(
        tenantId,
        'devices',
        devicesRemoved,
      );
    }
    if (dashboardsRemoved > 0) {
      await this.subscriptionsService.decrementTenantUsage(
        tenantId,
        'dashboards',
        dashboardsRemoved,
      );
    }

    const message = failures.length
      ? `Installation "${installation.installationName}" uninstalled with ${failures.length} error(s); ${resourcesRemoved} resource(s) removed`
      : `Installation "${installation.installationName}" uninstalled; ${resourcesRemoved} resource(s) removed`;

    this.logger.log(`Uninstall ${installationId}: ${message}`);

    return { success: failures.length === 0, message, resourcesRemoved };
  }

  // ── Installations ─────────────────────────────────────────────────────────

  async getInstallations(
    templateId: string,
    tenantId: string,
  ): Promise<TemplateInstallation[]> {
    // Ensures the template is visible to this tenant before listing
    await this.findOne(templateId, tenantId);

    return this.installationRepo.find({
      where: { templateId, tenantId },
      order: { installedAt: 'DESC' },
    });
  }

  /**
   * Every installation belonging to this tenant, across all templates.
   * The source template's identity is joined in so the caller does not need a
   * second round-trip per row.
   */
  async getMyInstallations(
    tenantId: string,
    page = 1,
    limit = 20,
  ): Promise<PaginatedResponseDto<TemplateInstallation>> {
    const skip = (page - 1) * limit;

    const [data, total] = await this.installationRepo
      .createQueryBuilder('installation')
      .leftJoin('installation.template', 'template')
      .addSelect([
        'template.id',
        'template.name',
        'template.category',
        'template.icon',
      ])
      .where('installation.tenantId = :tenantId', { tenantId })
      .orderBy('installation.installedAt', 'DESC')
      .skip(skip)
      .take(limit)
      .getManyAndCount();

    return PaginatedResponseDto.create(data, page, limit, total);
  }

  // ── Categories / statistics ───────────────────────────────────────────────

  async getCategories(
    tenantId: string,
  ): Promise<{ category: string; name: string; icon: string; count: number }[]> {
    const qb = this.templateRepository
      .createQueryBuilder('template')
      .select('template.category', 'category')
      .addSelect('COUNT(*)', 'count')
      .groupBy('template.category');
    this.applyVisibility(qb, tenantId);

    const categoryCounts = await qb.getRawMany();

    const categoryMap = categoryCounts.reduce(
      (acc, item) => {
        acc[item.category] = parseInt(item.count, 10);
        return acc;
      },
      {} as Record<string, number>,
    );

    const categories = [
      // Categories used by the 8 system templates
      { category: TemplateCategory.SMART_HOME, name: 'Smart Home', icon: 'home' },
      { category: TemplateCategory.SMART_BUILDING, name: 'Smart Building', icon: 'building' },
      { category: TemplateCategory.SMART_CITY, name: 'Smart City', icon: 'city' },
      { category: TemplateCategory.SMART_AGRICULTURE, name: 'Smart Agriculture', icon: 'plant' },
      { category: TemplateCategory.SMART_ENERGY, name: 'Smart Energy', icon: 'battery' },
      { category: TemplateCategory.SMART_RETAIL, name: 'Smart Retail', icon: 'shopping-cart' },
      { category: TemplateCategory.SMART_WATER, name: 'Smart Water Management', icon: 'droplet' },
      { category: TemplateCategory.SMART_FACILITY, name: 'Smart Facility', icon: 'tools' },
      // Legacy categories — still selectable for custom templates
      { category: TemplateCategory.SMART_FACTORY, name: 'Smart Factory', icon: 'factory' },
      { category: TemplateCategory.SMART_HEALTHCARE, name: 'Healthcare', icon: 'hospital' },
      { category: TemplateCategory.SMART_LOGISTICS, name: 'Logistics', icon: 'truck' },
      { category: TemplateCategory.SMART_CLIMATE, name: 'Climate Control', icon: 'thermometer' },
    ];

    return categories.map((cat) => ({
      ...cat,
      count: categoryMap[cat.category] || 0,
    }));
  }

  async getStatistics(tenantId: string) {
    const base = () =>
      this.applyVisibility(
        this.templateRepository.createQueryBuilder('template'),
        tenantId,
      );

    const [total, premium, systemTemplates] = await Promise.all([
      base().getCount(),
      base().andWhere('template.isPremium = true').getCount(),
      base().andWhere('template.isSystem = true').getCount(),
    ]);

    const totalInstalls = await base()
      .select('SUM(template.installs)', 'total')
      .getRawOne();

    const byCategoryResult = await base()
      .select('template.category', 'category')
      .addSelect('COUNT(*)', 'count')
      .groupBy('template.category')
      .getRawMany();

    const byCategory = byCategoryResult.reduce(
      (acc, item) => {
        acc[item.category] = parseInt(item.count, 10);
        return acc;
      },
      {} as Record<string, number>,
    );

    const popular = await base()
      .orderBy('template.installs', 'DESC')
      .addOrderBy('template.rating', 'DESC')
      .take(5)
      .getMany();

    return {
      total,
      premium,
      free: total - premium,
      systemTemplates,
      userTemplates: total - systemTemplates,
      totalInstalls: parseInt(totalInstalls?.total || '0', 10),
      byCategory,
      popular: popular.map((t) => ({
        id: t.id,
        name: t.name,
        category: t.category,
        installs: t.installs,
        rating: t.rating,
      })),
    };
  }

  // ── Rating ────────────────────────────────────────────────────────────────

  async rateTemplate(
    id: string,
    userId: string,
    tenantId: string,
    rating: number,
  ): Promise<SolutionTemplate> {
    if (typeof rating !== 'number' || Number.isNaN(rating)) {
      throw new BadRequestException('Rating must be a number');
    }
    if (rating < 0 || rating > 5) {
      throw new BadRequestException('Rating must be between 0 and 5');
    }

    const template = await this.findOne(id, tenantId);

    // One rating per user — re-rating replaces the previous value
    const ratings = { ...(template.ratings ?? {}) };
    ratings[userId] = rating;

    const values = Object.values(ratings);
    const average = values.reduce((sum, r) => sum + r, 0) / values.length;

    template.ratings = ratings;
    template.ratingCount = values.length;
    // decimal(3,2) — keep 2dp so the stored value round-trips exactly
    template.rating = Math.round(average * 100) / 100;
    template.updatedBy = userId;

    return await this.templateRepository.save(template);
  }
}
