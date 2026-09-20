// src/config/database.config.ts
import { DatabaseConfig } from '@common/interfaces/common.interface';
import { registerAs } from '@nestjs/config';
import { TypeOrmModuleOptions } from '@nestjs/typeorm';
import { envBoolean, envNumber, envRequired, envString } from './env.utils';

export default registerAs(
  'database',
  (): TypeOrmModuleOptions & DatabaseConfig => {
    const sslEnabled = envBoolean(process.env.DB_SSL, false);

    return {
      type: 'postgres',

      // No fallbacks on the connection identity. A default host of 'localhost'
      // or a default password of 'smartlife123' means a misconfigured deploy
      // starts up and connects to the wrong database (or fails at the first
      // query) instead of telling you what is missing.
      host: envRequired('DB_HOST', process.env.DB_HOST),
      port: envNumber(process.env.DB_PORT, 5432),
      username: envRequired('DB_USERNAME', process.env.DB_USERNAME),
      password: envRequired('DB_PASSWORD', process.env.DB_PASSWORD),
      database: envRequired('DB_DATABASE', process.env.DB_DATABASE),

      ssl: sslEnabled
        ? {
            rejectUnauthorized: envBoolean(
              process.env.DB_SSL_REJECT_UNAUTHORIZED,
              true,
            ),
          }
        : false,

      // ⚠️  IMPORTANT: Set to false in production, use migrations instead
      synchronize:
        process.env.NODE_ENV === 'development' &&
        envBoolean(process.env.DB_SYNCHRONIZE, false),

      // SQL query logs (disable in production)
      logging: envBoolean(process.env.DB_LOGGING, false),

      // Retry strategy
      retryAttempts: envNumber(process.env.DB_RETRY_ATTEMPTS, 10),
      retryDelay: envNumber(process.env.DB_RETRY_DELAY, 3000),

      // Auto-load entities
      autoLoadEntities: true,

      // ✅ Added: Migrations directory
      migrations: ['dist/database/migrations/*.js'],
      migrationsTableName: envString(
        process.env.DB_MIGRATIONS_TABLE,
        'migrations',
      ),
      migrationsRun: envBoolean(process.env.DB_RUN_MIGRATIONS, false),

      // Connection pool
      extra: {
        max: envNumber(process.env.DB_POOL_SIZE, 10),
        connectionTimeoutMillis: envNumber(
          process.env.DB_CONNECTION_TIMEOUT,
          5000,
        ),
        idleTimeoutMillis: envNumber(process.env.DB_IDLE_TIMEOUT, 30000),
      },
    };
  },
);
