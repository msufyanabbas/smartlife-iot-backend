import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * `modbus_devices` — the Modbus fleet, moved out of an environment variable.
 *
 * `ModbusAdapter` used to read every device and register map from a
 * `MODBUS_DEVICES` JSON blob: adding a meter was a redeploy, the configuration
 * was invisible to the product and belonged to no tenant, and a typo logged one
 * parse error and then polled nothing.
 *
 * `tenantId` and `deviceId` are `uuid` with real FKs because the entity
 * declares `@ManyToOne` against both — a join column takes the referenced key's
 * type and gets a constraint whether a hand-written migration says so or not
 * (see the note in 1788000000000-AiModels).
 *
 * `connectionType`, `parity` and `lastPollStatus` are varchar rather than PG
 * enums, for the reason the integrations table learned the hard way: a new
 * TypeScript member passes `@IsIn` and then the INSERT fails with
 * `invalid input value for enum`.
 *
 * `registers` is jsonb defaulting to `'[]'` — a device created but not yet
 * mapped is valid, and the poller skips it. That is better than a null every
 * reader has to guard. Nothing in the database enforces the shape of an entry;
 * `ModbusDevicesService.validateRegisters()` does, because a bad entry
 * otherwise becomes a read failure logged once per poll forever.
 */
export class ModbusDevices1788500000000 implements MigrationInterface {
  name = 'ModbusDevices1788500000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "modbus_devices" (
        "id"              uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
        "created_at"      TIMESTAMP NOT NULL DEFAULT now(),
        "updated_at"      TIMESTAMP NOT NULL DEFAULT now(),
        "deleted_at"      TIMESTAMP,
        "created_by"      character varying,
        "updated_by"      character varying,
        "deleted_by"      character varying,
        "tenantId"        uuid NOT NULL,
        "deviceId"        uuid NOT NULL,
        "name"            character varying(120) NOT NULL,
        "description"     text,
        "connectionType"  character varying(8) NOT NULL DEFAULT 'TCP',
        "host"            character varying(255),
        "port"            integer NOT NULL DEFAULT 502,
        "serialPort"      character varying(255),
        "baudRate"        integer,
        "parity"          character varying(8),
        "dataBits"        integer,
        "stopBits"        integer,
        "unitId"          integer NOT NULL DEFAULT 1,
        "pollIntervalMs"  integer NOT NULL DEFAULT 5000,
        "timeoutMs"       integer NOT NULL DEFAULT 5000,
        "registers"       jsonb NOT NULL DEFAULT '[]'::jsonb,
        "enabled"         boolean NOT NULL DEFAULT true,
        "lastPollStatus"  character varying(16),
        "lastPollError"   text,
        "lastPollAt"      TIMESTAMP,
        "pollCount"       bigint NOT NULL DEFAULT '0',
        "errorCount"      bigint NOT NULL DEFAULT '0',
        CONSTRAINT "FK_modbus_devices_tenant"
          FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE,
        CONSTRAINT "FK_modbus_devices_device"
          FOREIGN KEY ("deviceId") REFERENCES "devices"("id") ON DELETE CASCADE
      )
    `);

    // Partial unique index rather than a plain UNIQUE: a soft-deleted row must
    // not hold its name hostage, or deleting "Factory PLC" means you can never
    // create another one with that name.
    await queryRunner.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS "UQ_modbus_devices_tenant_name"
        ON "modbus_devices" ("tenantId", "name") WHERE "deleted_at" IS NULL
    `);
    // The poller's boot query: every enabled row.
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "IDX_modbus_devices_tenant_enabled"
        ON "modbus_devices" ("tenantId", "enabled")
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "IDX_modbus_devices_tenant_device"
        ON "modbus_devices" ("tenantId", "deviceId")
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `DROP INDEX IF EXISTS "IDX_modbus_devices_tenant_device"`,
    );
    await queryRunner.query(
      `DROP INDEX IF EXISTS "IDX_modbus_devices_tenant_enabled"`,
    );
    await queryRunner.query(
      `DROP INDEX IF EXISTS "UQ_modbus_devices_tenant_name"`,
    );
    await queryRunner.query(`DROP TABLE IF EXISTS "modbus_devices"`);
  }
}
