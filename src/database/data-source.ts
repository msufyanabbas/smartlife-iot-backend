import { DataSource } from 'typeorm';
import { config } from 'dotenv';
import path from 'path';
import * as entities from '@modules/index.entities';

// Load environment variables - fix the path loading
const envFile = process.env.NODE_ENV ? `.env.${process.env.NODE_ENV}` : '.env';
config({ path: path.resolve(process.cwd(), envFile) });

// Fallback to default .env if specific env file doesn't exist
if (process.env.NODE_ENV && !process.env.DB_HOST) {
  config({ path: path.resolve(process.cwd(), '.env') });
}

export const AppDataSource = new DataSource({
  type: 'postgres',
  host: process.env.DB_HOST,
  port: parseInt(process.env.DB_PORT || '5432', 10),
  username: process.env.DB_USERNAME,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_DATABASE,
  entities: Object.values(entities),
  migrations: ['src/database/migrations/**/*.ts'],
  synchronize: process.env.DB_SYNCHRONIZE === 'true',
  logging: process.env.DB_LOGGING === 'true',
  ssl:
    process.env.NODE_ENV === 'production'
      ? { rejectUnauthorized: false }
      : false,
});
