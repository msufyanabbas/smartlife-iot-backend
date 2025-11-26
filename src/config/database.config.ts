import { DatabaseConfig } from '@/common/interfaces/common.interface';
import { registerAs } from '@nestjs/config';
import { TypeOrmModuleOptions } from '@nestjs/typeorm';

export default registerAs(
  'database',
  (): TypeOrmModuleOptions & DatabaseConfig => {
    const sslEnabled = process.env.DB_SSL === 'true';

    return {
      type: 'postgres',
      host: process.env.DB_HOST,
      port: parseInt(process.env.DB_PORT || '5432', 10),
      username: process.env.DB_USERNAME,
      password: process.env.DB_PASSWORD,
      database: process.env.DB_DATABASE,

      // Auto-create tables (disable in production)
      synchronize: process.env.DB_SYNCHRONIZE === 'true',

      // Enable SQL query logs
      logging: process.env.DB_LOGGING === 'true',

      // SSL connection options
      ssl: sslEnabled ? { rejectUnauthorized: false } : false,

      // Retry strategy for DB connection
      retryAttempts: parseInt(process.env.DB_RETRY_ATTEMPTS || '10', 10),
      retryDelay: parseInt(process.env.DB_RETRY_DELAY || '3000', 10),

      // Automatically load entities from modules
      autoLoadEntities: true,

      // Connection pool options
      extra: {
        max: parseInt(process.env.DB_POOL_SIZE || '10', 10),
        connectionTimeoutMillis: 5000,
        idleTimeoutMillis: 30000,
      },
    };
  },
);
