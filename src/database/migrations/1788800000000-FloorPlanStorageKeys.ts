import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * `floor_plans` — driver-independent storage keys for the three file artefacts.
 *
 * ─── Why new columns rather than reusing the URL columns ──────────────────
 * A floor plan owns three files: the uploaded DWG/DXF source, the generated
 * PNG preview, and the generated or uploaded 3D model. Each already had a
 * column — `dwgFileUrl`, `thumbnailUrl`, `modelFileUrl` — holding a value like
 * `/uploads/floor-plans/dwg/<uuid>.dwg`, and the read paths reconstructed an
 * absolute local path from it (`path.join(process.cwd(), fileUrl)`).
 *
 * That works on one container and nowhere else, which is what
 * `src/lib/storage/` exists to fix. But the URL cannot simply be replaced by
 * the storage key: it is returned to clients (as `dwgFileUrl`, and as
 * `previewUrl` / `modelUrl` from `GET /floor-plans/:id`), an `<img src>` is
 * pointed straight at it, and with an object-store driver the public URL is
 * not derivable from the key at all (it may be signed, or on another host).
 *
 * So the two concerns are split: the `*Url` columns keep their meaning — where
 * a browser fetches it — and the new `*StorageKey` columns hold the
 * driver-independent identity (`floor-plans/dwg/<uuid>.dwg`), which is what
 * `StorageService.get()` / `.delete()` take. `storageProvider` records which
 * driver wrote the row, matching `images.storageProvider`.
 *
 * ─── The backfill ─────────────────────────────────────────────────────────
 * Existing rows hold only a URL, so `up()` derives the key for every row whose
 * URL sits under the public upload prefix: `/uploads/x/y` → `x/y`, which is
 * exactly the key the local driver would have produced for those bytes. Rows
 * whose URL is an absolute `http(s)` address (the seeder writes
 * `https://example.com/floorplans/...`) are left alone — they are not this
 * platform's files and have no key.
 *
 * The backfill is belt-and-braces: `FloorPlansService.resolveRef()` derives
 * the same key from the same URL at read time, so reads work with or without
 * this migration. What the backfill buys is that the columns are populated for
 * anything that queries them directly, and that a later switch to a remote
 * driver has a key to migrate the bytes under.
 *
 * ─── Running it ───────────────────────────────────────────────────────────
 * `migration:run` is blocked by two never-applied drift migrations that sort
 * ahead of everything later and abort the transaction (CLAUDE.md §11), so this
 * one has a standalone runner:
 *
 *   npm run migration:floor-plan-storage-keys <database> [up|down]
 */
export class FloorPlanStorageKeys1788800000000 implements MigrationInterface {
  name = 'FloorPlanStorageKeys1788800000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // IF NOT EXISTS throughout: this migration is applied by hand on several
    // databases (see the runner above) and must be safe to re-run.
    await queryRunner.query(`
      ALTER TABLE "floor_plans"
        ADD COLUMN IF NOT EXISTS "dwgStorageKey"       character varying(512),
        ADD COLUMN IF NOT EXISTS "thumbnailStorageKey" character varying(512),
        ADD COLUMN IF NOT EXISTS "modelStorageKey"     character varying(512),
        ADD COLUMN IF NOT EXISTS "storageProvider"     character varying(32)
    `);

    await queryRunner.query(`
      COMMENT ON COLUMN "floor_plans"."dwgStorageKey" IS
        'StorageService key for the uploaded DWG/DXF source, e.g. floor-plans/dwg/<uuid>.dwg. Driver-independent; dwgFileUrl is where a browser fetches it.'
    `);
    await queryRunner.query(`
      COMMENT ON COLUMN "floor_plans"."thumbnailStorageKey" IS
        'StorageService key for the generated PNG preview, e.g. floor-plans/previews/<id>.png.'
    `);
    await queryRunner.query(`
      COMMENT ON COLUMN "floor_plans"."modelStorageKey" IS
        'StorageService key for the 3D model, e.g. floor-plans/models/<id>.glb.'
    `);

    // The public prefix is UPLOAD_URL_PREFIX, which defaults to /uploads and is
    // what main.ts serves the upload directory at. Taken from the environment
    // so a deployment that changed it backfills correctly.
    const prefix = (process.env.UPLOAD_URL_PREFIX || '/uploads').replace(
      /\/+$/,
      '',
    );
    const like = `${prefix}/%`;
    const strip = prefix.length + 2; // SQL substring is 1-based; +1 skips the '/'

    for (const [urlColumn, keyColumn] of [
      ['dwgFileUrl', 'dwgStorageKey'],
      ['thumbnailUrl', 'thumbnailStorageKey'],
      ['modelFileUrl', 'modelStorageKey'],
    ] as const) {
      // `substr(text, int)`, not `substring(text FROM $1)`: with an untyped
      // parameter Postgres resolves the latter to the REGEX overload
      // `substring(text FROM text)`, so `FROM 10` is matched as the pattern
      // '10', finds nothing, and writes NULL into every row — a backfill that
      // runs, reports success and populates nothing. Found by running it.
      await queryRunner.query(
        `UPDATE "floor_plans"
            SET "${keyColumn}" = substr("${urlColumn}", $1::integer)
          WHERE "${keyColumn}" IS NULL
            AND "${urlColumn}" LIKE $2
            AND "${urlColumn}" NOT LIKE 'http://%'
            AND "${urlColumn}" NOT LIKE 'https://%'`,
        [strip, like],
      );
    }

    // Rows with any key now resolved are local-driver rows by definition —
    // nothing else has ever written these columns.
    await queryRunner.query(`
      UPDATE "floor_plans"
         SET "storageProvider" = 'local'
       WHERE "storageProvider" IS NULL
         AND ("dwgStorageKey" IS NOT NULL
           OR "thumbnailStorageKey" IS NOT NULL
           OR "modelStorageKey" IS NOT NULL)
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // Dropping the columns loses only the derived keys; every `*Url` column is
    // untouched by up(), so a revert returns the table to exactly its previous
    // state and the read paths fall back to deriving the key from the URL.
    await queryRunner.query(`
      ALTER TABLE "floor_plans"
        DROP COLUMN IF EXISTS "dwgStorageKey",
        DROP COLUMN IF EXISTS "thumbnailStorageKey",
        DROP COLUMN IF EXISTS "modelStorageKey",
        DROP COLUMN IF EXISTS "storageProvider"
    `);
  }
}
