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
    // Fetch users and tenants
    const users = await this.userRepository.find({ take: 10 });
    const tenants = await this.tenantRepository.find({ take: 5 });

    if (users.length === 0) {
      console.log(
        '⚠️  No users found. Seeding API logs without user associations.',
      );
    }

    if (tenants.length === 0) {
      console.log(
        '⚠️  No tenants found. Seeding API logs without tenant associations.',
      );
    }

    // Helper functions
    const getRandomItem = <T>(array: T[]): T | undefined => {
      return array.length > 0
        ? array[Math.floor(Math.random() * array.length)]
        : undefined;
    };

    const getRandomInt = (min: number, max: number): number => {
      return Math.floor(Math.random() * (max - min + 1)) + min;
    };

    const getRandomDate = (daysAgo: number): Date => {
      const date = new Date();
      date.setDate(date.getDate() - daysAgo);
      date.setHours(
        getRandomInt(0, 23),
        getRandomInt(0, 59),
        getRandomInt(0, 59),
      );
      return date;
    };

    // Common endpoints
    const endpoints = [
      '/api/v1/users',
      '/api/v1/users/:id',
      '/api/v1/devices',
      '/api/v1/devices/:id',
      '/api/v1/devices/:id/telemetry',
      '/api/v1/alarms',
      '/api/v1/alarms/:id',
      '/api/v1/tenants',
      '/api/v1/tenants/:id',
      '/api/v1/analytics/dashboard',
      '/api/v1/analytics/reports',
      '/api/v1/auth/login',
      '/api/v1/auth/logout',
      '/api/v1/auth/refresh',
      '/api/v1/health',
    ];

    const methods = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'];
    const statusCodes = [200, 201, 204, 400, 401, 403, 404, 422, 500];
    const userAgents = [
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
      'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36',
      'PostmanRuntime/7.32.3',
      'axios/1.5.0',
      'curl/7.88.1',
    ];

    const ips = [
      '192.168.1.100',
      '10.0.0.50',
      '172.16.0.25',
      '203.0.113.45',
      '198.51.100.89',
      '192.0.2.123',
    ];

    // Generate API logs
    const apiLogs: Partial<APILog>[] = [];

    for (let i = 0; i < 100; i++) {
      const method = getRandomItem(methods)!;
      const endpoint = getRandomItem(endpoints)!;
      const statusCode = getRandomItem(statusCodes)!;
      const isError = statusCode >= 400;
      const user = getRandomItem(users);
      const tenant = getRandomItem(tenants);

      const logData: Partial<APILog> = {
        method,
        endpoint,
        statusCode,
        responseTime: getRandomInt(10, isError ? 5000 : 1000),
        userId: user?.id,
        tenantId: tenant?.id,
        ip: getRandomItem(ips)!,
        userAgent: getRandomItem(userAgents),
        timestamp: getRandomDate(getRandomInt(0, 30)),
      };

      // Add request data
      if (method === 'POST' || method === 'PUT' || method === 'PATCH') {
        logData.request = {
          headers: {
            'content-type': 'application/json',
            authorization: 'Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...',
          },
          body: this.generateRequestBody(endpoint, method),
        };
      } else if (method === 'GET') {
        logData.request = {
          headers: {
            authorization: 'Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...',
          },
          query: this.generateQueryParams(endpoint),
        };
      }

      // Add response data
      if (isError) {
        logData.response = {
          statusCode,
          body: this.generateErrorResponse(statusCode),
        };
        logData.errorMessage = this.generateErrorMessage(statusCode, endpoint);
      } else {
        logData.response = {
          statusCode,
          body: this.generateSuccessResponse(endpoint, method, statusCode),
        };
      }

      apiLogs.push(logData);
    }

    // Save logs
    let created = 0;
    for (const logData of apiLogs) {
      const log = this.apiLogRepository.create(logData);
      await this.apiLogRepository.save(log);
      created++;
    }

    console.log(`✅ Created ${created} API log entries`);
    console.log('🎉 API log seeding completed!');
  }

  private generateRequestBody(endpoint: string, method: string): any {
    if (
      endpoint.includes('/users') &&
      (method === 'POST' || method === 'PUT')
    ) {
      return {
        email: 'user@example.com',
        firstName: 'John',
        lastName: 'Doe',
        role: 'user',
      };
    }
    if (
      endpoint.includes('/devices') &&
      (method === 'POST' || method === 'PUT')
    ) {
      return {
        name: 'Temperature Sensor',
        type: 'sensor',
        status: 'active',
      };
    }
    if (
      endpoint.includes('/alarms') &&
      (method === 'POST' || method === 'PUT')
    ) {
      return {
        name: 'Temperature Alert',
        severity: 'critical',
        rule: { telemetryKey: 'temperature', condition: 'gt', value: 75 },
      };
    }
    if (endpoint.includes('/auth/login')) {
      return {
        email: 'user@example.com',
        password: '********',
      };
    }
    return {};
  }

  private generateQueryParams(endpoint: string): any {
    if (endpoint.includes('/devices') && !endpoint.includes(':id')) {
      return { page: 1, limit: 10, status: 'active' };
    }
    if (endpoint.includes('/alarms')) {
      return { page: 1, limit: 20, severity: 'critical' };
    }
    if (endpoint.includes('/analytics')) {
      return { startDate: '2025-11-01', endDate: '2025-11-05' };
    }
    return {};
  }

  private generateSuccessResponse(
    endpoint: string,
    method: string,
    statusCode: number,
  ): any {
    if (statusCode === 204) {
      return null;
    }
    if (method === 'GET' && !endpoint.includes(':id')) {
      return {
        data: [],
        meta: { page: 1, limit: 10, total: 0 },
      };
    }
    if (method === 'POST' || method === 'PUT') {
      return {
        id: 'uuid-' + Math.random().toString(36).substring(7),
        message: 'Resource created successfully',
      };
    }
    if (endpoint.includes('/auth/login')) {
      return {
        accessToken: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...',
        refreshToken: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...',
      };
    }
    return { success: true };
  }

  private generateErrorResponse(statusCode: number): any {
    const errors: Record<number, any> = {
      400: {
        statusCode: 400,
        message: 'Bad Request',
        errors: ['Validation failed'],
      },
      401: {
        statusCode: 401,
        message: 'Unauthorized',
        error: 'Invalid credentials',
      },
      403: {
        statusCode: 403,
        message: 'Forbidden',
        error: 'Insufficient permissions',
      },
      404: {
        statusCode: 404,
        message: 'Not Found',
        error: 'Resource not found',
      },
      422: {
        statusCode: 422,
        message: 'Unprocessable Entity',
        errors: ['Invalid input data'],
      },
      500: {
        statusCode: 500,
        message: 'Internal Server Error',
        error: 'An unexpected error occurred',
      },
    };
    return errors[statusCode] || { statusCode, message: 'Error' };
  }

  private generateErrorMessage(statusCode: number, endpoint: string): string {
    const messages: Record<number, string> = {
      400: `Bad request to ${endpoint}`,
      401: `Unauthorized access attempt to ${endpoint}`,
      403: `Forbidden access to ${endpoint}`,
      404: `Resource not found at ${endpoint}`,
      422: `Validation error for ${endpoint}`,
      500: `Internal server error at ${endpoint}`,
    };
    return messages[statusCode] || `Error at ${endpoint}`;
  }
}
