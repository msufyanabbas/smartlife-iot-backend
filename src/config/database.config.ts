// src/config/database.config.ts
import { DatabaseConfig } from '@common/interfaces/common.interface';
import { registerAs } from '@nestjs/config';
import { TypeOrmModuleOptions } from '@nestjs/typeorm';

export default registerAs(
  'database',
  (): TypeOrmModuleOptions & DatabaseConfig => {
    const sslEnabled = process.env.DB_SSL === 'true';

    return {
      type: 'postgres',
      host: process.env.DB_HOST || 'localhost',
      port: parseInt(process.env.DB_PORT || '5432', 10),
      username: process.env.DB_USERNAME || 'smartlife',
      password: process.env.DB_PASSWORD || 'smartlife123',
      database: process.env.DB_DATABASE || 'smartlife_iot',

      ssl: sslEnabled
        ? {
            rejectUnauthorized: process.env.DB_SSL_REJECT_UNAUTHORIZED !== 'false',
          }
        : false,

      // ⚠️  IMPORTANT: Set to false in production, use migrations instead
      synchronize: process.env.NODE_ENV === 'development' && process.env.DB_SYNCHRONIZE === 'true',

      // SQL query logs (disable in production)
      logging: process.env.DB_LOGGING === 'true',

      // Retry strategy
      retryAttempts: parseInt(process.env.DB_RETRY_ATTEMPTS || '10', 10),
      retryDelay: parseInt(process.env.DB_RETRY_DELAY || '3000', 10),

      // Auto-load entities
      autoLoadEntities: true,

      // ✅ Added: Migrations directory
      migrations: ['dist/database/migrations/*.js'],
      migrationsRun: process.env.DB_RUN_MIGRATIONS === 'true',

      // Connection pool
      extra: {
        max: parseInt(process.env.DB_POOL_SIZE || '10', 10),
        connectionTimeoutMillis: 5000,
        idleTimeoutMillis: 30000,
      },
    };
  },
);