import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Tuya auto-provisioning: the schema a device imported from a third-party
 * cloud needs.
 *
 * Three additive changes:
 *
 *   1. `devices.externalId` — the device's id in the system it came from (a
 *      Tuya device id today). Deliberately NOT unique: the same physical device
 *      can be bound to two tenants' Tuya projects, and a global UNIQUE would
 *      make the second import fail. It is indexed together with tenantId
 *      instead, which is how every lookup in TuyaSyncService is written.
 *
 *   2. `devices_protocol_enum` += 'tuya' — imported devices have no MQTT
 *      credentials here; telemetry arrives by poll or webhook and commands go
 *      out through the Tuya OpenAPI, so they need their own protocol value
 *      rather than being mislabelled generic_mqtt.
 *
 *   3. `device_credentials_credentialstype_enum` += 'TUYA' — the row holding a
 *      device's Tuya local_key.
 *
 * The enum changes use `ADD VALUE IF NOT EXISTS` rather than the type swap
 * `migration:generate` emits (RENAME → CREATE → ALTER COLUMN … USING → DROP):
 * additive, idempotent, and it neither rewrites the column nor churns its
 * index. Supported inside a transaction on PG 12+ (this server is 15) provided
 * the new label is not *used* in the same transaction — it is not.
 *
 * As with IntegrationsRuntime, the unrelated statements `generate` wants to
 * emit are the pre-existing entity/DB drift documented in CLAUDE.md §11 and are
 * deliberately excluded.
 */
export class TuyaAutoProvisioning1786620000000 implements MigrationInterface {
  name = 'TuyaAutoProvisioning1786620000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "devices" ADD COLUMN IF NOT EXISTS "externalId" character varying`,
    );

    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "IDX_devices_tenant_external_id" ON "devices" ("tenantId", "externalId")`,
    );

    await queryRunner.query(
      `ALTER TYPE "public"."devices_protocol_enum" ADD VALUE IF NOT EXISTS 'tuya'`,
    );

    await queryRunner.query(
      `ALTER TYPE "public"."device_credentials_credentialstype_enum" ADD VALUE IF NOT EXISTS 'TUYA'`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `DROP INDEX IF EXISTS "public"."IDX_devices_tenant_external_id"`,
    );
    await queryRunner.query(
      `ALTER TABLE "devices" DROP COLUMN IF EXISTS "externalId"`,
    );

    // Postgres has no DROP VALUE. Removing 'tuya'/'TUYA' would mean recreating
    // both types and rewriting every dependent column — destructive, and it
    // would fail outright if any row already uses them. Unused labels are
    // harmless, so down() leaves them in place.
  }
}
