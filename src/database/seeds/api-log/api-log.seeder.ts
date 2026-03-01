// src/database/seeders/api-log.seeder.ts
import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { APILog, User, Tenant } from '@modules/index.entities';
import { ISeeder } from '../seeder.interface';

@Injectable()
export class APILogSeeder implements ISeeder {
  constructor(
    @InjectRepository(APILog)
    private readonly apiLogRepository: Repository<APILog>,
    @InjectRepository(User)
    private readonly userRepository: Repository<User>,
    @InjectRepository(Tenant)
    private readonly tenantRepository: Repository<Tenant>,
  ) {}

  async seed(): Promise<void> {
    console.log('📝 Seeding API logs...');

    // Get first tenant
    const tenant = await this.tenantRepository.findOne({
      where: {},
      order: { createdAt: 'ASC' },
    });

    if (!tenant) {
      console.log('⚠️  No tenants found. Please seed tenants first.');
      return;
    }

    // Get users from this tenant
    const users = await this.userRepository.find({
      where: { tenantId: tenant.id },
      take: 3,
    });

    if (users.length === 0) {
      console.log('⚠️  No users found. Please seed users first.');
      return;
    }

    // Helper functions
    const getRandomInt = (min: number, max: number): number => {
      return Math.floor(Math.random() * (max - min + 1)) + min;
    };

    const getMinutesAgo = (minutes: number): Date => {
      const date = new Date();
      date.setMinutes(date.getMinutes() - minutes);
      return date;
    };

    const apiLogsData = [
      // 1. Successful GET request
      {
        tenantId: tenant.id,
        customerId: users[0]?.customerId,
        userId: users[0]?.id,
        requestId: `req-${Date.now()}-001`,
        method: 'GET',
        endpoint: '/api/v1/devices',
        statusCode: 200,
        responseTime: 85,
        ip: '192.168.1.100',
        userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        timestamp: getMinutesAgo(5),
        request: {
          query: { page: 1, limit: 10, status: 'active' },
        },
        response: {
          statusCode: 200,
        },
        metadata: {
          route: 'DevicesController.findAll',
          executionTime: 80,
          dbQueryCount: 2,
          cacheHit: false,
        },
      },

      // 2. Successful POST request (Created)
      {
        tenantId: tenant.id,
        customerId: users[0]?.customerId,
        userId: users[0]?.id,
        requestId: `req-${Date.now()}-002`,
        method: 'POST',
        endpoint: '/api/v1/devices',
        statusCode: 201,
        responseTime: 145,
        ip: '192.168.1.100',
        userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        timestamp: getMinutesAgo(15),
        request: {
          // ⚠️ NO body - it may contain sensitive data
          // ⚠️ NO headers - they contain Authorization tokens
        },
        response: {
          statusCode: 201,
        },
        metadata: {
          route: 'DevicesController.create',
          executionTime: 142,
          dbQueryCount: 3,
          cacheHit: false,
        },
      },

      // 3. Unauthorized request (401)
      {
        tenantId: undefined, // No tenant for unauthenticated request
        customerId: undefined,
        userId: undefined,
        requestId: `req-${Date.now()}-003`,
        method: 'GET',
        endpoint: '/api/v1/devices',
        statusCode: 401,
        responseTime: 12,
        ip: '203.0.113.45',
        userAgent: 'PostmanRuntime/7.32.3',
        timestamp: getMinutesAgo(30),
        request: {},
        response: {
          statusCode: 401,
        },
        errorMessage: 'Unauthorized access attempt to /api/v1/devices',
        metadata: {
          route: 'JwtAuthGuard',
          executionTime: 10,
          dbQueryCount: 0,
          cacheHit: false,
        },
      },

      // 4. Not Found error (404)
      {
        tenantId: tenant.id,
        customerId: users[1]?.customerId || users[0]?.customerId,
        userId: users[1]?.id || users[0]?.id,
        requestId: `req-${Date.now()}-004`,
        method: 'GET',
        endpoint: '/api/v1/devices/non-existent-id',
        statusCode: 404,
        responseTime: 45,
        ip: '192.168.1.101',
        userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
        timestamp: getMinutesAgo(45),
        request: {
          params: { id: 'non-existent-id' },
        },
        response: {
          statusCode: 404,
        },
        errorMessage: 'Resource not found at /api/v1/devices/non-existent-id',
        metadata: {
          route: 'DevicesController.findOne',
          executionTime: 42,
          dbQueryCount: 1,
          cacheHit: false,
        },
      },

      // 5. Slow request (performance issue)
      {
        tenantId: tenant.id,
        customerId: users[2]?.customerId || users[0]?.customerId,
        userId: users[2]?.id || users[0]?.id,
        requestId: `req-${Date.now()}-005`,
        method: 'GET',
        endpoint: '/api/v1/analytics/reports',
        statusCode: 200,
        responseTime: 2450, // Slow!
        ip: '192.168.1.102',
        userAgent: 'axios/1.5.0',
        timestamp: getMinutesAgo(60),
        request: {
          query: { 
            startDate: '2025-01-01', 
            endDate: '2025-11-30',
            groupBy: 'day'
          },
        },
        response: {
          statusCode: 200,
        },
        metadata: {
          route: 'AnalyticsController.generateReport',
          executionTime: 2445,
          dbQueryCount: 15,
          cacheHit: false,
        },
      },
    ];

    for (const logData of apiLogsData) {
      const existing = await this.apiLogRepository.findOne({
        where: {
          requestId: logData.requestId,
        },
      });

      if (!existing) {
        const log = this.apiLogRepository.create(logData);
        await this.apiLogRepository.save(log);
        console.log(
          `✅ Created API log: ${logData.method} ${logData.endpoint} (${logData.statusCode})`,
        );
      } else {
        console.log(
          `⏭️  API log already exists: ${logData.requestId}`,
        );
      }
    }

    console.log('🎉 API log seeding completed! (5 logs created)');
  }
}