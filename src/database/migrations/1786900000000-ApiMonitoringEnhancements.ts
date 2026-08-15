import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * api_logs columns required by the API monitoring system.
 *
 * Adds the fields the request loggers now write (url, userRole, requestSize,
 * responseSize, isError), relaxes ip to nullable, and backfills the two derived
 * columns so pre-existing rows stay comparable with new ones.
 *
 * Written by hand rather than generated: `migration:generate` currently emits a
 * large amount of unrelated pre-existing drift (8 assignment junction tables, a
 * destructive narrowing of solution_templates_category_enum, firmware index
 * rebuilds), none of which belongs in this change.
 *
 * Every statement is IF EXISTS / IF NOT EXISTS guarded so it is safe to run
 * against a database where the DDL was already applied out of band.
 */
export class ApiMonitoringEnhancements1786900000000 implements MigrationInterface {
  name = 'ApiMonitoringEnhancements1786900000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // ── New columns ──────────────────────────────────────────────────────────
    await queryRunner.query(`ALTER TABLE "api_logs" ADD COLUMN IF NOT EXISTS "url" character varying`);
    await queryRunner.query(`ALTER TABLE "api_logs" ADD COLUMN IF NOT EXISTS "userRole" character varying`);
    await queryRunner.query(`ALTER TABLE "api_logs" ADD COLUMN IF NOT EXISTS "requestSize" integer NOT NULL DEFAULT 0`);
    await queryRunner.query(`ALTER TABLE "api_logs" ADD COLUMN IF NOT EXISTS "responseSize" integer NOT NULL DEFAULT 0`);
    await queryRunner.query(`ALTER TABLE "api_logs" ADD COLUMN IF NOT EXISTS "isError" boolean NOT NULL DEFAULT false`);

    // ── ip becomes nullable ──────────────────────────────────────────────────
    // A socket can be closed before the response finishes, leaving no address.
    // NOT NULL would drop exactly the requests worth recording.
    await queryRunner.query(`ALTER TABLE "api_logs" ALTER COLUMN "ip" DROP NOT NULL`);

    // ── Backfill ─────────────────────────────────────────────────────────────
    // Historic rows stored the raw URL in `endpoint`; copy it to `url` so the
    // two columns mean the same thing for every row.
    await queryRunner.query(`UPDATE "api_logs" SET "url" = "endpoint" WHERE "url" IS NULL`);
    // Without this, every historic 4xx/5xx would read as isError = false.
    await queryRunner.query(`UPDATE "api_logs" SET "isError" = true WHERE "statusCode" >= 400 AND "isError" = false`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "api_logs" DROP COLUMN IF EXISTS "isError"`);
    await queryRunner.query(`ALTER TABLE "api_logs" DROP COLUMN IF EXISTS "responseSize"`);
    await queryRunner.query(`ALTER TABLE "api_logs" DROP COLUMN IF EXISTS "requestSize"`);
    await queryRunner.query(`ALTER TABLE "api_logs" DROP COLUMN IF EXISTS "userRole"`);
    await queryRunner.query(`ALTER TABLE "api_logs" DROP COLUMN IF EXISTS "url"`);
    // ip is left nullable: restoring NOT NULL would fail on any row logged
    // without an address while the column was nullable.
  }
}
