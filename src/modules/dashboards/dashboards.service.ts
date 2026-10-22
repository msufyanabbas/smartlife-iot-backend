import {
  Injectable,
  NotFoundException,
  ForbiddenException,
  BadRequestException,
  Logger,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { EntityManager, In, Repository, SelectQueryBuilder } from 'typeorm';
import { randomUUID } from 'crypto';
import { Dashboard } from './entities/dashboard.entity';
import { DashboardVisibility, UserRole } from '@common/enums/index.enum';
import {
  CreateDashboardDto,
  UpdateDashboardDto,
  DashboardQueryDto,
  ShareDashboardDto,
  CloneDashboardDto,
} from './dto/dashboard.dto';
import {
  AddWidgetDto,
  UpdateWidgetDto,
  UpdateLayoutDto,
} from './dto/dashboard-widget.dto';
import type {
  DashboardWidgetConfig,
  EnrichedDashboardWidget,
} from './interfaces/dashboard-widget.interface';
import { User } from '../index.entities';
import { PaginatedResponseDto } from '@common/dto/pagination.dto';
import { WidgetType } from '@modules/widgets/entities/widget-type.entity';
import { Device } from '@modules/devices/entities/device.entity';
import { WebsocketGateway } from '@modules/websocket/websocket.gateway';
import { SubscriptionsService } from '@modules/subscriptions/subscriptions.service';
import {
  applyAccessScope,
  isCustomerScopedRole,
} from '@common/scoping/apply-access-scope';

@Injectable()
export class DashboardsService {
  private readonly logger = new Logger(DashboardsService.name);

  constructor(
    @InjectRepository(Dashboard)
    private readonly dashboardRepository: Repository<Dashboard>,
    // WidgetType and Device are read directly rather than by importing
    // WidgetsModule / DevicesModule — those would create module cycles, and the
    // repository is all this service needs. Same pattern as FloorPlansService.
    @InjectRepository(WidgetType)
    private readonly widgetTypeRepository: Repository<WidgetType>,
    @InjectRepository(Device)
    private readonly deviceRepository: Repository<Device>,
    private readonly websocketGateway: WebsocketGateway,
    // SubscriptionsModule is @Global(), so the service is injectable without
    // importing the module here — which also avoids a cycle, since
    // SubscriptionsService is what keeps the dashboards quota counter honest.
    private readonly subscriptionsService: SubscriptionsService,
  ) {}

  // ── Create ────────────────────────────────────────────────────────────────

  async create(user: User, createDto: CreateDashboardDto): Promise<Dashboard> {
    // randomUUID(), not uuidv4() — both produce a valid v4, but every other
    // widget-id site in the codebase uses node:crypto, and one generator is
    // easier to keep correct than two.
    const widgets = (createDto.widgets ?? []).map((w) => ({ ...w, id: randomUUID() }));

    const dashboard = this.dashboardRepository.create({
      ...createDto,
      userId: user.id,
      tenantId: user.tenantId,
      customerId:
        user.role === UserRole.CUSTOMER_USER ? user.customerId : createDto.customerId,
      widgets: widgets as any,
    });

    const saved = await this.dashboardRepository.save(dashboard);

    // Keep subscription.usage.dashboards honest — it is what
    // SubscriptionLimitGuard and GET /subscriptions/usage both read.
    // Non-fatal: the dashboard exists, so a counter failure must not fail the
    // request.
    try {
      await this.subscriptionsService.incrementTenantUsage(
        saved.tenantId,
        'dashboards',
        1,
      );
    } catch (err) {
      this.logger.error(
        `Failed to increment dashboards usage for tenant ${saved.tenantId}`,
        err,
      );
    }

    return saved;
  }

  // ── Scoping ───────────────────────────────────────────────────────────────

  /**
   * The caller's tenant/customer scope, plus the dashboard sharing rule.
   *
   * One place, used by every read path in this service, so the list, the
   * default lookup and the detail read cannot disagree about who sees what —
   * which is exactly how `findAll` ended up tenant-less while `findOne` was
   * tenant-scoped.
   *
   * · tenant: always, from `applyAccessScope` — a falsy tenantId denies.
   * · customer-scoped roles (CUSTOMER and CUSTOMER_USER alike): their own
   *   customer's dashboards, their own dashboards, and the tenant's PUBLIC
   *   ones. A falsy customerId denies rather than widening.
   * · a plain tenant USER / TENANT_ADMIN: the whole tenant, which for a
   *   LISTING is then narrowed by `restrictListingToOwn()`.
   * · SUPER_ADMIN: everything.
   */
  private static applyDashboardScope(
    qb: SelectQueryBuilder<Dashboard>,
    user: User,
  ): void {
    applyAccessScope(qb, 'dashboard', user, {
      alsoVisible: {
        sql:
          '(dashboard.userId = :scopeOwnUserId ' +
          'OR dashboard.visibility = :scopePublicVisibility)',
        params: {
          scopeOwnUserId: user.id,
          scopePublicVisibility: DashboardVisibility.PUBLIC,
        },
      },
    });
  }

  /**
   * A plain tenant-level user LISTS its own dashboards, not every
   * colleague's — which is what it did before this change, minus the missing
   * tenant predicate.
   *
   * Applied to the list and the default lookup only, never to the read by id:
   * `checkAccess()` has always let any tenant user open a PUBLIC or
   * explicitly shared dashboard by id, and narrowing that here would take a
   * working feature away rather than close a hole.
   */
  private static restrictListingToOwn(
    qb: SelectQueryBuilder<Dashboard>,
    user: User,
  ): void {
    if (user.role === UserRole.USER) {
      qb.andWhere('dashboard.userId = :scopeOwnUserId', {
        scopeOwnUserId: user.id,
      });
    }
  }

  // ── Find all ──────────────────────────────────────────────────────────────

  async findAll(
    user: User,
    query: DashboardQueryDto,
  ): Promise<PaginatedResponseDto<Dashboard>> {
    const { page = 1, limit = 10, search, visibility, isFavorite, tags } = query;

    const qb = this.dashboardRepository.createQueryBuilder('dashboard');

    // THE LEAK THIS CLOSES: the CUSTOMER_USER branch here was
    // `userId OR customerId OR visibility = PUBLIC` with NO tenant predicate,
    // so every PUBLIC dashboard of every tenant on the platform was listed to
    // every customer user. And `UserRole.CUSTOMER` — a customer ADMIN — fell
    // into the last branch and matched its own `userId` only, so it could not
    // see the dashboards assigned to its own customer at all. Both come from
    // the same shared helper now: the tenant predicate is unconditional, and
    // CUSTOMER gets the same customer-scoped branch as CUSTOMER_USER.
    //
    // `alsoVisible` carries the part of the rule that is specific to
    // dashboards — an owner always sees their own, and PUBLIC means
    // tenant-wide — which is why it is expressed here and not in the helper.
    // It can only widen WITHIN the tenant, and a customer-scoped caller with
    // no customerId is still denied everything before it is reached.
    DashboardsService.applyDashboardScope(qb, user);
    DashboardsService.restrictListingToOwn(qb, user);

    if (visibility) {
      qb.andWhere('dashboard.visibility = :visibility', { visibility });
    }

    if (search) {
      qb.andWhere(
        '(dashboard.name ILIKE :search OR dashboard.description ILIKE :search)',
        { search: `%${search}%` },
      );
    }

    if (isFavorite !== undefined) {
      qb.andWhere('dashboard.isFavorite = :isFavorite', { isFavorite });
    }

    if (tags && tags.length > 0) {
      qb.andWhere('dashboard.tags && :tags', { tags });
    }

    qb.skip((page - 1) * limit)
      .take(limit)
      .orderBy('dashboard.lastViewedAt', 'DESC', 'NULLS LAST')
      .addOrderBy('dashboard.updatedAt', 'DESC');

    const [data, total] = await qb.getManyAndCount();

    return PaginatedResponseDto.create(data, page, limit, total);
  }

  // ── Find one ──────────────────────────────────────────────────────────────

  async findOne(id: string, user: User): Promise<Dashboard> {
    // `findOne({ where: { id, tenantId: user.tenantId } })` looks scoped and
    // is not: TypeORM DROPS a `where` property whose value is undefined, so a
    // caller with no tenantId was reading by id alone across every tenant.
    // The shared helper denies that case explicitly.
    const qb = this.dashboardRepository
      .createQueryBuilder('dashboard')
      .where('dashboard.id = :id', { id });

    DashboardsService.applyDashboardScope(qb, user);

    const dashboard = await qb.getOne();

    if (!dashboard) {
      throw new NotFoundException(`Dashboard ${id} not found`);
    }

    if (!this.checkAccess(dashboard, user)) {
      throw new ForbiddenException('You do not have access to this dashboard');
    }

    // Update view stats (fire and forget — don't block the response)
    void this.dashboardRepository.update(id, {
      viewCount: () => '"viewCount" + 1',
      lastViewedAt: new Date(),
    });

    return dashboard;
  }

  // ── Default ───────────────────────────────────────────────────────────────

  async getDefault(user: User): Promise<Dashboard | null> {
    const qb = this.dashboardRepository
      .createQueryBuilder('dashboard')
      .where('dashboard.isDefault = true');

    // Same scope as the list — this was a fourth copy of the same branching,
    // and it had the same missing tenant predicate for a customer user.
    DashboardsService.applyDashboardScope(qb, user);
    DashboardsService.restrictListingToOwn(qb, user);

    return qb.getOne();
  }

  // ── Update ────────────────────────────────────────────────────────────────

  async update(id: string, user: User, updateDto: UpdateDashboardDto): Promise<Dashboard> {
    const dashboard = await this.findOne(id, user);

    if (dashboard.userId !== user.id) {
      throw new ForbiddenException('Only the dashboard owner can update it');
    }

    if (updateDto.isDefault) {
      await this.dashboardRepository.update(
        { userId: user.id, isDefault: true },
        { isDefault: false },
      );
    }

    // Belt-and-braces: UpdateDashboardDto no longer declares `widgets`, but this
    // is a blind assign onto the entity, so anything that reaches it with a
    // `widgets` key would replace the whole jsonb array in one shot. Widgets are
    // only ever changed through the per-widget endpoints.
    const { widgets: _ignored, ...safeUpdate } = updateDto as UpdateDashboardDto & {
      widgets?: unknown;
    };

    Object.assign(dashboard, safeUpdate);
    return this.dashboardRepository.save(dashboard);
  }

  // ── Delete ────────────────────────────────────────────────────────────────

  async remove(id: string, user: User): Promise<void> {
    const dashboard = await this.findOne(id, user);

    if (
      dashboard.userId !== user.id &&
      user.role !== UserRole.SUPER_ADMIN &&
      user.role !== UserRole.TENANT_ADMIN
    ) {
      throw new ForbiddenException('Only the owner or admins can delete this dashboard');
    }

    await this.dashboardRepository.softRemove(dashboard);

    try {
      await this.subscriptionsService.decrementTenantUsage(
        dashboard.tenantId,
        'dashboards',
        1,
      );
    } catch (err) {
      this.logger.error(
        `Failed to decrement dashboards usage for tenant ${dashboard.tenantId}`,
        err,
      );
    }
  }

  // ── Widget management ─────────────────────────────────────────────────────
  // When widgets are added or removed, we notify the WebSocket gateway so the
  // frontend can subscribe/unsubscribe from the relevant device rooms.

  /**
   * Owner-or-admin check for any write to a dashboard's widgets.
   *
   * findOne() already enforces read access; this is the narrower write gate.
   * TENANT_ADMIN and SUPER_ADMIN are allowed through so an admin can fix a
   * dashboard belonging to one of their users — matching remove()'s rule.
   */
  private assertCanEdit(dashboard: Dashboard, user: User): void {
    if (
      dashboard.userId !== user.id &&
      user.role !== UserRole.SUPER_ADMIN &&
      user.role !== UserRole.TENANT_ADMIN
    ) {
      throw new ForbiddenException(
        'Only the dashboard owner or an admin can modify its widgets',
      );
    }
  }

  /** The widgets column typed as the flat dashboard-widget shape. */
  private widgetsOf(dashboard: Dashboard): DashboardWidgetConfig[] {
    return (dashboard.widgets ?? []) as unknown as DashboardWidgetConfig[];
  }

  /**
   * Loads a dashboard for a widget write, holding a row lock until the
   * surrounding transaction commits.
   *
   * `widgets` is a single jsonb column, so every widget mutation is a
   * read-modify-write of the whole array: read it, change one entry, write it
   * all back. Without the lock two overlapping requests both read the same
   * array and the second write silently discards the first one's widget —
   * which is how widgets "disappeared" when the editor fired several calls at
   * once (add two widgets, or drag several and save). SELECT … FOR UPDATE
   * serialises them, so the array we write is always the current one with
   * exactly the intended entry changed.
   *
   * Deliberately not findOne(): that bumps viewCount as a side effect, and a
   * widget write is not a dashboard view. It also fires that increment without
   * awaiting it, which would contend with this very lock.
   */
  private async loadForWidgetWrite(
    manager: EntityManager,
    id: string,
    user: User,
  ): Promise<Dashboard> {
    // A falsy tenantId would be dropped from this `where` by TypeORM, leaving
    // a lookup by id alone, so it is refused before the query runs. (The
    // query itself cannot go through applyAccessScope: a locking read needs
    // the entity manager's findOne, not a query builder.)
    if (user.role !== UserRole.SUPER_ADMIN && !user.tenantId) {
      throw new NotFoundException(`Dashboard ${id} not found`);
    }

    const dashboard = await manager.findOne(Dashboard, {
      where:
        user.role === UserRole.SUPER_ADMIN
          ? { id }
          : { id, tenantId: user.tenantId },
      lock: { mode: 'pessimistic_write' },
    });

    if (!dashboard) {
      throw new NotFoundException(`Dashboard ${id} not found`);
    }

    if (!this.checkAccess(dashboard, user)) {
      throw new ForbiddenException('You do not have access to this dashboard');
    }

    this.assertCanEdit(dashboard, user);

    return dashboard;
  }

  private async loadWidgetType(widgetTypeId: string): Promise<WidgetType> {
    const widgetType = await this.widgetTypeRepository.findOne({
      where: { id: widgetTypeId },
    });
    if (!widgetType) {
      throw new NotFoundException(`Widget type ${widgetTypeId} not found`);
    }
    return widgetType;
  }

  /**
   * Resolves a datasource's deviceId to a device in the caller's tenant.
   * Cross-tenant ids are rejected rather than silently stored, so a widget can
   * never reference a device its viewers are not allowed to see.
   */
  private async resolveDevice(
    deviceId: string,
    tenantId: string,
  ): Promise<Device> {
    const device = await this.deviceRepository.findOne({
      where: { id: deviceId, tenantId },
    });
    if (!device) {
      throw new BadRequestException(
        `Device ${deviceId} not found in this tenant`,
      );
    }
    return device;
  }

  async addWidget(
    id: string,
    user: User,
    dto: AddWidgetDto,
  ): Promise<Dashboard> {
    // Resolved before the transaction opens: it does not depend on the
    // dashboard, and an unknown widget type should 404 without taking a lock.
    const widgetType = await this.loadWidgetType(dto.widgetTypeId);
    const descriptor = widgetType.descriptor ?? ({} as any);

    const { saved, widget } = await this.dashboardRepository.manager.transaction(
      async (manager) => {
        const dashboard = await this.loadForWidgetWrite(manager, id, user);

        const datasource: DashboardWidgetConfig['datasource'] = {
          ...(dto.datasource ?? {}),
        };
        if (datasource.deviceId) {
          const device = await this.resolveDevice(
            datasource.deviceId,
            dashboard.tenantId,
          );
          datasource.deviceName = device.name;
          datasource.entityType = datasource.entityType ?? 'DEVICE';
        }

        const now = new Date().toISOString();
        const widget: DashboardWidgetConfig = {
          id: randomUUID(),
          widgetTypeId: widgetType.id,
          widgetTypeAlias: descriptor.alias ?? widgetType.name,
          title: dto.title,
          row: dto.row ?? 0,
          col: dto.col ?? 0,
          // Fall back to the widget type's natural size rather than an arbitrary 1×1
          width: dto.width ?? descriptor.sizeX ?? 4,
          height: dto.height ?? descriptor.sizeY ?? 3,
          datasource,
          // defaultConfig first so caller overrides win, key by key
          config: { ...(descriptor.defaultConfig ?? {}), ...(dto.config ?? {}) },
          createdAt: now,
          updatedAt: now,
        };

        // Append to the widgets read under the lock — never to a copy captured
        // before another request may have written.
        dashboard.widgets = [
          ...this.widgetsOf(dashboard),
          widget,
        ] as unknown as Dashboard['widgets'];

        const saved = await manager.save(Dashboard, dashboard);
        return { saved, widget };
      },
    );

    // Broadcast after commit so clients are never told about a rolled-back write.
    // Notify connected clients that this dashboard's device list changed.
    // The frontend should re-evaluate which device rooms to subscribe to.
    this.websocketGateway.broadcastDashboardUpdate(id, {
      action: 'widget_added',
      widgetId: widget.id,
      usedDevices: saved.getUsedDevices(),
    });

    return saved;
  }

  async updateWidget(
    id: string,
    widgetId: string,
    user: User,
    dto: UpdateWidgetDto,
  ): Promise<DashboardWidgetConfig> {
    const { saved, updated } = await this.dashboardRepository.manager.transaction(
      async (manager) => {
        const dashboard = await this.loadForWidgetWrite(manager, id, user);

        const widgets = this.widgetsOf(dashboard);
        const index = widgets.findIndex((w) => w.id === widgetId);
        if (index === -1) {
          throw new NotFoundException(
            `Widget ${widgetId} not found on dashboard ${id}`,
          );
        }

        const current = widgets[index];

        // datasource and config merge one level deep so a partial update does not
        // wipe sibling keys; everything else is a straight replace.
        const datasource = dto.datasource
          ? { ...current.datasource, ...dto.datasource }
          : current.datasource;

        if (dto.datasource?.deviceId) {
          const device = await this.resolveDevice(
            dto.datasource.deviceId,
            dashboard.tenantId,
          );
          datasource.deviceName = device.name;
          datasource.entityType = datasource.entityType ?? 'DEVICE';
        }

        const updated: DashboardWidgetConfig = {
          ...current,
          title: dto.title ?? current.title,
          row: dto.row ?? current.row,
          col: dto.col ?? current.col,
          width: dto.width ?? current.width,
          height: dto.height ?? current.height,
          datasource,
          config: dto.config
            ? { ...current.config, ...dto.config }
            : current.config,
          updatedAt: new Date().toISOString(),
        };

        // Replace the one entry at its index; every sibling is carried through
        // untouched.
        widgets[index] = updated;
        dashboard.widgets = [...widgets] as unknown as Dashboard['widgets'];

        const saved = await manager.save(Dashboard, dashboard);
        return { saved, updated };
      },
    );

    this.websocketGateway.broadcastDashboardUpdate(id, {
      action: 'widget_updated',
      widgetId,
      usedDevices: saved.getUsedDevices(),
    });

    return updated;
  }

  async removeWidget(
    id: string,
    widgetId: string,
    user: User,
  ): Promise<{ removed: boolean; widgetId: string }> {
    const saved = await this.dashboardRepository.manager.transaction(
      async (manager) => {
        const dashboard = await this.loadForWidgetWrite(manager, id, user);

        const widgets = this.widgetsOf(dashboard);
        const remaining = widgets.filter((w) => w.id !== widgetId);
        if (remaining.length === widgets.length) {
          throw new NotFoundException(
            `Widget ${widgetId} not found on dashboard ${id}`,
          );
        }

        dashboard.widgets = remaining as unknown as Dashboard['widgets'];
        return manager.save(Dashboard, dashboard);
      },
    );

    this.websocketGateway.broadcastDashboardUpdate(id, {
      action: 'widget_removed',
      widgetId,
      usedDevices: saved.getUsedDevices(),
    });

    return { removed: true, widgetId };
  }

  /**
   * Every widget on the dashboard with its WidgetType and Device resolved.
   *
   * Both lookups are batched — one query for all referenced widget types, one
   * for all referenced devices — so a 30-widget dashboard costs 3 queries, not
   * 61. A widget whose type or device has since been deleted comes back with
   * that field null rather than being dropped, so the editor can show it as
   * broken instead of silently losing it.
   */
  async getWidgets(
    id: string,
    user: User,
  ): Promise<EnrichedDashboardWidget[]> {
    const dashboard = await this.findOne(id, user);
    const widgets = this.widgetsOf(dashboard);
    if (!widgets.length) return [];

    const widgetTypeIds = [
      ...new Set(widgets.map((w) => w.widgetTypeId).filter(Boolean)),
    ];
    const deviceIds = [
      ...new Set(
        widgets.map((w) => w.datasource?.deviceId).filter(Boolean) as string[],
      ),
    ];

    const [widgetTypes, devices] = await Promise.all([
      widgetTypeIds.length
        ? this.widgetTypeRepository.find({ where: { id: In(widgetTypeIds) } })
        : Promise.resolve([] as WidgetType[]),
      deviceIds.length
        ? this.deviceRepository.find({
            where: { id: In(deviceIds), tenantId: dashboard.tenantId },
          })
        : Promise.resolve([] as Device[]),
    ]);

    const typeMap = new Map(widgetTypes.map((t) => [t.id, t]));
    const deviceMap = new Map(devices.map((d) => [d.id, d]));

    return widgets.map((widget) => {
      const type = typeMap.get(widget.widgetTypeId);
      const device = widget.datasource?.deviceId
        ? deviceMap.get(widget.datasource.deviceId)
        : undefined;
      const descriptor = (type?.descriptor ?? {}) as any;

      return {
        ...widget,
        widgetType: type
          ? {
              id: type.id,
              name: type.name,
              alias: descriptor.alias ?? null,
              type: descriptor.type ?? null,
              category: type.category,
              description: type.description ?? null,
              defaultConfig: descriptor.defaultConfig ?? null,
              dataConfig: descriptor.dataConfig ?? null,
              sizeX: descriptor.sizeX ?? null,
              sizeY: descriptor.sizeY ?? null,
            }
          : null,
        device: device
          ? {
              id: device.id,
              name: device.name,
              status: device.status,
              type: device.type,
              deviceKey: device.deviceKey,
            }
          : null,
      };
    });
  }

  /**
   * Batch position update for drag-and-drop reordering — one save for the
   * whole grid instead of one request per moved widget.
   *
   * All ids are validated before anything is written, so a layout containing
   * one bad id fails cleanly rather than applying half the moves.
   */
  async updateLayout(
    id: string,
    user: User,
    dto: UpdateLayoutDto,
  ): Promise<DashboardWidgetConfig[]> {
    const widgets = await this.dashboardRepository.manager.transaction(
      async (manager) => {
        const dashboard = await this.loadForWidgetWrite(manager, id, user);

        const widgets = this.widgetsOf(dashboard);
        const byId = new Map(widgets.map((w) => [w.id, w]));

        const unknown = dto.widgets
          .filter((p) => !byId.has(p.id))
          .map((p) => p.id);
        if (unknown.length) {
          throw new NotFoundException(
            `Widget(s) not found on dashboard ${id}: ${unknown.join(', ')}`,
          );
        }

        // Positions are written onto the existing widget objects, so a widget
        // the layout does not mention keeps its position and all its other
        // fields — the payload is a patch, not the new widget list.
        const now = new Date().toISOString();
        for (const position of dto.widgets) {
          const widget = byId.get(position.id)!;
          widget.row = position.row;
          widget.col = position.col;
          widget.width = position.width;
          widget.height = position.height;
          widget.updatedAt = now;
        }

        dashboard.widgets = [...widgets] as unknown as Dashboard['widgets'];
        await manager.save(Dashboard, dashboard);
        return widgets;
      },
    );

    this.websocketGateway.broadcastDashboardUpdate(id, {
      action: 'layout_updated',
      widgetIds: dto.widgets.map((w) => w.id),
    });

    return widgets;
  }

  // ── Sharing ───────────────────────────────────────────────────────────────

  async share(id: string, user: User, shareDto: ShareDashboardDto): Promise<Dashboard> {
    const dashboard = await this.findOne(id, user);

    if (dashboard.userId !== user.id) {
      throw new ForbiddenException('Only the dashboard owner can share it');
    }

    dashboard.sharedWith = Array.from(
      new Set([...(dashboard.sharedWith ?? []), ...shareDto.userIds]),
    );

    if (dashboard.visibility === DashboardVisibility.PRIVATE) {
      dashboard.visibility = DashboardVisibility.SHARED;
    }

    return this.dashboardRepository.save(dashboard);
  }

  async unshare(id: string, user: User, targetUserId: string): Promise<Dashboard> {
    const dashboard = await this.findOne(id, user);

    if (dashboard.userId !== user.id) {
      throw new ForbiddenException('Only the dashboard owner can unshare it');
    }

    dashboard.sharedWith = (dashboard.sharedWith ?? []).filter((uid) => uid !== targetUserId);

    if (dashboard.sharedWith.length === 0) {
      dashboard.visibility = DashboardVisibility.PRIVATE;
    }

    return this.dashboardRepository.save(dashboard);
  }

  // ── Clone ─────────────────────────────────────────────────────────────────

  async clone(id: string, user: User, cloneDto: CloneDashboardDto): Promise<Dashboard> {
    const original = await this.findOne(id, user);

    const cloned = this.dashboardRepository.create({
      // Name is optional — default to "Copy of {original}" so the endpoint can
      // be called with an empty body.
      name: cloneDto.name?.trim() || `Copy of ${original.name}`,
      description: cloneDto.description ?? original.description,
      userId: user.id,
      tenantId: user.tenantId,
      customerId: user.role === UserRole.CUSTOMER_USER ? user.customerId : undefined,
      // null-safe deep clone — layout and settings may be null on new dashboards.
      // Every widget gets a fresh id so the copy's widgets are independent of
      // the source's (ids are referenced by the widget PATCH/DELETE routes).
      widgets: original.widgets
        ? JSON.parse(JSON.stringify(original.widgets)).map((w: any) => ({
            ...w,
            id: randomUUID(),
          }))
        : [],
      layout: original.layout ? JSON.parse(JSON.stringify(original.layout)) : undefined,
      settings: original.settings ? JSON.parse(JSON.stringify(original.settings)) : undefined,
      visibility: DashboardVisibility.PRIVATE,
      tags: [...(original.tags ?? [])],
    });

    return this.dashboardRepository.save(cloned);
  }

  // ── Favorite ──────────────────────────────────────────────────────────────

  async toggleFavorite(id: string, user: User): Promise<Dashboard> {
    const dashboard = await this.findOne(id, user);

    if (dashboard.userId !== user.id) {
      throw new ForbiddenException('Only the dashboard owner can favorite it');
    }

    dashboard.isFavorite = !dashboard.isFavorite;
    return this.dashboardRepository.save(dashboard);
  }

  // ── Shared dashboards ─────────────────────────────────────────────────────
  // Fixed: wrap the base OR expression in parentheses so the customer andWhere
  // binds to the whole expression, not just the last OR clause.

  async getShared(user: User): Promise<Dashboard[]> {
    const qb = this.dashboardRepository
      .createQueryBuilder('dashboard')
      .where(
        // `sharedWith` is a `simple-array`, which Postgres stores as a comma
        // separated VARCHAR — not an array. `:id = ANY(<varchar>)` is not a
        // scoping bug but a hard error (`op ANY/ALL (array) requires array on
        // right side`, SQLSTATE 42809), so this route answered 500 for every
        // caller and returned no rows to anybody. Found by running the
        // verifier, not by reading it. `string_to_array` is what makes the
        // membership test mean what it says; a NULL column yields NULL and so
        // matches nobody, which is correct.
        '(:userId = ANY(string_to_array(dashboard.sharedWith, \',\')) ' +
          'OR dashboard.visibility = :visibility)',
        { userId: user.id, visibility: DashboardVisibility.PUBLIC },
      )
      .orderBy('dashboard.updatedAt', 'DESC');

    // This had no tenant predicate at all, so "shared with me" listed every
    // PUBLIC dashboard on the platform to every authenticated user — the same
    // leak as findAll, one method down.
    DashboardsService.applyDashboardScope(qb, user);

    return qb.getMany();
  }

  // ── Statistics ────────────────────────────────────────────────────────────

  async getStatistics(user: User) {
    const qb = this.dashboardRepository.createQueryBuilder('dashboard');

    // A count is a disclosure too, and this was the fifth copy of the same
    // branching in this one file.
    DashboardsService.applyDashboardScope(qb, user);
    DashboardsService.restrictListingToOwn(qb, user);

    const [total, favorites, shared] = await Promise.all([
      qb.getCount(),
      qb.clone()
        .andWhere('dashboard.isFavorite = true')
        .andWhere('dashboard.userId = :userId', { userId: user.id })
        .getCount(),
      qb.clone()
        .andWhere('dashboard.visibility = :visibility', {
          visibility: DashboardVisibility.SHARED,
        })
        .andWhere('dashboard.userId = :userId', { userId: user.id })
        .getCount(),
    ]);

    const defaultDashboard = await this.getDefault(user);
    const mostViewed = await qb.clone()
      .orderBy('dashboard.viewCount', 'DESC')
      .take(5)
      .getMany();

    return { total, favorites, shared, hasDefault: !!defaultDashboard, mostViewed };
  }

  // ── Customer assignment ───────────────────────────────────────────────────

  async findByCustomer(customerId: string, user: User): Promise<Dashboard[]> {
    // CUSTOMER was missing from this check, so a customer admin could name a
    // sibling customer.
    if (isCustomerScopedRole(user.role) && user.customerId !== customerId) {
      throw new ForbiddenException('Access denied to this customer');
    }

    // And the lookup itself had no tenant predicate: any authenticated user
    // could list the dashboards of any customer of any tenant by uuid.
    const qb = this.dashboardRepository
      .createQueryBuilder('dashboard')
      .where('dashboard.customerId = :targetCustomerId', {
        targetCustomerId: customerId,
      })
      .orderBy('dashboard.updatedAt', 'DESC');

    applyAccessScope(qb, 'dashboard', user);

    return qb.getMany();
  }

  async assignToCustomer(
    dashboardId: string,
    customerId: string,
    user: User,
  ): Promise<Dashboard> {
    const dashboard = await this.findOne(dashboardId, user);

    if (
      dashboard.userId !== user.id &&
      user.role !== UserRole.SUPER_ADMIN &&
      user.role !== UserRole.TENANT_ADMIN
    ) {
      throw new ForbiddenException('Only the owner or admins can assign to customer');
    }

    dashboard.customerId = customerId;
    return this.dashboardRepository.save(dashboard);
  }

  async unassignFromCustomer(dashboardId: string, user: User): Promise<Dashboard> {
    const dashboard = await this.findOne(dashboardId, user);

    if (
      dashboard.userId !== user.id &&
      user.role !== UserRole.SUPER_ADMIN &&
      user.role !== UserRole.TENANT_ADMIN
    ) {
      throw new ForbiddenException('Only the owner or admins can unassign from customer');
    }

    dashboard.customerId = undefined;
    return this.dashboardRepository.save(dashboard);
  }

  // ── Private helpers ───────────────────────────────────────────────────────

  /**
   * The row-level half of the decision, for a dashboard already loaded.
   *
   * The query predicate (`applyDashboardScope`) is what confines the caller to
   * its tenant and customer; this adds the dashboard's own sharing rules. Two
   * things were wrong here:
   *
   *   · PUBLIC and `sharedWith` were honoured with no tenant check, so this
   *     function said "yes" to another tenant's public dashboard. Nothing
   *     reached it that way while every caller also applied a tenant
   *     predicate — but `findAll` proved how long that holds.
   *   · the customer branch tested CUSTOMER_USER only, so a CUSTOMER (a
   *     customer admin) was refused its own customer's dashboard.
   */
  private checkAccess(dashboard: Dashboard, user: User): boolean {
    if (user.role === UserRole.SUPER_ADMIN) return true;

    // Everything below is tenant-local. No tenant, no access.
    if (!user.tenantId || dashboard.tenantId !== user.tenantId) return false;

    if (dashboard.userId === user.id) return true;
    if (user.role === UserRole.TENANT_ADMIN) return true;
    if (dashboard.visibility === DashboardVisibility.PUBLIC) return true;
    if (dashboard.sharedWith?.includes(user.id)) return true;
    if (
      isCustomerScopedRole(user.role) &&
      !!user.customerId &&
      dashboard.customerId === user.customerId
    ) return true;
    return false;
  }
}