// src/health/indicators/database.health.ts
import { Injectable } from '@nestjs/common';
import { HealthIndicator, HealthIndicatorResult, HealthCheckError } from '@nestjs/terminus';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';

@Injectable()
export class DatabaseHealthIndicator extends HealthIndicator {
  constructor(@InjectDataSource() private dataSource: DataSource) {
    super();
  }

  async isHealthy(key: string): Promise<HealthIndicatorResult> {
    try {
      const result = await this.dataSource.query('SELECT 1');
      const isHealthy = result && result.length > 0;

      if (isHealthy) {
        // Get connection pool stats
        const driver = this.dataSource.driver as any;
        const poolSize = driver.master?.options?.max || 10;
        const activeConnections = driver.master?.totalCount || 0;

        return this.getStatus(key, true, {
          poolSize,
          activeConnections,
          database: this.dataSource.options.database,
        });
      }

      throw new HealthCheckError('Database check failed', {
        database: { status: 'down' },
      });
    } catch (error) {
      throw new HealthCheckError('Database check failed', {
        database: { status: 'down', error: error.message },
      });
    }
  }
}