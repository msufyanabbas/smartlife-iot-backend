import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Real script execution: the schema the scripts module needs now that
 * `POST /scripts/:id/execute` actually runs the stored code in a vm2 sandbox
 * instead of echoing its input back.
 *
 * Two additive changes:
 *
 *   1. Five columns on `scripts`.
 *      - `timeout`   — per-script sandbox budget in ms. ScriptsService clamps
 *        it to MAX_SCRIPT_TIMEOUT_MS (3000) at execution time, so this can only
 *        ever buy a script *less* event-loop time, never more.
 *      - `isSystem`  — seeded examples; blocked from update/delete.
 *      - `errorCount`, `lastExecutionTime`, `lastError` — the failure half of
 *        the stats that `executionCount`/`lastExecutedAt` already promised.
 *        Those two columns existed since the table was created but were never
 *        written, because nothing executed; they are written now.
 *
 *   2. `scripts_type_enum` += 'enrichment' — ThingsBoard's third script kind.
 *      An enrichment script returns a plain object that the rule engine merges
 *      into the message metadata; the existing five values had no member for it.
 *
 * `ADD VALUE IF NOT EXISTS` is used rather than the type swap
 * `migration:generate` emits (RENAME → CREATE → ALTER COLUMN … USING → DROP):
 * additive, idempotent, and it neither rewrites the column nor churns its
 * indexes. Supported inside a transaction on PG 12+ (this server is 15)
 * provided the new label is not *used* in the same transaction — it is not;
 * the seeder inserts enrichment rows in a separate session.
 *
 * As with TuyaAutoProvisioning, the unrelated statements `generate` wants to
 * emit are the pre-existing entity/DB drift documented in CLAUDE.md §11 and are
 * deliberately excluded — they need their own reviewed migration. Note also
 * that `migration:generate` reads `.env`, which points at localhost:5432 (a
 * native Postgres), not the containerised database the application uses, so its
 * diff for this table was wrong in both directions: it proposed CREATE TABLE
 * for a table that already exists.
 */
export class ScriptsExecution1786700000000 implements MigrationInterface {
  name = 'ScriptsExecution1786700000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "scripts" ADD COLUMN IF NOT EXISTS "timeout" integer NOT NULL DEFAULT 3000`,
    );
    await queryRunner.query(
      `ALTER TABLE "scripts" ADD COLUMN IF NOT EXISTS "isSystem" boolean NOT NULL DEFAULT false`,
    );
    await queryRunner.query(
      `ALTER TABLE "scripts" ADD COLUMN IF NOT EXISTS "errorCount" integer NOT NULL DEFAULT 0`,
    );
    await queryRunner.query(
      `ALTER TABLE "scripts" ADD COLUMN IF NOT EXISTS "lastExecutionTime" integer`,
    );
    await queryRunner.query(
      `ALTER TABLE "scripts" ADD COLUMN IF NOT EXISTS "lastError" text`,
    );

    await queryRunner.query(
      `ALTER TYPE "public"."scripts_type_enum" ADD VALUE IF NOT EXISTS 'enrichment'`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "scripts" DROP COLUMN IF EXISTS "lastError"`,
    );
    await queryRunner.query(
      `ALTER TABLE "scripts" DROP COLUMN IF EXISTS "lastExecutionTime"`,
    );
    await queryRunner.query(
      `ALTER TABLE "scripts" DROP COLUMN IF EXISTS "errorCount"`,
    );
    await queryRunner.query(
      `ALTER TABLE "scripts" DROP COLUMN IF EXISTS "isSystem"`,
    );
    await queryRunner.query(
      `ALTER TABLE "scripts" DROP COLUMN IF EXISTS "timeout"`,
    );

    // The 'enrichment' enum label is intentionally left in place. Postgres
    // cannot DROP a value from an enum; removing it means recreating the type,
    // which fails outright if any row still uses it. Reverting this migration
    // would then either error or require silently rewriting tenant data. An
    // unused extra label is harmless, so it stays.
  }
}
