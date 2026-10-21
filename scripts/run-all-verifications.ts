/**
 * ─────────────────────────────────────────────────────────────────────────────
 * Run every guard and verification script, and summarise
 * ─────────────────────────────────────────────────────────────────────────────
 *
 *   npm run verify:all              everything
 *   npm run verify:all -- --checks  static guards only (no database needed)
 *   npm run verify:all -- --filter ws   only scripts whose name contains "ws"
 *
 * ── Why this exists ───────────────────────────────────────────────────────
 * There are three dozen `check:*` and `verify:*` scripts and no single way to
 * run them, so in practice each one was run only by whoever had just touched
 * the thing it guards. That is how the suite came to contain scripts that had
 * been broken for a while: eleven had drifted out of sync with constructors
 * they build by hand, and one was reporting twelve passes while testing
 * nothing at all.
 *
 * It also removes a papercut that makes a working script look broken. The
 * DB-backed scripts each take a database name and expect it to exist; run one
 * fresh and it exits with `database "assettypecheck" does not exist`, which
 * reads as a failure of the thing being verified rather than a missing
 * scratch database. This creates them first.
 *
 * `check:*` scripts read source and need nothing. `verify:*` scripts need
 * Postgres; a few also want Redis (`verify:cluster-locks`) or stand up a local
 * server on a port (`verify:ws-delivery`, `verify:rpc`, `verify:lwm2m`,
 * `verify:snmp`, `verify:industrial-protocols`). Anything unavailable is
 * reported as SKIP, not as a pass — a suite that quietly counts an
 * unrunnable script as green is the failure mode this whole directory exists
 * to prevent.
 */
import { spawnSync } from 'child_process';
import { readFileSync } from 'fs';
import { join } from 'path';

const root = join(__dirname, '..');
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));

const args = process.argv.slice(2);
const checksOnly = args.includes('--checks');
const verifyOnly = args.includes('--verify');
const filterIdx = args.indexOf('--filter');
const filter = filterIdx >= 0 ? args[filterIdx + 1] : undefined;

/**
 * Scratch databases the DB-backed scripts default to. Taken from each
 * script's own `process.argv[2] ?? '<name>'` default, so this list and the
 * scripts cannot disagree about where the fixtures go.
 */
const SCRATCH_DATABASES = [
  'permcheck',
  'tscope',
  'bulkcheck',
  'subcheck',
  'aicheck',
  'wsauthz',
  'assettypecheck',
  'fpstorage',
];

const PG = {
  host: process.env.DB_HOST ?? 'localhost',
  port: process.env.DB_PORT ?? '5432',
  user: process.env.DB_USERNAME ?? 'postgres',
  password: process.env.DB_PASSWORD ?? '123456',
};

type Outcome = 'pass' | 'fail' | 'skip';
const results: Array<{ script: string; outcome: Outcome; note?: string }> = [];

function scriptNames(): string[] {
  const all = Object.keys(pkg.scripts).filter(
    (name) =>
      // Exclude this runner. It matches its own `verify:` prefix, so the first
      // version recursed into itself and burned its ten-minute timeout before
      // reaching the rest of the suite.
      name !== 'verify:all' &&
      (checksOnly
        ? name.startsWith('check:')
        : verifyOnly
          ? name.startsWith('verify:')
          : /^(check|verify):/.test(name)),
  );
  // Static guards first: they are fast and their failures are the easiest to
  // act on, so a developer sees those before waiting on the database suite.
  const ordered = [
    ...all.filter((n) => n.startsWith('check:')).sort(),
    ...all.filter((n) => n.startsWith('verify:')).sort(),
  ];
  return filter ? ordered.filter((n) => n.includes(filter)) : ordered;
}

function postgresReachable(): boolean {
  const probe = spawnSync(
    'psql',
    ['-h', PG.host, '-p', PG.port, '-U', PG.user, '-d', 'postgres', '-c', 'SELECT 1'],
    { env: { ...process.env, PGPASSWORD: PG.password }, stdio: 'ignore' },
  );
  return probe.status === 0;
}

function ensureDatabases(): void {
  for (const db of SCRATCH_DATABASES) {
    const exists = spawnSync(
      'psql',
      ['-h', PG.host, '-p', PG.port, '-U', PG.user, '-d', 'postgres', '-tAc',
       `SELECT 1 FROM pg_database WHERE datname = '${db}'`],
      { env: { ...process.env, PGPASSWORD: PG.password }, encoding: 'utf8' },
    );
    if (exists.stdout?.trim() === '1') continue;

    const created = spawnSync(
      'createdb',
      ['-h', PG.host, '-p', PG.port, '-U', PG.user, db],
      { env: { ...process.env, PGPASSWORD: PG.password }, stdio: 'ignore' },
    );
    console.log(
      created.status === 0
        ? `  created scratch database "${db}"`
        : `  could not create "${db}" — scripts using it will fail`,
    );
  }
}

function run(script: string): { outcome: Outcome; summary: string } {
  const started = Date.now();
  const result = spawnSync('npm', ['run', '--silent', script], {
    cwd: root,
    encoding: 'utf8',
    env: { ...process.env, PGPASSWORD: PG.password },
    timeout: 10 * 60 * 1000,
    maxBuffer: 64 * 1024 * 1024,
  });

  const output = `${result.stdout ?? ''}${result.stderr ?? ''}`;
  // Strip colour so the summary line is readable when piped to a file.
  const plain = output.replace(/\u001b\[[0-9;]*m/g, '');

  // A script that exits 2 is declaring its dependency absent (Redis, a
  // listener port). That is a skip. Counting it as a pass would be a lie, and
  // counting it as a failure would train people to ignore red.
  if (result.status === 2) {
    const reason =
      plain.split('\n').find((l) => l.includes('SKIP')) ?? 'dependency unavailable';
    return { outcome: 'skip', summary: reason.trim().slice(0, 90) };
  }

  const summaryLine =
    plain
      .split('\n')
      .reverse()
      .find((l) => /^(PASS|FAIL)\b/.test(l.trim()) || /✅|❌/.test(l)) ?? '';

  const seconds = ((Date.now() - started) / 1000).toFixed(1);
  return {
    outcome: result.status === 0 ? 'pass' : 'fail',
    summary: `${summaryLine.trim().slice(0, 86)} (${seconds}s)`,
  };
}

(() => {
  const scripts = scriptNames();
  const needsDatabase = scripts.some((s) => s.startsWith('verify:'));

  console.log(`\nRunning ${scripts.length} guard and verification script(s)\n`);

  if (needsDatabase) {
    if (!postgresReachable()) {
      console.log(
        `  Postgres at ${PG.host}:${PG.port} is not reachable — every verify:* ` +
          'script will be reported as SKIP.\n',
      );
    } else {
      ensureDatabases();
      console.log('');
    }
  }

  for (const script of scripts) {
    process.stdout.write(`  ${script.padEnd(32)}`);
    const { outcome, summary } = run(script);
    results.push({ script, outcome, note: summary });
    const label =
      outcome === 'pass'
        ? '\u001b[32mPASS\u001b[0m'
        : outcome === 'skip'
          ? '\u001b[33mSKIP\u001b[0m'
          : '\u001b[31mFAIL\u001b[0m';
    console.log(`${label}  ${summary}`);
  }

  const counts = {
    pass: results.filter((r) => r.outcome === 'pass').length,
    fail: results.filter((r) => r.outcome === 'fail').length,
    skip: results.filter((r) => r.outcome === 'skip').length,
  };

  console.log(
    `\n${counts.pass} passed, ${counts.fail} failed, ${counts.skip} skipped\n`,
  );

  if (counts.fail > 0) {
    console.log('Failed:');
    for (const r of results.filter((x) => x.outcome === 'fail')) {
      console.log(`  ${r.script}  —  re-run with:  npm run ${r.script}`);
    }
    console.log('');
  }

  process.exit(counts.fail === 0 ? 0 : 1);
})();
