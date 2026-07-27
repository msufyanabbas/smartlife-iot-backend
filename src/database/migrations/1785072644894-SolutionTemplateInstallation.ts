import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Solution template provisioning.
 *
 * - creates `template_installations` (one row per install attempt)
 * - adds `ratings` / `ratingCount` to `solution_templates` for per-user ratings
 *
 * NOTE: `migration:generate` also emitted a large amount of unrelated schema
 * drift, all of which has been deliberately removed from this file:
 *   • 7 × `ALTER TABLE "devices" DROP COLUMN "…firmware…"` — those columns exist
 *     in the database and `firmware.service.ts` still reads them; the Device
 *     entity simply does not declare them. Dropping them here would be a
 *     destructive, unrelated change.
 *   • `floor_plan_devices` / `floor_plans.modelFile*` — owned by the pending
 *     1784028884852-FloorPlanEnhancements migration, which runs before this one.
 *   • jsonb DEFAULT rewrites on customers / customer_user_limits / subscriptions
 *     — key-order churn only, semantically identical.
 * The generator produced them because data-source.ts globs `migrations/*.js`
 * and dist was not built, so TypeORM saw zero applied migrations and diffed the
 * whole schema from scratch.
 */
export class SolutionTemplateInstallation1785072644894
  implements MigrationInterface
{
  name = 'SolutionTemplateInstallation1785072644894';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // ── solution_templates: per-user ratings ────────────────────────────────
    await queryRunner.query(
      `ALTER TABLE "solution_templates" ADD "ratings" jsonb NOT NULL DEFAULT '{}'`,
    );
    await queryRunner.query(
      `ALTER TABLE "solution_templates" ADD "ratingCount" integer NOT NULL DEFAULT '0'`,
    );

    // ── template_installations ──────────────────────────────────────────────
    await queryRunner.query(
      `CREATE TYPE "public"."template_installations_status_enum" AS ENUM('INSTALLING', 'SUCCESS', 'FAILED', 'ROLLED_BACK')`,
    );
    await queryRunner.query(
      `CREATE TABLE "template_installations" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "created_at" TIMESTAMP NOT NULL DEFAULT now(),
        "updated_at" TIMESTAMP NOT NULL DEFAULT now(),
        "deleted_at" TIMESTAMP,
        "created_by" character varying,
        "updated_by" character varying,
        "deleted_by" character varying,
        "tenantId" uuid NOT NULL,
        "customerId" character varying,
        "templateId" uuid NOT NULL,
        "userId" uuid NOT NULL,
        "installationName" character varying NOT NULL,
        "status" "public"."template_installations_status_enum" NOT NULL DEFAULT 'INSTALLING',
        "installedAt" TIMESTAMP NOT NULL,
        "completedAt" TIMESTAMP,
        "error" text,
        "createdDeviceIds" jsonb NOT NULL DEFAULT '[]',
        "createdDashboardIds" jsonb NOT NULL DEFAULT '[]',
        "createdRuleChainIds" jsonb NOT NULL DEFAULT '[]',
        "createdAlarmIds" jsonb NOT NULL DEFAULT '[]',
        "configuration" jsonb,
        "customization" jsonb,
        CONSTRAINT "PK_1a0333cf0b4b63c26aff26fd2c5" PRIMARY KEY ("id")
      )`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_a9e8d9540ad3330d48a510944b" ON "template_installations" ("tenantId")`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_942c53a6cd201890425fa1c248" ON "template_installations" ("tenantId", "templateId")`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_d4c0b7b2bcb0aa1a18c829df65" ON "template_installations" ("tenantId", "status")`,
    );
    await queryRunner.query(
      `ALTER TABLE "template_installations" ADD CONSTRAINT "FK_a9e8d9540ad3330d48a510944b0" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE NO ACTION ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "template_installations" ADD CONSTRAINT "FK_f02de27d96728fa5a07c2a3e37f" FOREIGN KEY ("templateId") REFERENCES "solution_templates"("id") ON DELETE CASCADE ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "template_installations" ADD CONSTRAINT "FK_f2d844b8b05a2d15c88fad76617" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE NO ACTION ON UPDATE NO ACTION`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "template_installations" DROP CONSTRAINT "FK_f2d844b8b05a2d15c88fad76617"`,
    );
    await queryRunner.query(
      `ALTER TABLE "template_installations" DROP CONSTRAINT "FK_f02de27d96728fa5a07c2a3e37f"`,
    );
    await queryRunner.query(
      `ALTER TABLE "template_installations" DROP CONSTRAINT "FK_a9e8d9540ad3330d48a510944b0"`,
    );
    await queryRunner.query(
      `DROP INDEX "public"."IDX_d4c0b7b2bcb0aa1a18c829df65"`,
    );
    await queryRunner.query(
      `DROP INDEX "public"."IDX_942c53a6cd201890425fa1c248"`,
    );
    await queryRunner.query(
      `DROP INDEX "public"."IDX_a9e8d9540ad3330d48a510944b"`,
    );
    await queryRunner.query(`DROP TABLE "template_installations"`);
    await queryRunner.query(
      `DROP TYPE "public"."template_installations_status_enum"`,
    );
    await queryRunner.query(
      `ALTER TABLE "solution_templates" DROP COLUMN "ratingCount"`,
    );
    await queryRunner.query(
      `ALTER TABLE "solution_templates" DROP COLUMN "ratings"`,
    );
  }
}
