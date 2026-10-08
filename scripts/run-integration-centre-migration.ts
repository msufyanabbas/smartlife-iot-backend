/**
 * Applies IntegrationCentre1787400000000 on its own, against a database given
 * on the command line.
 *
 * Needed because `migration:run` is currently blocked: two earlier migrations
 * (PreExistingSchemaDrift / SchemaDriftFix) have never been applied and the
 * first one fails, and because they sort ahead of everything later the whole
 * transaction aborts. This runs one migration in isolation so its SQL can be
 * verified without untangling that first.
 */
import { DataSource } from 'typeorm';
import { IntegrationCentre1787400000000 } from '../src/database/migrations/1787400000000-IntegrationCentre';

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
  const migration = new IntegrationCentre1787400000000();

  // No explicit transaction: `ALTER TYPE ... ADD VALUE` is only transactional
  // on PG12+ when the new label is not used before commit, and running it
  // outside one matches how `migration:run --transaction=each` would behave
  // for this migration anyway.
  if (direction === 'down') await migration.down(runner);
  else await migration.up(runner);

  console.log(`${direction}() completed on "${database}"`);
  await runner.release();
  await dataSource.destroy();
})().catch((error) => {
  console.error('FAILED:', error.message);
  process.exit(1);
});
