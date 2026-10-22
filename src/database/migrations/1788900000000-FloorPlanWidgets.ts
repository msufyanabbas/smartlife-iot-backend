import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * `floor_plan_widgets` — the control widgets placed on a floor plan.
 *
 * Idempotent (`IF NOT EXISTS` throughout), because `migration:run` is blocked
 * (§11) and this is applied by a standalone runner that may be run twice:
 *
 *   npm run migration:floor-plan-widgets <database> [up|down]
 *
 * Column-type notes, each of which is a trap documented elsewhere in
 * CLAUDE.md:
 *
 *  · `kind` and `origin` are **varchar, not PG enums**. A new TypeScript enum
 *    member alone passes `@IsEnum` and then fails the INSERT with
 *    `invalid input value for enum` (§4e, `integrations.type`), and adding a
 *    widget kind must not need a migration while `migration:run` is blocked.
 *
 *  · `tenantId` and `floorPlanId` are **uuid with real FKs**, because the
 *    entity declares `@ManyToOne` against them — a join column takes the
 *    referenced key's type and gets a constraint whether a hand-written
 *    migration says so or not. Getting this wrong leaves the migration
 *    permanently at odds with the schema `synchronize` builds (§4f).
 *
 *  · `deviceId` is `ON DELETE SET NULL`, not CASCADE. Deleting a device must
 *    not silently remove the control from the plan: an operator who finds a
 *    widget with no device can rebind it, while one who finds an empty plan
 *    has no idea anything was ever there.
 *
 *  · `zoneId` is a plain varchar with NO foreign key. Zones live inside
 *    `floor_plans.zones` (jsonb), so there is no table to point at; the
 *    service validates the id against the plan on write.
 */
export class FloorPlanWidgets1788900000000 implements MigrationInterface {
  name = 'FloorPlanWidgets1788900000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // The default depends on it, and on a database built by this runner rather
    // than by `synchronize` the extension may not be there yet. Idempotent.
    await queryRunner.query(`CREATE EXTENSION IF NOT EXISTS "uuid-ossp"`);

    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "floor_plan_widgets" (
        "id"               uuid NOT NULL DEFAULT uuid_generate_v4(),
        "created_at"       TIMESTAMP NOT NULL DEFAULT now(),
        "updated_at"       TIMESTAMP NOT NULL DEFAULT now(),
        "deleted_at"       TIMESTAMP,
        "created_by"       character varying,
        "updated_by"       character varying,
        "deleted_by"       character varying,
        "tenantId"         uuid NOT NULL,
        "floorPlanId"      uuid NOT NULL,
        "kind"             character varying(32) NOT NULL,
        "label"            character varying(160) NOT NULL,
        "deviceId"         uuid,
        "zoneId"           character varying(64),
        "x"                double precision NOT NULL DEFAULT 0,
        "y"                double precision NOT NULL DEFAULT 0,
        "z"                double precision NOT NULL DEFAULT 0,
        "stateKey"         character varying(128),
        "stateTransform"   jsonb,
        "actions"          jsonb NOT NULL DEFAULT '[]'::jsonb,
        "visual"           jsonb,
        "enabled"          boolean NOT NULL DEFAULT true,
        "origin"           character varying(16) NOT NULL DEFAULT 'manual',
        "sourceMarkerId"   character varying(64),
        "metadata"         jsonb,
        CONSTRAINT "PK_floor_plan_widgets" PRIMARY KEY ("id")
      )
    `);

    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "IDX_floor_plan_widgets_tenant_plan"
        ON "floor_plan_widgets" ("tenantId", "floorPlanId")
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "IDX_floor_plan_widgets_tenant_device"
        ON "floor_plan_widgets" ("tenantId", "deviceId")
    `);

    // Re-importing from the drawing must not stack a second widget on every
    // fitting already placed. Partial, so the many manual widgets (which have
    // no marker id) do not collide with each other on NULL.
    await queryRunner.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS "UQ_floor_plan_widgets_source_marker"
        ON "floor_plan_widgets" ("floorPlanId", "sourceMarkerId")
        WHERE "sourceMarkerId" IS NOT NULL
    `);

    // Added separately and guarded: on a database where `synchronize` already
    // built this table, the constraints may exist with TypeORM's generated
    // names, and a duplicate would abort the whole migration.
    await queryRunner.query(`
      DO $$
      BEGIN
        IF NOT EXISTS (
          SELECT 1 FROM pg_constraint WHERE conname = 'FK_floor_plan_widgets_tenant'
        ) THEN
          ALTER TABLE "floor_plan_widgets"
            ADD CONSTRAINT "FK_floor_plan_widgets_tenant"
            FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE;
        END IF;

        IF NOT EXISTS (
          SELECT 1 FROM pg_constraint WHERE conname = 'FK_floor_plan_widgets_plan'
        ) THEN
          ALTER TABLE "floor_plan_widgets"
            ADD CONSTRAINT "FK_floor_plan_widgets_plan"
            FOREIGN KEY ("floorPlanId") REFERENCES "floor_plans"("id") ON DELETE CASCADE;
        END IF;

        IF NOT EXISTS (
          SELECT 1 FROM pg_constraint WHERE conname = 'FK_floor_plan_widgets_device'
        ) THEN
          ALTER TABLE "floor_plan_widgets"
            ADD CONSTRAINT "FK_floor_plan_widgets_device"
            FOREIGN KEY ("deviceId") REFERENCES "devices"("id") ON DELETE SET NULL;
        END IF;
      END $$;
    `);

    await queryRunner.query(`
      COMMENT ON COLUMN "floor_plan_widgets"."x" IS
        'Metres, in the drawing''s own coordinates — the same space as the display geometry.'
    `);
    await queryRunner.query(`
      COMMENT ON COLUMN "floor_plan_widgets"."actions" IS
        'The commands this widget may issue. Read by the action route; a request never supplies a method or a device.'
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS "floor_plan_widgets"`);
  }
}
