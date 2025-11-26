import {
  Injectable,
  NotFoundException,
  ForbiddenException,
  BadRequestException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, Like, In } from 'typeorm';
import { Dashboard, DashboardVisibility } from './entities/dashboard.entity';
import {
  CreateDashboardDto,
  UpdateDashboardDto,
  DashboardQueryDto,
  ShareDashboardDto,
  CloneDashboardDto,
} from './dto/dashboard.dto';
import { v4 as uuidv4 } from 'uuid';
import * as DashboardEntity from './entities/dashboard.entity';

@Injectable()
export class DashboardsService {
  constructor(
    @InjectRepository(Dashboard)
    private dashboardRepository: Repository<Dashboard>,
  ) {}

  /**
   * Create new dashboard
   */
  async create(
    userId: string,
    createDto: CreateDashboardDto,
  ): Promise<Dashboard> {
    // Generate widget IDs if not provided and ensure proper typing
    const widgets =
      createDto.widgets?.map((widget) => ({
        ...widget,
        id: uuidv4(),
      })) || [];

    const dashboard = this.dashboardRepository.create({
      ...createDto,
      userId,
      widgets: widgets as any, // Type assertion needed due to DTO vs Entity type differences
    });

    return await this.dashboardRepository.save(dashboard);
  }

  /**
   * Find all dashboards for user with filters
   */
  async findAll(userId: string, query: DashboardQueryDto) {
    const {
      page = 1,
      limit = 10,
      search,
      visibility,
      isFavorite,
      tags,
    } = query;

    const queryBuilder = this.dashboardRepository
      .createQueryBuilder('dashboard')
      .where('dashboard.userId = :userId', { userId });

    // Add visibility filter (also include shared dashboards)
    if (visibility) {
      queryBuilder.andWhere('dashboard.visibility = :visibility', {
        visibility,
      });
    }

    // Search by name or description
    if (search) {
      queryBuilder.andWhere(
        '(dashboard.name ILIKE :search OR dashboard.description ILIKE :search)',
        { search: `%${search}%` },
      );
    }

    // Filter favorites
    if (isFavorite !== undefined) {
      queryBuilder.andWhere('dashboard.isFavorite = :isFavorite', {
        isFavorite,
      });
    }

    // Filter by tags
    if (tags && tags.length > 0) {
      queryBuilder.andWhere('dashboard.tags && :tags', { tags });
    }

    // Pagination
    const skip = (page - 1) * limit;
    queryBuilder.skip(skip).take(limit);

    // Order by last viewed, then by updated date
    queryBuilder.orderBy('dashboard.lastViewedAt', 'DESC', 'NULLS LAST');
    queryBuilder.addOrderBy('dashboard.updatedAt', 'DESC');

    const [data, total] = await queryBuilder.getManyAndCount();

    return {
      data,
      total,
      page,
      limit,
      totalPages: Math.ceil(total / limit),
    };
  }

  /**
   * Get dashboard by ID
   */
  async findOne(id: string, userId: string): Promise<Dashboard> {
    const dashboard = await this.dashboardRepository.findOne({
      where: { id },
    });

    if (!dashboard) {
      throw new NotFoundException(`Dashboard with ID ${id} not found`);
    }

    // Check access permissions
    if (
      dashboard.userId !== userId &&
      dashboard.visibility === DashboardVisibility.PRIVATE &&
      !dashboard.sharedWith?.includes(userId)
    ) {
      throw new ForbiddenException('You do not have access to this dashboard');
    }

    // Update view count and last viewed
    dashboard.viewCount++;
    dashboard.lastViewedAt = new Date();
    await this.dashboardRepository.save(dashboard);

    return dashboard;
  }

  /**
   * Get default dashboard for user
   */
  async getDefault(userId: string): Promise<Dashboard | null> {
    return await this.dashboardRepository.findOne({
      where: { userId, isDefault: true },
    });
  }

  /**
   * Update dashboard
   */
  async update(
    id: string,
    userId: string,
    updateDto: UpdateDashboardDto,
  ): Promise<Dashboard> {
    const dashboard = await this.dashboardRepository.findOne({
      where: { id, userId },
    });

    if (!dashboard) {
      throw new NotFoundException(`Dashboard with ID ${id} not found`);
    }

    // If setting as default, unset other default dashboards
    if (updateDto.isDefault) {
      await this.dashboardRepository.update(
        { userId, isDefault: true },
        { isDefault: false },
      );
    }

    Object.assign(dashboard, updateDto);
    return await this.dashboardRepository.save(dashboard);
  }

  /**
   * Delete dashboard
   */
  async remove(id: string, userId: string): Promise<void> {
    const dashboard = await this.dashboardRepository.findOne({
      where: { id, userId },
    });

    if (!dashboard) {
      throw new NotFoundException(`Dashboard with ID ${id} not found`);
    }

    await this.dashboardRepository.softRemove(dashboard);
  }

  /**
   * Add widget to dashboard
   */
  async addWidget(id: string, userId: string, widget: any): Promise<Dashboard> {
    const dashboard = await this.dashboardRepository.findOne({
      where: { id, userId },
    });

    if (!dashboard) {
      throw new NotFoundException(`Dashboard with ID ${id} not found`);
    }

    // Generate widget ID
    const widgetWithId = {
      ...widget,
      id: uuidv4(),
    };

    dashboard.addWidget(widgetWithId);
    return await this.dashboardRepository.save(dashboard);
  }

  /**
   * Update widget in dashboard
   */
  async updateWidget(
    id: string,
    widgetId: string,
    userId: string,
    updates: any,
  ): Promise<Dashboard> {
    const dashboard = await this.dashboardRepository.findOne({
      where: { id, userId },
    });

    if (!dashboard) {
      throw new NotFoundException(`Dashboard with ID ${id} not found`);
    }

    dashboard.updateWidget(widgetId, updates);
    return await this.dashboardRepository.save(dashboard);
  }

  /**
   * Remove widget from dashboard
   */
  async removeWidget(
    id: string,
    widgetId: string,
    userId: string,
  ): Promise<Dashboard> {
    const dashboard = await this.dashboardRepository.findOne({
      where: { id, userId },
    });

    if (!dashboard) {
      throw new NotFoundException(`Dashboard with ID ${id} not found`);
    }

    dashboard.removeWidget(widgetId);
    return await this.dashboardRepository.save(dashboard);
  }

  /**
   * Share dashboard with users
   */
  async share(
    id: string,
    userId: string,
    shareDto: ShareDashboardDto,
  ): Promise<Dashboard> {
    const dashboard = await this.dashboardRepository.findOne({
      where: { id, userId },
    });

    if (!dashboard) {
      throw new NotFoundException(`Dashboard with ID ${id} not found`);
    }

    // Update shared users list
    dashboard.sharedWith = Array.from(
      new Set([...(dashboard.sharedWith || []), ...shareDto.userIds]),
    );

    // Update visibility to shared if it was private
    if (dashboard.visibility === DashboardVisibility.PRIVATE) {
      dashboard.visibility = DashboardVisibility.SHARED;
    }

    return await this.dashboardRepository.save(dashboard);
  }

  /**
   * Unshare dashboard
   */
  async unshare(
    id: string,
    userId: string,
    targetUserId: string,
  ): Promise<Dashboard> {
    const dashboard = await this.dashboardRepository.findOne({
      where: { id, userId },
    });

    if (!dashboard) {
      throw new NotFoundException(`Dashboard with ID ${id} not found`);
    }

    dashboard.sharedWith =
      dashboard.sharedWith?.filter((uid) => uid !== targetUserId) || [];

    // If no more shared users, set to private
    if (dashboard.sharedWith.length === 0) {
      dashboard.visibility = DashboardVisibility.PRIVATE;
    }

    return await this.dashboardRepository.save(dashboard);
  }

  /**
   * Clone dashboard
   */
  async clone(
    id: string,
    userId: string,
    cloneDto: CloneDashboardDto,
  ): Promise<Dashboard> {
    const original = await this.findOne(id, userId);

    // Create new dashboard with cloned data
    const cloned = this.dashboardRepository.create({
      name: cloneDto.name,
      description: cloneDto.description || original.description,
      userId,
      widgets: JSON.parse(JSON.stringify(original.widgets)), // Deep clone
      layout: JSON.parse(JSON.stringify(original.layout)),
      settings: JSON.parse(JSON.stringify(original.settings)),
      visibility: DashboardVisibility.PRIVATE, // Always private for clones
      tags: [...(original.tags || [])],
    });

    // Generate new IDs for all widgets
    if (cloned.widgets) {
      cloned.widgets = cloned.widgets.map((widget) => ({
        ...widget,
        id: uuidv4(),
      }));
    }

    return await this.dashboardRepository.save(cloned);
  }

  /**
   * Toggle favorite
   */
  async toggleFavorite(id: string, userId: string): Promise<Dashboard> {
    const dashboard = await this.dashboardRepository.findOne({
      where: { id, userId },
    });

    if (!dashboard) {
      throw new NotFoundException(`Dashboard with ID ${id} not found`);
    }

    dashboard.isFavorite = !dashboard.isFavorite;
    return await this.dashboardRepository.save(dashboard);
  }

  /**
   * Get shared dashboards (dashboards shared with this user)
   */
  async getShared(userId: string): Promise<Dashboard[]> {
    return await this.dashboardRepository
      .createQueryBuilder('dashboard')
      .where(':userId = ANY(dashboard.sharedWith)', { userId })
      .orWhere('dashboard.visibility = :visibility', {
        visibility: DashboardVisibility.PUBLIC,
      })
      .orderBy('dashboard.updatedAt', 'DESC')
      .getMany();
  }

  /**
   * Get dashboard statistics
   */
  async getStatistics(userId: string) {
    const total = await this.dashboardRepository.count({ where: { userId } });
    const favorites = await this.dashboardRepository.count({
      where: { userId, isFavorite: true },
    });
    const shared = await this.dashboardRepository.count({
      where: { userId, visibility: DashboardVisibility.SHARED },
    });
    const defaultDashboard = await this.getDefault(userId);

    return {
      total,
      favorites,
      shared,
      hasDefault: !!defaultDashboard,
      mostViewed: await this.dashboardRepository.find({
        where: { userId },
        order: { viewCount: 'DESC' },
        take: 5,
      }),
    };
  }
}
