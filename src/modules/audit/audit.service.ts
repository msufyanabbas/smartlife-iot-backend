// src/modules/audit/services/audit.service.ts
import { Injectable, NotFoundException, ForbiddenException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, Between, LessThan, Brackets } from 'typeorm';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { AuditAction, AuditEntityType, AuditSeverity, UserRole } from '@common/enums/index.enum';
import { AuditLog, User, Customer } from '@modules/index.entities';
import { CreateAuditLogDto, QueryAuditLogsDto } from './dto/audit.dto';

export interface AuditContext {
  user: User;
  allowedTenantIds: string[];
  allowedCustomerIds: string[];
  canSeeAllTenantLogs: boolean;
  canSeeCustomerLogs: boolean;
  canSeeOwnLogsOnly: boolean;
}

@Injectable()
export class AuditService {
  constructor(
    @InjectRepository(AuditLog)
    private auditRepository: Repository<AuditLog>,
    @InjectRepository(Customer)
    private customerRepository: Repository<Customer>,
    @InjectRepository(User)
    private userRepository: Repository<User>,
    private eventEmitter: EventEmitter2,
  ) {}

  /**
   * Build audit context from current user
   * This determines what logs the user can access
   */
  async buildAuditContext(user: User): Promise<AuditContext> {
    const context: AuditContext = {
      user,
      allowedTenantIds: [],
      allowedCustomerIds: [],
      canSeeAllTenantLogs: false,
      canSeeCustomerLogs: false,
      canSeeOwnLogsOnly: false,
    };

    switch (user.role) {
      case UserRole.SUPER_ADMIN:
        // Super admin can see everything
        context.canSeeAllTenantLogs = true;
        break;

      case UserRole.TENANT_ADMIN:
        // Tenant admin can see all logs in their tenant
        if (!user.tenantId) {
          throw new ForbiddenException('Tenant admin must have a tenant');
        }
        context.allowedTenantIds = [user.tenantId];
        context.canSeeAllTenantLogs = true;
        
        // Get all customers under this tenant
        const tenantCustomers = await this.customerRepository.find({
          where: { tenantId: user.tenantId },
          select: ['id'],
        });
        context.allowedCustomerIds = tenantCustomers.map(c => c.id);
        context.canSeeCustomerLogs = true;
        break;

      case UserRole.CUSTOMER_ADMIN:
        // Customer admin can see all logs in their customer
        if (!user.customerId) {
          throw new ForbiddenException('Customer admin must belong to a customer');
        }
        if (!user.tenantId) {
          throw new ForbiddenException('Customer admin must have a tenant');
        }
        
        context.allowedTenantIds = [user.tenantId];
        context.allowedCustomerIds = [user.customerId];
        context.canSeeCustomerLogs = true;
        break;

      case UserRole.CUSTOMER_USER:
        // Customer user can only see their own logs
        if (!user.customerId) {
          throw new ForbiddenException('Customer user must belong to a customer');
        }
        if (!user.tenantId) {
          throw new ForbiddenException('Customer user must have a tenant');
        }
        
        context.allowedTenantIds = [user.tenantId];
        context.allowedCustomerIds = [user.customerId];
        context.canSeeOwnLogsOnly = true;
        break;

      case UserRole.USER:
        // Regular user can only see their own logs
        if (user.tenantId) {
          context.allowedTenantIds = [user.tenantId];
        }
        context.canSeeOwnLogsOnly = true;
        break;

      default:
        throw new ForbiddenException('Invalid user role');
    }

    return context;
  }

  /**
   * Apply role-based filters to query builder
   */
  private applyRoleBasedFilters(
    queryBuilder: any,
    context: AuditContext,
  ): void {
    // Super admin - see everything (no filters)
    if (context.canSeeAllTenantLogs && context.allowedTenantIds.length === 0) {
      return;
    }

    // Tenant admin or filtered super admin - filter by tenant
    if (context.canSeeAllTenantLogs && context.allowedTenantIds.length > 0) {
      queryBuilder.andWhere('audit.tenantId IN (:...tenantIds)', {
        tenantIds: context.allowedTenantIds,
      });
      return;
    }

    // Own logs only (CUSTOMER_USER or USER)
    if (context.canSeeOwnLogsOnly) {
      queryBuilder.andWhere('audit.userId = :userId', {
        userId: context.user.id,
      });
      
      if (context.allowedTenantIds.length > 0) {
        queryBuilder.andWhere('audit.tenantId IN (:...tenantIds)', {
          tenantIds: context.allowedTenantIds,
        });
      }
      
      if (context.allowedCustomerIds.length > 0) {
        queryBuilder.andWhere('audit.customerId IN (:...customerIds)', {
          customerIds: context.allowedCustomerIds,
        });
      }
      return;
    }

    // Customer admin - see customer logs only
    if (context.canSeeCustomerLogs && !context.canSeeAllTenantLogs) {
      queryBuilder.andWhere('audit.tenantId IN (:...tenantIds)', {
        tenantIds: context.allowedTenantIds,
      });
      
      queryBuilder.andWhere('audit.customerId IN (:...customerIds)', {
        customerIds: context.allowedCustomerIds,
      });
    }
  }

  /**
   * Create an audit log entry
   */
  async log(createAuditLogDto: CreateAuditLogDto): Promise<AuditLog> {
    const auditLog = this.auditRepository.create({
      ...createAuditLogDto,
      timestamp: new Date(),
    });

    const saved = await this.auditRepository.save(auditLog);

    // Emit event for real-time updates
    this.eventEmitter.emit('audit.logged', saved);

    return saved;
  }

  /**
   * Quick log method for common patterns with auto-context
   */
  async logAction(params: {
    userId?: string;
    userName?: string;
    userEmail?: string;
    tenantId: string;
    customerId?: string;
    action: AuditAction;
    entityType: AuditEntityType;
    entityId?: string;
    entityName?: string;
    description?: string;
    metadata?: Record<string, any>;
    changes?: { before?: any; after?: any };
    ipAddress?: string;
    userAgent?: string;
    requestId?: string;
    severity?: AuditSeverity;
    success?: boolean;
    errorMessage?: string;
    tags?: string[];
  }): Promise<AuditLog> {
    return await this.log({
      userId: params.userId,
      userName: params.userName,
      userEmail: params.userEmail,
      tenantId: params.tenantId,
      customerId: params.customerId,
      action: params.action,
      entityType: params.entityType,
      entityId: params.entityId,
      entityName: params.entityName,
      description: params.description,
      metadata: params.metadata,
      changes: params.changes,
      ipAddress: params.ipAddress,
      userAgent: params.userAgent,
      requestId: params.requestId,
      severity: params.severity || AuditSeverity.INFO,
      success: params.success ?? true,
      errorMessage: params.errorMessage,
      tags: params.tags,
    });
  }

  /**
   * Query audit logs with automatic role-based filtering
   */
  async findAll(
    queryDto: QueryAuditLogsDto,
    currentUser: User,
  ): Promise<{
    logs: AuditLog[];
    total: number;
    page: number;
    limit: number;
    totalPages: number;
  }> {
    // Build audit context from current user
    const context = await this.buildAuditContext(currentUser);

    const page = queryDto.page || 1;
    const limit = Math.min(queryDto.limit || 50, 1000);
    const skip = (page - 1) * limit;

    const queryBuilder = this.auditRepository
      .createQueryBuilder('audit')
      .leftJoinAndSelect('audit.user', 'user')
      .leftJoinAndSelect('audit.tenant', 'tenant')
      .leftJoinAndSelect('audit.customer', 'customer');

    // Apply automatic role-based filters
    this.applyRoleBasedFilters(queryBuilder, context);

    // Apply additional user-provided filters
    if (queryDto.action) {
      queryBuilder.andWhere('audit.action = :action', {
        action: queryDto.action,
      });
    }

    if (queryDto.entityType) {
      queryBuilder.andWhere('audit.entityType = :entityType', {
        entityType: queryDto.entityType,
      });
    }

    if (queryDto.entityId) {
      queryBuilder.andWhere('audit.entityId = :entityId', {
        entityId: queryDto.entityId,
      });
    }

    if (queryDto.severity) {
      queryBuilder.andWhere('audit.severity = :severity', {
        severity: queryDto.severity,
      });
    }

    if (queryDto.success !== undefined) {
      queryBuilder.andWhere('audit.success = :success', {
        success: queryDto.success,
      });
    }

    if (queryDto.startDate && queryDto.endDate) {
      queryBuilder.andWhere('audit.timestamp BETWEEN :start AND :end', {
        start: new Date(queryDto.startDate),
        end: new Date(queryDto.endDate),
      });
    }

    if (queryDto.tags && queryDto.tags.length > 0) {
      queryBuilder.andWhere('audit.tags && :tags', { tags: queryDto.tags });
    }

    if (queryDto.search) {
      queryBuilder.andWhere(
        '(audit.description ILIKE :search OR audit.entityName ILIKE :search OR audit.userName ILIKE :search OR audit.userEmail ILIKE :search)',
        { search: `%${queryDto.search}%` },
      );
    }

    // Get total count
    const total = await queryBuilder.getCount();

    // Apply pagination and ordering
    const logs = await queryBuilder
      .orderBy('audit.timestamp', queryDto.sortOrder || 'DESC')
      .skip(skip)
      .take(limit)
      .getMany();

    return {
      logs,
      total,
      page,
      limit,
      totalPages: Math.ceil(total / limit),
    };
  }

  /**
   * MODULE-SPECIFIC METHODS with automatic role-based filtering
   */

  async findUserModuleLogs(
    userId: string | undefined,
    currentUser: User,
    options?: Partial<QueryAuditLogsDto>,
  ) {
    return this.findAll(
      {
        ...options,
        entityType: AuditEntityType.USER,
        entityId: userId,
        page: options?.page,
        limit: options?.limit,
        startDate: options?.startDate,
        endDate: options?.endDate,
        search: options?.search,
      } as QueryAuditLogsDto,
      currentUser,
    );
  }

  async findDeviceModuleLogs(
    deviceId: string | undefined,
    currentUser: User,
    options?: Partial<QueryAuditLogsDto>,
  ) {
    return this.findAll(
      {
        ...options,
        entityType: AuditEntityType.DEVICE,
        entityId: deviceId,
        page: options?.page,
        limit: options?.limit,
        startDate: options?.startDate,
        endDate: options?.endDate,
        search: options?.search,
      } as QueryAuditLogsDto,
      currentUser,
    );
  }

  async findAlarmModuleLogs(
    alarmId: string | undefined,
    currentUser: User,
    options?: Partial<QueryAuditLogsDto>,
  ) {
    return this.findAll(
      {
        ...options,
        entityType: AuditEntityType.ALARM,
        entityId: alarmId,
        page: options?.page,
        limit: options?.limit,
        startDate: options?.startDate,
        endDate: options?.endDate,
      } as QueryAuditLogsDto,
      currentUser,
    );
  }

  async findDeviceProfileModuleLogs(
    profileId: string | undefined,
    currentUser: User,
    options?: Partial<QueryAuditLogsDto>,
  ) {
    return this.findAll(
      {
        ...options,
        entityType: AuditEntityType.DEVICE_PROFILE,
        entityId: profileId,
        page: options?.page,
        limit: options?.limit,
        startDate: options?.startDate,
        endDate: options?.endDate,
      } as QueryAuditLogsDto,
      currentUser,
    );
  }

  async findAssetModuleLogs(
    assetId: string | undefined,
    currentUser: User,
    options?: Partial<QueryAuditLogsDto>,
  ) {
    return this.findAll(
      {
        ...options,
        entityType: AuditEntityType.ASSET,
        entityId: assetId,
        page: options?.page,
        limit: options?.limit,
        startDate: options?.startDate,
        endDate: options?.endDate,
      } as QueryAuditLogsDto,
      currentUser,
    );
  }

  async findDashboardModuleLogs(
    dashboardId: string | undefined,
    currentUser: User,
    options?: Partial<QueryAuditLogsDto>,
  ) {
    return this.findAll(
      {
        ...options,
        entityType: AuditEntityType.DASHBOARD,
        entityId: dashboardId,
        page: options?.page,
        limit: options?.limit,
        startDate: options?.startDate,
        endDate: options?.endDate,
      } as QueryAuditLogsDto,
      currentUser,
    );
  }

  async findCustomerModuleLogs(
    customerId: string | undefined,
    currentUser: User,
    options?: Partial<QueryAuditLogsDto>,
  ) {
    return this.findAll(
      {
        ...options,
        entityType: AuditEntityType.CUSTOMER,
        entityId: customerId,
        page: options?.page,
        limit: options?.limit,
        startDate: options?.startDate,
        endDate: options?.endDate,
      } as QueryAuditLogsDto,
      currentUser,
    );
  }

  /**
   * Get audit log by ID with role-based access check
   */
  async findOne(id: string, currentUser: User): Promise<AuditLog> {
    const context = await this.buildAuditContext(currentUser);

    const queryBuilder = this.auditRepository
      .createQueryBuilder('audit')
      .leftJoinAndSelect('audit.user', 'user')
      .leftJoinAndSelect('audit.tenant', 'tenant')
      .leftJoinAndSelect('audit.customer', 'customer')
      .where('audit.id = :id', { id });

    // Apply role-based filters
    this.applyRoleBasedFilters(queryBuilder, context);

    const log = await queryBuilder.getOne();

    if (!log) {
      throw new NotFoundException('Audit log not found or access denied');
    }

    return log;
  }

  /**
   * Get recent audit logs with role-based filtering
   */
  async getRecent(
    currentUser: User,
    hours: number = 24,
    limit: number = 100,
  ): Promise<AuditLog[]> {
    const context = await this.buildAuditContext(currentUser);
    const since = new Date();
    since.setHours(since.getHours() - hours);

    const queryBuilder = this.auditRepository
      .createQueryBuilder('audit')
      .leftJoinAndSelect('audit.user', 'user')
      .leftJoinAndSelect('audit.tenant', 'tenant')
      .leftJoinAndSelect('audit.customer', 'customer')
      .where('audit.timestamp >= :since', { since });

    this.applyRoleBasedFilters(queryBuilder, context);

    return await queryBuilder
      .orderBy('audit.timestamp', 'DESC')
      .take(limit)
      .getMany();
  }

  /**
   * Get failed actions with role-based filtering
   */
  async getFailedActions(
    currentUser: User,
    limit: number = 50,
  ): Promise<AuditLog[]> {
    const context = await this.buildAuditContext(currentUser);

    const queryBuilder = this.auditRepository
      .createQueryBuilder('audit')
      .leftJoinAndSelect('audit.user', 'user')
      .leftJoinAndSelect('audit.tenant', 'tenant')
      .leftJoinAndSelect('audit.customer', 'customer')
      .where('audit.success = :success', { success: false });

    this.applyRoleBasedFilters(queryBuilder, context);

    return await queryBuilder
      .orderBy('audit.timestamp', 'DESC')
      .take(limit)
      .getMany();
  }

  /**
   * Get audit statistics with role-based filtering
   */
  async getStatistics(
    currentUser: User,
    startDate?: Date,
    endDate?: Date,
  ): Promise<{
    total: number;
    byAction: Record<string, number>;
    byEntityType: Record<string, number>;
    bySeverity: Record<string, number>;
    successRate: number;
    topUsers: Array<{ userId: string; userName: string; count: number }>;
  }> {
    const context = await this.buildAuditContext(currentUser);

    const queryBuilder = this.auditRepository.createQueryBuilder('audit');

    this.applyRoleBasedFilters(queryBuilder, context);

    if (startDate && endDate) {
      queryBuilder.andWhere('audit.timestamp BETWEEN :start AND :end', {
        start: startDate,
        end: endDate,
      });
    }

    const total = await queryBuilder.getCount();

    // Get counts by action
    const byActionQuery = queryBuilder.clone();
    const actionResults = await byActionQuery
      .select('audit.action', 'action')
      .addSelect('COUNT(*)', 'count')
      .groupBy('audit.action')
      .getRawMany();

    const byAction: Record<string, number> = {};
    actionResults.forEach((row) => {
      byAction[row.action] = parseInt(row.count);
    });

    // Get counts by entity type
    const byEntityTypeQuery = queryBuilder.clone();
    const entityTypeResults = await byEntityTypeQuery
      .select('audit.entityType', 'entityType')
      .addSelect('COUNT(*)', 'count')
      .groupBy('audit.entityType')
      .getRawMany();

    const byEntityType: Record<string, number> = {};
    entityTypeResults.forEach((row) => {
      byEntityType[row.entityType] = parseInt(row.count);
    });

    // Get counts by severity
    const bySeverityQuery = queryBuilder.clone();
    const severityResults = await bySeverityQuery
      .select('audit.severity', 'severity')
      .addSelect('COUNT(*)', 'count')
      .groupBy('audit.severity')
      .getRawMany();

    const bySeverity: Record<string, number> = {};
    severityResults.forEach((row) => {
      bySeverity[row.severity] = parseInt(row.count);
    });

    // Calculate success rate
    const successQuery = queryBuilder.clone();
    const successCount = await successQuery
      .andWhere('audit.success = :success', { success: true })
      .getCount();

    const successRate = total > 0 ? (successCount / total) * 100 : 0;

    // Get top users
    const topUsersQuery = queryBuilder.clone();
    const topUsersResults = await topUsersQuery
      .select('audit.userId', 'userId')
      .addSelect('audit.userName', 'userName')
      .addSelect('COUNT(*)', 'count')
      .where('audit.userId IS NOT NULL')
      .groupBy('audit.userId')
      .addGroupBy('audit.userName')
      .orderBy('count', 'DESC')
      .limit(10)
      .getRawMany();

    const topUsers = topUsersResults.map((row) => ({
      userId: row.userId,
      userName: row.userName || 'Unknown',
      count: parseInt(row.count),
    }));

    return {
      total,
      byAction,
      byEntityType,
      bySeverity,
      successRate,
      topUsers,
    };
  }

  /**
   * Delete old audit logs (Super admin only)
   */
  async deleteOld(daysOld: number, currentUser: User): Promise<number> {
    if (currentUser.role !== UserRole.SUPER_ADMIN) {
      throw new ForbiddenException('Only super admins can delete audit logs');
    }

    const cutoffDate = new Date();
    cutoffDate.setDate(cutoffDate.getDate() - daysOld);

    const result = await this.auditRepository.delete({
      timestamp: LessThan(cutoffDate),
    });

    return result.affected || 0;
  }

  /**
   * Export audit logs to CSV with role-based filtering
   */
  async exportToCSV(
    queryDto: QueryAuditLogsDto,
    currentUser: User,
  ): Promise<string> {
    const { logs } = await this.findAll(
      { ...queryDto, limit: 10000 },
      currentUser,
    );

    const headers = [
      'Timestamp',
      'Tenant ID',
      'Customer ID',
      'User ID',
      'User Name',
      'Email',
      'Action',
      'Entity Type',
      'Entity ID',
      'Entity Name',
      'Description',
      'Severity',
      'Success',
      'IP Address',
      'User Agent',
      'Error Message',
    ];

    const rows = logs.map((log) => [
      log.timestamp.toISOString(),
      log.tenantId || 'N/A',
      log.customerId || 'N/A',
      log.userId || 'N/A',
      log.userName || 'N/A',
      log.userEmail || 'N/A',
      log.action,
      log.entityType,
      log.entityId || 'N/A',
      log.entityName || 'N/A',
      (log.description || 'N/A').replace(/"/g, '""'), // Escape quotes
      log.severity,
      log.success ? 'Yes' : 'No',
      log.ipAddress || 'N/A',
      (log.userAgent || 'N/A').replace(/"/g, '""'), // Escape quotes
      (log.errorMessage || 'N/A').replace(/"/g, '""'), // Escape quotes
    ]);

    const csv = [headers, ...rows]
      .map((row) => row.map((cell) => `"${cell}"`).join(','))
      .join('\n');

    return csv;
  }
}