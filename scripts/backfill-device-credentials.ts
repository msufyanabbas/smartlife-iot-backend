/**
 * ─────────────────────────────────────────────────────────────────────────────
 * Issue ACCESS_TOKEN credentials to every device that has none
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * Turning on `DEVICE_AUTH_ENFORCED` (the default) means an ingest request
 * must present a real credential. Any device without a row in
 * `device_credentials` stops being able to report the moment enforcement is
 * live — which, on a deployment that has been running without it, is every
 * device.
 *
 * This script closes that gap: one ACCESS_TOKEN per device that lacks
 * credentials, printed once so the tokens can be provisioned onto the
 * hardware.
 *
 *   npx ts-node -T -r tsconfig-paths/register \
 *     scripts/backfill-device-credentials.ts <database> [--apply]
 *
 * It is a DRY RUN by default. Nothing is written without `--apply`, because
 * the tokens are printed exactly once and a run nobody was watching is a run
 * whose output is lost.
 *
 * Idempotent: a device that already has credentials is skipped, never
 * rotated. Rotating a working device's token from a backfill script would
 * take the fleet offline, which is the opposite of the point.
 */
import { DataSource } from 'typeorm';
import * as crypto from 'crypto';

const database = process.argv[2] ?? process.env.DB_DATABASE ?? 'postgres';
const apply = process.argv.includes('--apply');

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

/**
 * 32 bytes of CSPRNG output, base64url.
 *
 * Not a uuid: a uuid v4 carries 122 bits in a recognisable shape, and these
 * tokens are the only thing standing between a stranger and a device's
 * identity. `randomBytes` is the right source and base64url survives a URL
 * path segment, an MQTT username and a CoAP path without escaping.
 */
function newToken(): string {
  return crypto.randomBytes(32).toString('base64url');
}

(async () => {
  await dataSource.initialize();

  const missing: Array<{ id: string; deviceKey: string; name: string }> =
    await dataSource.query(`
      SELECT d.id, d."deviceKey", d.name
      FROM devices d
      LEFT JOIN device_credentials c ON c."deviceId" = d.id
      WHERE c.id IS NULL AND d.deleted_at IS NULL
      ORDER BY d."createdAt"
    `);

  const total: Array<{ count: string }> = await dataSource.query(
    `SELECT COUNT(*)::text AS count FROM devices WHERE deleted_at IS NULL`,
  );

  console.log(`\nDatabase : ${database}`);
  console.log(`Devices  : ${total[0]?.count ?? '0'}`);
  console.log(`Missing  : ${missing.length} device(s) have no credentials\n`);

  if (missing.length === 0) {
    console.log('Nothing to do — every device already has credentials.');
    await dataSource.destroy();
    return;
  }

  if (!apply) {
    console.log('DRY RUN — no tokens issued. Re-run with --apply to write.\n');
    for (const d of missing.slice(0, 20)) {
      console.log(`  ${d.deviceKey.padEnd(28)} ${d.name ?? ''}`);
    }
    if (missing.length > 20) {
      console.log(`  … and ${missing.length - 20} more`);
    }
    await dataSource.destroy();
    return;
  }

  console.log('Issuing tokens. RECORD THESE — they are shown only once.\n');
  console.log('deviceKey,name,accessToken');

  let issued = 0;
  for (const d of missing) {
    const token = newToken();
    try {
      await dataSource.query(
        `INSERT INTO device_credentials
           (id, "deviceId", "credentialsType", "credentialsId", "isActive",
            created_at, updated_at)
         VALUES (gen_random_uuid(), $1, 'ACCESS_TOKEN', $2, true, now(), now())`,
        [d.id, token],
      );
      // CSV so the output can be piped straight into a provisioning step
      // rather than retyped. Names are quoted because they contain commas.
      console.log(`${d.deviceKey},"${(d.name ?? '').replace(/"/g, '""')}",${token}`);
      issued++;
    } catch (error) {
      console.error(
        `  FAILED ${d.deviceKey}: ${(error as Error).message}`,
      );
    }
  }

  console.log(`\nIssued ${issued} of ${missing.length}.`);
  if (issued < missing.length) {
    console.log(
      'Some devices were not issued a token and will be rejected while ' +
        'enforcement is on. Investigate before enabling it.',
    );
  }

  await dataSource.destroy();
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
