// src/database/data-source.ts
//
// This is the DataSource the running application uses (AppModule passes
// `AppDataSource.options` to `TypeOrmModule.forRoot`), so anything ignored here
// is ignored at runtime no matter what the config files say.
//
// Two things were previously ignored, and both matter in production:
//
//   * `ssl: false` was hardcoded. `DB_SSL` existed in the example env and in
//     database.config.ts, but neither reached the app — so a managed Postgres
//     that requires TLS would refuse the connection, and worse, one that merely
//     *offers* TLS would silently accept a plaintext connection carrying the
//     database password.
//   * The connection pool and retry settings (`DB_POOL_SIZE`,
//     `DB_RETRY_ATTEMPTS`, `DB_RETRY_DELAY`) were never applied, leaving TypeORM
//     on its defaults regardless of what was configured.
//
// Env loading is delegated to config/load-env, which resolves .env.<NODE_ENV>
// then .env in one place, so this file and ConfigModule can no longer disagree
// about which file is authoritative.

import { DataSource } from 'typeorm';
import path from 'path';
import * as entities from '@modules/index.entities';
import '@/config/load-env';
import {
  envBoolean,
  envNumber,
  envRequired,
  envString,
} from '@/config/env.utils';

const sslEnabled = envBoolean(process.env.DB_SSL, false);

export const AppDataSource = new DataSource({
  type: 'postgres',

  host: envRequired('DB_HOST', process.env.DB_HOST),
  port: envNumber(process.env.DB_PORT, 5432),
  username: envRequired('DB_USERNAME', process.env.DB_USERNAME),
  password: envRequired('DB_PASSWORD', process.env.DB_PASSWORD),
  database: envRequired('DB_DATABASE', process.env.DB_DATABASE),

  entities: Object.values(entities),

  // .js only — loading .ts migrations here crashes app boot with
  // ERR_INTERNAL_ASSERTION (TypeORM dynamic-import of a .ts file under nodenext).
  migrations: [path.join(__dirname, 'migrations', '*.js')],
  migrationsTableName: envString(process.env.DB_MIGRATIONS_TABLE, 'migrations'),
  migrationsRun: envBoolean(process.env.DB_RUN_MIGRATIONS, false),

  // Never true here. The app boots against this DataSource, and synchronize
  // rewrites the live schema — including dropping columns it does not recognise.
  synchronize: false,
  logging: envBoolean(process.env.DB_LOGGING, false),

  // `rejectUnauthorized` defaults to true: a cloud provider using a private CA
  // should have its CA trusted, not verification switched off. Set
  // DB_SSL_REJECT_UNAUTHORIZED=false only as a deliberate, temporary exception.
  ssl: sslEnabled
    ? {
        rejectUnauthorized: envBoolean(
          process.env.DB_SSL_REJECT_UNAUTHORIZED,
          true,
        ),
      }
    : false,

  retryAttempts: envNumber(process.env.DB_RETRY_ATTEMPTS, 10),
  retryDelay: envNumber(process.env.DB_RETRY_DELAY, 3000),

  extra: {
    max: envNumber(process.env.DB_POOL_SIZE, 10),
    connectionTimeoutMillis: envNumber(process.env.DB_CONNECTION_TIMEOUT, 5000),
    idleTimeoutMillis: envNumber(process.env.DB_IDLE_TIMEOUT, 30000),
  },
} as any);
