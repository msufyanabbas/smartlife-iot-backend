import {
  Injectable,
  NotFoundException,
  ForbiddenException,
  BadRequestException,
  Logger,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';
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

    return this.dashboardRepository.save(dashboard);
  }

  // ── Find all ──────────────────────────────────────────────────────────────

  async findAll(
    user: User,
    query: DashboardQueryDto,
  ): Promise<PaginatedResponseDto<Dashboard>> {
    const { page = 1, limit = 10, search, visibility, isFavorite, tags } = query;

    const qb = this.dashboardRepository.createQueryBuilder('dashboard');

    // Role-based base filter — wrap OR conditions in parentheses so subsequent
    // andWhere calls bind to the whole expression, not just the last OR clause.
    if (user.role === UserRole.CUSTOMER_USER) {
      if (!user.customerId) {
        qb.where('dashboard.userId = :userId', { userId: user.id });
      } else {
        qb.where(
          '(dashboard.userId = :userId OR dashboard.customerId = :customerId OR dashboard.visibility = :public)',
          { userId: user.id, customerId: user.customerId, public: DashboardVisibility.PUBLIC },
        );
      }
    } else if (user.role === UserRole.TENANT_ADMIN) {
      qb.where('dashboard.tenantId = :tenantId', { tenantId: user.tenantId });
    } else if (user.role !== UserRole.SUPER_ADMIN) {
      qb.where('dashboard.userId = :userId', { userId: user.id });
    }
    // SUPER_ADMIN: no base filter — sees everything

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
    const dashboard = await this.dashboardRepository.findOne({ where: { id, tenantId: user.tenantId } });

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

    if (user.role === UserRole.CUSTOMER_USER) {
      if (!user.customerId) {
        qb.andWhere('dashboard.userId = :userId', { userId: user.id });
      } else {
        qb.andWhere(
          '(dashboard.userId = :userId OR dashboard.customerId = :customerId)',
          { userId: user.id, customerId: user.customerId },
        );
      }
    } else if (user.role === UserRole.TENANT_ADMIN) {
      qb.andWhere('dashboard.tenantId = :tenantId', { tenantId: user.tenantId });
    } else if (user.role !== UserRole.SUPER_ADMIN) {
      qb.andWhere('dashboard.userId = :userId', { userId: user.id });
    }

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

    Object.assign(dashboard, updateDto);
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
    const dashboard = await this.findOne(id, user);
    this.assertCanEdit(dashboard, user);

    const widgetType = await this.loadWidgetType(dto.widgetTypeId);
    const descriptor = widgetType.descriptor ?? ({} as any);

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

    dashboard.widgets = [
      ...this.widgetsOf(dashboard),
      widget,
    ] as unknown as Dashboard['widgets'];
    const saved = await this.dashboardRepository.save(dashboard);

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
    const dashboard = await this.findOne(id, user);
    this.assertCanEdit(dashboard, user);

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
      config: dto.config ? { ...current.config, ...dto.config } : current.config,
      updatedAt: new Date().toISOString(),
    };

    widgets[index] = updated;
    dashboard.widgets = [...widgets] as unknown as Dashboard['widgets'];
    const saved = await this.dashboardRepository.save(dashboard);

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
    const dashboard = await this.findOne(id, user);
    this.assertCanEdit(dashboard, user);

    const widgets = this.widgetsOf(dashboard);
    const remaining = widgets.filter((w) => w.id !== widgetId);
    if (remaining.length === widgets.length) {
      throw new NotFoundException(
        `Widget ${widgetId} not found on dashboard ${id}`,
      );
    }

    dashboard.widgets = remaining as unknown as Dashboard['widgets'];
    const saved = await this.dashboardRepository.save(dashboard);

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
    const dashboard = await this.findOne(id, user);
    this.assertCanEdit(dashboard, user);

    const widgets = this.widgetsOf(dashboard);
    const byId = new Map(widgets.map((w) => [w.id, w]));

    const unknown = dto.widgets.filter((p) => !byId.has(p.id)).map((p) => p.id);
    if (unknown.length) {
      throw new NotFoundException(
        `Widget(s) not found on dashboard ${id}: ${unknown.join(', ')}`,
      );
    }

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
    await this.dashboardRepository.save(dashboard);

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
        '(:userId = ANY(dashboard.sharedWith) OR dashboard.visibility = :visibility)',
        { userId: user.id, visibility: DashboardVisibility.PUBLIC },
      )
      .orderBy('dashboard.updatedAt', 'DESC');

    if (user.role === UserRole.CUSTOMER_USER && user.customerId) {
      qb.andWhere(
        '(dashboard.customerId = :customerId OR dashboard.visibility = :public)',
        { customerId: user.customerId, public: DashboardVisibility.PUBLIC },
      );
    }

    return qb.getMany();
  }

  // ── Statistics ────────────────────────────────────────────────────────────

  async getStatistics(user: User) {
    const qb = this.dashboardRepository.createQueryBuilder('dashboard');

    if (user.role === UserRole.CUSTOMER_USER) {
      if (!user.customerId) {
        qb.where('dashboard.userId = :userId', { userId: user.id });
      } else {
        qb.where(
          '(dashboard.userId = :userId OR dashboard.customerId = :customerId)',
          { userId: user.id, customerId: user.customerId },
        );
      }
    } else if (user.role === UserRole.TENANT_ADMIN) {
      qb.where('dashboard.tenantId = :tenantId', { tenantId: user.tenantId });
    } else if (user.role !== UserRole.SUPER_ADMIN) {
      qb.where('dashboard.userId = :userId', { userId: user.id });
    }

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
    if (user.role === UserRole.CUSTOMER_USER && user.customerId !== customerId) {
      throw new ForbiddenException('Access denied to this customer');
    }

    return this.dashboardRepository.find({
      where: { customerId },
      order: { updatedAt: 'DESC' },
    });
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

  private checkAccess(dashboard: Dashboard, user: User): boolean {
    if (dashboard.userId === user.id) return true;
    if (user.role === UserRole.SUPER_ADMIN) return true;
    if (user.role === UserRole.TENANT_ADMIN && dashboard.tenantId === user.tenantId) return true;
    if (dashboard.visibility === DashboardVisibility.PUBLIC) return true;
    if (dashboard.sharedWith?.includes(user.id)) return true;
    if (
      user.role === UserRole.CUSTOMER_USER &&
      dashboard.customerId &&
      dashboard.customerId === user.customerId
    ) return true;
    return false;
  }
}