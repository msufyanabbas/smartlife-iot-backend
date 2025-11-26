import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, Between, LessThan } from 'typeorm';
import { EventEmitter2, OnEvent } from '@nestjs/event-emitter';
import {
  AuditLog,
  AuditAction,
  AuditEntityType,
  AuditSeverity,
} from './entities/audit-log.entity';
import { CreateAuditLogDto, QueryAuditLogsDto } from './dto/audit.dto';

@Injectable()
export class AuditService {
  constructor(
    @InjectRepository(AuditLog)
    private auditRepository: Repository<AuditLog>,
    private eventEmitter: EventEmitter2,
  ) {}

  /**
   * Create an audit log entry
   */
  async log(createAuditLogDto: CreateAuditLogDto): Promise<AuditLog> {
    const auditLog = this.auditRepository.create({
      ...createAuditLogDto,
      timestamp: new Date(),
    });

    return await this.auditRepository.save(auditLog);
  }

  /**
   * Quick log method for common patterns
   */
  async logAction(
    userId: string | undefined,
    action: AuditAction,
    entityType: AuditEntityType,
    entityId?: string,
    options?: {
      description?: string;
      metadata?: Record<string, any>;
      changes?: { before?: any; after?: any };
      ipAddress?: string;
      userAgent?: string;
      severity?: AuditSeverity;
      success?: boolean;
      errorMessage?: string;
    },
  ): Promise<AuditLog> {
    return await this.log({
      userId,
      action,
      entityType,
      entityId,
      description: options?.description,
      metadata: options?.metadata,
      changes: options?.changes,
      ipAddress: options?.ipAddress,
      userAgent: options?.userAgent,
      severity: options?.severity || AuditSeverity.INFO,
      success: options?.success ?? true,
      errorMessage: options?.errorMessage,
    });
  }

  /**
   * Query audit logs with filters
   */
  async findAll(queryDto: QueryAuditLogsDto): Promise<{
    logs: AuditLog[];
    total: number;
    page: number;
    limit: number;
    totalPages: number;
  }> {
    const page = queryDto.page || 1;
    const limit = queryDto.limit || 50;
    const skip = (page - 1) * limit;

    const queryBuilder = this.auditRepository.createQueryBuilder('audit');

    // Apply filters
    if (queryDto.userId) {
      queryBuilder.andWhere('audit.userId = :userId', {
        userId: queryDto.userId,
      });
    }

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

    if (queryDto.tenantId) {
      queryBuilder.andWhere('audit.tenantId = :tenantId', {
        tenantId: queryDto.tenantId,
      });
    }

    if (queryDto.startDate && queryDto.endDate) {
      queryBuilder.andWhere('audit.timestamp BETWEEN :start AND :end', {
        start: new Date(queryDto.startDate),
        end: new Date(queryDto.endDate),
      });
    }

    if (queryDto.search) {
      queryBuilder.andWhere(
        '(audit.description ILIKE :search OR audit.entityName ILIKE :search OR audit.userName ILIKE :search)',
        { search: `%${queryDto.search}%` },
      );
    }

    // Get total count
    const total = await queryBuilder.getCount();

    // Apply pagination and ordering
    const logs = await queryBuilder
      .orderBy('audit.timestamp', 'DESC')
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
   * Get audit log by ID
   */
  async findOne(id: string): Promise<AuditLog | null> {
    return await this.auditRepository.findOne({ where: { id } });
  }

  /**
   * Get audit logs for a specific user
   */
  async findByUser(userId: string, limit: number = 100): Promise<AuditLog[]> {
    return await this.auditRepository.find({
      where: { userId },
      order: { timestamp: 'DESC' },
      take: limit,
    });
  }

  /**
   * Get audit logs for a specific entity
   */
  async findByEntity(
    entityType: AuditEntityType,
    entityId: string,
  ): Promise<AuditLog[]> {
    return await this.auditRepository.find({
      where: { entityType, entityId },
      order: { timestamp: 'DESC' },
    });
  }

  /**
   * Get recent audit logs
   */
  async getRecent(
    hours: number = 24,
    limit: number = 100,
  ): Promise<AuditLog[]> {
    const since = new Date();
    since.setHours(since.getHours() - hours);

    return await this.auditRepository.find({
      where: {
        timestamp: Between(since, new Date()),
      },
      order: { timestamp: 'DESC' },
      take: limit,
    });
  }

  /**
   * Get failed actions
   */
  async getFailedActions(limit: number = 50): Promise<AuditLog[]> {
    return await this.auditRepository.find({
      where: { success: false },
      order: { timestamp: 'DESC' },
      take: limit,
    });
  }

  /**
   * Get audit statistics
   */
  async getStatistics(
    startDate?: Date,
    endDate?: Date,
  ): Promise<{
    total: number;
    byAction: Record<string, number>;
    byEntityType: Record<string, number>;
    bySeverity: Record<string, number>;
    successRate: number;
    topUsers: Array<{ userId: string; count: number }>;
  }> {
    const queryBuilder = this.auditRepository.createQueryBuilder('audit');

    if (startDate && endDate) {
      queryBuilder.where('audit.timestamp BETWEEN :start AND :end', {
        start: startDate,
        end: endDate,
      });
    }

    const total = await queryBuilder.getCount();

    // Count by action
    const actionCounts = await this.auditRepository
      .createQueryBuilder('audit')
      .select('audit.action', 'action')
      .addSelect('COUNT(*)', 'count')
      .groupBy('audit.action')
      .getRawMany();

    const byAction: Record<string, number> = {};
    actionCounts.forEach((row) => {
      byAction[row.action] = parseInt(row.count);
    });

    // Count by entity type
    const entityCounts = await this.auditRepository
      .createQueryBuilder('audit')
      .select('audit.entityType', 'entityType')
      .addSelect('COUNT(*)', 'count')
      .groupBy('audit.entityType')
      .getRawMany();

    const byEntityType: Record<string, number> = {};
    entityCounts.forEach((row) => {
      byEntityType[row.entityType] = parseInt(row.count);
    });

    // Count by severity
    const severityCounts = await this.auditRepository
      .createQueryBuilder('audit')
      .select('audit.severity', 'severity')
      .addSelect('COUNT(*)', 'count')
      .groupBy('audit.severity')
      .getRawMany();

    const bySeverity: Record<string, number> = {};
    severityCounts.forEach((row) => {
      bySeverity[row.severity] = parseInt(row.count);
    });

    // Calculate success rate
    const successCount = await this.auditRepository.count({
      where: { success: true },
    });
    const successRate = total > 0 ? (successCount / total) * 100 : 0;

    // Top users
    const topUsers = await this.auditRepository
      .createQueryBuilder('audit')
      .select('audit.userId', 'userId')
      .addSelect('COUNT(*)', 'count')
      .where('audit.userId IS NOT NULL')
      .groupBy('audit.userId')
      .orderBy('count', 'DESC')
      .limit(10)
      .getRawMany();

    return {
      total,
      byAction,
      byEntityType,
      bySeverity,
      successRate: Math.round(successRate * 100) / 100,
      topUsers: topUsers.map((row) => ({
        userId: row.userId,
        count: parseInt(row.count),
      })),
    };
  }

  /**
   * Delete old audit logs
   */
  async deleteOld(daysOld: number): Promise<number> {
    const cutoffDate = new Date();
    cutoffDate.setDate(cutoffDate.getDate() - daysOld);

    const result = await this.auditRepository.delete({
      timestamp: LessThan(cutoffDate),
    });

    return result.affected || 0;
  }

  /**
   * Export audit logs to CSV
   */
  async exportToCSV(queryDto: QueryAuditLogsDto): Promise<string> {
    const { logs } = await this.findAll({ ...queryDto, limit: 10000 });

    const headers = [
      'Timestamp',
      'User',
      'Action',
      'Entity Type',
      'Entity ID',
      'Description',
      'Severity',
      'Success',
      'IP Address',
    ];

    const rows = logs.map((log) => [
      log.timestamp.toISOString(),
      log.userName || log.userId || 'N/A',
      log.action,
      log.entityType,
      log.entityId || 'N/A',
      log.description || 'N/A',
      log.severity,
      log.success ? 'Yes' : 'No',
      log.ipAddress || 'N/A',
    ]);

    const csv = [headers, ...rows].map((row) => row.join(',')).join('\n');
    return csv;
  }

  // ============================================
  // Event Listeners for automatic audit logging
  // ============================================

  @OnEvent('user.created')
  async handleUserCreated(payload: { user: any }) {
    await this.logAction(
      payload.user.id,
      AuditAction.CREATE,
      AuditEntityType.USER,
      payload.user.id,
      {
        description: `User ${payload.user.email} created`,
        metadata: { role: payload.user.role },
      },
    );
  }

  @OnEvent('user.updated')
  async handleUserUpdated(payload: { user: any }) {
    await this.logAction(
      payload.user.id,
      AuditAction.UPDATE,
      AuditEntityType.USER,
      payload.user.id,
      {
        description: `User ${payload.user.email} updated`,
      },
    );
  }

  @OnEvent('user.deleted')
  async handleUserDeleted(payload: { userId: string }) {
    await this.logAction(
      payload.userId,
      AuditAction.DELETE,
      AuditEntityType.USER,
      payload.userId,
      {
        description: 'User deleted',
        severity: AuditSeverity.WARNING,
      },
    );
  }

  @OnEvent('device.created')
  async handleDeviceCreated(payload: { device: any; userId: string }) {
    await this.logAction(
      payload.userId,
      AuditAction.CREATE,
      AuditEntityType.DEVICE,
      payload.device.id,
      {
        description: `Device ${payload.device.name} created`,
      },
    );
  }

  @OnEvent('device.updated')
  async handleDeviceUpdated(payload: { device: any; userId: string }) {
    await this.logAction(
      payload.userId,
      AuditAction.UPDATE,
      AuditEntityType.DEVICE,
      payload.device.id,
      {
        description: `Device ${payload.device.name} updated`,
      },
    );
  }

  @OnEvent('alarm.triggered')
  async handleAlarmTriggered(payload: { alarm: any }) {
    await this.logAction(
      undefined,
      AuditAction.ALARM_TRIGGER,
      AuditEntityType.ALARM,
      payload.alarm.id,
      {
        description: `Alarm ${payload.alarm.name} triggered`,
        severity: AuditSeverity.WARNING,
        metadata: {
          severity: payload.alarm.severity,
          deviceId: payload.alarm.deviceId,
        },
      },
    );
  }

  @OnEvent('user.login')
  async handleUserLogin(payload: {
    userId: string;
    email: string;
    ipAddress?: string;
  }) {
    await this.logAction(
      payload.userId,
      AuditAction.LOGIN,
      AuditEntityType.USER,
      payload.userId,
      {
        description: `User ${payload.email} logged in`,
        ipAddress: payload.ipAddress,
      },
    );
  }

  @OnEvent('user.password.changed')
  async handlePasswordChanged(payload: { userId: string }) {
    await this.logAction(
      payload.userId,
      AuditAction.PASSWORD_CHANGE,
      AuditEntityType.USER,
      payload.userId,
      {
        description: 'Password changed',
        severity: AuditSeverity.WARNING,
      },
    );
  }
}
