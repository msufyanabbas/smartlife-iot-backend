// src/config/migration.config.ts
import { MigrationConfig } from '@common/interfaces/common.interface';
import { registerAs } from '@nestjs/config';
import { DataSource, DataSourceOptions } from 'typeorm';

export default registerAs(
  'migration',
  (): MigrationConfig => ({
    // Database Connection
    type: 'postgres',
    host: process.env.DB_HOST,
    port: parseInt(process.env.DB_PORT || '5432', 10),
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
    migrationsTableName: process.env.DB_MIGRATIONS_TABLE || 'migrations',
    synchronize: false, // ⚠️  ALWAYS false for migrations
    logging: process.env.DB_LOGGING === 'true',

    // Connection Options
    ssl: process.env.DB_SSL === 'true',
    extra:
      process.env.DB_SSL === 'true'
        ? {
            ssl: {
              rejectUnauthorized:
                process.env.DB_SSL_REJECT_UNAUTHORIZED !== 'false',
            },
          }
        : undefined,
  }),
);

// Separate DataSource for CLI usage (migrations, seeds, etc.)
export const migrationDataSource = new DataSource({
  type: 'postgres',
  host: process.env.DB_HOST || 'localhost',
  port: parseInt(process.env.DB_PORT || '5432', 10),
  username: process.env.DB_USERNAME || 'postgres',
  password: process.env.DB_PASSWORD || '123456',
  database: process.env.DB_DATABASE || 'postgres',
  entities: ['src/modules/**/entities/*.entity.ts'],
  migrations: ['src/database/migrations/*.ts'],
  migrationsTableName: process.env.DB_MIGRATIONS_TABLE || 'migrations',
  synchronize: false,
  logging: process.env.DB_LOGGING === 'true',
  ssl: process.env.DB_SSL === 'true',
  extra:
    process.env.DB_SSL === 'true'
      ? {
          ssl: {
            rejectUnauthorized:
              process.env.DB_SSL_REJECT_UNAUTHORIZED !== 'false',
          },
        }
      : undefined,
} as DataSourceOptions);
