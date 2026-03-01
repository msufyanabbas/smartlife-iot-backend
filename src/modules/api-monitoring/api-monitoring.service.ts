// src/modules/api-monitoring/services/api-monitoring.service.ts
import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, Between, MoreThan, LessThan } from 'typeorm';
import { APILog, Tenant } from '@modules/index.entities';
import { APILogFilterDto } from './dto/api-log-filter.dto';
import { Cron } from '@nestjs/schedule';

@Injectable()
export class ApiMonitoringService {
  private readonly logger = new Logger(ApiMonitoringService.name);
  
  constructor(
    @InjectRepository(APILog)
    private readonly apiLogRepository: Repository<APILog>,
    @InjectRepository(Tenant)
    private readonly tenantRepository: Repository<Tenant>,
  ) {}

  /**
   * Create API log
   */
  async createLog(logData: Partial<APILog>): Promise<APILog> {
    const log = this.apiLogRepository.create(logData);
    return await this.apiLogRepository.save(log);
  }

  /**
   * Get logs for tenant (optionally filtered by customer)
   */
  async getLogs(
    tenantId: string | undefined,
    filters: APILogFilterDto,
    customerId?: string,
  ) {
    const {
      page = 1,
      limit = 50,
      method,
      endpoint,
      statusCode,
      startDate,
      endDate,
    } = filters;
    const skip = (page - 1) * limit;

    const queryBuilder = this.apiLogRepository
      .createQueryBuilder('log')
      .where('log.tenantId = :tenantId', { tenantId });

    // Filter by customer if provided
    if (customerId) {
      queryBuilder.andWhere('log.customerId = :customerId', { customerId });
    }

    if (method) {
      queryBuilder.andWhere('log.method = :method', { method });
    }

    if (endpoint) {
      queryBuilder.andWhere('log.endpoint ILIKE :endpoint', {
        endpoint: `%${endpoint}%`,
      });
    }

    if (statusCode) {
      queryBuilder.andWhere('log.statusCode = :statusCode', { statusCode });
    }

    if (startDate && endDate) {
      queryBuilder.andWhere('log.timestamp BETWEEN :startDate AND :endDate', {
        startDate,
        endDate,
      });
    } else if (startDate) {
      queryBuilder.andWhere('log.timestamp >= :startDate', { startDate });
    } else if (endDate) {
      queryBuilder.andWhere('log.timestamp <= :endDate', { endDate });
    }

    queryBuilder.orderBy('log.timestamp', 'DESC').skip(skip).take(limit);

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
   * Get logs for specific user
   */
  async getUserLogs(
    tenantId: string | undefined,
    userId: string,
    filters: APILogFilterDto,
  ) {
    const {
      page = 1,
      limit = 50,
      method,
      endpoint,
      statusCode,
      startDate,
      endDate,
    } = filters;
    const skip = (page - 1) * limit;

    const queryBuilder = this.apiLogRepository
      .createQueryBuilder('log')
      .where('log.tenantId = :tenantId', { tenantId })
      .andWhere('log.userId = :userId', { userId });

    if (method) {
      queryBuilder.andWhere('log.method = :method', { method });
    }

    if (endpoint) {
      queryBuilder.andWhere('log.endpoint ILIKE :endpoint', {
        endpoint: `%${endpoint}%`,
      });
    }

    if (statusCode) {
      queryBuilder.andWhere('log.statusCode = :statusCode', { statusCode });
    }

    if (startDate && endDate) {
      queryBuilder.andWhere('log.timestamp BETWEEN :startDate AND :endDate', {
        startDate,
        endDate,
      });
    }

    queryBuilder.orderBy('log.timestamp', 'DESC').skip(skip).take(limit);

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
   * Get metrics for tenant
   */
  async getMetrics(tenantId: string | undefined, customerId?: string) {
    const now = new Date();
    const last24Hours = new Date(now.getTime() - 24 * 60 * 60 * 1000);

    const whereCondition: any = {
      tenantId,
      timestamp: MoreThan(last24Hours),
    };

    if (customerId) {
      whereCondition.customerId = customerId;
    }

    const [totalRequests, successRequests, errorRequests] = await Promise.all([
      this.apiLogRepository.count({ where: whereCondition }),
      this.apiLogRepository.count({
        where: {
          ...whereCondition,
          statusCode: Between(200, 299),
        },
      }),
      this.apiLogRepository.count({
        where: {
          ...whereCondition,
          statusCode: MoreThan(399),
        },
      }),
    ]);

    const queryBuilder = this.apiLogRepository
      .createQueryBuilder('log')
      .select('AVG(log.responseTime)', 'avg')
      .where('log.tenantId = :tenantId', { tenantId })
      .andWhere('log.timestamp > :last24Hours', { last24Hours });

    if (customerId) {
      queryBuilder.andWhere('log.customerId = :customerId', { customerId });
    }

    const avgResponseTimeResult = await queryBuilder.getRawOne();

    const requestsByEndpointBuilder = this.apiLogRepository
      .createQueryBuilder('log')
      .select('log.endpoint', 'endpoint')
      .addSelect('COUNT(*)', 'count')
      .where('log.tenantId = :tenantId', { tenantId })
      .andWhere('log.timestamp > :last24Hours', { last24Hours });

    if (customerId) {
      requestsByEndpointBuilder.andWhere('log.customerId = :customerId', {
        customerId,
      });
    }

    const requestsByEndpointResult = await requestsByEndpointBuilder
      .groupBy('log.endpoint')
      .orderBy('count', 'DESC')
      .limit(10)
      .getRawMany();

    const requestsByMethodBuilder = this.apiLogRepository
      .createQueryBuilder('log')
      .select('log.method', 'method')
      .addSelect('COUNT(*)', 'count')
      .where('log.tenantId = :tenantId', { tenantId })
      .andWhere('log.timestamp > :last24Hours', { last24Hours });

    if (customerId) {
      requestsByMethodBuilder.andWhere('log.customerId = :customerId', {
        customerId,
      });
    }

    const requestsByMethodResult =
      await requestsByMethodBuilder.groupBy('log.method').getRawMany();

    return {
      totalRequests,
      successRequests,
      errorRequests,
      successRate:
        totalRequests > 0 ? (successRequests / totalRequests) * 100 : 0,
      errorRate: totalRequests > 0 ? (errorRequests / totalRequests) * 100 : 0,
      avgResponseTime: Math.round(
        parseFloat(avgResponseTimeResult?.avg || '0'),
      ),
      requestsByEndpoint: requestsByEndpointResult.map((r) => ({
        endpoint: r.endpoint,
        count: parseInt(r.count),
      })),
      requestsByMethod: requestsByMethodResult.reduce(
        (acc, item) => {
          acc[item.method] = parseInt(item.count);
          return acc;
        },
        {} as Record<string, number>,
      ),
    };
  }

  /**
   * Get metrics for specific user
   */
  async getUserMetrics(tenantId: string | undefined, userId: string) {
    const now = new Date();
    const last24Hours = new Date(now.getTime() - 24 * 60 * 60 * 1000);

    const whereCondition = {
      tenantId,
      userId,
      timestamp: MoreThan(last24Hours),
    };

    const [totalRequests, successRequests, errorRequests] = await Promise.all([
      this.apiLogRepository.count({ where: whereCondition }),
      this.apiLogRepository.count({
        where: {
          ...whereCondition,
          statusCode: Between(200, 299),
        },
      }),
      this.apiLogRepository.count({
        where: {
          ...whereCondition,
          statusCode: MoreThan(399),
        },
      }),
    ]);

    const avgResponseTimeResult = await this.apiLogRepository
      .createQueryBuilder('log')
      .select('AVG(log.responseTime)', 'avg')
      .where('log.tenantId = :tenantId', { tenantId })
      .andWhere('log.userId = :userId', { userId })
      .andWhere('log.timestamp > :last24Hours', { last24Hours })
      .getRawOne();

    return {
      totalRequests,
      successRequests,
      errorRequests,
      successRate:
        totalRequests > 0 ? (successRequests / totalRequests) * 100 : 0,
      avgResponseTime: Math.round(
        parseFloat(avgResponseTimeResult?.avg || '0'),
      ),
    };
  }

  /**
   * Get statistics
   */
  async getStatistics(tenantId: string | undefined, customerId?: string) {
    const whereCondition: any = { tenantId };

    if (customerId) {
      whereCondition.customerId = customerId;
    }

    const totalLogs = await this.apiLogRepository.count({
      where: whereCondition,
    });

    const queryBuilder = this.apiLogRepository
      .createQueryBuilder('log')
      .select('log.statusCode', 'statusCode')
      .addSelect('COUNT(*)', 'count')
      .where('log.tenantId = :tenantId', { tenantId });

    if (customerId) {
      queryBuilder.andWhere('log.customerId = :customerId', { customerId });
    }

    const statusCodeResult = await queryBuilder
      .groupBy('log.statusCode')
      .getRawMany();

    const byStatusCode = statusCodeResult.reduce(
      (acc, item) => {
        acc[item.statusCode] = parseInt(item.count);
        return acc;
      },
      {} as Record<number, number>,
    );

    return {
      total: totalLogs,
      byStatusCode,
    };
  }

  /**
   * Get error logs (status >= 400)
   */
  async getErrors(
    tenantId: string | undefined,
    filters: APILogFilterDto,
    customerId?: string,
  ) {
    const { page = 1, limit = 50, startDate, endDate } = filters;
    const skip = (page - 1) * limit;

    const queryBuilder = this.apiLogRepository
      .createQueryBuilder('log')
      .where('log.tenantId = :tenantId', { tenantId })
      .andWhere('log.statusCode >= :minStatus', { minStatus: 400 });

    if (customerId) {
      queryBuilder.andWhere('log.customerId = :customerId', { customerId });
    }

    if (startDate && endDate) {
      queryBuilder.andWhere('log.timestamp BETWEEN :startDate AND :endDate', {
        startDate,
        endDate,
      });
    }

    queryBuilder.orderBy('log.timestamp', 'DESC').skip(skip).take(limit);

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
   * Get slow requests (response time > 1000ms)
   */
  async getSlowRequests(
    tenantId: string | undefined,
    filters: APILogFilterDto,
    customerId?: string,
  ) {
    const { page = 1, limit = 50, startDate, endDate } = filters;
    const skip = (page - 1) * limit;

    const queryBuilder = this.apiLogRepository
      .createQueryBuilder('log')
      .where('log.tenantId = :tenantId', { tenantId })
      .andWhere('log.responseTime > :threshold', { threshold: 1000 });

    if (customerId) {
      queryBuilder.andWhere('log.customerId = :customerId', { customerId });
    }

    if (startDate && endDate) {
      queryBuilder.andWhere('log.timestamp BETWEEN :startDate AND :endDate', {
        startDate,
        endDate,
      });
    }

    queryBuilder
      .orderBy('log.responseTime', 'DESC')
      .skip(skip)
      .take(limit);

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
   * Get top endpoints by usage
   */
  async getTopEndpoints(tenantId: string | undefined, customerId?: string) {
    const now = new Date();
    const last24Hours = new Date(now.getTime() - 24 * 60 * 60 * 1000);

    const queryBuilder = this.apiLogRepository
      .createQueryBuilder('log')
      .select('log.endpoint', 'endpoint')
      .addSelect('COUNT(*)', 'count')
      .addSelect('AVG(log.responseTime)', 'avgResponseTime')
      .where('log.tenantId = :tenantId', { tenantId })
      .andWhere('log.timestamp > :last24Hours', { last24Hours });

    if (customerId) {
      queryBuilder.andWhere('log.customerId = :customerId', { customerId });
    }

    const result = await queryBuilder
      .groupBy('log.endpoint')
      .orderBy('count', 'DESC')
      .limit(20)
      .getRawMany();

    return result.map((r) => ({
      endpoint: r.endpoint,
      count: parseInt(r.count),
      avgResponseTime: Math.round(parseFloat(r.avgResponseTime)),
    }));
  }

  /**
   * Get system health
   */
  async getHealth() {
    // TODO: Implement actual health checks for various services
    return {
      status: 'healthy',
      timestamp: new Date(),
      services: {
        database: 'healthy',
        redis: 'healthy',
        mqtt: 'healthy',
      },
      uptime: process.uptime(),
    };
  }

  /**
   * Get performance metrics
   */
  async getPerformanceMetrics(tenantId: string | undefined, customerId?: string) {
    const now = new Date();
    const last1Hour = new Date(now.getTime() - 60 * 60 * 1000);

    const queryBuilder = this.apiLogRepository
      .createQueryBuilder('log')
      .select("DATE_TRUNC('minute', log.timestamp)", 'minute')
      .addSelect('AVG(log.responseTime)', 'avgResponseTime')
      .where('log.tenantId = :tenantId', { tenantId })
      .andWhere('log.timestamp > :last1Hour', { last1Hour });

    if (customerId) {
      queryBuilder.andWhere('log.customerId = :customerId', { customerId });
    }

    const responseTimesByMinuteResult = await queryBuilder
      .groupBy('minute')
      .orderBy('minute', 'ASC')
      .getRawMany();

    return {
      responseTimesByMinute: responseTimesByMinuteResult.map((r) => ({
        time: r.minute,
        avgResponseTime: Math.round(parseFloat(r.avgResponseTime)),
      })),
    };
  }

  /**
   * Delete logs older than 90 days (run for all tenants)
   */
  @Cron('0 2 * * *') // Run at 2 AM daily
  async cleanupOldLogs() {
    const ninetyDaysAgo = new Date();
    ninetyDaysAgo.setDate(ninetyDaysAgo.getDate() - 90);

    const result = await this.apiLogRepository
      .createQueryBuilder()
      .delete()
      .where('timestamp < :date', { date: ninetyDaysAgo })
      .execute();

    this.logger.log(`Deleted ${result.affected} old API logs (older than 90 days)`);
  }

  /**
   * Delete logs for specific tenant
   */
  async deleteOldLogsForTenant(tenantId: string, daysOld: number): Promise<number> {
    const cutoffDate = new Date();
    cutoffDate.setDate(cutoffDate.getDate() - daysOld);

    const result = await this.apiLogRepository
      .createQueryBuilder()
      .delete()
      .where('tenantId = :tenantId', { tenantId })
      .andWhere('timestamp < :cutoffDate', { cutoffDate })
      .execute();

    return result.affected || 0;
  }
}