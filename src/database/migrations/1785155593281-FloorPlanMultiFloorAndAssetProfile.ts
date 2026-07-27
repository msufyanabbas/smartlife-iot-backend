import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Multi-floor floor plans + asset profile schema.
 *
 *   - asset_profiles.type    — 'building' | 'shop' | 'farm' | …
 *   - asset_profiles.schema  — the field definitions assets of that profile carry
 *   - assets.configuration   — values for those fields (incl. floorsData)
 *   - floor_plans.floorName  — display name for the floor
 *   - floor_plans.floorNumber DEFAULT 1
 *   - UNIQUE (assetId, floorNumber) — one plan per floor per asset
 *
 * SCOPE NOTE
 * ----------
 * `typeorm migration:generate` also wanted to create the 10 assignment junction
 * tables (customer_devices, user_floor_plans, …), add two firmware FKs, rename
 * two firmware indexes and rewrite several jsonb column defaults whose only
 * difference is key ordering. Those are the SAME pre-existing schema gap that
 * 1784028884852-FloorPlanEnhancements documented and deliberately left out —
 * the assignment entities exist in code but their tables were never created.
 * They are unrelated to this work and are excluded again here so this migration
 * stays reviewable. They still need their own migration.
 *
 * DATA REPAIR
 * -----------
 * The unique constraint cannot be added while duplicate (assetId, floorNumber)
 * rows exist — the local database had two such pairs, one of which included a
 * soft-deleted row (deleted_at is not part of the constraint, so soft-deleted
 * rows still occupy their slot). Duplicates are renumbered onto free floors
 * above the asset's current maximum, oldest row keeping the original number,
 * before the constraint is applied.
 */
export class FloorPlanMultiFloorAndAssetProfile1785155593281
  implements MigrationInterface
{
  name = 'FloorPlanMultiFloorAndAssetProfile1785155593281';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // ── New columns ─────────────────────────────────────────────────────────
    await queryRunner.query(
      `ALTER TABLE "assets" ADD "configuration" jsonb DEFAULT '{}'`,
    );
    await queryRunner.query(
      `ALTER TABLE "asset_profiles" ADD "type" character varying`,
    );
    await queryRunner.query(`ALTER TABLE "asset_profiles" ADD "schema" jsonb`);
    await queryRunner.query(
      `ALTER TABLE "floor_plans" ADD "floorName" character varying`,
    );
    await queryRunner.query(
      `ALTER TABLE "floor_plans" ALTER COLUMN "floorNumber" SET DEFAULT '1'`,
    );

    // Existing plans get their free-text `floor` label as the display name.
    await queryRunner.query(
      `UPDATE "floor_plans" SET "floorName" = "floor" WHERE "floorName" IS NULL`,
    );

    // ── Data repair: renumber duplicate (assetId, floorNumber) rows ─────────
    await queryRunner.query(`
      WITH ranked AS (
        SELECT id,
               "assetId",
               ROW_NUMBER() OVER (
                 PARTITION BY "assetId", "floorNumber"
                 ORDER BY created_at, id
               ) AS rn
        FROM "floor_plans"
        WHERE "floorNumber" IS NOT NULL
      ),
      dupes AS (
        SELECT id,
               "assetId",
               ROW_NUMBER() OVER (PARTITION BY "assetId" ORDER BY id) AS seq
        FROM ranked
        WHERE rn > 1
      ),
      highest AS (
        SELECT "assetId", COALESCE(MAX("floorNumber"), 0) AS mx
        FROM "floor_plans"
        WHERE "floorNumber" IS NOT NULL
        GROUP BY "assetId"
      )
      UPDATE "floor_plans" fp
      SET "floorNumber" = highest.mx + dupes.seq
      FROM dupes
      JOIN highest ON highest."assetId" = dupes."assetId"
      WHERE fp.id = dupes.id
    `);

    // ── Indexes + unique constraint ─────────────────────────────────────────
    await queryRunner.query(
      `CREATE INDEX "IDX_185850cc99c7451a3c06bb5554" ON "asset_profiles" ("tenantId", "type") `,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_7b6803118a3df906c5de0474ca" ON "floor_plans" ("assetId", "floorNumber") `,
    );
    await queryRunner.query(
      `ALTER TABLE "floor_plans" ADD CONSTRAINT "UQ_floor_plans_asset_floor" UNIQUE ("assetId", "floorNumber")`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // The floorNumber renumbering is not reversed — the original values are not
    // recoverable and the duplicates they restore were invalid data anyway.
    await queryRunner.query(
      `ALTER TABLE "floor_plans" DROP CONSTRAINT "UQ_floor_plans_asset_floor"`,
    );
    await queryRunner.query(
      `DROP INDEX "public"."IDX_7b6803118a3df906c5de0474ca"`,
    );
    await queryRunner.query(
      `DROP INDEX "public"."IDX_185850cc99c7451a3c06bb5554"`,
    );
    await queryRunner.query(
      `ALTER TABLE "floor_plans" ALTER COLUMN "floorNumber" DROP DEFAULT`,
    );
    await queryRunner.query(`ALTER TABLE "floor_plans" DROP COLUMN "floorName"`);
    await queryRunner.query(`ALTER TABLE "asset_profiles" DROP COLUMN "schema"`);
    await queryRunner.query(`ALTER TABLE "asset_profiles" DROP COLUMN "type"`);
    await queryRunner.query(`ALTER TABLE "assets" DROP COLUMN "configuration"`);
  }
}
