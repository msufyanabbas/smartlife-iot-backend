import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * OPC-UA, BACnet/IP and NB-IoT.
 *
 * Three tables plus two enum additions. Written by hand rather than generated:
 * `migration:generate` does not emit `ALTER TYPE ... ADD VALUE` for an enum
 * addition (it tries to recreate the type and rewrite every dependent column)
 * and it currently also emits a large amount of unrelated pre-existing drift
 * (CLAUDE.md §11).
 *
 * ── The enum additions are the part that cannot be skipped ─────────────────
 * `integrations.type` and `devices.protocol` are Postgres ENUM columns. A new
 * TypeScript member alone is not enough: `@IsEnum` / `@IsIn` accepts the value
 * and the INSERT then fails with `invalid input value for enum
 * integrations_type_enum: "nbiot_http"`. That is exactly why the frontend's
 * "Apache Kafka" tile used to 400 (§4e).
 *
 * `ADD VALUE IF NOT EXISTS` is safe inside a transaction on PostgreSQL 12+
 * provided the new value is not USED in the same transaction — it is not.
 *
 * `DeviceTransportType` (OPCUA / BACNET / NB_IOT) needs nothing here: that
 * column is varchar, deliberately, so a new transport costs no migration.
 *
 * ── tenantId is uuid with a real FK ───────────────────────────────────────
 * All three entities declare `@ManyToOne('Tenant')` against `tenantId`, and a
 * join column takes the referenced key's type and gets a constraint whether a
 * hand-written migration says so or not — the same reasoning as
 * `ai_models.tenantId` (compare `integration_events.tenantId`, correctly
 * varchar precisely BECAUSE it has no relation). Getting this backwards leaves
 * the migration permanently at odds with the schema `synchronize` builds.
 *
 * ── Unique indexes are partial ────────────────────────────────────────────
 * Every uniqueness rule here is `WHERE deleted_at IS NULL`. These are all
 * soft-deleted entities, and a plain UNIQUE would mean deleting a BACnet
 * device permanently reserved its instance number — so re-adding the same
 * controller after a mistake would be impossible.
 *
 * `migration:run` is blocked (§11), so apply this one on its own:
 *   npm run migration:industrial-protocols <database> [up|down]
 */
export class IndustrialProtocols1788100000000 implements MigrationInterface {
  name = 'IndustrialProtocols1788100000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // ── Enum additions ──────────────────────────────────────────────────────
    for (const value of ['nbiot_http', 'nbiot_coap']) {
      await queryRunner.query(
        `ALTER TYPE "integrations_type_enum" ADD VALUE IF NOT EXISTS '${value}'`,
      );
    }
    await queryRunner.query(
      `ALTER TYPE "devices_protocol_enum" ADD VALUE IF NOT EXISTS 'nb_iot'`,
    );

    // ── opcua_servers ───────────────────────────────────────────────────────
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "opcua_servers" (
        "id"                    uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
        "created_at"            TIMESTAMP NOT NULL DEFAULT now(),
        "updated_at"            TIMESTAMP NOT NULL DEFAULT now(),
        "deleted_at"            TIMESTAMP,
        "created_by"            character varying,
        "updated_by"            character varying,
        "deleted_by"            character varying,
        "tenantId"              uuid NOT NULL,
        "name"                  character varying(120) NOT NULL,
        "description"           text,
        "deviceId"              uuid,
        "assetId"               uuid,
        "endpointUrl"           character varying(500) NOT NULL,
        "securityMode"          character varying(32) NOT NULL DEFAULT 'None',
        "securityPolicy"        character varying(64) NOT NULL DEFAULT 'None',
        "username"              character varying(200),
        "passwordEncrypted"     text,
        "nodes"                 jsonb NOT NULL DEFAULT '[]'::jsonb,
        "useSubscription"       boolean NOT NULL DEFAULT true,
        "publishingIntervalMs"  integer NOT NULL DEFAULT 1000,
        "samplingIntervalMs"    integer NOT NULL DEFAULT 1000,
        "pollIntervalMs"        integer NOT NULL DEFAULT 10000,
        "flushWindowMs"         integer NOT NULL DEFAULT 1000,
        "enabled"               boolean NOT NULL DEFAULT true,
        "lastStatus"            character varying(32),
        "lastMessage"           text,
        "lastConnectedAt"       TIMESTAMP,
        "lastReadingAt"         TIMESTAMP,
        "readingCount"          bigint NOT NULL DEFAULT 0,
        CONSTRAINT "FK_opcua_servers_tenant"
          FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE,
        -- SET NULL, not CASCADE: deleting a device must not take the node map
        -- with it. Re-pointing the row at a new device is a dropdown; rebuilding
        -- a 200-node map is an afternoon.
        CONSTRAINT "FK_opcua_servers_device"
          FOREIGN KEY ("deviceId") REFERENCES "devices"("id") ON DELETE SET NULL,
        CONSTRAINT "FK_opcua_servers_asset"
          FOREIGN KEY ("assetId") REFERENCES "assets"("id") ON DELETE SET NULL
      )
    `);

    await queryRunner.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS "UQ_opcua_servers_tenant_name"
        ON "opcua_servers" ("tenantId", "name") WHERE "deleted_at" IS NULL
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "IDX_opcua_servers_tenant_enabled"
        ON "opcua_servers" ("tenantId", "enabled")
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "IDX_opcua_servers_tenant_device"
        ON "opcua_servers" ("tenantId", "deviceId")
    `);
    // The adapter groups rows by endpoint to share one session, so this is the
    // index that query uses.
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "IDX_opcua_servers_tenant_endpoint"
        ON "opcua_servers" ("tenantId", "endpointUrl")
    `);

    // ── bacnet_devices ──────────────────────────────────────────────────────
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "bacnet_devices" (
        "id"                       uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
        "created_at"               TIMESTAMP NOT NULL DEFAULT now(),
        "updated_at"               TIMESTAMP NOT NULL DEFAULT now(),
        "deleted_at"               TIMESTAMP,
        "created_by"               character varying,
        "updated_by"               character varying,
        "deleted_by"               character varying,
        "tenantId"                 uuid NOT NULL,
        "name"                     character varying(120) NOT NULL,
        "description"              text,
        "deviceId"                 uuid,
        "address"                  character varying(200) NOT NULL,
        "port"                     integer NOT NULL DEFAULT 47808,
        "deviceInstance"           integer NOT NULL,
        "vendorId"                 integer,
        "maxApdu"                  integer,
        "objects"                  jsonb NOT NULL DEFAULT '[]'::jsonb,
        "pollIntervalMs"           integer NOT NULL DEFAULT 30000,
        "useReadPropertyMultiple"  boolean NOT NULL DEFAULT true,
        "apduTimeoutMs"            integer NOT NULL DEFAULT 6000,
        "enabled"                  boolean NOT NULL DEFAULT true,
        "lastStatus"               character varying(32),
        "lastMessage"              text,
        "lastReadingAt"            TIMESTAMP,
        "readingCount"             bigint NOT NULL DEFAULT 0,
        CONSTRAINT "FK_bacnet_devices_tenant"
          FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE,
        CONSTRAINT "FK_bacnet_devices_device"
          FOREIGN KEY ("deviceId") REFERENCES "devices"("id") ON DELETE SET NULL,
        -- 0 … 4194302. 4194303 is the BACnet "unknown device" wildcard and is
        -- not a valid instance for a real controller.
        CONSTRAINT "CHK_bacnet_devices_instance"
          CHECK ("deviceInstance" >= 0 AND "deviceInstance" <= 4194302)
      )
    `);

    // A BACnet instance number is unique on the internetwork, so two live rows
    // claiming one means one of them is addressing the wrong controller — and
    // a poll would read the same points into two different platform devices.
    await queryRunner.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS "UQ_bacnet_devices_tenant_instance"
        ON "bacnet_devices" ("tenantId", "deviceInstance")
        WHERE "deleted_at" IS NULL
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "IDX_bacnet_devices_tenant_enabled"
        ON "bacnet_devices" ("tenantId", "enabled")
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "IDX_bacnet_devices_tenant_device"
        ON "bacnet_devices" ("tenantId", "deviceId")
    `);

    // ── nbiot_devices ───────────────────────────────────────────────────────
    //
    // `deviceId` is NOT NULL and CASCADEs here, unlike the two above: an
    // NB-IoT record with no device is a SIM in a drawer, and the uplink route
    // would have nowhere to put its telemetry.
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "nbiot_devices" (
        "id"                              uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
        "created_at"                      TIMESTAMP NOT NULL DEFAULT now(),
        "updated_at"                      TIMESTAMP NOT NULL DEFAULT now(),
        "deleted_at"                      TIMESTAMP,
        "created_by"                      character varying,
        "updated_by"                      character varying,
        "deleted_by"                      character varying,
        "tenantId"                        uuid NOT NULL,
        "deviceId"                        uuid NOT NULL,
        "imsi"                            character varying(32),
        "imei"                            character varying(32),
        "iccid"                           character varying(32),
        "msisdn"                          character varying(32),
        "carrier"                         character varying(120),
        "apn"                             character varying(200),
        "plmn"                            character varying(16),
        "band"                            integer,
        "appProtocol"                     character varying(16) NOT NULL DEFAULT 'coap',
        "expectedReportIntervalSeconds"   integer,
        "enabled"                         boolean NOT NULL DEFAULT true,
        "lastRsrp"                        double precision,
        "lastRsrq"                        double precision,
        "lastSinr"                        double precision,
        "lastEcl"                         integer,
        "lastCoverageClass"               integer,
        "lastCellId"                      character varying(32),
        "lastTac"                         character varying(32),
        "lastUplinkAt"                    TIMESTAMP,
        "uplinkCount"                     bigint NOT NULL DEFAULT 0,
        CONSTRAINT "FK_nbiot_devices_tenant"
          FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE,
        CONSTRAINT "FK_nbiot_devices_device"
          FOREIGN KEY ("deviceId") REFERENCES "devices"("id") ON DELETE CASCADE,
        -- 0, 1 or 2. Modules report 255 for "unknown", which the normaliser
        -- drops rather than storing; this stops anything else writing it.
        CONSTRAINT "CHK_nbiot_devices_ecl"
          CHECK ("lastEcl" IS NULL OR ("lastEcl" >= 0 AND "lastEcl" <= 2))
      )
    `);

    await queryRunner.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS "UQ_nbiot_devices_tenant_device"
        ON "nbiot_devices" ("tenantId", "deviceId") WHERE "deleted_at" IS NULL
    `);
    // IMEI / IMSI / ICCID are globally unique identifiers, so a duplicate
    // inside one tenant is a typo. Enforced in the database as well as the
    // service, because the uplink resolves by these columns and would
    // otherwise pick whichever row the query happened to return first.
    await queryRunner.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS "UQ_nbiot_devices_tenant_imei"
        ON "nbiot_devices" ("tenantId", "imei")
        WHERE "deleted_at" IS NULL AND "imei" IS NOT NULL
    `);
    await queryRunner.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS "UQ_nbiot_devices_tenant_imsi"
        ON "nbiot_devices" ("tenantId", "imsi")
        WHERE "deleted_at" IS NULL AND "imsi" IS NOT NULL
    `);
    await queryRunner.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS "UQ_nbiot_devices_tenant_iccid"
        ON "nbiot_devices" ("tenantId", "iccid")
        WHERE "deleted_at" IS NULL AND "iccid" IS NOT NULL
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "IDX_nbiot_devices_tenant_enabled"
        ON "nbiot_devices" ("tenantId", "enabled")
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS "nbiot_devices"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "bacnet_devices"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "opcua_servers"`);
    // The enum labels are NOT removed: PostgreSQL has no
    // `ALTER TYPE ... DROP VALUE`, and removing a label means recreating the
    // type and rewriting every dependent column — far more destructive than an
    // unused label. Same decision as IntegrationTypeEnum1787100000000.
  }
}
