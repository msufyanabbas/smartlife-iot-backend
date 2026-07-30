import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Adds the template catalogue image columns.
 *
 *   solution_templates.imageUrl  — absolute URL (seeded) or
 *                                  /uploads/solution-templates/<id>.<ext> (uploaded)
 *   solution_templates.imageAlt  — alt text for accessibility
 *
 * Both nullable, so existing rows are unaffected until the seeder backfills the
 * eight system templates.
 *
 * NOTE: `migration:generate` produced 180 statements for this change. All but
 * the two below are pre-existing entity/DB drift unrelated to images — the
 * eight assignment junction tables, firmware index rebuilds, jsonb default
 * rewrites, and a narrowing of solution_templates_category_enum that would
 * DROP six values ('agriculture', 'healthcare', 'energy', 'logistics',
 * 'retail', 'water'). That drift is deliberately excluded here and still needs
 * its own reviewed migration.
 */
export class SolutionTemplateImage1785410921506 implements MigrationInterface {
  name = 'SolutionTemplateImage1785410921506';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "solution_templates" ADD "imageUrl" character varying`,
    );
    await queryRunner.query(
      `ALTER TABLE "solution_templates" ADD "imageAlt" character varying`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "solution_templates" DROP COLUMN "imageAlt"`,
    );
    await queryRunner.query(
      `ALTER TABLE "solution_templates" DROP COLUMN "imageUrl"`,
    );
  }
}
