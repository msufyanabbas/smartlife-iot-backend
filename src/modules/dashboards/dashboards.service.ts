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
import { User } from '../index.entities';
import { UserRole } from '../users/entities/user.entity';

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
    user: User,
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
      userId: user.id,
      tenantId: user.tenantId,
      customerId: user.role === UserRole.CUSTOMER_USER ? user.customerId : createDto.customerId,
      widgets: widgets as any, // Type assertion needed due to DTO vs Entity type differences
    });

    return await this.dashboardRepository.save(dashboard);
  }

  /**
   * Find all dashboards for user with filters
   */
  async findAll(user: User, query: DashboardQueryDto) {
    const {
      page = 1,
      limit = 10,
      search,
      visibility,
      isFavorite,
      tags,
    } = query;

     const queryBuilder = this.dashboardRepository
      .createQueryBuilder('dashboard');

      if (user.role === UserRole.CUSTOMER_USER) {
      // Customer users see:
      // 1. Their own dashboards
      // 2. Dashboards assigned to their customer
      // 3. Public dashboards
      if (!user.customerId) {
        queryBuilder.where('dashboard.userId = :userId', { userId: user.id });
      } else {
        queryBuilder.where(
          '(dashboard.userId = :userId OR dashboard.customerId = :customerId OR dashboard.visibility = :public)',
          {
            userId: user.id,
            customerId: user.customerId,
            public: DashboardVisibility.PUBLIC,
          },
        );
      }
    } else if (user.role === UserRole.TENANT_ADMIN) {
      // Tenant admins see all dashboards in their tenant
      queryBuilder.where('dashboard.tenantId = :tenantId', {
        tenantId: user.tenantId,
      });
    } else if (user.role === UserRole.SUPER_ADMIN) {
      // Super admin sees everything (no filter)
    } else {
      // Regular users see their own dashboards
      queryBuilder.where('dashboard.userId = :userId', { userId: user.id });
    }


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
  async findOne(id: string, user: User): Promise<Dashboard> {
    const dashboard = await this.dashboardRepository.findOne({
      where: { id },
    });

    if (!dashboard) {
      throw new NotFoundException(`Dashboard with ID ${id} not found`);
    }

    // Check access permissions
    const hasAccess = this.checkDashboardAccess(dashboard, user);
    if (!hasAccess) {
      throw new ForbiddenException('You do not have access to this dashboard');
    }

    // Update view count and last viewed
    dashboard.viewCount++;
    dashboard.lastViewedAt = new Date();
    await this.dashboardRepository.save(dashboard);

    return dashboard;
  }

  /**
   * ============================================
   * NEW: Check if user has access to dashboard
   * ============================================
   */

  private checkDashboardAccess(dashboard: Dashboard, user: User): boolean {
    // Owner has access
    if (dashboard.userId === user.id) {
      return true;
    }

    // Super admin has access to everything
    if (user.role === UserRole.SUPER_ADMIN) {
      return true;
    }

    // Tenant admin has access to all dashboards in their tenant
    if (user.role === UserRole.TENANT_ADMIN && dashboard.tenantId === user.tenantId) {
      return true;
    }

    // Customer user checks
    if (user.role === UserRole.CUSTOMER_USER) {
      // Can access dashboards assigned to their customer
      if (dashboard.customerId && dashboard.customerId === user.customerId) {
        return true;
      }

      // Can access public dashboards
      if (dashboard.visibility === DashboardVisibility.PUBLIC) {
        return true;
      }

      // Can access shared dashboards
      if (dashboard.sharedWith?.includes(user.id)) {
        return true;
      }
    }

    // Public dashboards are accessible to all
    if (dashboard.visibility === DashboardVisibility.PUBLIC) {
      return true;
    }

    // Shared dashboards
    if (dashboard.sharedWith?.includes(user.id)) {
      return true;
    }

    return false;
  }

  /**
   * Get default dashboard for user
   */
  async getDefault(user: User): Promise<Dashboard | null> {
    const queryBuilder = this.dashboardRepository
      .createQueryBuilder('dashboard')
      .where('dashboard.isDefault = true');
       if (user.role === UserRole.CUSTOMER_USER) {
      if (!user.customerId) {
        queryBuilder.andWhere('dashboard.userId = :userId', {
          userId: user.id,
        });
      } else {
        queryBuilder.andWhere(
          '(dashboard.userId = :userId OR dashboard.customerId = :customerId)',
          {
            userId: user.id,
            customerId: user.customerId,
          },
        );
      }
    } else if (user.role === UserRole.TENANT_ADMIN) {
      queryBuilder.andWhere('dashboard.tenantId = :tenantId', {
        tenantId: user.tenantId,
      });
    } else {
      queryBuilder.andWhere('dashboard.userId = :userId', { userId: user.id });
    }

    return await queryBuilder.getOne();
  }

  /**
   * Update dashboard
   */
  async update(
    id: string,
    user: User,
    updateDto: UpdateDashboardDto,
  ): Promise<Dashboard> {
    const dashboard = await this.findOne(id, user);

    if (dashboard.userId !== user.id) {
      throw new ForbiddenException('Only the dashboard owner can update it');
    }

    // If setting as default, unset other default dashboards
    if (updateDto.isDefault) {
      await this.dashboardRepository.update(
        { userId: user.id, isDefault: true },
        { isDefault: false },
      );
    }

    Object.assign(dashboard, updateDto);
    return await this.dashboardRepository.save(dashboard);
  }

  /**
   * Delete dashboard
   */
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

  /**
   * Add widget to dashboard
   */
  async addWidget(id: string, user: User, widget: any): Promise<Dashboard> {
    const dashboard = await this.findOne(id, user);

    // Only owner can add widgets
    if (dashboard.userId !== user.id) {
      throw new ForbiddenException('Only the dashboard owner can add widgets');
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
    user: User,
    updates: any,
  ): Promise<Dashboard> {
    const dashboard = await this.findOne(id, user);

    // Only owner can update widgets
    if (dashboard.userId !== user.id) {
      throw new ForbiddenException('Only the dashboard owner can update widgets');
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
    user: User,
  ): Promise<Dashboard> {
    const dashboard = await this.findOne(id, user);

    // Only owner can remove widgets
    if (dashboard.userId !== user.id) {
      throw new ForbiddenException('Only the dashboard owner can remove widgets');
    }

    dashboard.removeWidget(widgetId);
    return await this.dashboardRepository.save(dashboard);
  }

  /**
   * Share dashboard with users
   */
  async share(
    id: string,
    user: User,
    shareDto: ShareDashboardDto,
  ): Promise<Dashboard> {
    const dashboard = await this.findOne(id, user);

   // Only owner can share
    if (dashboard.userId !== user.id) {
      throw new ForbiddenException('Only the dashboard owner can share it');
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
    user: User,
    targetUserId: string,
  ): Promise<Dashboard> {
    const dashboard = await this.findOne(id, user);

    // Only owner can unshare
    if (dashboard.userId !== user.id) {
      throw new ForbiddenException('Only the dashboard owner can unshare it');
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
    user: User,
    cloneDto: CloneDashboardDto,
  ): Promise<Dashboard> {
    const original = await this.findOne(id, user);

    // Create new dashboard with cloned data
    const cloned = this.dashboardRepository.create({
      name: cloneDto.name,
      description: cloneDto.description || original.description,
      userId: user.id,
      tenantId: user.tenantId,
      customerId: user.role === UserRole.CUSTOMER_USER ? user.customerId : undefined,
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
  async toggleFavorite(id: string, user: User): Promise<Dashboard> {
    const dashboard = await this.findOne(id, user);

     // Only owner can favorite
    if (dashboard.userId !== user.id) {
      throw new ForbiddenException('Only the dashboard owner can favorite it');
    }

    dashboard.isFavorite = !dashboard.isFavorite;
    return await this.dashboardRepository.save(dashboard);
  }

  /**
   * Get shared dashboards (dashboards shared with this user)
   */
async getShared(user: User): Promise<Dashboard[]> {
    const queryBuilder = this.dashboardRepository
      .createQueryBuilder('dashboard')
      .where(':userId = ANY(dashboard.sharedWith)', { userId: user.id })
      .orWhere('dashboard.visibility = :visibility', {
        visibility: DashboardVisibility.PUBLIC,
      })
      .orderBy('dashboard.updatedAt', 'DESC');

    // Apply customer filtering for customer users
    if (user.role === UserRole.CUSTOMER_USER && user.customerId) {
      queryBuilder.andWhere(
        '(dashboard.customerId = :customerId OR dashboard.visibility = :public)',
        {
          customerId: user.customerId,
          public: DashboardVisibility.PUBLIC,
        },
      );
    }

    return await queryBuilder.getMany();
  }

  /**
   * Get dashboard statistics
   */
 async getStatistics(user: User) {
    const queryBuilder = this.dashboardRepository.createQueryBuilder('dashboard');

    // Apply customer filtering
    if (user.role === UserRole.CUSTOMER_USER) {
      if (!user.customerId) {
        queryBuilder.where('dashboard.userId = :userId', { userId: user.id });
      } else {
        queryBuilder.where(
          '(dashboard.userId = :userId OR dashboard.customerId = :customerId)',
          {
            userId: user.id,
            customerId: user.customerId,
          },
        );
      }
    } else if (user.role === UserRole.TENANT_ADMIN) {
      queryBuilder.where('dashboard.tenantId = :tenantId', {
        tenantId: user.tenantId,
      });
    } else {
      queryBuilder.where('dashboard.userId = :userId', { userId: user.id });
    }

    const [total, favorites, shared] = await Promise.all([
      queryBuilder.getCount(),
      queryBuilder
        .clone()
        .andWhere('dashboard.isFavorite = true')
        .andWhere('dashboard.userId = :userId', { userId: user.id })
        .getCount(),
      queryBuilder
        .clone()
        .andWhere('dashboard.visibility = :visibility', {
          visibility: DashboardVisibility.SHARED,
        })
        .andWhere('dashboard.userId = :userId', { userId: user.id })
        .getCount(),
    ]);

    const defaultDashboard = await this.getDefault(user);

    const mostViewed = await queryBuilder
      .clone()
      .orderBy('dashboard.viewCount', 'DESC')
      .take(5)
      .getMany();

    return {
      total,
      favorites,
      shared,
      hasDefault: !!defaultDashboard,
      mostViewed,
    };
  }

 /**
   * ============================================
   * CUSTOMER-SPECIFIC METHODS
   * ============================================
   */

  /**
   * Get dashboards by customer
   */
  async findByCustomer(customerId: string, user: User): Promise<Dashboard[]> {
    // Validate access
    if (user.role === UserRole.CUSTOMER_USER && user.customerId !== customerId) {
      throw new ForbiddenException('Access denied to this customer');
    }

    return await this.dashboardRepository.find({
      where: { customerId },
      order: { updatedAt: 'DESC' },
    });
  }

  /**
   * Assign dashboard to customer
   */
  async assignToCustomer(
    dashboardId: string,
    customerId: string,
    user: User,
  ): Promise<Dashboard> {
    const dashboard = await this.findOne(dashboardId, user);

    // Only owner or admins can assign
    if (
      dashboard.userId !== user.id &&
      user.role !== UserRole.SUPER_ADMIN &&
      user.role !== UserRole.TENANT_ADMIN
    ) {
      throw new ForbiddenException(
        'Only dashboard owner or admins can assign to customer',
      );
    }

    dashboard.customerId = customerId;
    return await this.dashboardRepository.save(dashboard);
  }

  /**
   * Unassign dashboard from customer
   */
  async unassignFromCustomer(dashboardId: string, user: User): Promise<Dashboard> {
    const dashboard = await this.findOne(dashboardId, user);

    // Only owner or admins can unassign
    if (
      dashboard.userId !== user.id &&
      user.role !== UserRole.SUPER_ADMIN &&
      user.role !== UserRole.TENANT_ADMIN
    ) {
      throw new ForbiddenException('Only owner or admins can unassign from customer');
    }

    dashboard.customerId = undefined;
    return await this.dashboardRepository.save(dashboard);
  }

  
}
