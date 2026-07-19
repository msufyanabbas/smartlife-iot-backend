import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Floor plan enhancements:
 *   - floor_plan_devices: relational device placements (replaces the unnormalised
 *     floor_plans.devices JSONB array, which had no FKs and left orphan entries
 *     behind whenever a device was deleted).
 *   - floor_plans.modelFileUrl / modelFileType / modelFileSize: uploaded 3D model.
 *
 * NOTE: `typeorm migration:generate` also wanted to create 10 assignment junction
 * tables (customer_devices, user_floor_plans, …) and churn some index names /
 * jsonb defaults. Those are a PRE-EXISTING schema gap unrelated to floor plans —
 * the assignment entities exist in code but their tables were never created. That
 * has been deliberately left out of this migration and reported separately, so
 * this file stays scoped to the floor plan work.
 *
 * floor_plans.devices (JSONB) is intentionally NOT dropped: it is kept as a
 * backward-compatible read source and rollback safety net.
 */
export class FloorPlanEnhancements1784028884852 implements MigrationInterface {
  name = 'FloorPlanEnhancements1784028884852';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE "floor_plan_devices" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "created_at" TIMESTAMP NOT NULL DEFAULT now(),
        "updated_at" TIMESTAMP NOT NULL DEFAULT now(),
        "deleted_at" TIMESTAMP,
        "created_by" character varying,
        "updated_by" character varying,
        "deleted_by" character varying,
        "tenantId" uuid NOT NULL,
        "floorPlanId" uuid NOT NULL,
        "deviceId" uuid NOT NULL,
        "x" double precision NOT NULL DEFAULT '0',
        "y" double precision NOT NULL DEFAULT '0',
        "z" double precision NOT NULL DEFAULT '0',
        "rotation" jsonb,
        "scale" jsonb,
        "metadata" jsonb,
        "displayName" character varying,
        "deviceTypeLabel" character varying,
        "model3DUrl" character varying,
        "animationType" character varying,
        "animationConfig" jsonb,
        "telemetryBindings" jsonb,
        CONSTRAINT "UQ_617ac526631972ff9c2dc1018ce" UNIQUE ("floorPlanId", "deviceId"),
        CONSTRAINT "PK_d99d1e04a2d3c3614340c1e275a" PRIMARY KEY ("id")
      )
    `);

    await queryRunner.query(
      `CREATE INDEX "IDX_09a5389e79d5d9f25e02ee2961" ON "floor_plan_devices" ("tenantId", "floorPlanId")`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_2845ad2920701c6e204409f66a" ON "floor_plan_devices" ("tenantId", "deviceId")`,
    );

    await queryRunner.query(
      `ALTER TABLE "floor_plan_devices" ADD CONSTRAINT "FK_e23455422ce6c04299c1ce83095" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE NO ACTION ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "floor_plan_devices" ADD CONSTRAINT "FK_49326b4456fbce6db4e51bda627" FOREIGN KEY ("floorPlanId") REFERENCES "floor_plans"("id") ON DELETE CASCADE ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "floor_plan_devices" ADD CONSTRAINT "FK_4dd161c950817dd2af8ee7fd2de" FOREIGN KEY ("deviceId") REFERENCES "devices"("id") ON DELETE CASCADE ON UPDATE NO ACTION`,
    );

    // 3D model file columns
    await queryRunner.query(`ALTER TABLE "floor_plans" ADD "modelFileUrl" character varying`);
    await queryRunner.query(`ALTER TABLE "floor_plans" ADD "modelFileType" character varying`);
    await queryRunner.query(`ALTER TABLE "floor_plans" ADD "modelFileSize" bigint`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "floor_plans" DROP COLUMN "modelFileSize"`);
    await queryRunner.query(`ALTER TABLE "floor_plans" DROP COLUMN "modelFileType"`);
    await queryRunner.query(`ALTER TABLE "floor_plans" DROP COLUMN "modelFileUrl"`);

    await queryRunner.query(
      `ALTER TABLE "floor_plan_devices" DROP CONSTRAINT "FK_4dd161c950817dd2af8ee7fd2de"`,
    );
    await queryRunner.query(
      `ALTER TABLE "floor_plan_devices" DROP CONSTRAINT "FK_49326b4456fbce6db4e51bda627"`,
    );
    await queryRunner.query(
      `ALTER TABLE "floor_plan_devices" DROP CONSTRAINT "FK_e23455422ce6c04299c1ce83095"`,
    );
    await queryRunner.query(`DROP INDEX "public"."IDX_2845ad2920701c6e204409f66a"`);
    await queryRunner.query(`DROP INDEX "public"."IDX_09a5389e79d5d9f25e02ee2961"`);
    await queryRunner.query(`DROP TABLE "floor_plan_devices"`);
  }
}
