import {
  Injectable,
  NotFoundException,
  ForbiddenException,
  Logger,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { v4 as uuidv4 } from 'uuid';
import { Dashboard } from './entities/dashboard.entity';
import { DashboardVisibility, UserRole } from '@common/enums/index.enum';
import {
  CreateDashboardDto,
  UpdateDashboardDto,
  DashboardQueryDto,
  ShareDashboardDto,
  CloneDashboardDto,
} from './dto/dashboard.dto';
import { User } from '../index.entities';
import { WebsocketGateway } from '@modules/websocket/websocket.gateway';

@Injectable()
export class DashboardsService {
  private readonly logger = new Logger(DashboardsService.name);

  constructor(
    @InjectRepository(Dashboard)
    private readonly dashboardRepository: Repository<Dashboard>,
    private readonly websocketGateway: WebsocketGateway,
  ) {}

  // ── Create ────────────────────────────────────────────────────────────────

  async create(user: User, createDto: CreateDashboardDto): Promise<Dashboard> {
    const widgets = (createDto.widgets ?? []).map((w) => ({ ...w, id: uuidv4() }));

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

  async findAll(user: User, query: DashboardQueryDto) {
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

    return { data, total, page, limit, totalPages: Math.ceil(total / limit) };
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

  async addWidget(id: string, user: User, widget: any): Promise<Dashboard> {
    const dashboard = await this.findOne(id, user);

    if (dashboard.userId !== user.id) {
      throw new ForbiddenException('Only the dashboard owner can add widgets');
    }

    dashboard.addWidget({ ...widget, id: uuidv4() });
    const saved = await this.dashboardRepository.save(dashboard);

    // Notify connected clients that this dashboard's device list changed.
    // The frontend should re-evaluate which device rooms to subscribe to.
    this.websocketGateway.broadcastDashboardUpdate(id, {
      action: 'widget_added',
      usedDevices: saved.getUsedDevices(),
    });

    return saved;
  }

  async updateWidget(
    id: string,
    widgetId: string,
    user: User,
    updates: any,
  ): Promise<Dashboard> {
    const dashboard = await this.findOne(id, user);

    if (dashboard.userId !== user.id) {
      throw new ForbiddenException('Only the dashboard owner can update widgets');
    }

    dashboard.updateWidget(widgetId, updates);
    const saved = await this.dashboardRepository.save(dashboard);

    this.websocketGateway.broadcastDashboardUpdate(id, {
      action: 'widget_updated',
      widgetId,
      usedDevices: saved.getUsedDevices(),
    });

    return saved;
  }

  async removeWidget(id: string, widgetId: string, user: User): Promise<Dashboard> {
    const dashboard = await this.findOne(id, user);

    if (dashboard.userId !== user.id) {
      throw new ForbiddenException('Only the dashboard owner can remove widgets');
    }

    dashboard.removeWidget(widgetId);
    const saved = await this.dashboardRepository.save(dashboard);

    this.websocketGateway.broadcastDashboardUpdate(id, {
      action: 'widget_removed',
      widgetId,
      usedDevices: saved.getUsedDevices(),
    });

    return saved;
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
      name: cloneDto.name,
      description: cloneDto.description ?? original.description,
      userId: user.id,
      tenantId: user.tenantId,
      customerId: user.role === UserRole.CUSTOMER_USER ? user.customerId : undefined,
      // null-safe deep clone — layout and settings may be null on new dashboards
      widgets: original.widgets
        ? JSON.parse(JSON.stringify(original.widgets)).map((w: any) => ({ ...w, id: uuidv4() }))
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