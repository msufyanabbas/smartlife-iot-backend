// src/config/migration.config.ts
import { MigrationConfig } from '@common/interfaces/common.interface';
import { registerAs } from '@nestjs/config';
import { DataSource, DataSourceOptions } from 'typeorm';
import { envBoolean, envNumber, envRequired, envString } from './env.utils';
import './load-env';

export default registerAs(
  'migration',
  (): MigrationConfig => ({
    // Database Connection
    type: 'postgres',
    host: process.env.DB_HOST,
    port: envNumber(process.env.DB_PORT, 5432),
    username: process.env.DB_USERNAME,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_DATABASE,

    // Migration Settings
    entities: [
      process.env.NODE_ENV === 'production'
        ? 'dist/modules/**/*.entity.js'
        : 'src/modules/**/*.entity.ts',
    ],
    migrations: [
      process.env.NODE_ENV === 'production'
        ? 'dist/database/migrations/*.js'
        : 'src/database/migrations/*.ts',
    ],
    migrationsTableName: envString(
      process.env.DB_MIGRATIONS_TABLE,
      'migrations',
    ),
    synchronize: false, // ⚠️  ALWAYS false for migrations
    logging: envBoolean(process.env.DB_LOGGING, false),

    // Connection Options
    ssl: envBoolean(process.env.DB_SSL, false),
    extra: envBoolean(process.env.DB_SSL, false)
      ? {
          ssl: {
            rejectUnauthorized: envBoolean(
              process.env.DB_SSL_REJECT_UNAUTHORIZED,
              true,
            ),
          },
        }
      : undefined,
  }),
);

// Separate DataSource for CLI usage (migrations, seeds, etc.)
//
// The previous version fell back to postgres/123456/postgres when the env was
// not loaded. That is the dangerous kind of default: `migration:run` would
// silently connect to a *different* database than the app, appear to succeed,
// and leave the real schema untouched. Every field is now required.
export const migrationDataSource = new DataSource({
  type: 'postgres',
  host: envRequired('DB_HOST', process.env.DB_HOST),
  port: envNumber(process.env.DB_PORT, 5432),
  username: envRequired('DB_USERNAME', process.env.DB_USERNAME),
  password: envRequired('DB_PASSWORD', process.env.DB_PASSWORD),
  database: envRequired('DB_DATABASE', process.env.DB_DATABASE),
  entities: ['src/modules/**/entities/*.entity.ts'],
  migrations: ['src/database/migrations/*.ts'],
  migrationsTableName: envString(process.env.DB_MIGRATIONS_TABLE, 'migrations'),
  synchronize: false,
  logging: envBoolean(process.env.DB_LOGGING, false),
  ssl: envBoolean(process.env.DB_SSL, false),
  extra: envBoolean(process.env.DB_SSL, false)
    ? {
        ssl: {
          rejectUnauthorized: envBoolean(
            process.env.DB_SSL_REJECT_UNAUTHORIZED,
            true,
          ),
        },
      }
    : undefined,
} as DataSourceOptions);
