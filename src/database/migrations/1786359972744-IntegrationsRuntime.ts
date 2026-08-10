import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Integrations runtime engine: dispatch filters + the two new integration
 * types that have a dedicated adapter.
 *
 * `migration:generate` expressed the enum change as a full type swap
 * (RENAME → CREATE → ALTER COLUMN ... USING → DROP TYPE). That is replaced
 * here with `ALTER TYPE ... ADD VALUE IF NOT EXISTS`, which is additive,
 * idempotent, and does not rewrite the column or churn its index. Adding a
 * label inside a transaction is supported on PG 12+ (this server is 15) as
 * long as the new label is not *used* in the same transaction — it is not.
 *
 * The other 110 statements `generate` emitted are the pre-existing entity/DB
 * drift documented in CLAUDE.md §11 (assignment junction tables, the
 * destructive solution_templates_category_enum narrowing, alarms partial-index
 * drops, attributes unique-index change). They are deliberately excluded and
 * still need their own reviewed migration — see SchemaDriftFix.
 */
export class IntegrationsRuntime1786359972744 implements MigrationInterface {
  name = 'IntegrationsRuntime1786359972744';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // Which devices an integration forwards; NULL = every device in the tenant.
    await queryRunner.query(
      `ALTER TABLE "integrations" ADD COLUMN IF NOT EXISTS "deviceFilter" jsonb`,
    );

    // Which telemetry keys leave the platform; NULL = the whole payload.
    await queryRunner.query(
      `ALTER TABLE "integrations" ADD COLUMN IF NOT EXISTS "dataFilter" jsonb`,
    );

    await queryRunner.query(
      `ALTER TYPE "public"."integrations_type_enum" ADD VALUE IF NOT EXISTS 'tuya'`,
    );
    await queryRunner.query(
      `ALTER TYPE "public"."integrations_type_enum" ADD VALUE IF NOT EXISTS 'aws_iot'`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "integrations" DROP COLUMN IF EXISTS "dataFilter"`,
    );
    await queryRunner.query(
      `ALTER TABLE "integrations" DROP COLUMN IF EXISTS "deviceFilter"`,
    );

    // Postgres has no DROP VALUE. Removing 'tuya'/'aws_iot' would mean
    // recreating the type and rewriting every dependent column — destructive,
    // and it would fail outright if any row already uses them. The two extra
    // labels are harmless if unused, so down() leaves them in place.
  }
}
