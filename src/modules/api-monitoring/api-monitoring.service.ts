import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, Between, MoreThan, LessThan } from 'typeorm';
import { APILog } from './entities/api-log.entity';
import { APILogFilterDto } from './dto/api-log-filter.dto';

@Injectable()
export class ApiMonitoringService {
  constructor(
    @InjectRepository(APILog)
    private readonly apiLogRepository: Repository<APILog>,
  ) {}

  async createLog(logData: Partial<APILog>): Promise<APILog> {
    const log = this.apiLogRepository.create(logData);
    return await this.apiLogRepository.save(log);
  }

  async getLogs(userId: string, filters: APILogFilterDto) {
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
      .where('log.userId = :userId', { userId });

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

  async getMetrics(userId: string) {
    const now = new Date();
    const last24Hours = new Date(now.getTime() - 24 * 60 * 60 * 1000);

    const [totalRequests, successRequests, errorRequests] = await Promise.all([
      this.apiLogRepository.count({
        where: { userId, timestamp: MoreThan(last24Hours) },
      }),
      this.apiLogRepository.count({
        where: {
          userId,
          timestamp: MoreThan(last24Hours),
          statusCode: Between(200, 299),
        },
      }),
      this.apiLogRepository.count({
        where: {
          userId,
          timestamp: MoreThan(last24Hours),
          statusCode: MoreThan(399),
        },
      }),
    ]);

    const avgResponseTimeResult = await this.apiLogRepository
      .createQueryBuilder('log')
      .select('AVG(log.response_time)', 'avg')
      .where('log.userId = :userId', { userId })
      .andWhere('log.timestamp > :last24Hours', { last24Hours })
      .getRawOne();

    const requestsByEndpointResult = await this.apiLogRepository
      .createQueryBuilder('log')
      .select('log.endpoint', 'endpoint')
      .addSelect('COUNT(*)', 'count')
      .where('log.userId = :userId', { userId })
      .andWhere('log.timestamp > :last24Hours', { last24Hours })
      .groupBy('log.endpoint')
      .orderBy('count', 'DESC')
      .limit(10)
      .getRawMany();

    const requestsByMethodResult = await this.apiLogRepository
      .createQueryBuilder('log')
      .select('log.method', 'method')
      .addSelect('COUNT(*)', 'count')
      .where('log.userId = :userId', { userId })
      .andWhere('log.timestamp > :last24Hours', { last24Hours })
      .groupBy('log.method')
      .getRawMany();

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

  async getStatistics(userId: string) {
    const [totalLogs] = await Promise.all([
      this.apiLogRepository.count({ where: { userId } }),
    ]);

    const statusCodeResult = await this.apiLogRepository
      .createQueryBuilder('log')
      .select('log.statusCode', 'statusCode')
      .addSelect('COUNT(*)', 'count')
      .where('log.userId = :userId', { userId })
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

  async getPerformanceMetrics(userId: string) {
    const now = new Date();
    const last1Hour = new Date(now.getTime() - 60 * 60 * 1000);

    // Get response times by minute for the last hour
    const responseTimesByMinuteResult = await this.apiLogRepository
      .createQueryBuilder('log')
      .select("DATE_TRUNC('minute', log.timestamp)", 'minute')
      .addSelect('AVG(log.response_time)', 'avgResponseTime')
      .where('log.userId = :userId', { userId })
      .andWhere('log.timestamp > :last1Hour', { last1Hour })
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
}
