/**
 * Applies AssetTypeFromProfile1788700000000 on its own, against a database
 * given on the command line.
 *
 *   npm run migration:asset-type-inheritance <database> [plan|up|down]
 *
 * `plan` is the default and writes nothing: it prints the per-branch row
 * counts and lists every asset the backfill refuses to classify. Read that
 * before running `up` on anything with real rows in it — the whole point of
 * the branch split is that a human decides the cases a rule cannot.
 *
 * Standalone for the same reason as the other runners: `migration:run` is
 * blocked by two never-applied drift migrations that sort ahead of everything
 * later and abort the transaction (CLAUDE.md §11).
 */
import { DataSource } from 'typeorm';
import { AssetTypeFromProfile1788700000000 } from '../src/database/migrations/1788700000000-AssetTypeFromProfile';

const database = process.argv[2] ?? 'migcheck';
const direction = process.argv[3] ?? 'plan';

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

/** Branch → what it means, so the report is readable without the source. */
const BRANCH_NOTES: Record<string, string> = {
  profiled_typed_agree:
    'has a typed profile, legacy column agrees — untouched',
  profiled_typed_disagree:
    'has a typed profile, legacy column disagrees — untouched, PROFILE WINS',
  profiled_untyped:
    'profile has no type — UNRESOLVED, fix belongs on the profile',
  profile_missing:
    'assetProfileId is dangling — UNRESOLVED, re-pointing would be a guess',
  matched_by_legacy_type:
    'no profile, legacy type maps to exactly one tenant profile — ASSIGNED',
  ambiguous_legacy_match:
    'no profile, legacy type maps to 2+ tenant profiles — UNRESOLVED',
  assigned_default_profile:
    "no profile, assigned the tenant's default/custom profile — ASSIGNED",
  unresolvable_no_default:
    'no profile and the tenant has no single default/custom — UNRESOLVED',
};

(async () => {
  await dataSource.initialize();
  const runner = dataSource.createQueryRunner();
  await runner.connect();
  const migration = new AssetTypeFromProfile1788700000000();

  if (direction === 'plan') {
    const counts = await migration.plan(runner);
    const total = Object.values(counts).reduce((a, b) => a + b, 0);
    console.log(`\nAsset type backfill plan for "${database}" — ${total} live asset(s)\n`);
    for (const [branch, n] of Object.entries(counts)) {
      console.log(`  ${String(n).padStart(6)}  ${branch.padEnd(26)} ${BRANCH_NOTES[branch] ?? ''}`);
    }

    const writes =
      counts.matched_by_legacy_type + counts.assigned_default_profile;
    const unresolved =
      counts.profiled_untyped +
      counts.profile_missing +
      counts.ambiguous_legacy_match +
      counts.unresolvable_no_default;
    console.log(`\n  up() would WRITE ${writes} row(s) and LEAVE ${unresolved} unresolved.`);

    if (unresolved > 0) {
      console.log('\nUnresolved assets (left alone, for a human to decide):');
      for (const row of await migration.unresolved(runner)) {
        console.log(
          `  ${row.branch.padEnd(24)} asset=${row.id} tenant=${row.tenantId} legacyType=${row.legacy_type}`,
        );
      }
    }
    console.log('');
  } else if (direction === 'down') {
    await migration.down(runner);
    console.log(`down() completed on "${database}"`);
  } else {
    // The counts are printed BEFORE the write, not after: "what is about to
    // happen" is the number worth having on the deploy log.
    const before = await migration.plan(runner);
    console.log(`before: ${JSON.stringify(before)}`);
    await migration.up(runner);
    console.log(`after:  ${JSON.stringify(await migration.plan(runner))}`);
    console.log(`up() completed on "${database}"`);
  }

  await runner.release();
  await dataSource.destroy();
})().catch((error) => {
  console.error('FAILED:', error.message);
  process.exit(1);
});
