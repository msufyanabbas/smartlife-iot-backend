import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Adds escalation tracking to `alarms`.
 *
 * Hand-written rather than produced by `migration:generate`. The generator
 * currently also wants to create 8 assignment junction tables, narrow
 * `solution_templates_category_enum` (destructive — it drops 6 in-use values),
 * rebuild the firmware indexes and rewrite several jsonb defaults. That is
 * pre-existing entity/DB drift documented in CLAUDE.md §11 and needs its own
 * reviewed migration; folding it in here would make an additive change
 * silently destructive.
 *
 * Every statement is IF NOT EXISTS / IF EXISTS so a partially-applied run is
 * safe to repeat.
 */
export class AlarmEscalation1786579200000 implements MigrationInterface {
  name = 'AlarmEscalation1786579200000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "alarms"
        ADD COLUMN IF NOT EXISTS "escalationLevel" integer NOT NULL DEFAULT 0
    `);

    await queryRunner.query(`
      ALTER TABLE "alarms"
        ADD COLUMN IF NOT EXISTS "escalatedAt" TIMESTAMP
    `);

    await queryRunner.query(`
      ALTER TABLE "alarms"
        ADD COLUMN IF NOT EXISTS "escalationHistory" jsonb
    `);

    await queryRunner.query(`
      ALTER TABLE "alarms"
        ADD COLUMN IF NOT EXISTS "escalationRules" jsonb
    `);

    // Serves the escalation sweep: unacknowledged ACTIVE alarms ordered by how
    // long they have been open. Partial, so it stays small — cleared/resolved
    // and already-acknowledged rows are the overwhelming majority over time and
    // are never escalation candidates.
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "IDX_alarms_escalation_pending"
        ON "alarms" ("tenantId", "severity", "triggeredAt", "escalationLevel")
        WHERE "status" = 'active'
          AND "acknowledgedAt" IS NULL
          AND "deleted_at" IS NULL
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX IF EXISTS "IDX_alarms_escalation_pending"`);
    await queryRunner.query(`ALTER TABLE "alarms" DROP COLUMN IF EXISTS "escalationRules"`);
    await queryRunner.query(`ALTER TABLE "alarms" DROP COLUMN IF EXISTS "escalationHistory"`);
    await queryRunner.query(`ALTER TABLE "alarms" DROP COLUMN IF EXISTS "escalatedAt"`);
    await queryRunner.query(`ALTER TABLE "alarms" DROP COLUMN IF EXISTS "escalationLevel"`);
  }
}
