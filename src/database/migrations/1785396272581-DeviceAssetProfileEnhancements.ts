import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Device & asset profile enhancements (ThingsBoard parity).
 *
 * device_profiles:
 *   - transportType / provisionType: PG enum → varchar, values uppercased to
 *     the ThingsBoard vocabulary. Converted IN PLACE so the 13 seeded profiles
 *     keep their transport and provisioning settings.
 *       mqtt → MQTT, http → HTTP, coap → COAP, lwm2m → LWM2M, snmp → SNMP
 *       disabled              → DISABLED
 *       allow_create_new      → ALLOW_CREATE_NEW_DEVICES
 *       check_pre_provisioned → CHECK_PRE_PROVISIONED_DEVICES
 *   - provisionDeviceKey / provisionDeviceSecret: new flat columns, backfilled
 *     from the legacy `provisionConfiguration` jsonb (which is retained).
 *   - defaultQueueName      → renamed to queueName
 *   - firmwareConfiguration → renamed to firmwareConfig
 *   - defaultDashboardId: varchar → uuid
 *
 * NOTE: `migration:generate` also wanted to create eight assignment junction
 * tables, narrow solution_templates_category_enum (removing six in-use values),
 * rebuild the firmware indexes and rewrite several jsonb defaults. All of that
 * is pre-existing entity/DB drift unrelated to profiles — in particular the
 * enum narrowing is destructive — so it is deliberately NOT included here and
 * should be handled by its own reviewed migration.
 *
 * asset_profiles needs no DDL: `type` and `schema` already exist and the richer
 * bilingual schema is a jsonb content change applied by the seeder.
 */
export class DeviceAssetProfileEnhancements1785396272581
  implements MigrationInterface
{
  name = 'DeviceAssetProfileEnhancements1785396272581';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // ── transportType: enum → varchar, uppercased in place ──────────────────
    await queryRunner.query(
      `ALTER TABLE "device_profiles" ALTER COLUMN "transportType" DROP DEFAULT`,
    );
    await queryRunner.query(
      `ALTER TABLE "device_profiles" ALTER COLUMN "transportType" TYPE character varying ` +
        `USING UPPER("transportType"::text)`,
    );
    await queryRunner.query(
      `ALTER TABLE "device_profiles" ALTER COLUMN "transportType" SET DEFAULT 'DEFAULT'`,
    );
    await queryRunner.query(
      `DROP TYPE IF EXISTS "public"."device_profiles_transporttype_enum"`,
    );

    // ── provisionType: enum → varchar, remapped in place ────────────────────
    await queryRunner.query(
      `ALTER TABLE "device_profiles" ALTER COLUMN "provisionType" DROP DEFAULT`,
    );
    await queryRunner.query(
      `ALTER TABLE "device_profiles" ALTER COLUMN "provisionType" TYPE character varying ` +
        `USING CASE "provisionType"::text ` +
        `  WHEN 'allow_create_new'      THEN 'ALLOW_CREATE_NEW_DEVICES' ` +
        `  WHEN 'check_pre_provisioned' THEN 'CHECK_PRE_PROVISIONED_DEVICES' ` +
        `  ELSE 'DISABLED' ` +
        `END`,
    );
    await queryRunner.query(
      `ALTER TABLE "device_profiles" ALTER COLUMN "provisionType" SET DEFAULT 'DISABLED'`,
    );
    await queryRunner.query(
      `DROP TYPE IF EXISTS "public"."device_profiles_provisiontype_enum"`,
    );

    // ── Flat provisioning credentials, backfilled from the legacy jsonb ─────
    await queryRunner.query(
      `ALTER TABLE "device_profiles" ADD "provisionDeviceKey" character varying`,
    );
    await queryRunner.query(
      `ALTER TABLE "device_profiles" ADD "provisionDeviceSecret" character varying`,
    );
    await queryRunner.query(
      `UPDATE "device_profiles" SET ` +
        `"provisionDeviceKey"    = "provisionConfiguration"->>'provisionDeviceKey', ` +
        `"provisionDeviceSecret" = "provisionConfiguration"->>'provisionDeviceSecret' ` +
        `WHERE "provisionConfiguration" IS NOT NULL`,
    );

    // ── Renames (preserve seeded values; do NOT drop+add) ───────────────────
    await queryRunner.query(
      `ALTER TABLE "device_profiles" RENAME COLUMN "defaultQueueName" TO "queueName"`,
    );
    await queryRunner.query(
      `ALTER TABLE "device_profiles" RENAME COLUMN "firmwareConfiguration" TO "firmwareConfig"`,
    );

    // ── defaultDashboardId: varchar → uuid ──────────────────────────────────
    // Empty strings would fail the cast; normalise them to NULL first.
    await queryRunner.query(
      `ALTER TABLE "device_profiles" ALTER COLUMN "defaultDashboardId" TYPE uuid ` +
        `USING NULLIF("defaultDashboardId", '')::uuid`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "device_profiles" ALTER COLUMN "defaultDashboardId" TYPE character varying ` +
        `USING "defaultDashboardId"::text`,
    );

    await queryRunner.query(
      `ALTER TABLE "device_profiles" RENAME COLUMN "firmwareConfig" TO "firmwareConfiguration"`,
    );
    await queryRunner.query(
      `ALTER TABLE "device_profiles" RENAME COLUMN "queueName" TO "defaultQueueName"`,
    );

    await queryRunner.query(
      `ALTER TABLE "device_profiles" DROP COLUMN "provisionDeviceSecret"`,
    );
    await queryRunner.query(
      `ALTER TABLE "device_profiles" DROP COLUMN "provisionDeviceKey"`,
    );

    // ── provisionType: varchar → enum, values mapped back to lowercase ──────
    await queryRunner.query(
      `CREATE TYPE "public"."device_profiles_provisiontype_enum" AS ENUM(` +
        `'disabled', 'allow_create_new', 'check_pre_provisioned')`,
    );
    await queryRunner.query(
      `ALTER TABLE "device_profiles" ALTER COLUMN "provisionType" DROP DEFAULT`,
    );
    await queryRunner.query(
      `ALTER TABLE "device_profiles" ALTER COLUMN "provisionType" ` +
        `TYPE "public"."device_profiles_provisiontype_enum" ` +
        `USING (CASE "provisionType" ` +
        `  WHEN 'ALLOW_CREATE_NEW_DEVICES'      THEN 'allow_create_new' ` +
        `  WHEN 'CHECK_PRE_PROVISIONED_DEVICES' THEN 'check_pre_provisioned' ` +
        `  ELSE 'disabled' ` +
        `END)::"public"."device_profiles_provisiontype_enum"`,
    );
    await queryRunner.query(
      `ALTER TABLE "device_profiles" ALTER COLUMN "provisionType" SET DEFAULT 'disabled'`,
    );

    // ── transportType: varchar → enum. DEFAULT has no pre-change equivalent
    //    and collapses to 'mqtt', matching the old column default.
    await queryRunner.query(
      `CREATE TYPE "public"."device_profiles_transporttype_enum" AS ENUM(` +
        `'mqtt', 'http', 'coap', 'lwm2m', 'snmp')`,
    );
    await queryRunner.query(
      `ALTER TABLE "device_profiles" ALTER COLUMN "transportType" DROP DEFAULT`,
    );
    await queryRunner.query(
      `ALTER TABLE "device_profiles" ALTER COLUMN "transportType" ` +
        `TYPE "public"."device_profiles_transporttype_enum" ` +
        `USING (CASE WHEN LOWER("transportType") IN ('mqtt','http','coap','lwm2m','snmp') ` +
        `  THEN LOWER("transportType") ELSE 'mqtt' ` +
        `END)::"public"."device_profiles_transporttype_enum"`,
    );
    await queryRunner.query(
      `ALTER TABLE "device_profiles" ALTER COLUMN "transportType" SET DEFAULT 'mqtt'`,
    );
  }
}
