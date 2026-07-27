import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Expands two Postgres enum types so the 8 canonical system solution templates
 * can be seeded:
 *
 *   • devices_type_enum              — 21 new DeviceType members
 *   • solution_templates_category_enum — 5 new SolutionTemplateCategory members
 *
 * ── Why ADD VALUE rather than the rename/recreate dance ──────────────────────
 * `migration:generate` was NOT used here: `data-source.ts` globs
 * `migrations/*.js`, so with no `dist` build TypeORM sees zero applied
 * migrations and emits a full-schema diff full of unrelated destructive drift
 * (the same trap documented in 1785072644894-SolutionTemplateInstallation).
 *
 * `ALTER TYPE ... ADD VALUE` is safe inside a transaction from PostgreSQL 12
 * onward, provided the new label is not *used* in the same transaction — this
 * migration only declares the labels, the seeder writes rows afterwards. The
 * server here is 15.15. `IF NOT EXISTS` keeps the migration re-runnable.
 *
 * ── Why nothing is renamed or removed ────────────────────────────────────────
 * The legacy category labels (agriculture, healthcare, energy, logistics,
 * retail, water, climate, education) are still referenced by existing rows.
 * Removing or renaming them would orphan that data, so the new smart_* labels
 * are added alongside them.
 *
 * ── down() ───────────────────────────────────────────────────────────────────
 * Postgres offers no `ALTER TYPE ... DROP VALUE`. Reverting means recreating
 * each type without the new labels, which fails outright if any row uses one.
 * The down() below therefore rebuilds both types from their original label
 * lists and will raise a clear error if data still depends on the new values.
 */
export class SolutionTemplateEnumExpansion1785196800000
  implements MigrationInterface
{
  name = 'SolutionTemplateEnumExpansion1785196800000';

  private static readonly NEW_DEVICE_TYPES = [
    'thermostat',
    'light',
    'lock',
    'plug',
    'hvac',
    'access_control',
    'elevator',
    'light_controller',
    'traffic_sensor',
    'weather_station',
    'drone',
    'energy_meter',
    'inverter',
    'battery',
    'ev_charger',
    'grid_meter',
    'pos',
    'display',
    'shelf',
    'flow_meter',
    'beacon',
  ];

  private static readonly NEW_CATEGORIES = [
    'smart_agriculture',
    'smart_energy',
    'smart_retail',
    'smart_water',
    'smart_facility',
  ];

  public async up(queryRunner: QueryRunner): Promise<void> {
    for (const value of SolutionTemplateEnumExpansion1785196800000.NEW_DEVICE_TYPES) {
      await queryRunner.query(
        `ALTER TYPE "public"."devices_type_enum" ADD VALUE IF NOT EXISTS '${value}'`,
      );
    }

    for (const value of SolutionTemplateEnumExpansion1785196800000.NEW_CATEGORIES) {
      await queryRunner.query(
        `ALTER TYPE "public"."solution_templates_category_enum" ADD VALUE IF NOT EXISTS '${value}'`,
      );
    }
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // ── solution_templates.category ─────────────────────────────────────────
    await queryRunner.query(
      `ALTER TYPE "public"."solution_templates_category_enum" RENAME TO "solution_templates_category_enum_old"`,
    );
    await queryRunner.query(
      `CREATE TYPE "public"."solution_templates_category_enum" AS ENUM('smart_factory', 'smart_home', 'smart_building', 'smart_city', 'agriculture', 'healthcare', 'energy', 'logistics', 'retail', 'water', 'climate', 'education')`,
    );
    await queryRunner.query(
      `ALTER TABLE "solution_templates" ALTER COLUMN "category" TYPE "public"."solution_templates_category_enum" USING "category"::"text"::"public"."solution_templates_category_enum"`,
    );
    await queryRunner.query(
      `DROP TYPE "public"."solution_templates_category_enum_old"`,
    );

    // ── devices.type ────────────────────────────────────────────────────────
    await queryRunner.query(
      `ALTER TYPE "public"."devices_type_enum" RENAME TO "devices_type_enum_old"`,
    );
    await queryRunner.query(
      `CREATE TYPE "public"."devices_type_enum" AS ENUM('sensor', 'actuator', 'gateway', 'controller', 'camera', 'tracker')`,
    );
    await queryRunner.query(
      `ALTER TABLE "devices" ALTER COLUMN "type" DROP DEFAULT`,
    );
    await queryRunner.query(
      `ALTER TABLE "devices" ALTER COLUMN "type" TYPE "public"."devices_type_enum" USING "type"::"text"::"public"."devices_type_enum"`,
    );
    await queryRunner.query(
      `ALTER TABLE "devices" ALTER COLUMN "type" SET DEFAULT 'sensor'`,
    );
    await queryRunner.query(`DROP TYPE "public"."devices_type_enum_old"`);
  }
}
