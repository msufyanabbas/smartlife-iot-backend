import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * converters: the table behind the seven converter pages the frontend has
 * shipped against no backend at all.
 *
 * A converter turns a raw device payload into platform telemetry (uplink), or a
 * platform command into a device payload (downlink). Three types:
 * `json` (declarative path → key mapping), `script` (JS in a vm2 sandbox), and
 * `codec`, which delegates to `CodecRegistryService` so the 80+ Milesight
 * codecs under `modules/devices/codecs/` are reachable from a converter without
 * any decoding being reimplemented.
 *
 * ── Column types ────────────────────────────────────────────────────────────
 * `tenantId` and `customerId` are `uuid` with real foreign keys, because the
 * entity declares `@ManyToOne('Tenant')` / `@ManyToOne('Customer')` against
 * them: a column that is also a join column takes the referenced key's type and
 * gets a constraint whatever a hand-written migration says. Writing
 * `character varying` here — as `integration_events.tenantId` correctly does,
 * since THAT column has no relation — would leave this migration permanently at
 * odds with the schema `synchronize` builds.
 *
 * `userId` is deliberately the other way round: `character varying`, no FK. A
 * converter is tenant infrastructure that outlives whoever created it, exactly
 * as `rule_chain_templates.userId` does.
 *
 * `direction` and `type` are **`character varying`, not PostgreSQL enums**. A
 * PG enum column needs `ALTER TYPE … ADD VALUE` before a new TypeScript member
 * can be stored, and `@IsEnum` accepts the value that the INSERT then rejects —
 * the failure that made the frontend's "Apache Kafka" integration tile 400
 * (CLAUDE.md §4e). `device_profiles.transportType` is varchar for the same
 * reason. Adding a converter type is therefore a manifest and nothing else.
 *
 * There is no `status` column on purpose. The list page's badge is derived from
 * `enabled` and `lastError` by `Converter.health()`; a stored copy would be a
 * third source of truth that drifts from both.
 *
 * Name uniqueness is enforced in `ConvertersService`, not by a constraint: soft
 * deletes mean `deleted_at` is not part of any UNIQUE the ORM would build, so a
 * deleted converter would keep its name reserved forever.
 *
 * down() drops the table. Devices referencing a converter do so through
 * `devices.metadata.uplinkConverterId`, a jsonb key with no constraint, so
 * nothing else needs unwinding.
 */
export class DataConverters1787600000000 implements MigrationInterface {
  name = 'DataConverters1787600000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "converters" (
        "id"                   uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
        "created_at"           TIMESTAMP NOT NULL DEFAULT now(),
        "updated_at"           TIMESTAMP NOT NULL DEFAULT now(),
        "deleted_at"           TIMESTAMP,
        "created_by"           character varying,
        "updated_by"           character varying,
        "deleted_by"           character varying,
        "tenantId"             uuid NOT NULL,
        "customerId"           uuid,
        "userId"               character varying,
        "name"                 character varying NOT NULL,
        "description"          text,
        "direction"            character varying NOT NULL DEFAULT 'uplink',
        "type"                 character varying NOT NULL DEFAULT 'json',
        "protocol"             character varying,
        "configuration"        jsonb NOT NULL DEFAULT '{}'::jsonb,
        "enabled"              boolean NOT NULL DEFAULT true,
        "debugMode"            boolean NOT NULL DEFAULT false,
        "executionCount"       integer NOT NULL DEFAULT 0,
        "successCount"         integer NOT NULL DEFAULT 0,
        "failureCount"         integer NOT NULL DEFAULT 0,
        "lastExecuted"         TIMESTAMP,
        "averageExecutionTime" integer NOT NULL DEFAULT 0,
        "lastError"            text,
        "errorHistory"         jsonb,
        "tags"                 text,
        "additionalInfo"       jsonb,
        CONSTRAINT "FK_converters_tenant"
          FOREIGN KEY ("tenantId") REFERENCES "tenants"("id"),
        CONSTRAINT "FK_converters_customer"
          FOREIGN KEY ("customerId") REFERENCES "customers"("id")
      )
    `);

    // The list page filters a tenant's converters by direction (the
    // uplink/downlink split), by type (the "All types" dropdown) and by the
    // enabled flag; the dispatch-side lookup is (tenantId, enabled, direction).
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "IDX_converters_tenant_direction"
        ON "converters" ("tenantId", "direction")
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "IDX_converters_tenant_type"
        ON "converters" ("tenantId", "type")
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "IDX_converters_tenant_enabled"
        ON "converters" ("tenantId", "enabled")
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `DROP INDEX IF EXISTS "IDX_converters_tenant_enabled"`,
    );
    await queryRunner.query(`DROP INDEX IF EXISTS "IDX_converters_tenant_type"`);
    await queryRunner.query(
      `DROP INDEX IF EXISTS "IDX_converters_tenant_direction"`,
    );
    await queryRunner.query(`DROP TABLE IF EXISTS "converters"`);
  }
}
