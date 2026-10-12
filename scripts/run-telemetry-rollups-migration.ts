/**
 * Applies TelemetryRollups1787600000000 on its own, against a database given on
 * the command line.
 *
 *   npm run migration:telemetry-rollups <database> [up|down]
 *
 * Needed for the same reason as the integration-centre and rule-chain-templates
 * runners: `migration:run` is currently blocked by two never-applied drift
 * migrations that sort ahead of everything later and abort the transaction
 * (CLAUDE.md §11).
 */
import { DataSource } from 'typeorm';
import { TelemetryRollups1787600000000 } from '../src/database/migrations/1787600000000-TelemetryRollups';

const database = process.argv[2] ?? 'migcheck';
const direction = process.argv[3] ?? 'up';

const dataSource = new DataSource({
  type: 'postgres',
  host: process.env.DB_HOST ?? 'localhost',
  port: Number(process.env.DB_PORT ?? 5432),
  username: process.env.DB_USERNAME ?? 'postgres',
  password: process.env.DB_PASSWORD ?? '123456',
  database,
  entities: [],
  migrations: [],
  synchronize: false,
});

(async () => {
  await dataSource.initialize();
  const runner = dataSource.createQueryRunner();
  await runner.connect();
  const migration = new TelemetryRollups1787600000000();

  if (direction === 'down') await migration.down(runner);
  else await migration.up(runner);

  console.log(`${direction}() completed on "${database}"`);
  await runner.release();
  await dataSource.destroy();
})().catch((error) => {
  console.error('FAILED:', error.message);
  process.exit(1);
});
